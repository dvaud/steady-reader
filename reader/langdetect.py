"""Tiny stop-word based detector for the five supported languages."""

import re
from collections import Counter

STOPWORDS = {
    "en": "the and of to in that it was for with as on are this be by not you have but from they which at his her were would there their what about".split(),
    "hu": "az és hogy nem egy meg de van volt mint csak már ez ki el még azt ha vagy kell mert pedig nagyon lesz sem után itt ami aki amely voltak lehet".split(),
    "fr": "le la les des et est un une que qui dans pour pas du sur au avec ce il elle sont nous vous par mais ou cette leur aux été être".split(),
    "de": "der die das und ist nicht ein eine zu den mit sich auf für von dem im es auch als wird sind wie oder aber ich bei nach noch".split(),
    "nl": "het een en van dat niet op te met voor zijn er aan ook als maar bij door wordt naar dit wat deze om ik uit zich heeft hij".split(),
}
LOOKUP = {}
for lang, words in STOPWORDS.items():
    for w in words:
        LOOKUP.setdefault(w, []).append(lang)

NAMES = {"en": "English", "hu": "Magyar", "fr": "Français", "de": "Deutsch", "nl": "Nederlands"}


def detect(text: str, default: str = "en") -> str:
    words = re.findall(r"[^\W\d_]+", text[:20000].lower())
    score = Counter()
    for w in words:
        for lang in LOOKUP.get(w, ()):
            score[lang] += 1
    # letters that only one candidate language uses
    score["hu"] += 3 * len(re.findall(r"[őű]", text[:20000].lower()))
    if not score:
        return default
    return score.most_common(1)[0][0]
