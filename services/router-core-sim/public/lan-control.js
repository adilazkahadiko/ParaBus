/** Local SETUP management. A connection code is never inserted into the DOM,
 * storage, an error, or a log; the user's copy action sends it to the clipboard. */
export function mountLanControl(localSettingsAvailable, fetchRequest = fetch, clipboard = globalThis.navigator?.clipboard) {
  if (!localSettingsAvailable) return;
  const $ = id => document.getElementById(id), nonce = document.querySelector('meta[name="dbr-session-nonce"]')?.content ?? '';
  const form = $('lan-control-form'), list = $('lan-control-devices');
  let busy = false, signature = '', addressSignature = '', hostSignature = '';
  async function post(payload) {
    const response = await fetchRequest('/api/lan-control', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dbr-session-nonce': nonce }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('LAN操作を変更できません。SETUP・アドレス・ポート・保存先の権限を確認してください。');
    return result.data;
  }
  async function operate(payload) {
    if (busy && payload.action !== 'stop') return;
    busy = true;
    try { const result = await post(payload); render(result); $('lan-control-message').textContent = '保存しました'; }
    catch (error) { $('lan-control-message').textContent = error.message; }
    finally { busy = false; }
  }
  async function copyCode(deviceId) {
    if (busy) return; busy = true;
    try {
      let result = await post({ action: 'connection-code', deviceId });
      if (result.requiresReissue) {
        if (!confirm('この機器の鍵を再発行します。古い鍵・接続コードでは接続できなくなります。再発行しますか？')) return;
        result = await post({ action: 'connection-code', deviceId, reissue: true });
      }
      if (!result.connectionCode || !clipboard) throw new Error();
      await clipboard.writeText(result.connectionCode);
      $('lan-control-message').textContent = '接続コードをコピーしました。人に見せない・チャットに貼らないでください。';
    } catch { $('lan-control-message').textContent = '接続コードをコピーできません。SETUP・証明書・ブラウザーのクリップボード権限を確認してください。'; }
    finally { busy = false; }
  }
  function render(state) {
    const setup = state.state === 'SETUP';
    $('lan-control-status').textContent = state.listening ? `TLS 1.3で待ち受け中: ${state.address}:${state.port}` : state.enabled ? 'ON（待ち受け停止中）' : 'OFF';
    $('lan-control-error').textContent = [state.error, state.protectionWarning].filter(Boolean).join(' ');
    $('lan-control-fingerprint').textContent = state.fingerprint ?? '初めてONにしたときに証明書を生成します';
    const badge = $('lan-control-badge'); badge.hidden = !state.enabled;
    badge.textContent = state.listening ? `別PC操作: LAN待ち受け中 ${state.address}:${state.port}` : '別PC操作: ON・待ち受け停止中';
    const addressKey = JSON.stringify([state.addresses, state.address]);
    if (addressSignature !== addressKey) {
      addressSignature = addressKey;
      const select = $('lan-control-address');
      select.replaceChildren(new Option('IPv4アドレスを選んでください', ''), ...state.addresses.map(address => new Option(address, address)));
      if (state.address && !state.addresses.includes(state.address)) select.append(new Option(`${state.address}（使用できません）`, state.address));
      select.value = state.address;
    }
    const hostKey = JSON.stringify([state.enabled, state.address, state.port]);
    if (hostSignature !== hostKey) { hostSignature = hostKey; $('lan-control-port').value = state.port; $('lan-control-enabled').checked = state.enabled; }
    for (const input of form.elements) input.disabled = !setup;
    $('lan-control-stop').disabled = !state.enabled;
    $('lan-control-rotate').disabled = !setup || !state.address;
    const next = JSON.stringify([setup, state.devices, state.selectors, Boolean(state.fingerprint)]);
    if (signature === next) return;
    signature = next;
    const expanded = new Set([...list.children].filter(row => row.open).map(row => row.dataset.deviceId));
    list.replaceChildren(...state.devices.map(device => {
      const row = document.createElement('details'); row.dataset.deviceId = device.deviceId; row.open = expanded.has(device.deviceId);
      const summary = document.createElement('summary'); summary.textContent = `${device.name}${device.revoked ? '（取り消し済み）' : ''}`; row.append(summary);
      if (device.revoked) return row;
      const enabledLabel = document.createElement('label'), enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = device.enabled; enabled.disabled = !setup;
      enabledLabel.append(enabled, document.createTextNode('別のPCから使う')); row.append(enabledLabel);
      const ipsLabel = document.createElement('label'), ips = document.createElement('textarea'); ips.rows = 2; ips.value = device.addresses.join('\n'); ips.disabled = !setup;
      ips.placeholder = '192.0.2.10 または 192.0.2.0/24'; ipsLabel.append(document.createTextNode('許可するIPv4アドレス（完全一致またはCIDR /16〜/32、最大8件、1行に1つ）'), ips); row.append(ipsLabel);
      const selectors = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = '操作してよいセレクター'; selectors.append(legend);
      const choices = [];
      for (const selector of state.selectors) {
        const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = device.selectorIds.includes(selector.selectorId); input.disabled = !setup;
        choices.push({ input, id: selector.selectorId }); label.append(input, document.createTextNode(selector.name)); selectors.append(label);
      }
      row.append(selectors);
      const groups = document.createElement('fieldset'), groupTitle = document.createElement('legend'); groupTitle.textContent = '追加で許可する操作（必要なものだけ）'; groups.append(groupTitle);
      const groupChoices = [];
      for (const [id, title] of [['mix', 'ミュートとフェーダー'], ['cue', 'Cue（PFL）'], ['emergency', '緊急ミュート'], ['tx', 'TXの開始・停止'], ['recording', '録音の開始・停止'], ['scenes', 'シーンの呼び出し']]) {
        const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = device.groups.includes(id); input.disabled = !setup;
        groupChoices.push({ input, id }); label.append(input, document.createTextNode(title)); groups.append(label);
      }
      row.append(groups);
      const save = document.createElement('button'); save.type = 'button'; save.textContent = '機器の設定を保存'; save.disabled = !setup;
      save.addEventListener('click', () => {
        const addresses = ips.value.split(/[\s,]+/).filter(Boolean);
        if (addresses.some(address => /\/(1[6-9]|2[0-3])$/.test(address)) && !confirm('共用ネットワークでは、ほかのスタジオのPCも含まれる可能性があります。この範囲を保存しますか？')) return;
        return operate({ action: 'scope', deviceId: device.deviceId, scope: { enabled: enabled.checked, addresses, selectorIds: choices.filter(choice => choice.input.checked).map(choice => choice.id), groups: groupChoices.filter(choice => choice.input.checked).map(choice => choice.id) } });
      });
      const masked = document.createElement('p'); masked.textContent = '接続コード: parabus1:••••••••（鍵を含むため伏せています）';
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '接続コードをコピー'; copy.disabled = !setup || !state.fingerprint || !device.enabled; copy.addEventListener('click', () => copyCode(device.deviceId));
      row.append(save, masked, copy); return row;
    }));
  }
  form.addEventListener('submit', event => { event.preventDefault(); void operate({ action: 'configure', enabled: $('lan-control-enabled').checked, address: $('lan-control-address').value, port: Number($('lan-control-port').value) }); });
  $('lan-control-stop').addEventListener('click', () => operate({ action: 'stop' }));
  $('lan-control-rotate').addEventListener('click', () => { if (confirm('証明書の指紋が変わります。すべての機器で接続コードを貼り直す必要があります。証明書を作り直しますか？')) void operate({ action: 'rotate', confirmed: true }); });
  const poll = async () => {
    try { if (!busy && !document.hidden) render(await post({ action: 'status' })); }
    catch { $('lan-control-error').textContent = 'LAN操作の状態を取得できません。接続を確認してください。'; }
    setTimeout(poll, 2000);
  };
  void poll();
}
