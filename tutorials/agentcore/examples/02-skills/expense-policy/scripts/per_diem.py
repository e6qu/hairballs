"""Compute the maximum trip allowance under the Fintech Ltd expense policy."""

import argparse

HOTEL_CAP_EUR = {"major": 180, "standard": 120}
MEALS_PER_DAY_EUR = 60


def allowance(days: int, city_class: str) -> dict[str, int]:
    nights = max(days - 1, 0)
    hotel = nights * HOTEL_CAP_EUR[city_class]
    meals = days * MEALS_PER_DAY_EUR
    return {"nights": nights, "hotel_eur": hotel, "meals_eur": meals, "total_eur": hotel + meals}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, required=True)
    parser.add_argument("--city-class", choices=sorted(HOTEL_CAP_EUR), required=True)
    args = parser.parse_args()
    result = allowance(args.days, args.city_class)
    print(
        f"{args.days} days, {result['nights']} nights ({args.city_class}): "
        f"hotel {result['hotel_eur']} EUR + meals {result['meals_eur']} EUR "
        f"= {result['total_eur']} EUR"
    )


if __name__ == "__main__":
    main()
