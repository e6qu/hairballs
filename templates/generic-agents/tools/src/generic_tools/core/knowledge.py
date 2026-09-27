"""Keyword ranking over a small corpus (pure). The offline stand-in for Bedrock Knowledge Bases."""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence
from decimal import Decimal

from generic_tools.domain import Document, HitLimit, KnowledgeHit, KnowledgeQuery

_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset({"the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "what", "how"})


def _terms(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


def _snippet(body: str, terms: set[str]) -> str:
    for line in body.splitlines():
        if terms & set(_terms(line)):
            return line.strip()[:240]
    return body.strip().splitlines()[0][:240] if body.strip() else ""


def search(query: KnowledgeQuery, corpus: Sequence[Document], limit: HitLimit) -> list[KnowledgeHit]:
    """Rank documents with a simple TF-IDF score; deterministic ordering (score, then id)."""
    q_terms = set(_terms(query.text))
    if not q_terms or not corpus:
        return []
    doc_terms = [Counter(_terms(d.title + " " + d.body)) for d in corpus]
    n = len(corpus)
    scored: list[tuple[float, Document]] = []
    for doc, counts in zip(corpus, doc_terms, strict=True):
        score = 0.0
        for term in q_terms:
            tf = counts.get(term, 0)
            if tf:
                df = sum(1 for c in doc_terms if term in c)
                score += (1 + math.log(tf)) * math.log(1 + n / df)
        if score > 0:
            scored.append((score, doc))
    scored.sort(key=lambda pair: (-pair[0], pair[1].id.value))
    return [
        KnowledgeHit(doc.id, doc.title, _snippet(doc.body, q_terms), Decimal(f"{score:.4f}"))
        for score, doc in scored[: limit.value]
    ]
