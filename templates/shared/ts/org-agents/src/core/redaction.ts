/** Redaction of sensitive values in text before it is persisted, logged or sent onward (pure). */

export type Finding = "card_number" | "iban" | "email" | "aws_access_key" | "bearer_token";

export type Redacted = {
  readonly text: string;
  readonly findings: ReadonlyMap<Finding, number>;
  /** True when at least one value was redacted. */
  readonly changed: boolean;
};

function luhnOk(digits: string): boolean {
  let total = 0;
  const reversed = [...digits].reverse();
  for (const [i, ch] of reversed.entries()) {
    let d = Number(ch);
    if (i % 2 === 1) d = d > 4 ? d * 2 - 9 : d * 2;
    total += d;
  }
  return total % 10 === 0;
}

function ibanOk(candidate: string): boolean {
  const s = candidate.replaceAll(" ", "").toUpperCase();
  const rearranged = s.slice(4) + s.slice(0, 4);
  // mod-97 over the base-36 expansion, computed piecewise to stay within safe integers.
  let remainder = 0;
  for (const ch of rearranged) {
    const value = Number.parseInt(ch, 36);
    if (Number.isNaN(value)) return false;
    for (const digit of String(value)) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

type Rule = { readonly finding: Finding; readonly pattern: RegExp; readonly check: (match: string) => boolean };

const ALWAYS = (): boolean => true;

// Order matters: tokens and keys first, so their substrings are not reported as something else.
const RULES: readonly Rule[] = [
  {
    finding: "bearer_token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    check: ALWAYS,
  },
  { finding: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, check: ALWAYS },
  { finding: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, check: ALWAYS },
  {
    finding: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    check: ibanOk,
  },
  {
    finding: "card_number",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (match) => luhnOk(match.replace(/[ -]/g, "")),
  },
];

export function redact(text: string): Redacted {
  const counts = new Map<Finding, number>();
  let out = text;
  for (const { finding, pattern, check } of RULES) {
    out = out.replace(pattern, (match) => {
      if (!check(match)) return match;
      counts.set(finding, (counts.get(finding) ?? 0) + 1);
      return `[REDACTED:${finding}]`;
    });
  }
  return { text: out, findings: counts, changed: counts.size > 0 };
}
