/**
 * Locating the opencode binary without install scripts.
 *
 * The `opencode-ai` npm package needs a postinstall script to pick the platform binary, which we
 * never run (`npm ci --ignore-scripts`). Instead the platform packages themselves
 * (`opencode-linux-arm64` for AgentCore, `opencode-linux-x64` for CI/dev) are exact-pinned
 * optional dependencies; npm installs only the one matching the host's os/cpu, and we resolve its
 * `bin/opencode` here. `OPENCODE_BIN` overrides (e.g. a binary from a checksum-verified tarball).
 */

import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { Env } from "@org/agents";

export function opencodeBinary(env: Env): string {
  const override = env["OPENCODE_BIN"];
  const path = override ?? packagedBinary();
  accessSync(path, constants.X_OK);
  return path;
}

function packagedBinary(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (process.platform !== "linux" || arch === null) {
    throw new Error(`no pinned opencode binary for ${process.platform}/${process.arch}; set OPENCODE_BIN`);
  }
  const require = createRequire(import.meta.url);
  const manifest = require.resolve(`opencode-linux-${arch}/package.json`);
  return join(dirname(manifest), "bin", "opencode");
}
