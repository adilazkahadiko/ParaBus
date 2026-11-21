import { parseEnv } from "node:util";
import { PROTECTED_TOKEN_PREFIX, type TokenProtection } from "../../discord-adapter/src/token-protection.ts";

/** Replace only token values, including shadowed duplicate assignments. Preserve comments,
 * other lines, quotes, ordering and CRLF/LF bytes. No plaintext staging file is created. */
export async function encryptEnvironmentTokens(text: string, protection: TokenProtection): Promise<{ text: string; failed: boolean; changed: boolean }> {
  const pattern = /^([\t ]*(?:export[\t ]+)?(DISCORD_BOT_TOKEN(?:_[A-Z0-9_]+)?)[\t ]*=[\t ]*)("[^"]*"|'[^']*'|[^\r\n#]*?)([\t ]*(?:#[^\r\n]*)?)(?=\r?$)/gm;
  const entries = [...text.matchAll(pattern)].flatMap(match => {
    const value = parseEnv(match[0])[match[2]];
    return value && !value.startsWith(PROTECTED_TOKEN_PREFIX) ? [{ match, value }] : [];
  });
  if (!entries.length) return { text, failed: false, changed: false };
  let encrypted: (string | null)[];
  try { encrypted = await protection.protect(entries.map(entry => entry.value)); }
  catch { encrypted = entries.map(() => null); }
  let result = text, failed = false, changed = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const value = encrypted[index], { match } = entries[index];
    if (!value) { failed = true; continue; }
    const quote = /^["']/.test(match[3]) ? match[3][0] : "";
    const replacement = match[1] + quote + value + quote + match[4];
    result = result.slice(0, match.index!) + replacement + result.slice(match.index! + match[0].length);
    changed ||= value !== entries[index].value;
  }
  return { text: result, failed, changed };
}
