/**
 * Outbound JSON text in the same form as Python's `json.dumps(..., separators=(",", ":"))`:
 * compact, ASCII-only (`ensure_ascii`), optionally with sorted keys. Shell-only.
 */

export type DumpOptions = { readonly sortKeys?: boolean };

function asciiString(text: string): string {
  // JSON.stringify escapes quotes, backslashes and control characters; Python additionally escapes
  // everything outside printable ASCII as \uXXXX (lower-case hex, surrogate pairs for astral chars).
  return JSON.stringify(text).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function dumpNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return JSON.stringify(value);
}

function dump(value: unknown, sortKeys: boolean, inArray: boolean): string | undefined {
  switch (typeof value) {
    case "string":
      return asciiString(value);
    case "number":
      return dumpNumber(value);
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
    case "function":
    case "symbol":
      return inArray ? "null" : undefined;
    case "object": {
      if (value === null) return "null";
      if (value instanceof Date) return asciiString(value.toISOString());
      if (Array.isArray(value)) {
        return `[${value.map((item: unknown) => dump(item, sortKeys, true)).join(",")}]`;
      }
      const record = value as Readonly<Record<string, unknown>>;
      const keys = Object.keys(record);
      if (sortKeys) keys.sort();
      const parts: string[] = [];
      for (const key of keys) {
        const text = dump(record[key], sortKeys, false);
        if (text !== undefined) parts.push(`${asciiString(key)}:${text}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return undefined;
  }
}

export function dumps(value: unknown, options: DumpOptions = {}): string {
  return dump(value, options.sortKeys ?? false, true) ?? "null";
}
