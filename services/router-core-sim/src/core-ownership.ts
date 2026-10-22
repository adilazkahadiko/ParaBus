import type { CoreOwnershipSnapshot } from "../../../packages/shared-types/src/index.ts";

export const CORE_OWNERSHIP_MODES = [
  "typescript",
  "rust-shadow",
  "rust-canary",
  "rust-production",
] as const;

export type CoreOwnershipMode = (typeof CORE_OWNERSHIP_MODES)[number];

export interface CoreOwnershipConfiguration {
  snapshot: CoreOwnershipSnapshot;
  discordMetadataShadowEnabled: boolean;
  rustManagementEnabled: boolean;
}

const RUST_OWNERSHIP_BLOCKERS = Object.freeze([
  "Windows Core Audio/WASAPI stream is not connected to production ownership",
  "Discord OPUS and TX PCM ownership remains in TypeScript",
  "ControlCommand and RouterSnapshot production parity is incomplete",
  "physical-device and live Discord long-run acceptance is incomplete",
] as const);

export class CoreOwnershipConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreOwnershipConfigurationError";
  }
}

function isCoreOwnershipMode(value: string): value is CoreOwnershipMode {
  return CORE_OWNERSHIP_MODES.some((mode) => mode === value);
}

export function resolveCoreOwnership(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CoreOwnershipConfiguration {
  const explicit = environment.ROUTER_CORE_OWNERSHIP?.trim();
  const legacyShadowEnabled = environment.DISCORD_RUST_SHADOW === "1";
  const requestedMode = explicit || (legacyShadowEnabled ? "rust-shadow" : "typescript");
  if (!isCoreOwnershipMode(requestedMode)) {
    throw new CoreOwnershipConfigurationError(
      `ROUTER_CORE_OWNERSHIP must be one of: ${CORE_OWNERSHIP_MODES.join(", ")}`,
    );
  }
  if (requestedMode === "rust-canary" || requestedMode === "rust-production") {
    throw new CoreOwnershipConfigurationError(
      `${requestedMode} is blocked until these gates pass: ${RUST_OWNERSHIP_BLOCKERS.join("; ")}`,
    );
  }

  const discordMetadataShadowEnabled = requestedMode === "rust-shadow";
  const rustManagementEnabled = platform === "win32" || discordMetadataShadowEnabled;
  const snapshot: CoreOwnershipSnapshot = {
    requestedMode,
    effectiveOwner: "typescript",
    managementProvider: rustManagementEnabled ? "rust-read-only" : "none",
    configurationSource: explicit
      ? "ownership-flag"
      : legacyShadowEnabled
        ? "legacy-shadow-flag"
        : "default",
    shadowScope: discordMetadataShadowEnabled ? "discord-metadata-program-audio-control-and-wasapi-management" : "none",
    transitionPolicy: "restart-required",
    canaryReady: false,
    productionReady: false,
    blockers: RUST_OWNERSHIP_BLOCKERS,
  };
  return Object.freeze({
    snapshot: Object.freeze(snapshot),
    discordMetadataShadowEnabled,
    rustManagementEnabled,
  });
}
