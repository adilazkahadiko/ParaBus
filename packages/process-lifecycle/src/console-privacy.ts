/** Console output reaches the persistent tray log. Keep only four digits of
 * Discord snowflakes; do not match a substring of a longer numeric identifier. */
export function maskDiscordIds(value: string): string {
  return value.replace(/(?<!\d)\d{17,20}(?!\d)/g, id => `…${id.slice(-4)}`);
}

/** Never stringify an exception or access its message/stack, including getters. */
export function consoleErrorKind(error: unknown): { name: string; code: string } {
  const field = (key: "name" | "code"): string => {
    try {
      if (typeof error !== "object" || error === null) return "unknown";
      const value: unknown = (error as Record<string, unknown>)[key];
      const text = key === "code" && typeof value === "number" && Number.isSafeInteger(value)
        ? String(value) : value;
      return typeof text === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : "unknown";
    } catch { return "unknown"; }
  };
  return { name: field("name"), code: field("code") };
}

/** The summary must be authored locally, never taken from an exception. */
export function consoleErrorSummary(summary: string, error: unknown): string {
  const kind = consoleErrorKind(error);
  return maskDiscordIds(`${summary} name=${kind.name} code=${kind.code}`);
}
