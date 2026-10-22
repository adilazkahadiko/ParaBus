import assert from "node:assert/strict";
import test from "node:test";
import { DAVESession } from "@discordjs/voice";
import { installDaveWrongEpochRecovery } from "../services/discord-adapter/src/bot-connection.ts";

test("DAVE WrongEpoch proposal recovers instead of terminating the Adapter", () => {
  installDaveWrongEpochRecovery();
  const recovered: number[] = [];
  const context = {
    session: {
      processProposals() {
        throw new Error("Failed to process proposals: MessageProcessingFailed(ValidationError(WrongEpoch))");
      },
    },
    lastTransitionId: 7,
    recoverFromInvalidTransition(transitionId: number) {
      recovered.push(transitionId);
    },
  } as unknown as DAVESession;

  const result = DAVESession.prototype.processProposals.call(context, Buffer.from([0]), new Set());

  assert.equal(result, undefined);
  assert.deepEqual(recovered, [7]);
});

test("DAVE proposal errors other than WrongEpoch still fail closed", () => {
  const context = {
    session: {
      processProposals() {
        throw new Error("unexpected DAVE failure");
      },
    },
  } as unknown as DAVESession;

  assert.throws(
    () => DAVESession.prototype.processProposals.call(context, Buffer.from([0]), new Set()),
    /unexpected DAVE failure/,
  );
});
