"""Redaction of sensitive values in text before it is persisted, logged or sent onward (pure)."""

from __future__ import annotations

import enum
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType


class Finding(enum.Enum):
    CARD_NUMBER = "card_number"
    IBAN = "iban"
    EMAIL = "email"
    AWS_ACCESS_KEY = "aws_access_key"
    BEARER_TOKEN = "bearer_token"


@dataclass(frozen=True, slots=True)
class Redacted:
    text: str
    findings: Mapping[Finding, int]

    @property
    def changed(self) -> bool:
        return any(self.findings.values())


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def _iban_ok(candidate: str) -> bool:
    s = candidate.replace(" ", "").upper()
    rearranged = s[4:] + s[:4]
    numeric = "".join(str(int(c, 36)) for c in rearranged)
    return int(numeric) % 97 == 1


_RULES: tuple[tuple[Finding, re.Pattern[str], Callable[[str], bool]], ...] = (
    (
        Finding.BEARER_TOKEN,
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
        lambda _: True,
    ),
    (Finding.AWS_ACCESS_KEY, re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), lambda _: True),
    (Finding.EMAIL, re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), lambda _: True),
    (
        Finding.IBAN,
        re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b"),
        _iban_ok,
    ),
    (
        Finding.CARD_NUMBER,
        re.compile(r"\b(?:\d[ -]?){12,18}\d\b"),
        lambda m: _luhn_ok(re.sub(r"[ -]", "", m)),
    ),
)


def redact(text: str) -> Redacted:
    counts: dict[Finding, int] = {}
    for finding, pattern, check in _RULES:

        def replace(
            match: re.Match[str], finding: Finding = finding, check: Callable[[str], bool] = check
        ) -> str:
            if not check(match.group(0)):
                return match.group(0)
            counts[finding] = counts.get(finding, 0) + 1
            return f"[REDACTED:{finding.value}]"

        text = pattern.sub(replace, text)
    return Redacted(text=text, findings=MappingProxyType(counts))
