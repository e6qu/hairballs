---
name: expense-policy
description: Fintech Ltd expense rules (hotels, meals, taxis, claim deadlines) and how to compute a trip allowance. Use for any question about what can be expensed or how much.
---

# Expense policy

## Limits

- Hotels: up to 180 EUR per night in major cities (London, Paris, New York), 120 EUR elsewhere.
- Meals: up to 60 EUR per day, receipts required.
- Taxis: allowed to and from airports and stations, and after 21:00. Otherwise use public transport.
- Claims must be submitted within 30 days of the trip, with itemised receipts.

## Trip allowance

Do not add the numbers yourself. Run the script and quote its output:

```bash
python3 scripts/per_diem.py --days 4 --city-class major
```

`--city-class` is `major` or `standard`. Nights are days minus one.
