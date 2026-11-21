import { spawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

export const PROTECTED_TOKEN_PREFIX = "dpapi:v1:";
export const TOKEN_PROTECTION_WARNING = "Bot Tokenを暗号化できなかったため、暗号化せずに保存しました。保存先の権限を確認してください。暗号化が利用可能になった後に再起動してください。";
export const TOKEN_REENTRY_MESSAGE = "このPCまたはWindowsアカウントでは保存済みのTokenを読めません。Tokenを入力し直してください。";
const HELPER_ERROR = "Bot Tokenの保護処理に失敗しました";
export type TokenOperation = "protect" | "unprotect";
export interface TokenProtection {
  protect(values: readonly string[]): Promise<(string | null)[]>;
  unprotect(values: readonly string[]): Promise<(string | null)[]>;
}

// This constant contains code only. Request values travel exclusively through stdin.
// API contract: https://learn.microsoft.com/dotnet/api/system.security.cryptography.protecteddata
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -ne 'protect' -and $request.operation -ne 'unprotect') { throw 'Invalid operation' }
  if (@($request.values).Count -gt 256) { throw 'Too many values' }
  $entropy = [Text.Encoding]::UTF8.GetBytes('ParaBus.BotToken.v1')
  $results = @($request.values | ForEach-Object {
    $data = $null; $result = $null
    try {
      if ($_ -isnot [string] -or $_.Length -gt 16384) { throw 'Invalid input' }
      if ($request.operation -eq 'protect') {
        $data = [Text.Encoding]::UTF8.GetBytes($_)
        $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        @{ ok = $true; value = [Convert]::ToBase64String($result) }
      } else {
        $data = [Convert]::FromBase64String($_)
        $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        @{ ok = $true; value = [Text.Encoding]::UTF8.GetString($result) }
      }
    } catch { @{ ok = $false } }
    finally {
      if ($null -ne $data) { [Array]::Clear($data, 0, $data.Length) }
      if ($null -ne $result) { [Array]::Clear($result, 0, $result.Length) }
    }
  })
  [Console]::Out.Write((ConvertTo-Json -InputObject @{ results = $results } -Depth 4 -Compress))
} catch { [Console]::Out.Write('{"error":"TOKEN_PROTECTION_FAILED"}'); exit 1 }
`;

export const tokenHelperArguments = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
export function tokenHelperEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const systemRoot = environment.SystemRoot ?? "C:\\Windows";
  return { SystemRoot: systemRoot, PATH: join(systemRoot, "System32") };
}
export interface TokenHelperRequest { operation: TokenOperation; values: readonly string[] }
export type TokenHelperTransport = (request: TokenHelperRequest) => Promise<unknown>;

/** No child-process Error/stdio/request is ever attached to an escaping exception. */
export async function runTokenHelper(request: TokenHelperRequest, start: typeof spawn = spawn): Promise<unknown> {
  const env = tokenHelperEnvironment();
  const executable = join(env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = start(executable, [...tokenHelperArguments], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] } satisfies SpawnOptions); }
    catch { reject(new Error(HELPER_ERROR)); return; }
    let output = "", completed = false;
    const finish = (ok: boolean, value?: unknown) => {
      if (completed) return;
      completed = true; clearTimeout(timer); output = "";
      if (ok) resolve(value);
      else { try { child.kill(); } catch { /* Fixed error only. */ } reject(new Error(HELPER_ERROR)); }
    };
    const timer = setTimeout(() => finish(false), 15_000);
    child.on("error", () => finish(false));
    child.stdin?.on("error", () => finish(false));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (completed) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 1024 * 1024) finish(false);
    });
    // Drain/discard diagnostics; PowerShell errors can contain the request.
    child.stderr?.resume();
    child.on("close", code => {
      if (completed) return;
      if (code !== 0) { finish(false); return; }
      try { finish(true, JSON.parse(output.replace(/^\uFEFF/, ""))); } catch { finish(false); }
    });
    try { child.stdin?.end(JSON.stringify(request), "utf8"); } catch { finish(false); }
  });
}

export function createTokenProtection(platform: NodeJS.Platform = process.platform, transport: TokenHelperTransport = runTokenHelper): TokenProtection {
  const transform = async (operation: TokenOperation, values: readonly string[]): Promise<(string | null)[]> => {
    if (!values.length) return [];
    if (platform !== "win32") return values.map(value => operation === "protect" || !value.startsWith(PROTECTED_TOKEN_PREFIX) ? value : null);
    try {
      if (values.length > 256 || values.some(value => !value || value.length > 16384)) throw new Error(HELPER_ERROR);
      const requestValues = operation === "protect" ? values : values.map(value => value.slice(PROTECTED_TOKEN_PREFIX.length));
      const response = await transport({ operation, values: requestValues }) as { results?: unknown } | null;
      if (!response || !Array.isArray(response.results) || response.results.length !== values.length) throw new Error(HELPER_ERROR);
      return response.results.map(raw => {
        const result = raw as { ok?: unknown; value?: unknown } | null;
        if (result?.ok !== true || typeof result.value !== "string" || !result.value || result.value.length > 16384) return null;
        if (operation === "protect" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.value)) return null;
        return operation === "protect" ? PROTECTED_TOKEN_PREFIX + result.value : result.value;
      });
    } catch { return values.map(() => null); }
  };
  return { protect: values => transform("protect", values), async unprotect(values) {
    const encrypted = values.filter(value => value.startsWith(PROTECTED_TOKEN_PREFIX));
    const decoded = await transform("unprotect", encrypted);
    let index = 0;
    return values.map(value => value.startsWith(PROTECTED_TOKEN_PREFIX) ? decoded[index++] : value);
  } };
}
export const tokenProtection = createTokenProtection();

export function redactBotTokenError(error: unknown, token: string): string {
  let text = error instanceof Error ? error.message : "Discord接続に失敗しました";
  if (token) text = text.split(token).join("[CREDENTIAL REDACTED]");
  return text.replace(/dpapi:v1:[A-Za-z0-9+/=]+/g, "[CREDENTIAL REDACTED]").replace(/[\r\n\t]/g, " ").slice(0, 240);
}

/** Cache decrypted adapter credentials only; never assign them to any environment. */
export class AdapterTokenCache {
  #cache = new Map<string, string | null>();
  #pending: Promise<void> = Promise.resolve();
  read(values: readonly string[], protection: TokenProtection = tokenProtection): Promise<(string | null)[]> {
    const captured = [...values];
    const result = this.#pending.then(() => this.readLocked(captured, protection));
    this.#pending = result.then(() => {}, () => {});
    return result;
  }
  private async readLocked(values: readonly string[], protection: TokenProtection): Promise<(string | null)[]> {
    const missing = [...new Set(values.filter(value => value.startsWith(PROTECTED_TOKEN_PREFIX) && !this.#cache.has(value)))];
    const decoded = missing.length ? await protection.unprotect(missing) : [];
    missing.forEach((value, index) => { this.#cache.set(value, decoded[index] ?? null); });
    while (this.#cache.size > 128) this.#cache.delete(this.#cache.keys().next().value!);
    return values.map(value => value.startsWith(PROTECTED_TOKEN_PREFIX) ? this.#cache.get(value) ?? null : value);
  }
}
