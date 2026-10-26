export type NativeFailureClassification = "APP_CONTROL_BLOCKED" | "NATIVE_LOAD_FAILED";

/** WinError.h ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION = 4551 (0x11c7).
 * Node's dlopen error often exposes only ERR_DLOPEN_FAILED and localized text. */
export function classifyNativeFailure(error: unknown, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") {
    const errors: unknown[] = [error];
    const seen = new Set<unknown>();
    for (let i = 0; i < errors.length && i < 8; i++) {
      const item = errors[i];
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      const value = item as Record<string, unknown>;
      for (const key of ["code", "errno", "win32Code", "win32Error", "nativeErrorCode", "hresult"]) {
        const code = value[key];
        if (code === "ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION" ||
            ((typeof code === "number" || (typeof code === "string" && /^(?:-?\d+|0x[0-9a-f]+)$/i.test(code))) &&
              Number.isInteger(Number(code)) && Number(code) >= -0x80000000 && Number(code) <= 0xffffffff &&
              [4551, 0x800711c7].includes(Number(code) >>> 0))) {
          return { classification: "APP_CONTROL_BLOCKED" as const, classificationSource: "WINDOWS_ERROR_CODE" as const };
        }
      }
      if (value.cause) errors.push(value.cause);
    }
    for (const item of [error, ...seen]) {
      const message = item instanceof Error ? item.message : typeof item === "string" ? item
        : item && typeof item === "object" && typeof (item as Record<string, unknown>).message === "string" ? String((item as Record<string, unknown>).message) : "";
      if (/An Application Control policy has blocked this file\./i.test(message) ||
          /アプリケーション制御ポリシーによってこのファイルがブロックされました。/.test(message)) {
        return { classification: "APP_CONTROL_BLOCKED" as const, classificationSource: "MESSAGE" as const };
      }
    }
  }
  return { classification: "NATIVE_LOAD_FAILED" as const, classificationSource: null };
}

export function nativeCheckGuidance(classification: NativeFailureClassification | null): string | null {
  if (classification === null) return null;
  if (classification === "APP_CONTROL_BLOCKED") return "Windowsのアプリ制御が音声部品をブロックしました。再導入では解決しません。「ログを開く」で詳細を確認してください。OSの保護設定は変更しないでください。";
  return "音声部品を読み込めません。ZIP版は配布元のZIPを新しいフォルダーへすべて展開したか確認してください。ソース版はdocs/SOURCE_RELEASE.mdを参照してください。詳細はログを確認してください。";
}
