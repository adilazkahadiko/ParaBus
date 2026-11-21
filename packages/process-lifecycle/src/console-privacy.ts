/** Console output reaches the persistent tray log. Keep only four digits of
 * Discord snowflakes; do not match a substring of a longer numeric identifier. */
export function maskDiscordIds(value: string): string {
  return value.replace(/(?<!\d)\d{17,20}(?!\d)/g, id => `…${id.slice(-4)}`);
}
