/**
 * Access to the copies of `@earendil-works/pi-ai` (TypeBox `Type`, faux provider, credential
 * store) and `@smithy/credential-provider-imds` that pi itself uses.
 *
 * `@earendil-works/pi-coding-agent` ships an `npm-shrinkwrap.json`, so npm installs its whole
 * dependency tree *nested* under `node_modules/@earendil-works/pi-coding-agent/node_modules`.
 * Declaring pi-ai / TypeBox as our own dependencies would install a second copy (+83 packages)
 * and split module state (provider registries, TypeBox kinds). Instead we import pi's copy by
 * path, falling back to the bare specifier if a future install hoists it. Types come from the
 * same files through `paths` in tsconfig.json.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type * as PiAiModule from "@earendil-works/pi-ai";
import type * as ImdsModule from "@smithy/credential-provider-imds";

const PI_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent"); // .../pi-coding-agent/dist/index.js

async function importNested<T>(pathFromPiDist: string, bareSpecifier: string): Promise<T> {
  const nested = new URL(pathFromPiDist, PI_ENTRY);
  const target = existsSync(fileURLToPath(nested)) ? nested.href : bareSpecifier;
  return (await import(target)) as T;
}

export type PiAi = typeof PiAiModule;

export const piAi: PiAi = await importNested<PiAi>(
  "../node_modules/@earendil-works/pi-ai/dist/index.js",
  "@earendil-works/pi-ai",
);

/** Loaded on demand: only the AgentCore credential refresher needs it. */
export function loadImds(): Promise<typeof ImdsModule> {
  return importNested<typeof ImdsModule>(
    "../node_modules/@smithy/credential-provider-imds/dist-cjs/index.js",
    "@smithy/credential-provider-imds",
  );
}
