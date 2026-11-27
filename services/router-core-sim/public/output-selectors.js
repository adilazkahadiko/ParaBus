/** Stable controls: meter ticks only update values/classes, never rebuild buttons. */
export function createOutputSelectorControls(root, sendCommand, { conflicts = () => [], notice = () => {}, confirmAction = message => confirm(message) } = {}) {
  const panels = root.querySelector('[data-selector-panels]');
  const form = root.querySelector('form');
  const select = form.elements.selectorId;
  const members = form.querySelector('[data-selector-members]');
  const views = new Map();
  let current, connected = false, signature = '', formSignature = '', timer, heldButton, suppressClick = false;
  const selectors = () => current?.buses.filter(bus => bus.selector) ?? [];
  function cancelHold() { clearTimeout(timer); timer = undefined; heldButton = undefined; }
  function operate(selectorId, busId, extended = false) {
    if (!connected) return;
    const bus = selectors().find(bus => bus.id === selectorId);
    if (!bus?.selector.sourceBusIds.includes(busId)) return;
    const state = bus.selector;
    sendCommand({ type: 'SELECT_OUTPUT_SELECTOR', selectorId, busId,
      operation: state.mode === 'ADDITIVE' ? 'TOGGLE' : extended ? state.selectedBusIds.includes(busId) ? 'REMOVE' : 'ADD' : 'SWITCH' });
  }
  panels.addEventListener('pointerdown', event => {
    const button = event.target.closest('[data-source]');
    if (!button || button.disabled || event.button !== 0) return;
    cancelHold(); heldButton = button; suppressClick = false;
    timer = setTimeout(() => {
      suppressClick = true;
      operate(button.dataset.selector, button.dataset.source, true);
      timer = undefined;
    }, 500);
  });
  panels.addEventListener('pointerup', cancelHold);
  panels.addEventListener('pointercancel', () => { suppressClick = true; cancelHold(); });
  panels.addEventListener('pointerout', event => { if (heldButton && !heldButton.contains(event.relatedTarget)) { suppressClick = true; cancelHold(); } });
  globalThis.addEventListener?.('blur', cancelHold);
  panels.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !connected) return;
    if (button.dataset.source) {
      if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
      cancelHold(); operate(button.dataset.selector, button.dataset.source, event.shiftKey);
    } else if (button.dataset.off) sendCommand({ type: 'OUTPUT_SELECTOR_OFF', selectorId: button.dataset.off });
    else if (button.dataset.mute) {
      const bus = selectors().find(bus => bus.id === button.dataset.mute);
      if (bus) sendCommand({ type: 'SET_BUS_MUTE', busId: bus.id, mute: !bus.mute });
    } else if (button.dataset.limiter && current.state === 'SETUP') {
      const bus = selectors().find(bus => bus.id === button.dataset.limiter);
      if (bus) sendCommand({ type: 'SET_LIMITER', busId: bus.id, enabled: !bus.limiterEnabled });
    }
  });
  panels.addEventListener('input', event => {
    if (event.target.dataset.master && connected) sendCommand({ type: 'SET_BUS_MASTER', busId: event.target.dataset.master, db: Number(event.target.value) });
  });
  function populateForm() {
    const buses = current.buses.filter(bus => !bus.selector && !Array.isArray(bus.groupSourceIds));
    const bus = selectors().find(bus => bus.id === select.value);
    const state = bus?.selector;
    const next = JSON.stringify([select.value, buses.map(bus => [bus.id, bus.label]), bus?.label, state?.mode, state?.fadeMs, state?.sourceBusIds, bus?.physicalOutputs]);
    if (formSignature !== next) {
      formSignature = next;
      form.elements.name.value = bus?.label ?? '';
      form.elements.mode.value = state?.mode ?? 'SWITCH';
      form.elements.fadeMs.value = state?.fadeMs ?? 300;
      form.elements.output.value = (bus?.physicalOutputs[0]?.output ?? 0) + 1;
      form.elements.outputMode.value = bus?.physicalOutputs.length === 2 ? 'DUAL_MONO' : 'MONO';
      members.replaceChildren(...buses.map(source => {
        const label = document.createElement('label'), box = document.createElement('input');
        box.type = 'checkbox'; box.name = 'sourceBusId'; box.value = source.id;
        box.checked = state?.sourceBusIds.includes(source.id) ?? false;
        label.append(box, document.createTextNode(source.label)); return label;
      }));
    }
    for (const input of form.querySelectorAll('input, select, button')) input.disabled = !connected || current.state !== 'SETUP';
    form.querySelector('[data-selector-remove]').disabled ||= !bus;
    form.querySelector('[type=submit]').disabled ||= !bus && selectors().length >= 8;
  }
  select.addEventListener('change', populateForm);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!connected || current?.state !== 'SETUP') return;
    const name = form.elements.name.value.trim();
    if (!name) return notice('名前を入力してください', true);
    const output = Number(form.elements.output.value) - 1, outputMode = form.elements.outputMode.value;
    const collisions = conflicts(current, output, outputMode, { busIds: select.value ? [select.value] : [] });
    const allowCollision = collisions.length > 0;
    if (allowCollision && !confirmAction(`出力chが重複します: ${collisions.join(' / ')}\n音声が加算されます。この割り当てを適用しますか？`)) return;
    sendCommand({ type: select.value ? 'UPDATE_OUTPUT_SELECTOR' : 'CREATE_OUTPUT_SELECTOR', ...(select.value ? { selectorId: select.value } : {}),
      name, output, outputMode, mode: form.elements.mode.value, fadeMs: Number(form.elements.fadeMs.value),
      sourceBusIds: [...members.querySelectorAll('input:checked')].map(box => box.value), allowCollision, confirmed: allowCollision });
  });
  form.querySelector('[data-selector-remove]').addEventListener('click', () => {
    if (connected && current?.state === 'SETUP' && select.value && confirmAction('セレクターを削除しますか？元のVC Busは残ります。')) sendCommand({ type: 'REMOVE_OUTPUT_SELECTOR', selectorId: select.value, confirmed: true });
  });
  return function render(snapshot, isConnected = true) {
    current = snapshot; connected = isConnected;
    if (!connected) cancelHold();
    const buses = selectors(), byId = new Map(snapshot.buses.map(bus => [bus.id, bus]));
    const next = JSON.stringify(buses.map(bus => [bus.id, bus.label, bus.selector.sourceBusIds.map(id => [id, byId.get(id)?.label])]));
    if (signature !== next) {
      signature = next; cancelHold(); views.clear();
      const selectedId = select.value;
      select.replaceChildren(new Option('新規作成', ''), ...buses.map(bus => new Option(bus.label, bus.id)));
      select.value = buses.some(bus => bus.id === selectedId) ? selectedId : '';
      panels.replaceChildren(...buses.map(bus => {
        const panel = document.createElement('article'); panel.className = 'output-selector-panel';
        const title = document.createElement('h4'); title.textContent = bus.label;
        const status = document.createElement('p'), teams = document.createElement('div'); teams.className = 'output-selector-teams';
        const buttons = new Map(bus.selector.sourceBusIds.map(id => {
          const button = document.createElement('button'); button.type = 'button';
          button.dataset.source = id; button.dataset.selector = bus.id;
          button.textContent = byId.get(id)?.label ?? 'VC Bus';
          button.title = 'クリックで選択。0.5秒長押し、またはShift+クリック／Shift+Enterで追加・外す';
          teams.append(button); return [id, button];
        }));
        const off = document.createElement('button'); off.type = 'button'; off.textContent = 'OFF'; off.dataset.off = bus.id;
        const masterLabel = document.createElement('label'); masterLabel.textContent = 'MASTER ';
        const master = document.createElement('input'); master.type = 'range'; master.min = -90; master.max = 12; master.step = .5; master.dataset.master = bus.id;
        const db = document.createElement('output'); masterLabel.append(master, db);
        const meter = document.createElement('meter'); meter.min = 0; meter.max = 1; meter.setAttribute('aria-label', `${bus.label} 出力レベル`);
        const mute = document.createElement('button'); mute.type = 'button'; mute.textContent = 'MUTE'; mute.dataset.mute = bus.id;
        const limiter = document.createElement('button'); limiter.type = 'button'; limiter.dataset.limiter = bus.id;
        const reduction = document.createElement('span');
        panel.append(title, status, teams, off, masterLabel, meter, mute, limiter, reduction);
        views.set(bus.id, { panel, status, buttons, master, db, meter, off, mute, limiter, reduction });
        return panel;
      }));
    }
    for (const bus of buses) {
      const view = views.get(bus.id), state = bus.selector, selected = new Set(state.selectedBusIds);
      const output = bus.physicalOutputs.map(binding => binding.output + 1).join('/');
      view.status.textContent = `OUT ${output || '未割当'} · ${state.mode === 'SWITCH' ? '切り替え型' : '足し算型'} · ${state.fadeMs} ms · ${selected.size ? `${selected.size}チーム${selected.size > 1 ? '（追加あり）' : ''}` : 'OFF'}${snapshot.emergencyMuted ? ' · 緊急ミュート中' : ''}`;
      for (const [id, button] of view.buttons) {
        const additional = state.mode === 'SWITCH' && selected.has(id) && id !== state.primaryBusId;
        button.setAttribute('aria-pressed', String(selected.has(id)));
        button.setAttribute('aria-label', `${byId.get(id)?.label ?? 'VC Bus'}${additional ? '（追加）' : ''}`);
        button.classList.toggle('selected', selected.has(id));
        button.classList.toggle('additional', additional);
        button.disabled = !connected;
      }
      if (document.activeElement !== view.master) view.master.value = bus.masterDb;
      view.db.textContent = `${bus.masterDb.toFixed(1)} dB`;
      view.meter.value = Math.min(1, Math.max(0, bus.meter.peak));
      view.reduction.textContent = ` GR ${bus.limiterGainReductionDb.toFixed(1)} dB`;
      view.mute.setAttribute('aria-pressed', String(bus.mute));
      view.limiter.textContent = `LIMITER ${bus.limiterEnabled ? 'ON' : 'OFF'}`;
      view.limiter.setAttribute('aria-pressed', String(bus.limiterEnabled));
      view.limiter.disabled = !connected || snapshot.state !== 'SETUP';
      view.off.disabled = view.master.disabled = view.mute.disabled = !connected;
    }
    populateForm();
  };
}
