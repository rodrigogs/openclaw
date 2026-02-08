import type { PluginLogger } from "openclaw/plugin-sdk";

// Numeric severity: lower = more severe
const LEVEL_MAP: Record<string, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type PluginLogLevel = "silent" | "error" | "warn" | "info" | "debug";

export function createPluginLogger(
  base: PluginLogger,
  level?: PluginLogLevel,
): Required<PluginLogger> {
  const minLevel = LEVEL_MAP[level ?? "debug"]; // default: pass everything through
  const noop = () => {};
  return {
    error: minLevel >= 0 ? base.error : noop,
    warn: minLevel >= 1 ? base.warn : noop,
    info: minLevel >= 2 ? base.info : noop,
    debug: minLevel >= 3 ? (base.debug ?? noop) : noop,
  };
}
