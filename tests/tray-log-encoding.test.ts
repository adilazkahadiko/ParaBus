import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

const tray = readFileSync(new URL("../scripts/router-tray.ps1", import.meta.url), "utf8");
const helper = tray.match(/function Add-RouterLog \{[\s\S]*?\r?\n\}/)![0];

test("all tray log appends explicitly use BOM-free UTF-8 instead of edition-dependent Add-Content", () => {
  assert.doesNotMatch(tray, /\bAdd-Content\b/i);
  assert.match(helper, /\[System\.IO\.File\]::AppendAllText\(\$script:LogPath,.*New-Object System\.Text\.UTF8Encoding \$false/);
  assert.match(tray, /Add-RouterLog \(\$checkOutput \+ \$errorTask\.Result\)/);
  assert.match(tray, /Add-RouterLog .*\$\(\$_\.Exception\.Message\)/);
});

const windows = process.platform === "win32";
const pwshCandidate = windows && existsSync(join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell/7/pwsh.exe"))
  ? join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell/7/pwsh.exe") : "pwsh.exe";
const pwshAvailable = windows && spawnSync(pwshCandidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true }).stdout?.trim() === "7";
for (const [name, executable, available, version] of [
  ["Windows PowerShell 5.1", "powershell.exe", windows, /^5\.1\./],
  ["PowerShell 7", pwshCandidate, pwshAvailable, /^7\./],
] as const) {
  test(`${name} appends Japanese check output and exceptions as exact UTF-8 bytes without BOM`, { skip: !available }, t => {
    const root = mkdtempSync(join(tmpdir(), "parabus-tray-utf8-"));
    t.after(() => {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      rmSync(root, { recursive: true, force: true });
    });
    const messages = ["日本語のチェック出力：音声部品をブロックしました。", "例外：ファイルを読み込めません。"];
    for (const existing of [false, true]) {
      const path = join(root, existing ? "existing.log" : "new.log");
      const prefix = existing ? "Nodeの既存UTF-8出力\n" : "";
      if (existing) writeFileSync(path, prefix, "utf8");
      const commands = messages.map(text => `Add-RouterLog ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}')))`);
      const command = `${helper}\n$script:LogPath = '${path.replaceAll("'", "''")}'; ${commands.join("; ")}; [Console]::Write($PSVersionTable.PSVersion.ToString())`;
      const result = spawnSync(executable, ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, version);
      const bytes = readFileSync(path);
      assert.deepEqual(bytes, Buffer.from(prefix + messages.map(text => text + "\r\n").join(""), "utf8"));
      assert.equal(bytes.indexOf(Buffer.from([0xef, 0xbb, 0xbf])), -1);
    }
  });
}
