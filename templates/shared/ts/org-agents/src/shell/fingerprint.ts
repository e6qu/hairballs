/** Fingerprints of raw tool arguments (shell: the only place raw arguments are serialized). */

import { createHash } from "node:crypto";

import { Fingerprint } from "../domain.ts";
import { dumps } from "./json.ts";

/** Canonical JSON of raw arguments: sorted keys, compact separators, ASCII-only. */
export function canonicalJson(rawArguments: unknown): string {
  return dumps(rawArguments, { sortKeys: true });
}

/** Hash raw tool arguments canonically, so the same call always yields the same fingerprint. */
export function fingerprintArguments(rawArguments: unknown): Fingerprint {
  const digest = createHash("sha256").update(canonicalJson(rawArguments), "utf8").digest("hex");
  return Fingerprint.of(digest);
}
