function txInputReady(snapshot, stem) {
  if (snapshot.input?.state !== "READY" || !snapshot.input?.selectedDeviceId?.startsWith("pa:")) return false;
  const exists = id => id && snapshot.channels?.some(channel => channel.id === id && channel.kind === "LocalMonoInput");
  return exists(stem.sourceInputChannelId) && (stem.audioMode !== "STEREO" || exists(stem.sourceInputRightChannelId));
}

export function createTxMixControls(root, send, controls) {
  const list = root.querySelector(".tx-mix-list"), stopAll = root.querySelector(".tx-stop-all");
  const strips = new Map();
  let current = null, connected = false;
  stopAll.addEventListener("click", () => { if (connected) send({ type: "CLEAR_ALL" }); });
  return (snapshot, configured = [], isConnected = true) => {
    current = snapshot; connected = isConnected;
    const stems = snapshot.discord?.txStems ?? [];
    const rows = [...stems, ...configured.filter(bot => bot.enabled && ["TX", "DUPLEX"].includes(bot.role) && !stems.some(stem => stem.profileId === bot.id))
      .map(bot => ({ profileId: bot.id, label: bot.label, state: "NOT_READY", active: false, offline: true }))];
    const ids = new Set(rows.map(row => row.profileId));
    for (const [id, refs] of strips) if (!ids.has(id)) {
      controls.forgetFader(`tx:${id}`); refs.node.remove(); strips.delete(id);
    }
    root.hidden = rows.length === 0;
    stopAll.disabled = !connected || !stems.some(stem => stem.active);
    for (const row of rows) {
      const id = row.profileId;
      let refs = strips.get(id);
      if (!refs) {
        const node = document.createElement("section"); node.className = "vc-master-strip tx-mix-strip";
        node.innerHTML = `<header><strong class="vc-master-label"></strong><small class="vc-master-scope"></small></header>
          <div class="vc-master-meter" aria-label="TX送信Peak"><span></span></div>
          <input class="vc-master-fader" type="range" min="0" max="1000" step="1" value="780">
          <label class="level-number"><input type="number" min="-90" max="12" step="0.1" value="0.0"><span>dB</span></label>
          <button class="tx-send-toggle channel-toggle" type="button" aria-pressed="false">送信OFF</button>`;
        refs = { node, label: node.querySelector("strong"), scope: node.querySelector("small"), meter: node.querySelector(".vc-master-meter span"),
          fader: node.querySelector('[type="range"]'), number: node.querySelector('[type="number"]'), toggle: node.querySelector("button") };
        const toggle = refs.toggle;
        toggle.addEventListener("click", () => {
          if (!connected || toggle.disabled) return;
          const live = current.discord?.txStems?.find(stem => stem.profileId === id);
          if (live) controls.operate(id, !live.active);
        });
        controls.bindFader(refs.fader, refs.number, () => `tx:${id}`, db => ({ type: "SET_TX_MASTER", profileId: id, db }));
        strips.set(id, refs); list.append(node);
      }
      const name = row.label ?? id;
      refs.label.textContent = name; refs.label.title = name;
      refs.scope.textContent = row.offline ? "未接続" : `${row.audioMode ?? "MONO"} · ${row.state}`;
      refs.scope.title = `${row.voiceChannelName ?? row.voiceChannelId ?? "未接続"} · ${row.sourceInputChannelId ?? "入力未割当"}`;
      refs.fader.setAttribute("aria-label", `${name} TX音量`); refs.number.setAttribute("aria-label", `${name} TX音量 dB`);
      refs.fader.disabled = refs.number.disabled = !connected || row.offline || snapshot.state === "FAULT";
      controls.syncFader(`tx:${id}`, refs.fader, refs.number, row.masterDb ?? 0);
      refs.toggle.textContent = row.active ? "送信ON" : "送信OFF";
      refs.toggle.classList.toggle("on", Boolean(row.active)); refs.toggle.classList.toggle("off", !row.active);
      refs.toggle.setAttribute("aria-pressed", String(Boolean(row.active)));
      refs.toggle.setAttribute("aria-label", `${name} ${row.active ? "送信を停止" : "送信を開始"}`);
      refs.toggle.disabled = !connected || (!row.active && (row.offline || row.state !== "READY" || snapshot.state === "FAULT" || snapshot.emergencyMuted || !txInputReady(snapshot, row)));
      const peak = row.active && connected ? row.peak ?? 0 : 0;
      const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      refs.meter.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
      refs.meter.parentElement.title = `TX Peak ${Number.isFinite(db) ? db.toFixed(1) : "−∞"} dBFS`;
      refs.meter.parentElement.classList.toggle("clipping", peak >= 0.999);
    }
  };
}
