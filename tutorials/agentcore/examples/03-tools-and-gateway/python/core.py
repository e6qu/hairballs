"""Pure logic: the expense policy and what to print. No AWS, no I/O."""

from __future__ import annotations

from decimal import Decimal

from domain import Category, CityClass, Claim, Eur, OverLimit, Verdict, WithinPolicy

LIMITS_EUR = {
    (Category.HOTEL, CityClass.MAJOR): Eur(Decimal(180)),
    (Category.HOTEL, CityClass.STANDARD): Eur(Decimal(120)),
    (Category.MEALS, CityClass.MAJOR): Eur(Decimal(60)),
    (Category.MEALS, CityClass.STANDARD): Eur(Decimal(60)),
}


def check_claim(claim: Claim) -> Verdict:
    limit = LIMITS_EUR[(claim.category, claim.city)]
    if claim.amount.amount <= limit.amount:
        return WithinPolicy(limit)
    return OverLimit(limit, Eur(claim.amount.amount - limit.amount))


def render(claim: Claim, verdict: Verdict) -> str:
    what = f"{claim.amount.amount} EUR {claim.category.value} ({claim.city.value})"
    match verdict:
        case WithinPolicy(limit=limit):
            return f"{what}: within policy (limit {limit.amount} EUR)"
        case OverLimit(limit=limit, excess=excess):
            return f"{what}: {excess.amount} EUR over the limit of {limit.amount} EUR"
