"""Local speech with Piper, plus exact per-word timings.

Piper reports how many audio samples each phoneme takes. We phonemize every
word on its own as a reference, align that against the phonemes of the whole
sentence, and read off when each word starts.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import threading
import unicodedata
import urllib.request
import wave
from collections import OrderedDict
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

import numpy as np

HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# key, label  (first one per language is the default)
VOICES: dict[str, list[tuple[str, str]]] = {
    "en": [
        ("en_US-lessac-medium", "Lessac · US"),
        ("en_US-ryan-medium", "Ryan · US"),
        ("en_GB-alba-medium", "Alba · UK"),
        ("en_GB-alan-medium", "Alan · UK"),
    ],
    "hu": [
        ("hu_HU-anna-medium", "Anna"),
        ("hu_HU-imre-medium", "Imre"),
        ("hu_HU-berta-medium", "Berta"),
    ],
    "fr": [
        ("fr_FR-siwis-medium", "Siwis"),
        ("fr_FR-tom-medium", "Tom"),
    ],
    "de": [
        ("de_DE-thorsten-medium", "Thorsten"),
        ("de_DE-kerstin-low", "Kerstin (lower quality)"),
    ],
    "nl": [
        ("nl_NL-ronnie-medium", "Ronnie"),
        ("nl_NL-pim-medium", "Pim"),
        ("nl_BE-nathalie-medium", "Nathalie · BE"),
    ],
}
ALL_KEYS = {k for vs in VOICES.values() for k, _ in vs}

# Characters ignored when aligning (stress, length, pauses, punctuation).
IGNORE = set(" ˈˌː.,;:!?¡¿—–-…'\"()[]{}«»“”‘’^$_|/")


def _voice_url(key: str, suffix: str) -> str:
    lang_region, name, quality = key.split("-", 2)
    family = lang_region.split("_")[0]
    return f"{HF_BASE}/{family}/{lang_region}/{name}/{quality}/{key}.onnx{suffix}"


class VoiceStore:
    def __init__(self, folder: Path):
        self.folder = folder
        self.folder.mkdir(parents=True, exist_ok=True)
        self.progress: dict[str, dict] = {}
        self.loaded: dict[str, object] = {}
        self.lock = threading.Lock()  # espeak (phonemizer) is not thread-safe
        self.cache: OrderedDict[tuple, dict] = OrderedDict()  # recent speech, at most CACHE_BYTES
        self.cache_bytes = 0
        self.cache_lock = threading.Lock()
        self._ref_cache: dict[tuple, list[str]] = {}

    # ---- files

    def path(self, key: str) -> Path:
        return self.folder / f"{key}.onnx"

    def installed(self, key: str) -> bool:
        return self.path(key).exists() and Path(str(self.path(key)) + ".json").exists()

    def status(self) -> dict:
        out = {}
        for lang, vs in VOICES.items():
            out[lang] = [
                {"key": k, "label": label, "installed": self.installed(k),
                 "progress": self.progress.get(k)}
                for k, label in vs
            ]
        return out

    def install(self, key: str):
        """Start downloading a voice in the background (no-op if present)."""
        if key not in ALL_KEYS:
            raise ValueError("unknown voice")
        if self.installed(key) or (key in self.progress and not self.progress[key].get("error")):
            return
        self.progress[key] = {"done": 0, "total": 0}
        threading.Thread(target=self._download, args=(key,), daemon=True).start()

    def _download(self, key: str):
        try:
            for suffix in (".json", ""):
                dest = Path(str(self.path(key)) + suffix)
                tmp = dest.with_suffix(dest.suffix + ".part")
                with urllib.request.urlopen(_voice_url(key, suffix), timeout=60) as r:
                    total = int(r.headers.get("Content-Length") or 0)
                    if suffix == "":
                        self.progress[key]["total"] = total
                    with open(tmp, "wb") as f:
                        while chunk := r.read(1 << 16):
                            f.write(chunk)
                            if suffix == "":
                                self.progress[key]["done"] += len(chunk)
                tmp.replace(dest)
            self.progress.pop(key, None)
        except Exception as e:  # surfaced to the UI
            self.progress[key] = {"error": str(e)}

    # ---- synthesis

    def voice(self, key: str):
        if key not in self.loaded:
            if not self.installed(key):
                raise FileNotFoundError(key)
            self.loaded[key] = _load_voice(self.path(key))
        return self.loaded[key]

    def _ref(self, voice, key: str, word: str) -> list[str]:
        ck = (key, word)
        if ck not in self._ref_cache:
            ph = [p for sent in voice.phonemize(word) for p in sent if p not in IGNORE]
            if len(self._ref_cache) > 50000:
                self._ref_cache.clear()
            self._ref_cache[ck] = ph
        return self._ref_cache[ck]

    def speak(self, key: str, words: list[str], rate: float = 1.0) -> dict:
        rate = min(max(rate, MIN_RATE), MAX_RATE)
        ck = (key, round(rate, 2), tuple(words))
        with self.cache_lock:
            if ck in self.cache:
                self.cache.move_to_end(ck)
                return self.cache[ck]

        with self.lock:
            voice = self.voice(key)
            sr = voice.config.sample_rate

            text = " ".join(words)
            model_rate = min(rate, MODEL_MAX_RATE)
            stretch = _stretch_factor(rate)
            tail = max(0.12 * stretch, 0.2 / model_rate)  # silence kept after each sentence
            audio_parts = []
            act: list[str] = []      # aligned phonemes of the whole text
            act_t: list[int] = []    # their start sample
            offset = 0
            for audio, phonemes, al in _synthesize(voice, text, model_rate):
                # look for the last sound only shortly after the spoken phonemes, not in the EOS tail
                last_spoken = len(phonemes)
                while last_spoken > 0 and (phonemes[last_spoken - 1] == " " or phonemes[last_spoken - 1] in PAUSES):
                    last_spoken -= 1
                spoken = sum(al[:last_spoken + 1]) if al and last_spoken else None
                audio, cut = _trim(audio, sr, tail=tail, until=None if spoken is None else spoken + int(0.15 * sr))
                if al:
                    cum = al[0] - cut
                    for i, ph in enumerate(phonemes):
                        if ph not in IGNORE:
                            act.append(ph)
                            act_t.append(offset + max(0, cum))
                        cum += al[i + 1]
                else:  # no alignment: spread phonemes evenly over the chunk
                    keep = [p for p in phonemes if p not in IGNORE]
                    for i, ph in enumerate(keep):
                        act.append(ph)
                        act_t.append(offset + int(len(audio) * i / max(1, len(keep))))
                audio_parts.append(audio)
                offset += len(audio)

            refs = [self._ref(voice, key, w) for w in words]

        starts = _align(refs, act, act_t)
        audio = np.concatenate(audio_parts) if audio_parts else np.zeros(1, dtype=np.float32)
        if stretch > 1:
            audio = _wsola(audio, stretch, sr)
            starts = [None if t is None else int(t / stretch) for t in starts]
        result = {
            "wav": _wav(audio, sr),
            "starts": [None if s is None else round(s / sr, 3) for s in starts],
            "duration": round(len(audio) / sr, 3),
        }
        with self.cache_lock:
            if ck not in self.cache:
                self.cache[ck] = result
                self.cache_bytes += len(result["wav"])
            while self.cache_bytes > CACHE_BYTES and len(self.cache) > 1:
                self.cache_bytes -= len(self.cache.popitem(last=False)[1]["wav"])
        return result


CACHE_BYTES = 100 << 20  # about 40 minutes of speech


MIN_RATE, MAX_RATE = 0.5, 4.0
# Above this the voice model can't get faster without mumbling: every sound already has
# its shortest possible length. Faster speeds are reached by time-stretching its audio
# (pitch stays the same): 3.5x = the 3x voice played 1.2 times faster, 4x = 1.4 times.
MODEL_MAX_RATE = 3.0


def _stretch_factor(rate: float) -> float:
    return 1 + 0.4 * (rate - MODEL_MAX_RATE) if rate > MODEL_MAX_RATE else 1.0


def _wsola(x: np.ndarray, speed: float, sr: int, frame: float = 0.03, tol: float = 0.012) -> np.ndarray:
    """Make speech `speed` times faster without changing its pitch (WSOLA: overlap short
    windows of the input, each shifted slightly so its waveform lines up with the last one)."""
    n = int(frame * sr) // 2 * 2
    if speed <= 1 or len(x) < 2 * n:
        return x
    hs, ha, d = n // 2, n / 2 * speed, int(tol * sr)
    win = np.hanning(n).astype(np.float32)
    off = d + n
    pad = np.concatenate([np.zeros(off, np.float32), x.astype(np.float32),
                          np.zeros(d + int(n * (speed + 3)), np.float32)])
    out_len = int(len(x) / speed)
    y = np.zeros(out_len + 2 * n, np.float32)
    wsum = np.zeros(out_len + 2 * n, np.float32)
    prev, k = off, 0
    while k * hs < out_len:
        nominal = off + int(round(k * ha))
        if k == 0:
            pos = nominal
        else:
            target = pad[prev + hs: prev + hs + n]           # what would naturally come next
            lo = nominal - d
            pos = lo + int(np.argmax(np.correlate(pad[lo: lo + n + 2 * d], target, mode="valid")))
        y[k * hs: k * hs + n] += pad[pos: pos + n] * win
        wsum[k * hs: k * hs + n] += win
        prev, k = pos, k + 1
    return (y / np.maximum(wsum, 1e-3))[:out_len]


# Minimum silent room kept on the end-of-sentence (EOS) token so the last word
# finishes decaying even at high speeds (instead of appending fake ". . ." pause
# phonemes, which are out-of-distribution for Piper/VITS and cause trailing "uh"/"hmm" moans).
EOS_MIN_SECONDS = 0.12

# Speeding the voice up shortens every sound by the same factor. But the end of a word
# before a pause (comma, full stop, end of a line) is naturally drawn out, so it lost
# the most: at 3x those sounds kept 43% of their length (other sounds about 64%) and
# sounded cut off. So word endings are sped up less than the rest:
END_BEFORE_PAUSE_MAX = 1.5  # at most this much faster than normal
END_OF_WORD_MAX = 2.0

VOWELS = set("aeiouyæɑɒɐəɛɜɪɔʊʌøœɯɤɨʉɘɵɞʏɶɚɝ")
MARKS = set("ˈˌːˑ")
PAUSES = set(",.;:!?…—")


WINDOWS = os.name == "nt"


@lru_cache(maxsize=1)
def _espeak_data_dir() -> Path:
    """Where espeak-ng should read its data. On Windows it opens files with plain fopen, which
    fails on paths with non-ASCII letters (e.g. an accented user name) or that are long, and
    then silently falls back to a path baked in at build time. So it always reads a short ASCII copy."""
    from piper.phonemize_espeak import ESPEAK_DATA_DIR as src
    if not WINDOWS:
        return src

    def usable(p) -> bool:
        return str(p).isascii() and len(str(p)) < 100

    stamp = str((src / "phontab").stat().st_size) + "-" + str(sum(1 for _ in src.rglob("*")))
    drive = os.environ.get("SystemDrive", "C:") + "\\"
    for base in (os.environ.get("ProgramData", ""), os.environ.get("PUBLIC", ""), drive):
        if not base:
            continue
        dest = Path(base) / "Steady" / "espeak-ng-data"
        if not usable(dest):
            continue
        try:
            mark = dest / ".steady-copy"
            if not mark.exists() or mark.read_text() != stamp:
                shutil.copytree(src, dest, dirs_exist_ok=True)
                mark.write_text(stamp)
            return dest
        except OSError:
            continue
    return src


def _load_voice(path: Path):
    """Load a Piper voice whose model also reports how long each phoneme lasts (for
    word timing) and accepts per-phoneme duration controls (for _ending_factors and EOS tail)."""
    from piper import PiperVoice

    try:
        import onnx
        import onnxruntime
        from onnx import TensorProto, helper, numpy_helper
        from piper.config import PiperConfig
        from piper.patch_voice_with_alignment import add_alignment_output

        model = onnx.load(str(path))
        add_alignment_output(model)
        g = model.graph
        # durations = ceil(max(predicted * length_scale * dur_scale, dur_min))
        ceil = next(n for n in g.node if n.op_type == "Ceil")
        g.input.append(helper.make_tensor_value_info("dur_scale", TensorProto.FLOAT, [1, 1, None]))
        g.initializer.append(numpy_helper.from_array(np.ones((1, 1, 1), np.float32), "dur_scale"))
        g.input.append(helper.make_tensor_value_info("dur_min", TensorProto.FLOAT, [1, 1, None]))
        g.initializer.append(numpy_helper.from_array(np.zeros((1, 1, 1), np.float32), "dur_min"))
        mul = helper.make_node("Mul", [ceil.input[0], "dur_scale"], ["steady_dur_scaled"], name="SteadyDurScale")
        clamp = helper.make_node("Max", ["steady_dur_scaled", "dur_min"], ["steady_dur_clamped"], name="SteadyDurMin")
        nodes = list(g.node)
        idx = nodes.index(ceil)
        nodes.insert(idx, mul)
        nodes.insert(idx + 1, clamp)
        ceil.input[0] = "steady_dur_clamped"
        del g.node[:]
        g.node.extend(nodes)
        opts = onnxruntime.SessionOptions()
        opts.log_severity_level = 3
        session = onnxruntime.InferenceSession(model.SerializeToString(), sess_options=opts,
                                               providers=["CPUExecutionProvider"])
        config = PiperConfig.from_dict(json.loads(Path(f"{path}.json").read_text("utf8")))
        voice = PiperVoice(config=config, session=session, espeak_data_dir=_espeak_data_dir())
        voice.steady_dur_scale = True
        return voice
    except Exception:  # unusual model: plain Piper (word endings not protected)
        return PiperVoice.load(str(path), include_alignments=True, espeak_data_dir=_espeak_data_dir())


def _is_mark(p: str) -> bool:
    return p in MARKS or bool(unicodedata.combining(p))


def _ending_factors(phonemes: list[str], rate: float) -> list[float]:
    """How much longer than the global speed allows each phoneme should last (1 = no change)."""
    out = [1.0] * len(phonemes)
    before_pause = rate / min(rate, END_BEFORE_PAUSE_MAX)
    word_end = rate / min(rate, END_OF_WORD_MAX)
    if before_pause <= 1 and word_end <= 1:
        return out
    n, i = len(phonemes), 0
    is_break = lambda p: p == " " or p in PAUSES
    while i < n:
        if is_break(phonemes[i]):
            i += 1
            continue
        k = i
        while k < n and not is_break(phonemes[k]):
            k += 1
        # word is phonemes[i:k]; is a pause next (skipping spaces)?
        m = k
        while m < n and phonemes[m] == " ":
            m += 1
        pause = m >= n or phonemes[m] in PAUSES
        e = k - 1
        while e >= i and _is_mark(phonemes[e]):
            e -= 1
        if e >= i:
            if phonemes[e] in VOWELS:  # ends on a vowel: only matters before a pause
                start = e
                while start > i and (phonemes[start - 1] in VOWELS or _is_mark(phonemes[start - 1])):
                    start -= 1
                factor = before_pause if pause else 1.0
            else:  # the final consonants
                start = e
                while start > i and phonemes[start - 1] not in VOWELS:
                    start -= 1
                factor = before_pause if pause else word_end
            for x in range(start, k):
                out[x] = max(out[x], factor)
        i = k
    return out


def _synthesize(voice, text: str, rate: float):
    """Like PiperVoice.synthesize at `rate`, with word endings and the sentence-end
    EOS silence tail protected (see _ending_factors and EOS_MIN_SECONDS).

    Yields (audio, phonemes, samples per phoneme with BOS first and EOS last, or None).
    """
    from piper import SynthesisConfig
    from piper.const import BOS, EOS, PAD

    c = voice.config
    id_map = c.phoneme_id_map
    pad = len(id_map.get(PAD, []))
    length_scale = (c.length_scale or 1.0) / rate
    tail_scale = max(1.0, rate)
    eos_min = float(max(1, round(EOS_MIN_SECONDS * c.sample_rate / c.hop_length)))
    for phonemes in voice.phonemize(text):
        if not phonemes:
            continue
        ids = voice.phonemes_to_ids(phonemes)
        if getattr(voice, "steady_dur_scale", False):
            factors = _ending_factors(phonemes, rate)
            # Keep trailing punctuation at its natural (1x) length at high speeds.
            for i in range(len(phonemes) - 1, -1, -1):
                if phonemes[i] == " " or phonemes[i] in PAUSES:
                    factors[i] = max(factors[i], tail_scale)
                else:
                    break
            per_id = [1.0] * (len(id_map[BOS]) + pad)
            min_id = [0.0] * (len(id_map[BOS]) + pad)
            for p, f in zip(phonemes, factors):
                if p in id_map:
                    n = len(id_map[p]) + pad
                    per_id += [f] * n
                    min_id += [0.0] * n
            eos_n = len(id_map[EOS])
            per_id += [tail_scale] * eos_n
            min_id += [eos_min] * eos_n
            args = {
                "input": np.array([ids], dtype=np.int64),
                "input_lengths": np.array([len(ids)], dtype=np.int64),
                "scales": np.array([c.noise_scale, length_scale, c.noise_w_scale], dtype=np.float32),
                "dur_scale": np.array(per_id[:len(ids)], dtype=np.float32).reshape(1, 1, -1),
                "dur_min": np.array(min_id[:len(ids)], dtype=np.float32).reshape(1, 1, -1),
            }
            if c.num_speakers > 1:
                args["sid"] = np.array([c.default_speaker_id], dtype=np.int64)
            out = voice.session.run(None, args)
            audio = out[0].squeeze()
            id_samples = (out[1].squeeze() * c.hop_length).astype(np.int64) if len(out) > 1 else None
        else:
            res = voice.phoneme_ids_to_audio(ids, SynthesisConfig(length_scale=length_scale), include_alignments=True)
            audio, id_samples = res if isinstance(res, tuple) else (res, None)
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        audio = np.clip(audio / peak, -1, 1) if peak > 1e-8 else np.zeros_like(audio)

        # phonemes_to_ids writes BOS PAD, then "id PAD" per known phoneme, then EOS.
        samples = None
        if id_samples is not None and len(id_samples) == len(ids):
            counts = [len(id_map[BOS]) + pad]
            counts += [len(id_map[p]) + pad if p in id_map else 0 for p in phonemes]
            counts.append(len(id_map[EOS]))
            if sum(counts) == len(ids):
                samples, i = [], 0
                for n in counts:
                    samples.append(int(np.sum(id_samples[i:i + n])))
                    i += n
        yield audio.astype(np.float32), phonemes, samples


def _align(refs: list[list[str]], act: list[str], act_t: list[int]) -> list[int | None]:
    """Start sample for every word (None for words that aren't spoken)."""
    ref: list[str] = []
    owner: list[int] = []
    for wi, r in enumerate(refs):
        ref.extend(r)
        owner.extend([wi] * len(r))

    mapping: dict[int, int] = {}
    if ref and act:
        sm = SequenceMatcher(None, ref, act, autojunk=False)
        for a, b, size in sm.get_matching_blocks():
            for j in range(size):
                mapping[a + j] = b + j

    starts: list[int | None] = [None] * len(refs)
    pos = 0
    for wi, r in enumerate(refs):
        hits = [mapping[i] for i in range(pos, pos + len(r)) if i in mapping]
        if hits:
            # the first matched phoneme, shifted back by any unmatched ones before it
            first_ref = next(i for i in range(pos, pos + len(r)) if i in mapping)
            b = max(0, mapping[first_ref] - (first_ref - pos))
            starts[wi] = act_t[b]
        pos += len(r)

    # Fill spoken words that didn't align by interpolating between neighbours.
    spoken = [i for i, r in enumerate(refs) if r]
    end_t = act_t[-1] if act_t else 0
    known = [(i, starts[i]) for i in spoken if starts[i] is not None]
    for i in spoken:
        if starts[i] is not None:
            continue
        before = next(((j, t) for j, t in reversed(known) if j < i), (None, 0))
        after = next(((j, t) for j, t in known if j > i), (None, end_t))
        lo_i = before[0] if before[0] is not None else -1
        hi_i = after[0] if after[0] is not None else len(refs)
        frac = (i - lo_i) / max(1, hi_i - lo_i)
        starts[i] = int(before[1] + (after[1] - before[1]) * frac)

    # Keep starts increasing.
    last = 0
    for i in spoken:
        if starts[i] < last:
            starts[i] = last
        last = starts[i]
    return starts


def _trim(audio: np.ndarray, sr: int, lead: float = 0.04, tail: float = 0.2,
          until: int | None = None) -> tuple[np.ndarray, int]:
    """Cut long silences around a sentence and end it with exactly `tail` seconds
    after the last sound (keeping a brief natural decay, fading cleanly to zero,
    and padding the rest with silence), so the end of the last word is never lost
    and any late noise in the pause tail stays silent. Returns (audio, samples cut at start)."""
    if not len(audio):
        return audio, 0
    loud = np.flatnonzero(np.abs(audio[:until]) > 0.02 * (np.max(np.abs(audio)) or 1))
    if not len(loud):
        return audio, 0
    start = max(0, int(loud[0] - lead * sr))
    want = int(loud[-1] + tail * sr)
    keep = min(len(audio), int(loud[-1] + min(tail, 0.06) * sr))
    out = audio[start:keep].copy()
    fade = min(len(out), min(int(0.03 * sr), max(int(0.01 * sr), keep - int(loud[-1]) - int(0.02 * sr))))
    if fade:
        out[len(out) - fade:] *= np.linspace(1, 0, fade, dtype=out.dtype)
    if want > keep:
        out = np.concatenate([out, np.zeros(want - keep, dtype=out.dtype)])
    return out, start


def _wav(audio: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()
