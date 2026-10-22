import assert from "node:assert/strict";
import test from "node:test";
import {
  CoreOwnershipConfigurationError,
  resolveCoreOwnership,
} from "../services/router-core-sim/src/core-ownership.ts";

test("Core ownership defaults to the TypeScript production reference", () => {
  const configuration = resolveCoreOwnership({}, "linux");
  assert.equal(configuration.snapshot.requestedMode, "typescript");
  assert.equal(configuration.snapshot.effectiveOwner, "typescript");
  assert.equal(configuration.snapshot.managementProvider, "none");
  assert.equal(configuration.snapshot.configurationSource, "default");
  assert.equal(configuration.snapshot.shadowScope, "none");
  assert.equal(configuration.discordMetadataShadowEnabled, false);
  assert.equal(configuration.rustManagementEnabled, false);
  assert.equal(configuration.snapshot.transitionPolicy, "restart-required");
});

test("Windows TypeScript production enables only the read-only Rust management provider", () => {
  const configuration = resolveCoreOwnership({}, "win32");
  assert.equal(configuration.snapshot.requestedMode, "typescript");
  assert.equal(configuration.snapshot.effectiveOwner, "typescript");
  assert.equal(configuration.snapshot.managementProvider, "rust-read-only");
  assert.equal(configuration.snapshot.shadowScope, "none");
  assert.equal(configuration.discordMetadataShadowEnabled, false);
  assert.equal(configuration.rustManagementEnabled, true);
});

test("Rust shadow enables metadata, Program Audio, and WASAPI management without changing production ownership", () => {
  const configuration = resolveCoreOwnership({ ROUTER_CORE_OWNERSHIP: "rust-shadow" });
  assert.equal(configuration.snapshot.requestedMode, "rust-shadow");
  assert.equal(configuration.snapshot.effectiveOwner, "typescript");
  assert.equal(configuration.snapshot.managementProvider, "rust-read-only");
  assert.equal(configuration.snapshot.shadowScope, "discord-metadata-program-audio-control-and-wasapi-management");
  assert.equal(configuration.discordMetadataShadowEnabled, true);
  assert.equal(configuration.rustManagementEnabled, true);
  assert.equal(configuration.snapshot.canaryReady, false);
  assert.equal(configuration.snapshot.productionReady, false);
});

test("The explicit ownership flag takes precedence over the legacy shadow flag", () => {
  const configuration = resolveCoreOwnership({
    ROUTER_CORE_OWNERSHIP: "typescript",
    DISCORD_RUST_SHADOW: "1",
  });
  assert.equal(configuration.snapshot.requestedMode, "typescript");
  assert.equal(configuration.snapshot.configurationSource, "ownership-flag");
  assert.equal(configuration.discordMetadataShadowEnabled, false);
});

test("The legacy shadow flag remains backward compatible when ownership is unset", () => {
  const configuration = resolveCoreOwnership({ DISCORD_RUST_SHADOW: "1" });
  assert.equal(configuration.snapshot.requestedMode, "rust-shadow");
  assert.equal(configuration.snapshot.configurationSource, "legacy-shadow-flag");
  assert.equal(configuration.discordMetadataShadowEnabled, true);
});

test("Unknown ownership values are rejected without echoing their value", () => {
  const invalidValue = "token-shaped-secret-value";
  assert.throws(
    () => resolveCoreOwnership({ ROUTER_CORE_OWNERSHIP: invalidValue }),
    (error: unknown) => error instanceof CoreOwnershipConfigurationError
      && !error.message.includes(invalidValue)
      && error.message.includes("must be one of"),
  );
});

for (const mode of ["rust-canary", "rust-production"] as const) {
  test(`${mode} fails closed while production gates are incomplete`, () => {
    assert.throws(
      () => resolveCoreOwnership({ ROUTER_CORE_OWNERSHIP: mode }),
      (error: unknown) => error instanceof CoreOwnershipConfigurationError
        && error.message.includes(`${mode} is blocked`)
        && error.message.includes("Core Audio")
        && error.message.includes("Discord"),
    );
  });
}
