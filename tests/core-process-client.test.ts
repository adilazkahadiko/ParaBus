import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoreProcessClient } from "../packages/core-ipc/src/index.ts";

test("Core process spawn failure can be closed without crashing", async () => {
  const client = new CoreProcessClient({
    command: join(tmpdir(), `missing-router-core-${process.pid}-${Date.now()}.exe`),
    requestTimeoutMs: 100,
  });
  await assert.rejects(client.health());
  assert.doesNotThrow(() => client.close());
});
