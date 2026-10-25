import assert from "node:assert/strict";
import { win32 } from "node:path";

export function assertExpectedBuild(build: { buildCommit?: unknown }, expectedCommit: string): void {
  assert.match(expectedCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "Pass the expected full commit SHA");
  assert.equal(build.buildCommit, expectedCommit, "Build does not match the independently supplied expected commit");
}

export function smokeEnvironment(parent: NodeJS.ProcessEnv, settings: { root: string; port: number; base: string; pipe: string; rack: string }): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(parent).filter(([key]) => !/^(DISCORD_|DBR_|ROUTER_|RECORDER_)|^NODE_(OPTIONS|PATH)$/i.test(key)));
  return {
    ...clean, PORT: String(settings.port), OPEN_BROWSER: "0", DBR_SETTINGS_ROOT: settings.root,
    RECORDER_FOLDER: win32.join(settings.root, "recordings"), DBR_OPERATOR_ORIGIN: settings.base, DBR_LAN_ACCESS: "0",
    DISCORD_IPC_ENDPOINT: settings.pipe, DISCORD_BOT_RACK_FILE: settings.rack, ROUTER_CORE_OWNERSHIP: "typescript",
  };
}

export function assertSmokeSnapshot(snapshot: any, expectedCommit: string): void {
  assertExpectedBuild(snapshot.runtimeInfo ?? {}, expectedCommit);
  assert.equal(snapshot.discord?.configuredBots, 0, "API must explicitly confirm zero configured bots");
  assert.equal(snapshot.discord?.readyBots, 0);
}

/** Literal, case-insensitive path checks: brackets and wildcard characters have no special meaning. */
export function smokeProcessQuery(root: string): string {
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const tray = win32.join(root, "scripts", "router-tray.ps1");
  return `$root = ${literal(root)}; $tray = ${literal(tray)}; $p = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.ExecutablePath -is [string] -and $_.ExecutablePath.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) -or ($_.Name -ieq 'powershell.exe' -and $_.CommandLine -is [string] -and $_.CommandLine.IndexOf($tray, [StringComparison]::OrdinalIgnoreCase) -ge 0)) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $p -Compress`;
}
