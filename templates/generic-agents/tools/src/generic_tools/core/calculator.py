"""Safe decimal arithmetic (pure): a tokenizer and recursive-descent parser. No ``eval``."""

from __future__ import annotations

from decimal import Decimal, DivisionByZero, InvalidOperation, localcontext

from generic_tools.domain import Calculated, CalculationError, CalculationOutcome, Expression

_MAX_DEPTH = 32


class _Syntax(Exception):
    pass


def _tokens(text: str) -> list[str]:
    tokens: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in " \t":
            i += 1
        elif ch in "+-*/()":
            tokens.append(ch)
            i += 1
        else:
            j = i
            while j < len(text) and (text[j].isdigit() or text[j] == "."):
                j += 1
            if j == i or text[i:j].count(".") > 1:
                raise _Syntax(f"bad number near position {i}")
            tokens.append(text[i:j])
            i = j
    return tokens


class _Parser:
    def __init__(self, tokens: list[str]) -> None:
        self._tokens = tokens
        self._pos = 0

    def _peek(self) -> str | None:
        return self._tokens[self._pos] if self._pos < len(self._tokens) else None

    def _take(self) -> str:
        token = self._peek()
        if token is None:
            raise _Syntax("unexpected end of expression")
        self._pos += 1
        return token

    def parse(self) -> Decimal:
        value = self._expr(0)
        if self._peek() is not None:
            raise _Syntax(f"unexpected {self._peek()!r}")
        return value

    def _expr(self, depth: int) -> Decimal:
        value = self._term(depth)
        while self._peek() in ("+", "-"):
            op = self._take()
            rhs = self._term(depth)
            value = value + rhs if op == "+" else value - rhs
        return value

    def _term(self, depth: int) -> Decimal:
        value = self._factor(depth)
        while self._peek() in ("*", "/"):
            op = self._take()
            rhs = self._factor(depth)
            value = value * rhs if op == "*" else value / rhs
        return value

    def _factor(self, depth: int) -> Decimal:
        if depth > _MAX_DEPTH:
            raise _Syntax("expression nested too deeply")
        token = self._take()
        if token == "-":
            return -self._factor(depth + 1)
        if token == "+":
            return self._factor(depth + 1)
        if token == "(":
            value = self._expr(depth + 1)
            if self._take() != ")":
                raise _Syntax("missing ')'")
            return value
        if token in "*/)":
            raise _Syntax(f"unexpected {token!r}")
        return Decimal(token)


def calculate(expression: Expression) -> CalculationOutcome:
    try:
        with localcontext() as ctx:
            ctx.prec = 28
            ctx.traps[DivisionByZero] = True
            value = _Parser(_tokens(expression.text)).parse()
    except _Syntax as exc:
        return CalculationError(str(exc))
    except (DivisionByZero, InvalidOperation):
        return CalculationError("division by zero or invalid operation")
    # Integers keep exponent 0 (540, never 5.4E+2); fractions drop trailing zeros (0.30 -> 0.3).
    return Calculated(value.to_integral_value() if value == value.to_integral_value() else value.normalize())
