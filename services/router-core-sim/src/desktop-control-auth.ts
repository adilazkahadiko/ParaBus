import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { networkInterfaces } from "node:os";

export const DESKTOP_NONCE_HEADER = "x-dbr-session-nonce";
export const DESKTOP_NONCE_META = "dbr-session-nonce";

export class DesktopControlAuthError extends Error {}

/** One initial warning, then bounded summaries; never retain request data. */
export class DesktopAuthFailureLog {
  #lastReportAt: number | null = null;
  #suppressed = 0;
  readonly report: (message: string) => void;
  readonly now: () => number;

  constructor(report: (message: string) => void, now = () => performance.now()) {
    this.report = report;
    this.now = now;
  }

  reject(): void {
    if (this.#lastReportAt === null) {
      this.#lastReportAt = this.now();
      this.report("操作画面の認証に失敗したHTTP・WS要求を拒否しました");
      return;
    }
    this.#suppressed = Math.min(Number.MAX_SAFE_INTEGER, this.#suppressed + 1);
    this.flush();
  }

  flush(force = false): void {
    if (!this.#suppressed || this.#lastReportAt === null || (!force && this.now() - this.#lastReportAt < 60_000)) return;
    this.report(`操作画面の認証失敗: 同様の要求${this.#suppressed}件の記録を抑制しました`);
    this.#suppressed = 0;
    this.#lastReportAt = this.now();
  }
}

export function createDesktopSessionNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function resolveOperatorOrigin(bindHost: string, port: number, configured?: string): string {
  const safeHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  const host = safeHost.includes(":") && !safeHost.startsWith("[") ? `[${safeHost}]` : safeHost;
  const candidate = configured?.trim() || `http://${host}:${port}`;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("DBR_OPERATOR_ORIGIN must be one exact HTTP(S) origin");
  }
  return parsed.origin;
}

export function resolveDesktopAccess(port: number, configured: string | undefined, lanEnabled: boolean, interfaces = networkInterfaces()) {
  const origin = resolveOperatorOrigin("127.0.0.1", port, configured);
  if (!lanEnabled) return { host: "127.0.0.1", origin, allowedOrigins: [origin], lanEnabled: false, urls: [] as string[] };
  const urls = [...new Set(Object.values(interfaces).flatMap(entries => (entries ?? [])
    .filter(entry => entry.family === "IPv4" && !entry.internal).map(entry => `http://${entry.address}:${port}`)))];
  return { host: "0.0.0.0", origin, allowedOrigins: [...new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...urls, origin])], lanEnabled: true, urls };
}

export function isLocalDesktopAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function desktopAllowedHosts(port: number, access: ReturnType<typeof resolveDesktopAccess>): ReadonlySet<string> {
  return new Set([
    `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`,
    ...[access.origin, ...(access.lanEnabled ? access.urls : [])].map(url => new URL(url).host),
  ]);
}

export function isDesktopHostAllowed(headers: IncomingHttpHeaders, allowedHosts: ReadonlySet<string>): boolean {
  return typeof headers.host === "string" && allowedHosts.has(headers.host.toLowerCase());
}

export function injectDesktopAccess(html: string, access: { lanEnabled: boolean; urls: string[]; localSettingsAvailable: boolean }): string {
  const value = JSON.stringify(access).replaceAll("<", "\\u003c");
  const script = `<script id="desktop-access" type="application/json">${value}</script>`;
  const placeholder = '<script id="desktop-access" type="application/json">{}</script>';
  return html.includes(placeholder) ? html.replace(placeholder, script) : html.replace("<head>", `<head>\n    ${script}`);
}

export function injectDesktopSessionNonce(html: string, nonce: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error("invalid desktop session nonce");
  return html.replace("<head>", `<head>\n    <meta name="${DESKTOP_NONCE_META}" content="${nonce}" />`);
}

export function assertDesktopControlAuthorized(headers: IncomingHttpHeaders, expectedOrigin: string | readonly string[], expectedNonce: string, suppliedNonce?: string | null): void {
  const origin = headers.origin;
  const headerNonce = headers[DESKTOP_NONCE_HEADER];
  const nonce = suppliedNonce ?? (Array.isArray(headerNonce) ? null : headerNonce);
  const originAllowed = typeof origin === "string" && (typeof expectedOrigin === "string" ? origin === expectedOrigin : expectedOrigin.includes(origin));
  if (!originAllowed || typeof nonce !== "string" || !constantTimeEqual(nonce, expectedNonce)) {
    throw new DesktopControlAuthError("Unauthorized desktop control request");
  }
}

/** Local health checks stay nonce-free. Browser GETs need an equivalent origin proof. */
export function assertDesktopStateAuthorized(headers: IncomingHttpHeaders, remoteAddress: string | undefined, expectedOrigins: readonly string[], expectedNonce: string): void {
  if (isLocalDesktopAddress(remoteAddress)) return;
  let readOrigin = headers.origin;
  // Same-origin browser GETs omit Origin, which scripts cannot set themselves.
  // Referer must prove the allowed page origin and this exact Host. HTTP LAN
  // pages also omit Fetch Metadata; reject contradictory metadata when present.
  // Never override an explicit bad Origin, and always require the nonce header.
  if (headers.origin === undefined && typeof headers.referer === "string"
    && (headers["sec-fetch-site"] === undefined || headers["sec-fetch-site"] === "same-origin")
    && (headers["sec-fetch-mode"] === undefined || ["cors", "same-origin"].includes(String(headers["sec-fetch-mode"])))) {
    try {
      const page = new URL(headers.referer);
      if (!page.username && !page.password && page.host === headers.host?.toLowerCase()) {
        readOrigin = page.origin;
      }
    } catch {
      // Malformed or missing origin proof is rejected by the shared check below.
    }
  }
  assertDesktopControlAuthorized({ ...headers, origin: readOrigin }, expectedOrigins, expectedNonce);
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
