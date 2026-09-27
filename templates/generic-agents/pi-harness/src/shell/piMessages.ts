/**
 * Parsing pi's agent messages (harness boundary) into domain values.
 *
 * pi's message objects are treated as untyped data here: only the fields that drive decisions
 * (role, usage, stopReason, text, errorMessage) are read, each through a parser.
 */

import {
  attempt,
  expectArray,
  expectObject,
  expectString,
  field,
  fieldOr,
  must,
  ok,
  type Parsed,
  TokenCount,
  Usage,
} from "@org/agents";

import type { FinalMessage } from "../core/domain.ts";

function roleOf(raw: unknown, path: string): Parsed<string> {
  return attempt(() => must(expectString(must(field(must(expectObject(raw, path)), "role", path)), `${path}.role`)));
}

/**
 * Usage of one assistant message: pi's `{input, output, cacheRead, cacheWrite}` token counts.
 * Returns `null` for non-assistant messages (user, toolResult, system).
 */
export function parseAssistantUsage(raw: unknown, path = "$.message"): Parsed<Usage | null> {
  return attempt(() => {
    if (must(roleOf(raw, path)) !== "assistant") return null;
    const message = must(expectObject(raw, path));
    const usage = must(expectObject(must(field(message, "usage", path)), `${path}.usage`));
    const count = (name: string): TokenCount =>
      must(TokenCount.parse(fieldOr(usage, name, 0), `${path}.usage.${name}`));
    return Usage.of(count("input"), count("output"), count("cacheRead"), count("cacheWrite"));
  });
}

function textOf(message: Readonly<Record<string, unknown>>, path: string): string {
  const content = must(expectArray(fieldOr(message, "content", []), `${path}.content`));
  const parts: string[] = [];
  for (const [i, item] of content.entries()) {
    const block = must(expectObject(item, `${path}.content[${i}]`));
    if (block["type"] === "text") parts.push(must(expectString(block["text"], `${path}.content[${i}].text`)));
  }
  return parts.join("").trim();
}

/** The last assistant message among `messages` (the ones a run added), or null if there is none. */
export function parseFinalMessage(messages: readonly unknown[], path = "$.messages"): Parsed<FinalMessage | null> {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const at = `${path}[${i}]`;
    const role = roleOf(messages[i], at);
    if (role.kind === "err") return role;
    if (role.value !== "assistant") continue;
    return attempt((): FinalMessage => {
      const message = must(expectObject(messages[i], at));
      const stopReason = must(expectString(fieldOr(message, "stopReason", "stop"), `${at}.stopReason`));
      switch (stopReason) {
        case "error":
          return {
            kind: "error",
            message: must(expectString(fieldOr(message, "errorMessage", "model error"), `${at}.errorMessage`)),
          };
        case "aborted":
          return { kind: "aborted", text: textOf(message, at) };
        default:
          return { kind: "text", text: textOf(message, at) };
      }
    });
  }
  return ok(null);
}

/** Usage of the model call(s) that produced a compaction summary (`compactionEntry.usage`), if any. */
export function parseCompactionUsage(raw: unknown, path = "$.compactionEntry"): Parsed<Usage | null> {
  return attempt(() => {
    const entry = must(expectObject(raw, path));
    const usage = fieldOr(entry, "usage", null);
    if (usage === null) return null;
    const fields = must(expectObject(usage, `${path}.usage`));
    const count = (name: string): TokenCount => must(TokenCount.parse(fieldOr(fields, name, 0), `${path}.usage.${name}`));
    return Usage.of(count("input"), count("output"), count("cacheRead"), count("cacheWrite"));
  });
}
