import { mock } from "node:test";

// General HTTP/startup tests do not exercise the Rust management integration.
// Keep the real Windows process and Named Pipe behavior, but inject disabled ownership.
mock.module("../../services/router-core-sim/src/core-ownership.ts", {
  namedExports: {
    resolveCoreOwnership: () => ({
      snapshot: {
        requestedMode: "typescript",
        effectiveOwner: "typescript",
        managementProvider: "none",
        configurationSource: "default",
        shadowScope: "none",
        transitionPolicy: "restart-required",
        canaryReady: false,
        productionReady: false,
        blockers: [],
      },
      discordMetadataShadowEnabled: false,
      rustManagementEnabled: false,
    }),
  },
});

await import("../../services/router-core-sim/src/server.ts");
