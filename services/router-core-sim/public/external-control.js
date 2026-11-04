/** Local desktop management only; Bearer credentials never enter desktop state or storage. */
export function mountExternalControl(localSettingsAvailable, fetchRequest = fetch) {
  const $ = id => document.getElementById(id);
  if (!localSettingsAvailable) return;
  const nonce = document.querySelector('meta[name="dbr-session-nonce"]')?.content ?? "";
  const dialog = $("external-control-token-dialog"), tokenNode = $("external-control-token");
  let tokenTimer, busy = false, devicesSignature = "";
  const clearToken = () => { clearTimeout(tokenTimer); tokenNode.textContent = ""; if (dialog.open) dialog.close(); };
  dialog.addEventListener("close", clearToken);
  $("external-control-token-close").addEventListener("click", clearToken);
  window.addEventListener("pagehide", clearToken);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearToken(); });
  async function post(payload) {
    const response = await fetchRequest("/api/external-control", { method: "POST", cache: "no-store",
      headers: { "content-type": "application/json", "x-dbr-session-nonce": nonce }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error("操作できません。SETUPと接続状態を確認してください。");
    return result.data;
  }
  async function refresh() {
    const state = await post({ action: "status" });
    $("external-control-status").textContent = `外部操作: ${state.enabled ? "有効" : "無効"} / 接続中 ${state.activeDeviceCount} 台${state.activeDeviceNames.length ? ` (${state.activeDeviceNames.join("、")})` : ""}`;
    $("external-control-url").textContent = `${state.url}${state.available ? "" : " — 利用不可（ポートの競合・登録ファイルを確認）"}${state.port !== state.activePort ? ` / 再起動後のポート: ${state.port}` : ""}`;
    const setup = state.state === "SETUP";
    $("external-control-enable").disabled = !setup || state.enabled || !state.available;
    for (const form of [$("external-control-register"), $("external-control-port-form")]) for (const input of form.elements) input.disabled = !setup;
    if (document.activeElement !== $("external-control-port")) $("external-control-port").value = state.port;
    const signature = JSON.stringify([setup, state.devices]);
    if (signature === devicesSignature) return;
    devicesSignature = signature;
    const list = $("external-control-devices"); list.replaceChildren();
    for (const device of state.devices) {
      const row = document.createElement("li"), name = document.createElement("span");
      name.textContent = `${device.name}（${device.revoked ? "取り消し済み" : "登録済み"}） `; row.append(name);
      if (!device.revoked) {
        const label = document.createElement("label"), readNames = document.createElement("input");
        readNames.type = "checkbox"; readNames.checked = device.readDisplayNames; readNames.disabled = !setup;
        label.append(readNames, document.createTextNode("表示名の読み取り")); row.append(label);
        readNames.addEventListener("change", () => operate({ action: "permissions", deviceId: device.deviceId, readDisplayNames: readNames.checked }));
        for (const [action, title] of [["reissue", "再発行"], ["revoke", "取り消し"]]) {
          const button = document.createElement("button"); button.type = "button"; button.textContent = title; button.disabled = !setup;
          button.addEventListener("click", () => operate({ action, deviceId: device.deviceId })); row.append(button);
        }
      }
      list.append(row);
    }
  }
  async function operate(payload) {
    if (busy && payload.action !== "stop") return; busy = true; clearToken();
    try {
      const result = await post(payload);
      if (result.token) { tokenNode.textContent = result.token; dialog.showModal(); tokenTimer = setTimeout(clearToken, 60000); }
      if (payload.action === "register") $("external-control-name").value = "";
      $("external-control-message").textContent = "保存しました"; await refresh();
    } catch (error) { $("external-control-message").textContent = error.message; }
    finally { busy = false; }
  }
  $("external-control-stop").addEventListener("click", () => operate({ action: "stop" }));
  $("external-control-enable").addEventListener("click", () => operate({ action: "enable" }));
  $("external-control-register").addEventListener("submit", event => { event.preventDefault(); void operate({ action: "register", name: $("external-control-name").value, readDisplayNames: $("external-control-names").checked }); });
  $("external-control-port-form").addEventListener("submit", event => { event.preventDefault(); void operate({ action: "port", port: Number($("external-control-port").value) }); });
  const poll = async () => {
    try { if (!busy && !document.hidden) await refresh(); }
    catch { $("external-control-status").textContent = "外部操作: 接続を確認してください"; }
    setTimeout(poll, 2000);
  };
  void poll();
}
