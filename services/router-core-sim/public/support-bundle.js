/** Shared by both desktop diagnostic screens; never changes audio/TX state. */
export function mountSupportBundle(root, fetchRequest = fetch, localSettingsAvailable = true) {
  const create = root.querySelector("[data-support-create]");
  const open = root.querySelector("[data-support-open]");
  const days = root.querySelector("[data-support-days]");
  const status = root.querySelector("[data-support-status]");
  if (!localSettingsAvailable) {
    create.disabled = true; open.disabled = true; days.disabled = true;
    status.textContent = "このPCからのみ操作できます";
    return;
  }
  const nonce = document.querySelector('meta[name="dbr-session-nonce"]')?.content ?? "";
  async function post(path, payload = {}) {
    const response = await fetchRequest(path, {
      method: "POST", headers: { "content-type": "application/json", "x-dbr-session-nonce": nonce }, body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Support Bundleの操作に失敗しました");
    return result;
  }
  create.addEventListener("click", async () => {
    create.disabled = true;
    days.disabled = true;
    status.textContent = "Support Bundleを作成中です。音声処理は継続します。";
    try {
      const result = await post("/api/support-bundle", { days: Number(days.value) });
      status.textContent = `作成しました: ${result.path}（このZIPのみを共有してください）`;
    } catch (error) { status.textContent = error.message; }
    finally { create.disabled = false; days.disabled = false; }
  });
  open.addEventListener("click", async () => {
    open.disabled = true;
    try { await post("/api/support-bundle/open-directory"); }
    catch (error) { status.textContent = `${error.message}。出力先: settingsRoot/support/`; }
    finally { open.disabled = false; }
  });
}
