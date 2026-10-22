import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeInfoSnapshot } from "../../../packages/shared-types/src/index.ts";

/** Read release metadata once at startup; runtime never requires Git. */
export function runtimeInfo(projectRoot: string, botConfig: unknown, startedAt = new Date()): RuntimeInfoSnapshot {
  let buildCommit: string | null = null;
  try {
    const metadata = JSON.parse(readFileSync(join(projectRoot, "release-build-info.json"), "utf8"));
    if (metadata.schemaVersion === 1 && typeof metadata.buildCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.buildCommit)) {
      buildCommit = metadata.buildCommit;
    }
  } catch {
    // Development checkouts have no release metadata.
  }
  const entries = Array.isArray(botConfig) ? botConfig : (botConfig as { bots?: unknown } | null)?.bots;
  const enabled = Array.isArray(entries) ? entries.filter((bot) => bot && typeof bot === "object" && bot.enabled !== false) : [];
  const rx = enabled.some((bot) => bot.role !== "TX");
  const tx = enabled.some((bot) => bot.role === "TX" || bot.role === "DUPLEX");
  return { buildCommit, pcRole: rx && tx ? "MIXED" : rx ? "RX" : tx ? "TX" : "UNCONFIGURED", startedAt: startedAt.toISOString() };
}
