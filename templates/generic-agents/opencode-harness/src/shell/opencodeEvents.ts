/**
 * Parsing opencode server output (SSE events and message lists) into domain values (boundary).
 *
 * Verified against opencode 1.18.31 (`packages/opencode/src/session/processor.ts`,
 * `session/session.ts` `getUsage`, `permission/index.ts`): event JSON is
 * `{"id", "type", "properties": {...}}`. Only the events the adapter acts on are parsed; every
 * other event becomes `{kind: "other"}`. The wire format is not typed: it is `unknown` until parsed.
 */

import {
  attempt,
  expectArray,
  expectObject,
  expectString,
  field,
  fieldOr,
  must,
  type Parsed,
  TokenCount,
  type UnknownRecord,
  Usage,
} from "@org/agents";

import { OcMessageId, OcSessionId, PermissionRequestId } from "../domain.ts";

export type PermissionAsked = {
  readonly kind: "permission_asked";
  readonly session: OcSessionId;
  readonly request: PermissionRequestId;
  readonly permission: string;
};

/** An assistant message (= one model call in opencode's loop) was created or updated. */
export type AssistantMessageUpdated = {
  readonly kind: "assistant_message";
  readonly session: OcSessionId;
  readonly message: OcMessageId;
  /** Usage is final once the message is completed. */
  readonly completed: boolean;
  readonly usage: Usage;
};

export type SessionIdle = { readonly kind: "session_idle"; readonly session: OcSessionId };
export type SessionError = { readonly kind: "session_error"; readonly session: OcSessionId; readonly error: string };
export type OtherEvent = { readonly kind: "other" };

export type OcEvent = PermissionAsked | AssistantMessageUpdated | SessionIdle | SessionError | OtherEvent;

const OTHER: OtherEvent = { kind: "other" };

/**
 * opencode token counts → org `Usage`. opencode reports `input` without cached tokens, `output`
 * without reasoning tokens, and cache read/write separately; the org guard prices all of them.
 */
export function parseTokens(raw: unknown, path: string): Parsed<Usage> {
  return attempt(() => {
    const tokens = must(expectObject(raw, path));
    const cache = must(expectObject(fieldOr(tokens, "cache", {}), `${path}.cache`));
    const count = (fields: UnknownRecord, name: string, at: string): TokenCount =>
      must(TokenCount.parse(fieldOr(fields, name, 0), `${at}.${name}`));
    const output = count(tokens, "output", path);
    const reasoning = count(tokens, "reasoning", path);
    return Usage.of(
      count(tokens, "input", path),
      TokenCount.add(output, reasoning),
      count(cache, "read", `${path}.cache`),
      count(cache, "write", `${path}.cache`),
    );
  });
}

function errorText(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return String(raw);
  const record = raw as UnknownRecord;
  const data = record["data"];
  const message =
    typeof data === "object" && data !== null ? (data as UnknownRecord)["message"] : record["message"];
  const name = typeof record["name"] === "string" ? record["name"] : "Error";
  return typeof message === "string" && message.length > 0 ? `${name}: ${message}` : name;
}

/** True for the error opencode records when a session is aborted (not a model/provider failure). */
export function isAbortError(error: string): boolean {
  return error.startsWith("MessageAbortedError") || error.startsWith("AbortError");
}

export function parseEvent(raw: unknown): Parsed<OcEvent> {
  return attempt((): OcEvent => {
    const event = must(expectObject(raw, "$"));
    const type = must(expectString(must(field(event, "type", "$")), "$.type"));
    const props = must(expectObject(fieldOr(event, "properties", {}), "$.properties"));
    switch (type) {
      case "permission.asked":
        return {
          kind: "permission_asked",
          session: must(OcSessionId.parse(must(field(props, "sessionID", "$.properties")), "$.properties.sessionID")),
          request: must(PermissionRequestId.parse(must(field(props, "id", "$.properties")), "$.properties.id")),
          permission: must(expectString(must(field(props, "permission", "$.properties")), "$.properties.permission")),
        };
      case "message.updated": {
        const info = must(expectObject(must(field(props, "info", "$.properties")), "$.properties.info"));
        if (fieldOr(info, "role", "") !== "assistant") return OTHER;
        const time = must(expectObject(fieldOr(info, "time", {}), "$.properties.info.time"));
        return {
          kind: "assistant_message",
          session: must(OcSessionId.parse(must(field(info, "sessionID", "$.properties.info")), "$.properties.info.sessionID")),
          message: must(OcMessageId.parse(must(field(info, "id", "$.properties.info")), "$.properties.info.id")),
          completed: fieldOr(time, "completed", null) !== null,
          usage: must(parseTokens(fieldOr(info, "tokens", {}), "$.properties.info.tokens")),
        };
      }
      case "session.idle":
        return {
          kind: "session_idle",
          session: must(OcSessionId.parse(must(field(props, "sessionID", "$.properties")), "$.properties.sessionID")),
        };
      case "session.error": {
        const session = fieldOr(props, "sessionID", null);
        if (session === null) return OTHER; // global errors (e.g. plugin load) are logged by the host
        return {
          kind: "session_error",
          session: must(OcSessionId.parse(session, "$.properties.sessionID")),
          error: errorText(fieldOr(props, "error", "unknown error")),
        };
      }
      default:
        return OTHER;
    }
  });
}

// ---------------------------------------------------------------- messages (GET /session/:id/message)

export type AssistantMessage = {
  readonly id: OcMessageId;
  readonly completed: boolean;
  readonly usage: Usage;
  /** Concatenated text parts (what the model said to the user). */
  readonly text: string;
  readonly error: string | null;
};

export function parseAssistantMessages(raw: unknown): Parsed<readonly AssistantMessage[]> {
  return attempt(() => {
    const items = must(expectArray(raw, "$"));
    const out: AssistantMessage[] = [];
    for (const [i, item] of items.entries()) {
      const path = `$[${i}]`;
      const entry = must(expectObject(item, path));
      const info = must(expectObject(must(field(entry, "info", path)), `${path}.info`));
      if (fieldOr(info, "role", "") !== "assistant") continue;
      const parts = must(expectArray(fieldOr(entry, "parts", []), `${path}.parts`));
      const texts: string[] = [];
      for (const [j, part] of parts.entries()) {
        const p = must(expectObject(part, `${path}.parts[${j}]`));
        if (p["type"] === "text" && typeof p["text"] === "string" && p["synthetic"] !== true) texts.push(p["text"]);
      }
      const time = must(expectObject(fieldOr(info, "time", {}), `${path}.info.time`));
      const error = fieldOr(info, "error", null);
      out.push({
        id: must(OcMessageId.parse(must(field(info, "id", `${path}.info`)), `${path}.info.id`)),
        completed: fieldOr(time, "completed", null) !== null,
        usage: must(parseTokens(fieldOr(info, "tokens", {}), `${path}.info.tokens`)),
        text: texts.join("").trim(),
        error: error === null ? null : errorText(error),
      });
    }
    return out;
  });
}
