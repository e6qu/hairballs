"""Boundary parsing helpers: turn untyped outside data (``object``) into primitives, with a path.

These helpers are the only place where untyped data is inspected. Domain parsers
(``X.parse`` / ``parse_x``) build on them and return domain types; nothing past the
boundary ever sees ``object`` again.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation


class ParseError(ValueError):
    """Raised when outside data cannot be parsed into a domain type."""

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


def expect_mapping(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(path, f"expected an object, got {type(raw).__name__}")
    for key in raw:
        if not isinstance(key, str):
            raise ParseError(path, "object keys must be strings")
    return raw


def expect_sequence(raw: object, path: str) -> Sequence[object]:
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        raise ParseError(path, f"expected an array, got {type(raw).__name__}")
    return raw


def field(fields: Mapping[str, object], name: str, path: str) -> object:
    if name not in fields:
        raise ParseError(f"{path}.{name}", "is required")
    return fields[name]


def expect_str(raw: object, path: str) -> str:
    if not isinstance(raw, str):
        raise ParseError(path, f"expected a string, got {type(raw).__name__}")
    return raw


def expect_non_empty_str(raw: object, path: str, *, max_length: int | None = None) -> str:
    value = expect_str(raw, path).strip()
    if not value:
        raise ParseError(path, "must not be empty")
    if max_length is not None and len(value) > max_length:
        raise ParseError(path, f"must be at most {max_length} characters")
    return value


def expect_int(raw: object, path: str, *, minimum: int | None = None) -> int:
    # bool is a subclass of int; a JSON ``true`` is never a count.
    if isinstance(raw, bool) or not isinstance(raw, int):
        if isinstance(raw, str) and raw.strip().lstrip("-").isdigit():
            raw = int(raw.strip())
        else:
            raise ParseError(path, f"expected an integer, got {type(raw).__name__}")
    if minimum is not None and raw < minimum:
        raise ParseError(path, f"must be >= {minimum}")
    return raw


def expect_decimal(raw: object, path: str, *, minimum: Decimal | None = None) -> Decimal:
    if isinstance(raw, bool):
        raise ParseError(path, "expected a number, got bool")
    if isinstance(raw, float):
        # Floats are converted through their shortest repr, never through binary expansion.
        raw = repr(raw)
    if not isinstance(raw, (int, str, Decimal)):
        raise ParseError(path, f"expected a number, got {type(raw).__name__}")
    try:
        value = Decimal(str(raw).strip())
    except InvalidOperation as exc:
        raise ParseError(path, "is not a valid decimal number") from exc
    if not value.is_finite():
        raise ParseError(path, "must be finite")
    if minimum is not None and value < minimum:
        raise ParseError(path, f"must be >= {minimum}")
    return value


def expect_bool(raw: object, path: str) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.strip().lower() in {"true", "false", "1", "0"}:
        return raw.strip().lower() in {"true", "1"}
    raise ParseError(path, f"expected a boolean, got {type(raw).__name__}")
