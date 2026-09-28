"""Compute the maximum trip allowance under the Fintech Ltd expense policy.

One file, because it runs inside the agent's VM: domain types, a pure core, and a small shell (main).
Usage: python3 per_diem.py --days 4 --city-class major
"""

from __future__ import annotations

import argparse
import enum
import sys
from dataclasses import dataclass

# --- domain: types that can only hold valid values ---------------------------------------------


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


class CityClass(enum.Enum):
    MAJOR = "major"  # London, Paris, New York
    STANDARD = "standard"

    @classmethod
    def parse(cls, raw: str) -> CityClass:
        try:
            return cls(raw)
        except ValueError as exc:
            raise ParseError(f"city class must be major or standard, not {raw!r}") from exc


@dataclass(frozen=True, slots=True)
class Days:
    """Trip length in days: 1 to 90."""

    count: int

    @classmethod
    def parse(cls, raw: str) -> Days:
        if not raw.isdigit() or not 1 <= int(raw) <= 90:
            raise ParseError(f"days must be a whole number from 1 to 90, not {raw!r}")
        return cls(int(raw))


@dataclass(frozen=True, slots=True)
class Allowance:
    """Whole euros; money is never a float."""

    nights: int
    hotel_eur: int
    meals_eur: int

    @property
    def total_eur(self) -> int:
        return self.hotel_eur + self.meals_eur


# --- core: the policy, as pure functions -------------------------------------------------------

HOTEL_CAP_EUR = {CityClass.MAJOR: 180, CityClass.STANDARD: 120}
MEALS_PER_DAY_EUR = 60


def allowance(days: Days, city: CityClass) -> Allowance:
    nights = days.count - 1
    return Allowance(nights, nights * HOTEL_CAP_EUR[city], days.count * MEALS_PER_DAY_EUR)


def render(days: Days, city: CityClass, a: Allowance) -> str:
    return (
        f"{days.count} days, {a.nights} nights ({city.value}): "
        f"hotel {a.hotel_eur} EUR + meals {a.meals_eur} EUR = {a.total_eur} EUR"
    )


# --- shell: parse the arguments, call the core, print -----------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Maximum trip allowance.")
    parser.add_argument("--days", required=True)
    parser.add_argument("--city-class", required=True)
    args = parser.parse_args(argv)
    try:
        days, city = Days.parse(args.days), CityClass.parse(args.city_class)
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(render(days, city, allowance(days, city)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
