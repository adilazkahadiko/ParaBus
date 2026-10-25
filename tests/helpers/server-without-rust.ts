import { mock } from "node:test";

// General HTTP/startup tests do not exercise the Rust management integration.
// Keep the real Windows process and Named Pipe behavior, but inject disabled ownership.
// PortAudio initialization enumerates real drivers and can block on host hardware.
// HTTP/auth tests use the built-in simulator devices and must not open real streams.
try {
  mock.module("naudiodon2", {
    cache: true,
    defaultExport: {
      SampleFormatFloat32: 1,
      getDevices: () => [],
      getHostAPIs: () => [],
      AudioIO: class { constructor() { throw new Error("Real audio streams are disabled in HTTP/startup tests"); } },
    },
  });
} catch (error) {
  if (!["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
}

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
