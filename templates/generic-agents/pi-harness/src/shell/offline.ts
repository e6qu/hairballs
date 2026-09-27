/**
 * pi supply-chain switches (shell). Imported first by app.ts, before any pi module runs.
 *
 * - PI_OFFLINE=1: no package auto-install at startup, no git/npm refresh of configured packages
 *   (core/package-manager.js `isOfflineModeEnabled`), no model-catalog network refresh
 *   (core/model-runtime.js: network is enabled only when PI_OFFLINE is unset).
 * - PI_SKIP_VERSION_CHECK=1: no npm version check (utils/version-check.js).
 * - PI_TELEMETRY=0: no install telemetry (core/telemetry.js).
 *
 * These are forced, not defaulted: they are controls, not preferences. The Dockerfile sets them too.
 */

export const PI_OFFLINE_ENV: Readonly<Record<string, string>> = {
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};

export function enforceOffline(env: Record<string, string | undefined>): void {
  Object.assign(env, PI_OFFLINE_ENV);
}

enforceOffline(process.env);
