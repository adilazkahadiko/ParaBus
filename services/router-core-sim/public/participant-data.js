export const PARTICIPANT_DELETE_CONFIRMATION = "元に戻せません。録音ファイル、トレイのログ、バックアップ、ほかのPCにあるコピーは削除されません。";

/** Local settings only. Participant strings are always text, never HTML. */
export function mountParticipantData(root, fetchRequest = fetch, local = true, confirmRequest = message => confirm(message)) {
  if (!root) return { refresh: async () => false };
  const search = root.querySelector("[data-participant-search]"), list = root.querySelector("[data-participant-list]");
  const refreshButton = root.querySelector("[data-participant-refresh]"), purge = root.querySelector("[data-participant-purge]");
  const status = root.querySelector("[data-participant-status]");
  const document = root.ownerDocument;
  const nonce = document.querySelector('meta[name="dbr-session-nonce"]')?.content ?? "";
  let rows = [], busy = false;
  async function post(operation, body = {}) {
    const response = await fetchRequest(`/api/participant-data/${operation}`, {
      method: "POST", headers: { "content-type": "application/json", "x-dbr-session-nonce": nonce }, body: JSON.stringify(body), cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "参加者データの操作に失敗しました");
    return result;
  }
  function render() {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = rows.filter(row => row.discordUserId.includes(query) || row.displayName.toLocaleLowerCase().includes(query));
    list.replaceChildren(...visible.map(row => {
      const item = document.createElement("li"), label = document.createElement("span"), button = document.createElement("button");
      const updated = row.updatedAt && Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toLocaleString() : "不明（シーン内のみ）";
      label.textContent = `${row.displayName} / Discord ID: ${row.discordUserId} / 最終更新: ${updated}`;
      button.type = "button"; button.className = "danger-action"; button.textContent = "この参加者のデータを削除"; button.disabled = busy || !local;
      button.addEventListener("click", () => {
        if (busy || !local || !confirmRequest(`${row.displayName}\nDiscord ID: ${row.discordUserId}\n\n${PARTICIPANT_DELETE_CONFIRMATION}`)) return;
        void remove("delete", { discordUserId: row.discordUserId, confirmed: true });
      });
      item.append(label, button); return item;
    }));
    refreshButton.disabled = busy || !local; purge.disabled = busy || !local; search.disabled = !local;
  }
  async function refresh() {
    if (!local || busy) return false;
    busy = true; render();
    try {
      const result = await post("list");
      if (!Array.isArray(result.participants) || result.participants.some(row => !row || !/^\d{17,20}$/.test(row.discordUserId) || typeof row.displayName !== "string")) throw new Error("参加者一覧を読み込めませんでした");
      rows = result.participants; return true;
    } catch (error) { status.textContent = error.message; return false; }
    finally { busy = false; render(); }
  }
  async function remove(operation, body) {
    busy = true; render(); status.textContent = "削除内容を保存しています…";
    try {
      const result = await post(operation, body);
      busy = false;
      const refreshed = await refresh();
      status.textContent = result.message + (refreshed ? "" : "。一覧を再読み込みしてください。");
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; render(); }
  }
  search.addEventListener("input", render);
  refreshButton.addEventListener("click", () => { void refresh(); });
  purge.addEventListener("click", () => {
    if (busy || !local || !confirmRequest(`全員分の運用ログと診断ZIPをすべて削除します。\n\n${PARTICIPANT_DELETE_CONFIRMATION}`)) return;
    void remove("delete-diagnostics", { confirmed: true });
  });
  if (!local) status.textContent = "このPCからのみ操作できます";
  render(); void refresh();
  return { refresh };
}
