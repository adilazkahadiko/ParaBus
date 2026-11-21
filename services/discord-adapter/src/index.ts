import { DiscordBotRack } from "./bot-rack.ts";
import { DiscordIpcClient } from "./ipc-client.ts";
import { readLauncherTokenInput, watchLauncher } from "../../../packages/process-lifecycle/src/index.ts";
import { loadBotRackEnvironment, loadBotRackProfiles } from "./bot-config.ts";

const ignoredUserIds = new Set(
  (process.env.DISCORD_TX_BOT_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
);
const ipc = new DiscordIpcClient();
const inheritedTokens = await readLauncherTokenInput();
const settingsEnvironment = { ...process.env, ...inheritedTokens };
const rack = new DiscordBotRack(ipc, ignoredUserIds, { loadProfiles: () => loadBotRackProfiles(loadBotRackEnvironment(settingsEnvironment)) });
ipc.onFrame((frame) => rack.ingest(frame));
let stopping = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  await rack.close();
  ipc.close();
  process.exit(exitCode);
}

ipc.start();
console.log("Discord Bot Rack: 未接続で待機中。SETUPからBotを接続してください。");

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGHUP", () => void shutdown(0));
watchLauncher(() => void shutdown(0));
