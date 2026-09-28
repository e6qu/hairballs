// Pure logic: the expense policy and what to print. No AWS, no I/O.
import type { Category, Cents, CityClass, Claim, Verdict } from "./domain.ts";

const LIMITS_CENTS: Readonly<Record<Category, Readonly<Record<CityClass, Cents>>>> = {
  hotel: { major: 18_000 as Cents, standard: 12_000 as Cents },
  meals: { major: 6_000 as Cents, standard: 6_000 as Cents },
};

export function checkClaim(claim: Claim): Verdict {
  const limit = LIMITS_CENTS[claim.category][claim.city];
  if (claim.amount <= limit) return { kind: "within", limit };
  return { kind: "over", limit, excess: (claim.amount - limit) as Cents };
}

function eur(amount: Cents): string {
  return `${(amount / 100).toFixed(2)} EUR`;
}

export function render(claim: Claim, verdict: Verdict): string {
  const what = `${eur(claim.amount)} ${claim.category} (${claim.city})`;
  switch (verdict.kind) {
    case "within":
      return `${what}: within policy (limit ${eur(verdict.limit)})`;
    case "over":
      return `${what}: ${eur(verdict.excess)} over the limit of ${eur(verdict.limit)}`;
  }
}
