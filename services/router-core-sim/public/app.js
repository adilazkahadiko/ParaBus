import { createTxMixControls } from "./tx-mix.js";
import { mountSupportBundle } from "./support-bundle.js";
import { mergeMeterSnapshot } from "./meter-snapshot.js";

const desktopAccess = JSON.parse(document.querySelector("#desktop-access")?.textContent || "{}");
const localSettingsAvailable = desktopAccess.localSettingsAvailable !== false;
mountSupportBundle(document.querySelector("#support-bundle"), fetch, localSettingsAvailable);

const renderTxMix = createTxMixControls(document.querySelector("#tx-mix-panel"), sendCommand, {
  bindFader, syncFader, operate: operateTxAssignment,
  forgetFader(key) {
    activeFaders.delete(key); pendingFaders.delete(key); queuedFaders.delete(key); lastFaderSend.delete(key);
    const frame = faderFrames.get(key); if (frame) cancelAnimationFrame(frame);
    faderFrames.delete(key);
  },
});
const elements = {
  applicationState: document.querySelector("#application-state"),
  groupBusSelect: document.querySelector("#group-bus-select"),
  groupBusName: document.querySelector("#group-bus-name"),
  groupBusMembers: document.querySelector("#group-bus-members"),
  applyGroupBus: document.querySelector("#apply-group-bus"),
  removeGroupBus: document.querySelector("#remove-group-bus"),
  sharedCueChannel: document.querySelector("#shared-cue-channel"),
  sharedCueMode: document.querySelector("#shared-cue-mode"),
  applySharedCue: document.querySelector("#apply-shared-cue"),
  clearSharedCue: document.querySelector("#clear-shared-cue"),
  sharedCueState: document.querySelector("#shared-cue-state"),
  lanAccessEnabled: document.querySelector("#lan-access-enabled"),
  sharedGuildId: document.querySelector("#shared-guild-id"),
  exportBotProfiles: document.querySelector("#export-bot-profiles"),
  importBotProfiles: document.querySelector("#import-bot-profiles"),
  nextAction: document.querySelector("#next-action"),
  botState: document.querySelector("#bot-state"),
  botName: document.querySelector("#bot-name"),
  voiceChannel: document.querySelector("#voice-channel"),
  participantCount: document.querySelector("#participant-count"),
  participantHelp: document.querySelector("#participant-help"),
  mixBotFilter: document.querySelector("#mix-bot-filter"),
  mixBankPrev: document.querySelector("#mix-bank-prev"),
  mixBankLabel: document.querySelector("#mix-bank-label"),
  mixBankNext: document.querySelector("#mix-bank-next"),
  participants: document.querySelector("#participants"),
  emptyState: document.querySelector("#empty-state"),
  template: document.querySelector("#participant-template"),
  outputGuard: document.querySelector("#output-guard"),
  receiverGuard: document.querySelector("#receiver-guard"),
  applicationControl: document.querySelector("#application-control"),
  legacyPostRecovery: document.querySelector("#legacy-post-recovery"),
  legacyPostList: document.querySelector("#legacy-post-list"),
  emergencyState: document.querySelector("#emergency-state"),
  controlState: document.querySelector("#control-state"),
  masterPanel: document.querySelector("#vc-masters"),
  masterList: document.querySelector("#vc-master-list"),
  masterTemplate: document.querySelector("#vc-master-template"),
  showMix: document.querySelector("#show-mix"),
  showRoute: document.querySelector("#show-route"),
  showStatus: document.querySelector("#show-status"),
  showSession: document.querySelector("#show-session"),
  showSetup: document.querySelector("#show-setup"),
  mixView: document.querySelector("#mix-view"),
  mixSearch: document.querySelector("#mix-search"),
  extendedDiagnostics: document.querySelector("#extended-diagnostics"),
  extendedDiagnosticsData: document.querySelector("#extended-diagnostics-data"),
  routeView: document.querySelector("#route-view"),
  statusView: document.querySelector("#status-view"),
  sessionView: document.querySelector("#session-view"),
  setupView: document.querySelector("#setup-view"),
  statusOverall: document.querySelector("#status-overall"),
  statusNextAction: document.querySelector("#status-next-action"),
  statusActionDetail: document.querySelector("#status-action-detail"),
  statusOpenRecovery: document.querySelector("#status-open-recovery"),
  statusApplication: document.querySelector("#status-application"),
  statusApplicationDetail: document.querySelector("#status-application-detail"),
  statusDiscord: document.querySelector("#status-discord"),
  statusDiscordDetail: document.querySelector("#status-discord-detail"),
  statusAudio: document.querySelector("#status-audio"),
  statusAudioDetail: document.querySelector("#status-audio-detail"),
  statusIo: document.querySelector("#status-io"),
  statusIoDetail: document.querySelector("#status-io-detail"),
  statusCue: document.querySelector("#status-cue"),
  statusCueDetail: document.querySelector("#status-cue-detail"),
  statusInput: document.querySelector("#status-input"),
  statusInputDetail: document.querySelector("#status-input-detail"),
  statusRecorder: document.querySelector("#status-recorder"),
  statusRecorderDetail: document.querySelector("#status-recorder-detail"),
  statusStatRx: document.querySelector("#status-stat-rx"),
  statusStatRxDetail: document.querySelector("#status-stat-rx-detail"),
  statusStatSources: document.querySelector("#status-stat-sources"),
  statusStatSourcesDetail: document.querySelector("#status-stat-sources-detail"),
  statusStatTx: document.querySelector("#status-stat-tx"),
  statusStatTxDetail: document.querySelector("#status-stat-tx-detail"),
  statusStatIo: document.querySelector("#status-stat-io"),
  statusStatIoDetail: document.querySelector("#status-stat-io-detail"),
  statusStatRecorder: document.querySelector("#status-stat-recorder"),
  statusStatRecorderDetail: document.querySelector("#status-stat-recorder-detail"),
  statusStatsSince: document.querySelector("#status-stats-since"),
  statusRuntimeInfo: document.querySelector("#status-runtime-info"),
  statusRefresh: document.querySelector("#status-refresh"),
  statusReset: document.querySelector("#status-reset"),
  statusBotCount: document.querySelector("#status-bot-count"),
  statusBotList: document.querySelector("#status-bot-list"),
  statusUserCount: document.querySelector("#status-user-count"),
  statusUserList: document.querySelector("#status-user-list"),
  statusEventCount: document.querySelector("#status-event-count"),
  statusEventList: document.querySelector("#status-event-list"),
  sceneCurrent: document.querySelector("#scene-current"),
  sceneName: document.querySelector("#scene-name"),
  saveScene: document.querySelector("#save-scene"),
  sceneSelect: document.querySelector("#scene-select"),
  previewScene: document.querySelector("#preview-scene"),
  overwriteScene: document.querySelector("#overwrite-scene"),
  deleteScene: document.querySelector("#delete-scene"),
  recallScene: document.querySelector("#recall-scene"),
  scenePreviewSummary: document.querySelector("#scene-preview-summary"),
  scenePreviewList: document.querySelector("#scene-preview-list"),
  recallSafePanel: document.querySelector("#recall-safe-panel"),
  recallSafeCount: document.querySelector("#recall-safe-count"),
  recallSafeFilter: document.querySelector("#recall-safe-filter"),
  recallSafeList: document.querySelector("#recall-safe-list"),
  statusLogLevel: document.querySelector("#status-log-level"),
  statusLogFilter: document.querySelector("#status-log-filter"),
  clearEventLog: document.querySelector("#clear-event-log"),
  recorderState: document.querySelector("#recorder-state"),
  recorderDuration: document.querySelector("#recorder-duration"),
  recorderTrackCount: document.querySelector("#recorder-track-count"),
  recorderQueue: document.querySelector("#recorder-queue"),
  recorderDiskFree: document.querySelector("#recorder-disk-free"),
  recorderTargets: document.querySelector("#recorder-targets"),
  recorderOutputs: document.querySelector("#recorder-outputs"),
  recorderUsers: document.querySelector("#recorder-users"),
  recorderBuses: document.querySelector("#recorder-buses"),
  recorderOutputsCount: document.querySelector("#recorder-outputs-count"),
  recorderBusesCount: document.querySelector("#recorder-buses-count"),
  recorderUsersCount: document.querySelector("#recorder-users-count"),
  recorderSelectionSummary: document.querySelector("#recorder-selection-summary"),
  startRecording: document.querySelector("#start-recording"),
  stopRecording: document.querySelector("#stop-recording"),
  recorderFolder: document.querySelector("#recorder-folder"),
  recorderMessage: document.querySelector("#recorder-message"),
  recorderTracks: document.querySelector("#recorder-tracks"),
  setupForm: document.querySelector("#bot-setup-form"),
  appPort: document.querySelector("#application-port"),
  outputTestTones: document.querySelector("#output-test-tones"),
  botProfileList: document.querySelector("#bot-profile-list"),
  botProfileCount: document.querySelector("#bot-profile-count"),
  addBotProfile: document.querySelector("#add-bot-profile"),
  addTxProfile: document.querySelector("#add-tx-profile"),
  addDuplexProfile: document.querySelector("#add-duplex-profile"),
  txAssignmentList: document.querySelector("#tx-assignment-list"),
  bulkBotTokens: document.querySelector("#bulk-bot-tokens"),
  addBotTokens: document.querySelector("#add-bot-tokens"),
  setupStatus: document.querySelector("#setup-status"),
  saveBotProfiles: document.querySelector("#save-bot-profiles"),
  restartRouter: document.querySelector("#restart-router"),
  shutdownRouter: document.querySelector("#shutdown-router"),
  restartDetail: document.querySelector("#restart-detail"),
  receiverOwnerState: document.querySelector("#receiver-owner-state"),
  receiverOwnerSummary: document.querySelector("#receiver-owner-summary"),
  receiverOwnerList: document.querySelector("#receiver-owner-list"),
  refreshIo: document.querySelector("#refresh-io"),
  ioOutputState: document.querySelector("#io-output-state"),
  ioOutputGuidance: document.querySelector("#io-output-guidance"),
  setupOpenRoute: document.querySelector("#setup-open-route"),
  routeOpenDevices: document.querySelector("#route-open-devices"),
  ioOutputDevice: document.querySelector("#io-output-device"),
  ioOutputEndpoint: document.querySelector("#io-output-endpoint"),
  ioCueOutputState: document.querySelector("#io-cue-output-state"),
  ioCueOutputDevice: document.querySelector("#io-cue-output-device"),
  ioCueOutputEndpoint: document.querySelector("#io-cue-output-endpoint"),
  applyIoCueOutput: document.querySelector("#apply-io-cue-output"),
  closeIoCueOutput: document.querySelector("#close-io-cue-output"),
  ioCueOutputDetail: document.querySelector("#io-cue-output-detail"),
  applyIoOutput: document.querySelector("#apply-io-output"),
  closeIoOutput: document.querySelector("#close-io-output"),
  routeOverviewCount: document.querySelector("#route-overview-count"),
  routeMatrixDevice: document.querySelector("#route-matrix-device"),
  routeMatrixMode: document.querySelector("#route-matrix-mode"),
  routeMatrixPrev: document.querySelector("#route-matrix-prev"),
  routeMatrixNext: document.querySelector("#route-matrix-next"),
  routeMatrixBank: document.querySelector("#route-matrix-bank"),
  vcRouteList: document.querySelector("#vc-route-list"),
  ioOutputDetail: document.querySelector("#io-output-detail"),
  ioInputState: document.querySelector("#io-input-state"),
  ioInputDevice: document.querySelector("#io-input-device"),
  ioInputEndpoint: document.querySelector("#io-input-endpoint"),
  ioInputChannels: document.querySelector("#io-input-channels"),
  applyIoInput: document.querySelector("#apply-io-input"),
  closeIoInput: document.querySelector("#close-io-input"),
  ioInputDetail: document.querySelector("#io-input-detail"),
  notice: document.querySelector("#notice"),
};

const stripRefs = new Map();
const masterRefs = new Map();
const activeFaders = new Set();
const pendingFaders = new Map();
const queuedFaders = new Map();
const faderFrames = new Map();
const lastFaderSend = new Map();
const recorderTrackRefs = new Map();
const recorderTargetRefs = new Map();
const botRecoveries = new Map();
const MIX_BANK_SIZE = 16;
const desktopSessionNonce = document.querySelector('meta[name="dbr-session-nonce"]')?.content ?? "";
const desktopJsonHeaders = { "content-type": "application/json", "x-dbr-session-nonce": desktopSessionNonce };

let socket = null;
let reconnectTimer = null;
let snapshot = null;
let selectedChannelId = null;
let primaryBotKey = null;
let selectedMixBotProfileId = "all";
let mixBotFilterSignature = "";
let mixBankIndex = 0;
let noticeTimer = null;
let settingsSnapshot = null;
let settingsLoading = false;
let settingsDirty = false;
let receiverOwnerSignature = "";
let routeOverviewSignature = "";
const expandedRouteVcs = new Set();
let routeMatrixBank = 0;
let selectedRouteVcKey = "";
let selectedSceneId = null;
let scenePreview = null;
let sceneOptionsSignature = "";
let scenePreviewSignature = "";
let recorderSelection = null;
let recorderSessionStartedAt = null;
let lastRecorderState = null;
let windowsEndpointInventory = [];
let ioInventoryLoading = false;
let ioOptionsSignature = "";
let statusEventSignature = null;
let statusStatsBaseline = null;
let statusBreakdownRenderedAt = 0;
let restartRequested = false;
let shutdownRequested = false;
let txAssignmentSignature = "";
const FADER_CURVE = [[-90, 0], [-60, 6], [-40, 16], [-30, 24], [-20, 34], [-10, 50], [-5, 64], [0, 78], [5, 89], [10, 97], [12, 100]];

function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  elements.notice.textContent = message || "操作を完了できませんでした";
  elements.notice.classList.toggle("error", error);
  elements.notice.classList.add("show");
  noticeTimer = setTimeout(() => elements.notice.classList.remove("show"), 3200);
}

function setConnection(connected) {
  if (snapshot) renderTxAssignments(snapshot);
  if (snapshot) renderTxMix(snapshot, settingsSnapshot?.bots ?? [], connected);
  elements.controlState.textContent = connected ? "システム: 正常" : "システム: 再接続中";
  elements.controlState.className = `status ${connected ? "ready" : "warning"}`;
}

function connect() {
  if (shutdownRequested) return;
  clearTimeout(reconnectTimer);
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?nonce=${encodeURIComponent(desktopSessionNonce)}`);
  socket.addEventListener("open", () => {
    restartRequested = false;
    setConnection(true);
  });
  socket.addEventListener("close", () => {
    for (const recovery of botRecoveries.values()) clearTimeout(recovery.timeout);
    botRecoveries.clear();
    setConnection(false);
    if (shutdownRequested) {
      elements.controlState.textContent = "ParaBusを終了しました。このタブを閉じてください";
      return;
    }
    reconnectTimer = setTimeout(connect, 1000);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") render(message.payload);
    if (message.type === "meters" && snapshot) render(mergeMeterSnapshot(snapshot, message.payload));
    if (message.type === "command-result") {
      if (!message.payload.ok) {
        pendingFaders.clear();
        showNotice(message.payload.code === "STALE_STATE"
          ? "状態が変わりました。画面を確認してからもう一度操作してください"
          : message.payload.error, true);
        if (snapshot) render(snapshot);
      } else if (message.payload.data?.kind === "scene-preview") {
        selectedSceneId = message.payload.data.sceneId;
        scenePreview = message.payload.data;
        scenePreviewSignature = "";
        if (snapshot) renderSession(snapshot);
      } else if (message.payload.data?.id && message.payload.data?.values) {
        selectedSceneId = message.payload.data.id;
        scenePreview = null;
        sceneOptionsSignature = "";
        scenePreviewSignature = "";
        showNotice("Sceneを保存しました");
      }
    }
  });
}

function sendCommand(command) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showNotice("操作接続を再接続しています。少し待ってください", true);
    return false;
  }
  socket.send(JSON.stringify({ type: "command", payload: command }));
  return true;
}

function generatedTokenEnvironment(profileId) {
  return `DISCORD_BOT_TOKEN_${profileId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
}

function showView(view) {
  window.scrollTo(0, 0);
  const setup = view === "setup";
  const session = view === "session";
  const status = view === "status";
  const route = view === "route";
  elements.mixView.hidden = setup || session || status || route;
  elements.routeView.hidden = !route;
  elements.statusView.hidden = !status;
  elements.sessionView.hidden = !session;
  elements.setupView.hidden = !setup;
  elements.showMix.classList.toggle("active", !setup && !session && !status && !route);
  elements.showRoute.classList.toggle("active", route);
  elements.showStatus.classList.toggle("active", status);
  elements.showSession.classList.toggle("active", session);
  elements.showSetup.classList.toggle("active", setup);
  if (setup || route) {
    void loadWindowsEndpoints();
  }
  if (setup) { void loadDesktopSettings();  }
}

function markSettingsDirty() {
  settingsDirty = true;
  elements.setupStatus.textContent = "未保存";
  elements.saveBotProfiles.classList.add("attention");
}

function nextBotProfileId(prefix = "BOT") {
  const used = new Set([...elements.botProfileList.querySelectorAll(".bot-profile-card")].map((card) => card.querySelector('[data-setting="id"]').value.trim()));
  for (let index = 1; index <= 99; index += 1) {
    const candidate = `${prefix}${String(index).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix}${Date.now().toString().slice(-6)}`;
}

function updateBotProfileCount() {
  const cards = [...elements.botProfileList.querySelectorAll(".bot-profile-card")];
  const enabled = cards.filter((card) => card.querySelector('[data-setting="enabled"]').checked);
  const rx = enabled.filter((card) => card.querySelector('[data-setting="role"]').value !== "TX").length;
  const tx = enabled.filter((card) => ["TX", "DUPLEX"].includes(card.querySelector('[data-setting="role"]').value)).length;
  const limits = settingsSnapshot?.limits ?? { rx: 24, tx: 22, total: 24 };
  elements.botProfileCount.textContent = `RX ${rx}/${limits.rx} · TX ${tx}/${limits.tx} · 全${cards.length}/${limits.total}`;
  elements.addBotProfile.disabled = snapshot?.state === "ON_AIR" || snapshot?.state === "FAULT" || cards.length >= limits.total;
  for (const button of [elements.addTxProfile, elements.addDuplexProfile]) button.disabled = elements.addBotProfile.disabled;
  elements.addBotTokens.disabled = !settingsSnapshot || elements.addBotProfile.disabled;
  elements.bulkBotTokens.disabled = snapshot?.state === "ON_AIR" || snapshot?.state === "FAULT";
}

function addBotProfile(prefix = "RX", guildId = "", role = "RX") {
  if (snapshot?.state === "ON_AIR" || snapshot?.state === "FAULT") return null;
  if (elements.botProfileList.querySelectorAll(".bot-profile-card").length >= (settingsSnapshot?.limits.total ?? 24)) return null;
  elements.botProfileList.querySelector(".empty-state")?.remove();
  const profileId = nextBotProfileId(prefix);
  const card = createBotProfileCard({
    id: profileId,
    label: profileId,
    role,
    txSubtype: null,
    txAudioMode: null,
    tokenEnv: generatedTokenEnvironment(profileId),
    tokenConfigured: false,
    guildId: guildId || elements.sharedGuildId?.value.trim() || "",
    voiceChannelId: "",
    enabled: true,
  });
  elements.botProfileList.append(card);
  markSettingsDirty();
  updateBotProfileCount();
  return card;
}

function addBotProfileTokens() {
  if (!settingsSnapshot || snapshot?.state === "ON_AIR" || snapshot?.state === "FAULT") return;
  const tokens = [], seen = new Set();
  let skipped = 0;
  for (const line of elements.bulkBotTokens.value.split(/\r?\n/)) {
    const token = line.trim();
    if (!token) continue;
    if (seen.has(token) || token.length > 256 || /[\s#=]/.test(token)) { skipped += 1; continue; }
    seen.add(token);
    tokens.push(token);
  }
  const cards = elements.botProfileList.querySelectorAll(".bot-profile-card");
  const guildId = cards[0]?.querySelector('[data-setting="guildId"]').value ?? "";
  const available = Math.max(0, settingsSnapshot.limits.total - cards.length);
  let added = 0;
  for (const token of tokens.slice(0, available)) {
    const card = addBotProfile("RX", guildId);
    const input = card.querySelector('[data-setting="token"]');
    input.value = token;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    added += 1;
  }
  elements.bulkBotTokens.value = "";
  markSettingsDirty();
  updateBotProfileCount();
  showNotice(`${added}件追加しました（上限で${tokens.length - added}件、重複・形式不正で${skipped}件をスキップ）`);
}

function createBotProfileCard(bot, persisted = false) {
  const card = document.createElement("article");
  card.className = "bot-profile-card";
  card.dataset.persisted = String(persisted);
  card.dataset.legacySpare = String(bot.role === "SPARE");
  card.dataset.tokenEnv = bot.tokenEnv || generatedTokenEnvironment(bot.id);
  card.dataset.autoTokenEnv = String(!bot.tokenEnv || bot.tokenEnv === generatedTokenEnvironment(bot.id));
  card.dataset.tokenConfigured = String(Boolean(bot.tokenConfigured));
  card.dataset.txSubtype = bot.txSubtype ?? "CUSTOM";
  card.dataset.txDestination = bot.txDestination ?? "";
  card.dataset.txAudioMode = bot.txAudioMode ?? "MONO";
  card.innerHTML = `
    <header class="bot-profile-head">
      <label class="enabled-check"><input data-setting="enabled" type="checkbox"><span>使用</span></label>
      <span class="bot-role-badge">RX</span>
      <strong data-field="title">新しいBot</strong>
    </header>
    <div class="bot-profile-resolved" aria-label="接続先">
      <strong data-field="guild-name">Server未確認</strong>
      <span>/</span>
      <strong data-field="voice-name">VC未確認</strong>
    </div>
    <strong class="bot-profile-state" data-field="runtime-state">未接続</strong>
    <div class="bot-card-actions">
      <button data-action="connect" type="button">接続</button>
      <button data-action="disconnect" class="danger-action" type="button">切断</button>
    </div>
    <details class="bot-profile-edit">
      <summary>詳細</summary>
      <div class="bot-profile-fields">
        <label><span>名前</span><input data-setting="label" type="text" maxlength="80" required></label>
        <label><span>役割</span><select data-setting="role"><option value="RX">RX（受信）</option><option value="TX">TX（送信）</option><option value="DUPLEX">RX+TX（双方向）</option></select></label>
        <label><span>TX MODE</span><select data-setting="txAudioMode"><option>MONO</option><option>STEREO</option></select></label>
        <label><span>取得済みServer</span><select data-setting="guildChoice"></select></label>
        <label><span>取得済みVC</span><select data-setting="voiceChoice"></select></label>
        <label class="token-field"><span>Token <small data-field="token-state">未設定</small></span><input data-setting="token" type="password" maxlength="256" autocomplete="new-password" spellcheck="false" placeholder="変更時のみ"></label>
        <label><span>Server ID</span><input data-setting="guildId" type="text" inputmode="numeric" maxlength="20" spellcheck="false"></label>
        <label><span>VC ID</span><input data-setting="voiceChannelId" type="text" inputmode="numeric" maxlength="20" spellcheck="false"></label>
      </div>
      <div class="bot-profile-edit-actions"><button data-action="remove" class="danger-action" type="button">Botを削除</button></div>
      <input data-setting="id" type="hidden">
      <small hidden>Token保存先: <strong data-field="token-env"></strong></small>
    </details>`;
  const setting = (name) => card.querySelector(`[data-setting="${name}"]`);
  setting("enabled").checked = bot.enabled !== false;
  setting("id").value = bot.id ?? nextBotProfileId();
  setting("id").readOnly = true;
  setting("label").value = bot.label ?? "";
  setting("role").value = bot.role === "SPARE" ? "RX" : bot.role ?? "RX";
  setting("txAudioMode").value = bot.txAudioMode ?? "MONO";
  setting("guildId").value = bot.guildId ?? "";
  setting("voiceChannelId").value = bot.voiceChannelId ?? "";
  refreshBotProfileLocationOptions(card);
  updateBotProfileTxFields(card);
  card.querySelector('[data-field="token-env"]').textContent = card.dataset.tokenEnv;
  card.querySelector('[data-field="title"]').textContent = bot.label || bot.id || "新しいBot";
  card.setAttribute("aria-label", card.querySelector('[data-field="title"]').textContent);
  const tokenState = card.querySelector('[data-field="token-state"]');
  tokenState.textContent = bot.tokenConfigured ? "設定済み" : "Token未設定";
  tokenState.className = bot.tokenConfigured ? "configured" : "";
  card.querySelector(".bot-role-badge").textContent = setting("role").value === "DUPLEX" ? "RX+TX" : setting("role").value;
  card.querySelector(".bot-profile-edit").open = !persisted;
  card.classList.toggle("disabled", !setting("enabled").checked);

  setting("enabled").addEventListener("change", () => {
    card.classList.toggle("disabled", !setting("enabled").checked);
    markSettingsDirty();
    updateBotProfileCount();
  });
  setting("role").addEventListener("change", () => {
    updateBotProfileTxFields(card);
    card.querySelector(".bot-role-badge").textContent = setting("role").value === "DUPLEX" ? "RX+TX" : setting("role").value;
    markSettingsDirty();
    updateBotProfileCount();
  });
  setting("label").addEventListener("input", () => {
    card.querySelector('[data-field="title"]').textContent = setting("label").value || setting("id").value || "新しいBot";
    card.setAttribute("aria-label", card.querySelector('[data-field="title"]').textContent);
  });
  setting("id").addEventListener("input", () => {
    if (card.dataset.autoTokenEnv === "true") card.dataset.tokenEnv = generatedTokenEnvironment(setting("id").value);
    card.querySelector('[data-field="token-env"]').textContent = card.dataset.tokenEnv;
  });
  setting("guildChoice").addEventListener("change", () => {
    setting("guildId").value = setting("guildChoice").value;
    setting("voiceChannelId").value = "";
    refreshBotProfileLocationOptions(card);
  });
  setting("voiceChoice").addEventListener("change", () => { setting("voiceChannelId").value = setting("voiceChoice").value; });
  for (const field of [setting("guildId"), setting("voiceChannelId")]) field.addEventListener("change", () => refreshBotProfileLocationOptions(card));
  setting("token").addEventListener("input", () => {
    const changed = Boolean(setting("token").value);
    tokenState.textContent = changed ? "保存予定" : card.dataset.tokenConfigured === "true" ? "設定済み" : "Token未設定";
    tokenState.className = changed ? "changed" : card.dataset.tokenConfigured === "true" ? "configured" : "";
  });
  for (const field of card.querySelectorAll("input, select")) {
    field.addEventListener("input", markSettingsDirty);
    field.addEventListener("change", markSettingsDirty);
  }
  card.querySelector('[data-action="connect"]').addEventListener("click", () => {
    const profileId = setting("id").value.trim();
    const label = setting("label").value.trim() || profileId;
    if (settingsDirty) return showNotice("先にBot設定を保存してください", true);
    if (!setting("enabled").checked) return showNotice("このBotを「使用する」にして保存してください", true);
    if (["FAULT", "RECONNECTING"].includes(card.dataset.runtimeHealth)) {
      if (!confirm(`${label}を復旧しますか？\nこのBotのRX/TXと対象VCは一時的に無音になります。\n\n自動再試行はせず、1回だけ切断→再接続します。`)) return;
      const recovery = { phase: "disconnecting", label, timeout: 0 };
      recovery.timeout = setTimeout(() => {
        if (botRecoveries.get(profileId) !== recovery) return;
        botRecoveries.delete(profileId);
        showNotice(`${label}の復旧が完了しませんでした。状態を確認してください`, true);
        if (snapshot) renderSetupRuntime(snapshot);
      }, 15_000);
      botRecoveries.set(profileId, recovery);
      if (!sendCommand({ type: "DISCONNECT_DISCORD_BOT", profileId, confirmed: true })) {
        clearTimeout(recovery.timeout);
        botRecoveries.delete(profileId);
      } else if (snapshot) renderSetupRuntime(snapshot);
      return;
    }
    if (sendCommand({ type: "CONNECT_DISCORD_BOT", profileId })) card.querySelector('[data-field="runtime-state"]').textContent = "接続要求中";
  });
  card.querySelector('[data-action="disconnect"]').addEventListener("click", () => {
    const profileId = setting("id").value.trim();
    const label = setting("label").value.trim() || profileId;
    if (!profileId || !confirm(`${label}をVCから切断しますか？\nこのBotの受信・送信は停止します。`)) return;
    sendCommand({ type: "DISCONNECT_DISCORD_BOT", profileId, confirmed: true });
  });
  card.querySelector('[data-action="remove"]').addEventListener("click", () => {
    const label = setting("label").value.trim() || setting("id").value.trim() || "このBot";
    if (card.dataset.runtimeConnected === "true") return showNotice("先にこのBotを切断してください", true);
    if (!confirm(`${label}を設定一覧から削除しますか？\n保存済みTokenは安全のため.envに残します。`)) return;
    card.remove();
    markSettingsDirty();
    updateBotProfileCount();
  });
  return card;
}

function botSettingsFromCard(card) {
  const setting = (name) => card.querySelector(`[data-setting="${name}"]`);
  // Preserve legacy standby semantics on unrelated saves. Converting to RX
  // would make automatic ownership ambiguous when a primary RX shares its VC.
  const role = card.dataset.legacySpare === "true" && setting("role").value === "RX" ? "SPARE" : setting("role").value;
  return {
    id: setting("id").value.trim(),
    label: setting("label").value.trim(),
    role,
    txSubtype: role === "TX" || role === "DUPLEX" ? card.dataset.txSubtype || "CUSTOM" : null,
    txAudioMode: role === "TX" || role === "DUPLEX" ? setting("txAudioMode").value || "MONO" : null,
    txDestination: card.dataset.txDestination || null,
    tokenEnv: card.dataset.tokenEnv || generatedTokenEnvironment(setting("id").value.trim()),
    token: setting("token").value,
    guildId: setting("guildId").value.trim(),
    voiceChannelId: setting("voiceChannelId").value.trim(),
    enabled: setting("enabled").checked,
  };
}

function changeSharedGuild() {
  if (!localSettingsAvailable || !settingsSnapshot || ["ON_AIR", "FAULT"].includes(snapshot?.state)) return;
  const previous = elements.sharedGuildId.dataset.previous ?? "";
  const next = elements.sharedGuildId.value.trim();
  if (next && !/^\d{17,20}$/.test(next)) return showNotice("Server IDは17〜20桁の数字で入力してください", true);
  for (const card of elements.botProfileList.querySelectorAll(".bot-profile-card")) {
    const guild = card.querySelector('[data-setting="guildId"]');
    if (guild.value.trim() && guild.value.trim() !== previous) continue;
    if (guild.value.trim() !== next) card.querySelector('[data-setting="voiceChannelId"]').value = "";
    guild.value = next;
    refreshBotProfileLocationOptions(card);
  }
  elements.sharedGuildId.dataset.previous = next;
  markSettingsDirty();
}

function portableBotProfiles(bots) {
  const fields = ["id", "label", "role", "txSubtype", "txAudioMode", "txDestination", "guildId", "voiceChannelId", "enabled"];
  return { schemaVersion: 1, kind: "ParaBus Bot profiles", bots: bots.map(bot => Object.fromEntries(fields.map(field => [field, bot[field]]))) };
}

function exportBotProfiles() {
  if (!localSettingsAvailable || !settingsSnapshot) return;
  const bots = [...elements.botProfileList.querySelectorAll(".bot-profile-card")].map(botSettingsFromCard);
  const url = URL.createObjectURL(new Blob([JSON.stringify(portableBotProfiles(bots), null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "ParaBus-bot-profiles.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice("Bot設定を書き出しました。Tokenは含まれません。Server / VC IDは含まれます");
}

async function importBotProfiles() {
  const input = elements.importBotProfiles, file = input.files?.[0]; input.value = "";
  if (!file || !localSettingsAvailable || !settingsSnapshot || ["ON_AIR", "FAULT"].includes(snapshot?.state)) return;
  try {
    if (file.size > 1024 * 1024) throw new Error();
    const parsed = JSON.parse(await file.text());
    if (parsed.schemaVersion !== 1 || parsed.kind !== "ParaBus Bot profiles" || !Array.isArray(parsed.bots) || parsed.bots.length > settingsSnapshot.limits.total) throw new Error();
    const seen = new Set();
    for (const bot of parsed.bots) {
      if (!bot || typeof bot.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(bot.id) || seen.has(bot.id) || typeof bot.label !== "string" || !bot.label.trim() || bot.label.length > 80 || !["RX", "TX", "DUPLEX", "SPARE"].includes(bot.role)
        || ![bot.guildId, bot.voiceChannelId].every(id => typeof id === "string" && (id === "" || /^\d{17,20}$/.test(id))) || typeof bot.enabled !== "boolean") throw new Error();
      seen.add(bot.id);
    }
    // File reading is asynchronous: recheck the live safety state afterwards.
    if (["ON_AIR", "FAULT"].includes(snapshot?.state)) return;
    if (!confirm(`${parsed.bots.length}件のBot設定で編集一覧を置き換えますか？\nTokenは読み込みません。保存するまで本体には反映しません。`)) return;
    const safe = portableBotProfiles(parsed.bots).bots;
    const cards = safe.map(bot => {
      const existing = settingsSnapshot.bots.find(saved => saved.id === bot.id);
      return createBotProfileCard({ ...bot, tokenEnv: existing?.tokenEnv ?? generatedTokenEnvironment(bot.id), tokenConfigured: existing?.tokenConfigured ?? false });
    });
    elements.botProfileList.replaceChildren(...cards);
    elements.sharedGuildId.value = safe[0]?.guildId ?? ""; elements.sharedGuildId.dataset.previous = elements.sharedGuildId.value;
    markSettingsDirty(); updateBotProfileCount();
    showNotice(`${safe.length}件を読み込みました。Tokenと接続先を確認して保存してください`);
  } catch { showNotice("Bot設定ファイルを読み込めません。ParaBusから書き出したJSONを選んでください", true); }
}

function updateBotProfileTxFields(card) {
  const enabled = ["TX", "DUPLEX"].includes(card.querySelector('[data-setting="role"]').value);
  card.querySelector('[data-setting="txAudioMode"]').disabled = !enabled;
}

function refreshBotProfileLocationOptions(card) {
  const setting = name => card.querySelector(`[data-setting="${name}"]`);
  const guildId = setting("guildId").value.trim(), voiceId = setting("voiceChannelId").value.trim();
  const channels = snapshot?.discord?.availableVoiceChannels ?? [];
  const guilds = [...new Set(channels.map(channel => channel.guildId))];
  if (guildId && !guilds.includes(guildId)) guilds.push(guildId);
  syncControlSelect(setting("guildChoice"), [{ value: "", label: "Serverを選択" }, ...guilds.map(id => ({ value: id, label: `Guild ···${id.slice(-4)}` }))]);
  setting("guildChoice").value = guildId;
  const voices = channels.filter(channel => channel.guildId === guildId).map(channel => ({ value: channel.id, label: channel.name }));
  if (voiceId && !voices.some(voice => voice.value === voiceId)) voices.push({ value: voiceId, label: `Configured VC ···${voiceId.slice(-4)}` });
  syncControlSelect(setting("voiceChoice"), [{ value: "", label: "VCを選択（自動割当しません）" }, ...voices]);
  setting("voiceChoice").value = voiceId;
}

function renderDesktopSettings(settings) {
  settingsSnapshot = settings;
  elements.appPort.value = String(settings.operator?.port ?? 4173);
  elements.lanAccessEnabled.checked = settings.operator?.lanAccess === true;
  elements.sharedGuildId.value = settings.bots[0]?.guildId ?? "";
  elements.sharedGuildId.dataset.previous = elements.sharedGuildId.value;
  elements.botProfileList.replaceChildren(...settings.bots.map((bot) => createBotProfileCard(bot, true)));
  if (!settings.bots.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "—";
    elements.botProfileList.append(empty);
  }
  settingsDirty = false;
  elements.saveBotProfiles.classList.remove("attention");
  elements.setupStatus.textContent = "保存済み";
  updateBotProfileCount();
  routeOverviewSignature = "";
  receiverOwnerSignature = "";
  if (snapshot) {
    renderRouteOverview(snapshot);
    renderReceiverOwners(snapshot);
    renderSetupRuntime(snapshot);
  }
}

async function loadDesktopSettings(force = false) {
  if (!localSettingsAvailable) { elements.setupStatus.textContent = "このPCからのみ操作できます"; return; }
  if (settingsLoading || (settingsSnapshot && !force)) return;
  settingsLoading = true;
  elements.setupStatus.textContent = "読込中";
  try {
    const response = await fetch("/api/settings", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "設定を読み込めませんでした");
    renderDesktopSettings(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.setupStatus.textContent = message;
    showNotice(message, true);
  } finally {
    settingsLoading = false;
  }
}

async function loadWindowsEndpoints(notify = false) {
  if (!localSettingsAvailable) return;
  if (ioInventoryLoading) return;
  ioInventoryLoading = true;
  elements.refreshIo.disabled = true;
  try {
    const response = await fetch("/api/rust/wasapi", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Windows endpointを取得できませんでした");
    windowsEndpointInventory = payload.inventory?.endpoints ?? [];
    if (snapshot && payload.management) snapshot.rustManagement = payload.management;
    ioOptionsSignature = "";
    if (snapshot) renderIo(snapshot);
    if (notify) showNotice(`Windows endpointを${windowsEndpointInventory.length}件検出しました`);
  } catch (error) {
    windowsEndpointInventory = [];
    const message = error instanceof Error ? error.message : String(error);
    if (notify) showNotice(message, true);
  } finally {
    ioInventoryLoading = false;
    elements.refreshIo.disabled = false;
  }
}



let extendedDiagnosticsRenderedAt = -Infinity;
function renderExtendedDiagnostics(currentSnapshot, force = false) {
  if (!elements.extendedDiagnostics.open) return;
  const now = performance.now();
  if (!force && now - extendedDiagnosticsRenderedAt < 1000) return;
  extendedDiagnosticsRenderedAt = now;
  elements.extendedDiagnosticsData.textContent = JSON.stringify({ runtimeInfo: currentSnapshot.runtimeInfo, engine: { sampleRate: currentSnapshot.sampleRate, blockSize: currentSnapshot.blockSize, callbackLoad: currentSnapshot.callbackLoad, xruns: currentSnapshot.xruns, uptimeSeconds: currentSnapshot.uptimeSeconds }, audioTiming: currentSnapshot.audioTiming, audioRuntimeTiming: currentSnapshot.audioRuntimeTiming, system: currentSnapshot.system, coreOwnership: currentSnapshot.coreOwnership, input: currentSnapshot.input, output: currentSnapshot.output, cueOutput: currentSnapshot.cueOutput, discord: currentSnapshot.discord, recorder: currentSnapshot.recorder, programAudioShadow: currentSnapshot.programAudioShadow, rustManagement: currentSnapshot.rustManagement }, null, 2);
}


function setSelectOptions(select, options, preferredValue = "", preferCurrentState = false) {
  const held = select.value;
  const values = new Set(options.map((option) => option.value));
  const children = [], groups = new Map();
  for (const item of options) {
    const option = new Option(item.label, item.value);
    option.disabled = Boolean(item.disabled);
    if (!item.group) children.push(option);
    else {
      if (!groups.has(item.group)) {
        const group = document.createElement("optgroup"); group.label = item.group;
        groups.set(item.group, group); children.push(group);
      }
      groups.get(item.group).append(option);
    }
  }
  select.replaceChildren(...children);
  if (preferCurrentState && values.has(preferredValue)) select.value = preferredValue;
  else if (values.has(held)) select.value = held;
  else if (values.has(preferredValue)) select.value = preferredValue;
  else select.value = options[0]?.value ?? "";
}

function selectedIoDevice(select, devices = []) {
  return devices.find((device) => device.id === select.value) ?? null;
}

function requiresWindowsEndpoint(device) {
  return Boolean(device?.id.startsWith("pa:") && ["Windows WASAPI", "Windows DirectSound", "Windows WDM-KS", "MME"].includes(device.hostApi));
}

function autoSelectSafetyEndpoint(deviceSelect, endpointSelect, devices, direction) {
  const device = selectedIoDevice(deviceSelect, devices);
  if (!device?.id.startsWith("pa:")) {
    endpointSelect.value = "";
    return null;
  }
  const matches = windowsEndpointInventory.filter((endpoint) => (
    endpoint.direction === direction
    && endpoint.state === "ACTIVE"
    && endpoint.name === device.name
  ));
  endpointSelect.value = matches.length === 1 ? matches[0].id : "";
  return matches.length === 1 ? matches[0] : null;
}

function updateInputChannelOptions() {
  const input = snapshot?.input;
  const device = selectedIoDevice(elements.ioInputDevice, input?.devices);
  const previous = Number(elements.ioInputChannels.value) || 1;
  const maximum = Math.max(1, Math.min(8, device?.maxInputChannels ?? 1));
  const options = Array.from({ length: maximum }, (_, index) => ({ value: String(index + 1), label: `${index + 1} ch` }));
  setSelectOptions(elements.ioInputChannels, options, String(Math.min(previous, maximum)));
}

function configuredReceiverGroups(currentSnapshot) {
  const groups = currentSnapshot.discord?.receiverOwnership ?? [];
  if (!settingsSnapshot) return groups;
  const targets = new Set(settingsSnapshot.bots
    .filter((bot) => bot.enabled && bot.role !== "TX")
    .map((bot) => `${bot.guildId}:${bot.voiceChannelId}`));
  return groups.filter((group) => targets.has(`${group.guildId}:${group.voiceChannelId}`));
}

function configuredTxStems(currentSnapshot) {
  const stems = currentSnapshot.discord?.txStems ?? [];
  if (!settingsSnapshot) return stems;
  return stems.filter((stem) => settingsSnapshot.bots.some((bot) => (
    bot.enabled
    && (bot.role === "TX" || bot.role === "DUPLEX")
    && bot.id === stem.profileId
    && bot.guildId === stem.guildId
    && bot.voiceChannelId === stem.voiceChannelId
  )));
}

function routeVcKey(guildId, voiceChannelId) {
  return `${guildId}:${voiceChannelId}`;
}

function audioDeviceNameplate(name) {
  return typeof name === "string" ? name.replace(/\s+\([^)]*(?:Virtual Audio Device|High Definition Audio)\)\s*$/i, "").trim() : "";
}

function configuredVoiceRoutes(currentSnapshot) {
  const routes = new Map();
  const getRoute = (guildId, voiceChannelId) => {
    const key = routeVcKey(guildId, voiceChannelId);
    if (!routes.has(key)) routes.set(key, { key, guildId, voiceChannelId, group: null, stems: [] });
    return routes.get(key);
  };
  for (const group of configuredReceiverGroups(currentSnapshot)) {
    getRoute(group.guildId, group.voiceChannelId).group = group;
  }
  for (const stem of configuredTxStems(currentSnapshot)) {
    getRoute(stem.guildId, stem.voiceChannelId).stems.push(stem);
  }
  return [...routes.values()].sort((left, right) => {
    const leftName = left.group?.voiceChannelName ?? left.stems[0]?.voiceChannelName ?? left.voiceChannelId;
    const rightName = right.group?.voiceChannelName ?? right.stems[0]?.voiceChannelName ?? right.voiceChannelId;
    return leftName.localeCompare(rightName, "ja");
  });
}


function routeBots(currentSnapshot, roles) {
  return (currentSnapshot.discord?.bots ?? [])
    .filter((bot) => roles.includes(bot.role) && bot.health !== "STALE" && bot.health !== "DISCONNECTED")
    .sort((left, right) => left.label.localeCompare(right.label, "ja"));
}

function busOutputMode(bus) {
  const outputs = bus?.physicalOutputs ?? [];
  return outputs.length === 2 && outputs[1].output === outputs[0].output + 1 ? "DUAL_MONO" : "MONO";
}

function teamRxBuses(currentSnapshot) {
  const keys = new Set(configuredReceiverGroups(currentSnapshot).map((group) => routeVcKey(group.guildId, group.voiceChannelId)));
  return currentSnapshot.buses.filter((bus) => keys.has(routeVcKey(bus.linkedDiscordGuildId, bus.linkedDiscordVoiceChannelId)));
}

function commonTeamOutput(buses) {
  if (!buses.length || buses.some((bus) => !bus.physicalOutputs?.length)) return null;
  const first = buses[0].physicalOutputs.map((route) => route.output).sort((left, right) => left - right);
  if (!buses.every((bus) => JSON.stringify(bus.physicalOutputs.map((route) => route.output).sort((left, right) => left - right)) === JSON.stringify(first))) return null;
  return { output: first[0], mode: first.length === 2 && first[1] === first[0] + 1 ? "DUAL_MONO" : "MONO" };
}

function physicalOutputClaims(currentSnapshot, ignore = {}) {
  const claims = new Map();
  const add = (output, owner) => {
    if (!Number.isInteger(output)) return;
    const owners = claims.get(output) ?? [];
    owners.push(owner);
    claims.set(output, owners);
  };
  const ignoredBusIds = new Set(ignore.busIds ?? []);
  for (const bus of currentSnapshot.buses) {
    if (bus.id === ignore.busId || ignoredBusIds.has(bus.id)) continue;
    for (const route of bus.physicalOutputs ?? []) add(route.output, `VC MIX: ${bus.label}`);
  }
  for (const channel of currentSnapshot.channels) {
    if (channel.id === ignore.channelId || !channel.directOutput) continue;
    add(channel.directOutput.output, `Direct: ${participantDisplayName(currentSnapshot, channel)}`);
  }
  const monitor = currentSnapshot.monitorOutput;
  if (monitor && !ignore.monitor) {
    add(monitor.leftOutput, "Monitor Out");
    if (monitor.mode === "DUAL_MONO") add(monitor.leftOutput + 1, "Monitor Out");
  }
  return claims;
}


function physicalOutputOption(index, mode, claims, prefix = "Physical OUT") {
  const outputs = mode === "DUAL_MONO" ? [index, index + 1] : [index];
  const owners = [...new Set(outputs.flatMap((output) => claims.get(output) ?? []))];
  const target = mode === "DUAL_MONO" ? `${prefix} ${index + 1}/${index + 2}` : `${prefix} ${index + 1}`;
  return {
    value: String(index),
    label: owners.length ? `${target} · 使用中: ${owners.join(" / ")}` : target,
    disabled: owners.length > 0,
  };
}

function selectedOutputConflict(currentSnapshot, output, mode, ignore) {
  const claims = physicalOutputClaims(currentSnapshot, ignore);
  const outputs = mode === "DUAL_MONO" ? [output, output + 1] : [output];
  return [...new Set(outputs.flatMap((index) => claims.get(index) ?? []))];
}

function syncIoOptions(currentSnapshot) {
  const output = currentSnapshot.output;
  const cueOutput = currentSnapshot.cueOutput;
  const input = currentSnapshot.input;
  const localInputs = currentSnapshot.channels.filter((channel) => channel.kind === "LocalMonoInput" || channel.kind === "LocalStereoInput");
  const signature = JSON.stringify({
    outputDevices: output?.devices?.map((device) => [device.id, device.name, device.hostApi, device.maxOutputChannels]),
    outputSelection: [output?.selectedDeviceId, output?.selectedHostApi],
    cueOutputDevices: cueOutput?.devices?.map((device) => [device.id, device.name, device.maxOutputChannels]),
    cueOutputSelection: [cueOutput?.selectedDeviceId, cueOutput?.state, cueOutput?.activeChannelCount],
    inputDevices: input?.devices?.map((device) => [device.id, device.name, device.maxInputChannels]),
    outputChannels: output?.activeChannelCount,
    outputBinding: output?.windowsEndpointBinding?.endpointId,
    cueOutputBinding: cueOutput?.windowsEndpointBinding?.endpointId,
    inputBinding: input?.windowsEndpointBinding?.endpointId,
    endpoints: windowsEndpointInventory.map((endpoint) => [endpoint.id, endpoint.name, endpoint.direction, endpoint.state]),
    localInputs: localInputs.map((channel) => [channel.id, channel.label]),
    busOutputs: currentSnapshot.buses.map((bus) => [bus.id, bus.linkedDiscordVoiceChannelId, bus.physicalOutputs?.map((route) => route.output)]),
    monitorOutput: currentSnapshot.monitorOutput,
  });
  if (signature === ioOptionsSignature) return;
  ioOptionsSignature = signature;

  setSelectOptions(
    elements.ioOutputDevice,
    (output?.devices ?? [])
      .filter((device) => device.backend === "mock" || Boolean(device.hostApi))
      .map((device) => ({ value: device.id, group: device.hostApi, label: device.backend === "mock" ? "物理出力なし（Mock）" : `${device.name} · ${device.hostApi} · ${device.maxOutputChannels}ch`, disabled: cueOutput?.selectedDeviceId === device.id && cueOutput?.state === "READY" && device.backend === "portaudio" })),
    output?.selectedDeviceId ?? "",
    true,
  );
  setSelectOptions(
    elements.ioCueOutputDevice,
    (cueOutput?.devices ?? [])
      .filter((device) => device.backend === "mock" || (Boolean(device.hostApi) && device.hostApi !== "ASIO"))
      .map((device) => ({
        value: device.id,
        group: device.hostApi,
        label: device.backend === "mock" ? "出力しない" : `${device.name} · ${device.hostApi} · Stereo`,
        disabled: output?.selectedDeviceId === device.id && output?.state === "READY" && device.backend === "portaudio",
      })),
    cueOutput?.selectedDeviceId ?? "",
    true,
  );
  setSelectOptions(
    elements.ioInputDevice,
    (input?.devices ?? [])
      .filter((device) => device.id === "mock-studio-8" || Boolean(device.hostApi))
      .map((device) => ({ value: device.id, group: device.hostApi, label: device.id === "mock-studio-8" ? "物理入力なし（Mock）" : `${device.name} · ${device.hostApi} · ${device.maxInputChannels}ch` })),
    input?.selectedDeviceId ?? "",
    true,
  );
  const endpointOptions = (direction) => [
    { value: "", label: "Windows endpointを選択" },
    ...windowsEndpointInventory
      .filter((endpoint) => endpoint.direction === direction && endpoint.state === "ACTIVE")
      .map((endpoint) => ({ value: endpoint.id, label: endpoint.name })),
  ];
  setSelectOptions(elements.ioOutputEndpoint, endpointOptions("render"), output?.windowsEndpointBinding?.endpointId ?? "");
  setSelectOptions(elements.ioCueOutputEndpoint, endpointOptions("render"), cueOutput?.windowsEndpointBinding?.endpointId ?? "");
  setSelectOptions(elements.ioInputEndpoint, endpointOptions("capture"), input?.windowsEndpointBinding?.endpointId ?? "");
  autoSelectSafetyEndpoint(elements.ioOutputDevice, elements.ioOutputEndpoint, output?.devices ?? [], "render");
  autoSelectSafetyEndpoint(elements.ioCueOutputDevice, elements.ioCueOutputEndpoint, cueOutput?.devices ?? [], "render");
  autoSelectSafetyEndpoint(elements.ioInputDevice, elements.ioInputEndpoint, input?.devices ?? [], "capture");
  updateInputChannelOptions();

}

function mainOutputGuidance(currentSnapshot) {
  const output = currentSnapshot.output;
  if (output?.state === "FAULT") return "Main障害 · STATUSで確認／手動復旧";
  const device = output?.devices?.find((candidate) => candidate.id === output.selectedDeviceId);
  if (output?.state !== "READY" || device?.backend !== "portaudio") return "機器を選択 → デバイスを開始";
  const inRange = (binding) => Number.isInteger(binding?.output) && binding.output >= 0 && binding.output < output.activeChannelCount;
  const busCount = currentSnapshot.buses.filter((bus) => bus.physicalOutputs?.some(inRange)).length;
  const directCount = currentSnapshot.channels.filter((channel) => inRange(channel.directOutput)).length;
  return busCount || directCount
    ? `本線：VC MIX ${busCount}件 / Direct Out ${directCount}件`
    : "出力先chが未設定 → ROUTEで割り当て";
}

function renderIo(currentSnapshot) {
  renderSharedCue(currentSnapshot);
  const output = currentSnapshot.output;
  const cueOutput = currentSnapshot.cueOutput;
  const input = currentSnapshot.input;
  syncIoOptions(currentSnapshot);
  const outputDevice = output?.devices?.find((device) => device.id === output.selectedDeviceId) ?? null;
  const cueOutputDevice = cueOutput?.devices?.find((device) => device.id === cueOutput.selectedDeviceId) ?? null;
  const physicalOutputOpen = outputDevice?.backend === "portaudio" && output?.state === "READY";
  const physicalCueOutputOpen = cueOutputDevice?.backend === "portaudio" && cueOutput?.state === "READY";
  const physicalInputOpen = Boolean(input?.selectedDeviceId?.startsWith("pa:")) && input?.state === "READY";
  const structureLocked = currentSnapshot.state === "ON_AIR" || currentSnapshot.state === "FAULT";
  const anyTxActive = (currentSnapshot.discord?.txStems ?? []).some((candidate) => candidate.active);
  const outputChoice = selectedIoDevice(elements.ioOutputDevice, output?.devices);
  const cueOutputChoice = selectedIoDevice(elements.ioCueOutputDevice, cueOutput?.devices);
  const inputChoice = selectedIoDevice(elements.ioInputDevice, input?.devices);
  const outputNeedsEndpoint = requiresWindowsEndpoint(outputChoice);
  const cueOutputNeedsEndpoint = requiresWindowsEndpoint(cueOutputChoice);
  const inputNeedsEndpoint = requiresWindowsEndpoint(inputChoice);
  elements.ioOutputState.textContent = output?.state === "FAULT" ? "FAULT · 障害" : physicalOutputOpen ? "デバイス稼働中" : "停止中";
  elements.ioOutputState.className = `io-state ${output?.state === "FAULT" ? "danger" : physicalOutputOpen ? "active" : ""}`;
  elements.ioOutputDetail.textContent = physicalOutputOpen
    ? `稼働中：${output.selectedDeviceName} · ${output.selectedHostApi ?? outputDevice.hostApi} · ${output.activeChannelCount}ch${outputChoice?.id !== output.selectedDeviceId ? "（選択変更は未適用）" : ""}`
    : output?.state === "FAULT" ? output.error ?? "出力FAULT" : "現在：物理出力なし（Mock）";
  elements.ioCueOutputState.textContent = cueOutput?.state === "FAULT" ? "FAULT · Main影響なし" : physicalCueOutputOpen ? "デバイス稼働中" : "未使用／停止中";
  elements.ioCueOutputState.className = `io-state ${cueOutput?.state === "FAULT" ? "danger" : physicalCueOutputOpen ? "active" : ""}`;
  elements.ioCueOutputDetail.textContent = physicalCueOutputOpen
    ? `稼働中：${cueOutput.selectedDeviceName} · ${cueOutput.selectedHostApi ?? cueOutputDevice.hostApi} · Stereo · DROP ${cueOutput.backpressureDrops}`
    : cueOutput?.state === "FAULT" ? `${cueOutput.error ?? "Cue出力FAULT"} · Mainに影響しません` : "現在：独立Cue未使用";
  elements.ioInputState.textContent = input?.state === "FAULT" ? "FAULT · 障害" : physicalInputOpen ? "デバイス稼働中" : "未使用／停止中";
  elements.ioInputState.className = `io-state ${input?.state === "FAULT" ? "danger" : physicalInputOpen ? "active" : ""}`;
  elements.ioInputDetail.textContent = physicalInputOpen
    ? `稼働中：${input.selectedDeviceName} · ${input.selectedHostApi ?? inputChoice?.hostApi} · ${input.activeChannelCount}ch`
    : input?.state === "FAULT" ? input.error ?? "入力FAULT" : "現在：物理入力なし（Mock）";

  elements.ioOutputEndpoint.disabled = true;
  elements.ioCueOutputEndpoint.disabled = true;
  elements.ioInputEndpoint.disabled = true;
  elements.ioOutputDevice.disabled = currentSnapshot.state !== "SETUP" || anyTxActive;
  elements.ioCueOutputDevice.disabled = currentSnapshot.state !== "SETUP" || anyTxActive;
  elements.ioInputDevice.disabled = currentSnapshot.state !== "SETUP" || anyTxActive;
  elements.ioInputChannels.disabled = currentSnapshot.state !== "SETUP" || anyTxActive;
  elements.applyIoOutput.disabled = currentSnapshot.state !== "SETUP" || !outputChoice || outputChoice.backend !== "portaudio" || (outputNeedsEndpoint && !elements.ioOutputEndpoint.value) || anyTxActive;
  elements.applyIoCueOutput.disabled = currentSnapshot.state !== "SETUP" || !cueOutputChoice || cueOutputChoice.backend !== "portaudio" || (cueOutputNeedsEndpoint && !elements.ioCueOutputEndpoint.value) || anyTxActive;
  elements.applyIoInput.disabled = currentSnapshot.state !== "SETUP" || !inputChoice || !inputChoice.id.startsWith("pa:") || (inputNeedsEndpoint && !elements.ioInputEndpoint.value) || anyTxActive;
  elements.closeIoOutput.disabled = currentSnapshot.state !== "SETUP" || (!physicalOutputOpen && output?.state !== "FAULT") || anyTxActive;
  elements.closeIoCueOutput.disabled = currentSnapshot.state !== "SETUP" || (!physicalCueOutputOpen && cueOutput?.state !== "FAULT") || anyTxActive;
  elements.closeIoInput.disabled = currentSnapshot.state !== "SETUP" || (!physicalInputOpen && input?.state !== "FAULT") || anyTxActive;

}

function renderSharedCue(current) {
  const main = current.output, cue = current.cueOutput;
  const ready = main?.state === "READY" && main.selectedDeviceId?.startsWith("pa:");
  const independent = cue?.state === "READY" && cue.selectedDeviceId?.startsWith("pa:");
  const width = elements.sharedCueMode.value === "MONO" ? 1 : 2;
  const options = Array.from({ length: ready ? Math.max(0, main.activeChannelCount - width + 1) : 0 }, (_, output) => {
    const occupied = selectedOutputConflict(current, output, width === 2 ? "DUAL_MONO" : "MONO", { monitor: true });
    return { value: String(output), label: `OUT ${output + 1}${width === 2 ? `/${output + 2}` : ""}${occupied.length ? " · 使用中" : ""}`, disabled: occupied.length > 0 };
  });
  syncControlSelect(elements.sharedCueChannel, [{ value: "", label: "空き出力を選択" }, ...options]);
  const locked = current.state !== "SETUP" || (current.discord?.txStems ?? []).some(stem => stem.active);
  elements.sharedCueChannel.disabled = locked || !ready || independent;
  elements.sharedCueMode.disabled = elements.sharedCueChannel.disabled;
  elements.applySharedCue.disabled = elements.sharedCueChannel.disabled || elements.sharedCueChannel.value === "" || Boolean(options.find(option => option.value === elements.sharedCueChannel.value)?.disabled);
  elements.clearSharedCue.disabled = locked || !current.monitorOutput;
  const assigned = current.monitorOutput;
  elements.sharedCueState.textContent = assigned ? `共有Cue：${main?.selectedDeviceName ?? "Main"} · ${main?.selectedHostApi ?? ""} · OUT ${assigned.leftOutput + 1}${assigned.mode === "DUAL_MONO" ? `/${assigned.leftOutput + 2}` : ""}`
    : independent ? "独立Cueを停止すると共有Cueを設定できます" : "共有Cue：未割当";
}

function applySharedCue() {
  if (!snapshot || snapshot.state !== "SETUP" || elements.applySharedCue.disabled) return;
  if (snapshot.output?.state !== "READY" || !snapshot.output.selectedDeviceId?.startsWith("pa:") || (snapshot.cueOutput?.state === "READY" && snapshot.cueOutput.selectedDeviceId?.startsWith("pa:")) || snapshot.discord?.txStems?.some(stem => stem.active)) return;
  const output = Number(elements.sharedCueChannel.value), mode = elements.sharedCueMode.value;
  if (!["MONO", "DUAL_MONO"].includes(mode) || elements.sharedCueChannel.value === "" || !Number.isInteger(output) || output < 0 || output + (mode === "MONO" ? 1 : 2) > snapshot.output.activeChannelCount || selectedOutputConflict(snapshot, output, mode, { monitor: true }).length) return;
  if (!confirm(`MainデバイスのOUT ${output + 1}${mode === "DUAL_MONO" ? `/${output + 2}` : ""}をCue専用にしますか？\n本線の出力chと接続先を確認してください。`)) return;
  sendCommand({ type: "SET_MONITOR_OUTPUT", output, mode });
}

function renderRouteOverview(currentSnapshot) {
  renderGroupBuses(currentSnapshot);
  const routes = configuredVoiceRoutes(currentSnapshot);
  const rxBots = routeBots(currentSnapshot, ["RX", "DUPLEX", "SPARE"]);
  const txBots = routeBots(currentSnapshot, ["TX", "DUPLEX"]);
  const localInputs = currentSnapshot.channels.filter((channel) => channel.kind === "LocalMonoInput" || channel.kind === "LocalStereoInput");
  const outputNameplate = audioDeviceNameplate(currentSnapshot.output?.selectedDeviceName) || "物理出力";
  const inputNameplate = audioDeviceNameplate(currentSnapshot.input?.selectedDeviceName) || "物理入力";
  const output = currentSnapshot.output;
  const device = output?.devices?.find((candidate) => candidate.id === output.selectedDeviceId);
  const outputOpen = device?.backend === "portaudio" && output?.state === "READY";
  const outputCount = outputOpen ? output.activeChannelCount : device?.maxOutputChannels ?? output?.activeChannelCount ?? 0;
  routeMatrixBank = Math.min(routeMatrixBank, Math.max(0, Math.ceil(outputCount / 16) - 1));
  const mode = elements.routeMatrixMode.value;
  const step = mode === "DUAL_MONO" ? 2 : 1;
  const outputsInBank = [];
  for (let index = routeMatrixBank * 16; index + step <= Math.min(outputCount, (routeMatrixBank + 1) * 16); index += step) outputsInBank.push(index);
  const teamBuses = teamRxBuses(currentSnapshot);
  const teamAssignment = commonTeamOutput(teamBuses);
  const locked = currentSnapshot.state === "ON_AIR" || currentSnapshot.state === "FAULT";
  const signature = JSON.stringify({
    selectedVc: selectedRouteVcKey,
    expanded: [...expandedRouteVcs],
    groupBuses: currentSnapshot.buses.map(bus => [bus.id, bus.label, bus.groupSourceIds]),
    directChannels: currentSnapshot.channels.map(channel => [channel.id, channel.label, channel.currentVoiceChannelId, channel.directOutput]),
    matrix: [routeMatrixBank, mode, outputCount, currentSnapshot.state, output?.state, currentSnapshot.cueOutput?.state, currentSnapshot.cueOutput?.selectedDeviceId, currentSnapshot.monitorSourceId, currentSnapshot.monitorOutput],
    claims: [...physicalOutputClaims(currentSnapshot)],
    routes: routes.map((route) => [
      route.key,
      route.group?.voiceChannelName,
      route.group?.ownerProfileId,
      route.group?.status,
      route.group?.receivers.map((receiver) => [receiver.profileId, receiver.label, receiver.health, receiver.state]),
      route.stems.map((stem) => [stem.profileId, stem.label, stem.voiceChannelName, stem.state, stem.active, stem.sourceOutput, stem.sourceInputChannelId]),
    ]),
    inputs: localInputs.map((channel) => [channel.id, channel.label, Object.entries(channel.vcSends ?? {}).map(([busId, send]) => [busId, send.mute])]),
    devices: [currentSnapshot.output?.selectedDeviceName, currentSnapshot.input?.selectedDeviceName, currentSnapshot.cueOutput?.selectedDeviceName],
    buses: currentSnapshot.buses.map((bus) => [bus.id, bus.linkedDiscordGuildId, bus.linkedDiscordVoiceChannelId, bus.participantCount, bus.physicalOutputs?.map((binding) => binding.output)]),
  });
  if (signature === routeOverviewSignature) return;
  routeOverviewSignature = signature;

  elements.routeOverviewCount.textContent = routes.length + " VC";
  const cueDevice = currentSnapshot.cueOutput?.devices?.find((candidate) => candidate.id === currentSnapshot.cueOutput.selectedDeviceId);
  const cueTarget = currentSnapshot.cueOutput?.state === "READY" && cueDevice?.backend === "portaudio"
    ? audioDeviceNameplate(currentSnapshot.cueOutput.selectedDeviceName)
    : currentSnapshot.monitorOutput ? `Main内Monitor${physicalMonitorReady(currentSnapshot) ? "" : "（停止中）"}` : "未設定／停止中";
  elements.routeMatrixDevice.textContent = `Main: ${outputNameplate} · ${outputOpen ? "READY" : "出力停止中（SETUPで開始）"} ｜ Cue: ${cueTarget}`;
  elements.routeMatrixBank.textContent = outputCount ? `OUT ${routeMatrixBank * 16 + 1}–${Math.min(outputCount, (routeMatrixBank + 1) * 16)} / ${outputCount}` : "出力chなし";
  elements.routeMatrixPrev.disabled = routeMatrixBank === 0;
  elements.routeMatrixNext.disabled = (routeMatrixBank + 1) * 16 >= outputCount;
  const table = document.createElement("table");
  table.className = "route-matrix";
  const head = table.createTHead().insertRow();
  for (const label of ["VC ＼ OUT", "出力なし", ...outputsInBank.map((index) => step === 2 ? `OUT ${index + 1}/${index + 2}` : `OUT ${index + 1}`), "CUE"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    head.append(cell);
  }
  const body = table.createTBody();
  function appendDirectRow(channel) {
    const row = body.insertRow(), label = document.createElement("th");
    row.className = "matrix-direct"; label.scope = "row";
    label.textContent = `↳ ${participantDisplayName(currentSnapshot, channel)} · Direct ${channel.directOutput?.tap ?? "PRE"}`;
    row.append(label);
    for (const output of [null, ...outputsInBank]) {
      const active = output === null ? !channel.directOutput : channel.directOutput?.output === output;
      const conflict = output !== null && selectedOutputConflict(currentSnapshot, output, "MONO", { channelId: channel.id }).length > 0;
      const button = document.createElement("button"); button.type = "button"; button.className = `matrix-crosspoint${active ? " assigned" : ""}`;
      button.textContent = active ? "✓" : conflict ? "×" : "—";
      button.title = `${channel.label} → ${output === null ? "出力なし" : `OUT ${output + 1}`}${step !== 1 ? "（DirectはMONO表示で設定）" : ""}`;
      button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", String(active));
      button.disabled = locked || step !== 1 || conflict || (output === null ? active : !outputOpen);
      button.addEventListener("click", () => applyMatrixDirect(channel.id, active ? null : output));
      row.insertCell().append(button);
    }
    const cue = document.createElement("button"); cue.type = "button"; cue.textContent = currentSnapshot.monitorSourceId === channel.id ? "✓" : "—";
    cue.setAttribute("aria-label", `${channel.label} CUE`); cue.disabled = !physicalMonitorReady(currentSnapshot) || currentSnapshot.state === "FAULT";
    cue.addEventListener("click", () => sendCommand({ type: "SET_PFL", sourceId: snapshot?.monitorSourceId === channel.id ? null : channel.id }));
    row.insertCell().append(cue);
  }

  function appendOutputCells(row, buses, team, sourceLabel = "TeamBus（全RX VC合算）") {
    const assigned = (team && !teamAssignment ? [] : buses[0]?.physicalOutputs?.map((binding) => binding.output)) ?? [];
    const teamActive = !team && teamBuses.length > 1 && Boolean(teamAssignment) && teamBuses.some((bus) => bus.id === buses[0]?.id);
    const ignore = { busIds: (teamActive ? teamBuses : buses).map((bus) => bus.id) };
    for (const target of [null, ...outputsInBank]) {
      const indices = target === null ? [] : Array.from({ length: step }, (_, offset) => target + offset);
      const active = target === null ? !assigned.length && buses.every((bus) => !bus.physicalOutputs?.length) : indices.every((index) => assigned.includes(index));
      const partial = target !== null && !active && indices.some((index) => assigned.includes(index));
      const conflicts = target === null ? [] : selectedOutputConflict(currentSnapshot, target, mode, ignore);
      const advanced = buses.some((bus) => bus.physicalOutputs?.length > 2);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `matrix-crosspoint ${conflicts.length ? "conflict" : target === null ? "" : active || partial ? outputOpen ? "assigned" : "stopped" : ""}`;
      button.textContent = conflicts.length ? "×" : active ? "✓" : partial ? "•" : "—";
      button.setAttribute("aria-pressed", String(active));
      const label = target === null ? "出力なし" : `OUT ${indices.map((index) => index + 1).join("/")}`;
      button.title = `${sourceLabel} → ${label}${conflicts.length ? ` · 使用中: ${conflicts.join(" / ")}` : partial ? " · 一部割り当て済み" : active ? " · 割り当て済み" : ""}${teamActive ? " · TeamBus行から変更してください" : ""}`;
      button.setAttribute("aria-label", button.title);
      button.disabled = locked || !buses.length || teamActive || conflicts.length > 0 || (target === null ? active : !active && (!outputOpen || advanced));
      button.addEventListener("click", () => applyRouteOutput(buses.map((bus) => bus.id), active ? null : target, mode, team));
      row.insertCell().append(button);
    }
  }
  for (const bus of currentSnapshot.buses.filter(bus => Array.isArray(bus.groupSourceIds))) {
    const row = body.insertRow(), label = document.createElement("th");
    label.scope = "row"; label.textContent = `${bus.label} · GROUP ${bus.groupSourceIds.length} VC`; row.append(label);
    appendOutputCells(row, [bus], false, bus.label);
    const cue = document.createElement("button"); cue.type = "button";
    cue.textContent = currentSnapshot.monitorSourceId === bus.id ? "✓" : "—";
    cue.setAttribute("aria-label", `${bus.label} CUE`);
    cue.disabled = currentSnapshot.state === "FAULT" || !physicalMonitorReady(currentSnapshot);
    cue.addEventListener("click", () => sendCommand({ type: "SET_PFL", sourceId: snapshot?.monitorSourceId === bus.id ? null : bus.id }));
    row.insertCell().append(cue);
  }
  if (teamBuses.length) {
    const row = body.insertRow();
    row.className = "matrix-team";
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = `TeamBus · 全${teamBuses.length} RX VC合算`;
    row.append(label);
    appendOutputCells(row, teamBuses, true);
    row.insertCell().textContent = "—";
  }
  for (const voiceRoute of routes) {
    const group = voiceRoute.group;
    const rxBot = rxBots.find((candidate) => routeVcKey(candidate.guildId, candidate.voiceChannelId) === voiceRoute.key && candidate.profileId === group?.ownerProfileId)
      ?? rxBots.find((candidate) => routeVcKey(candidate.guildId, candidate.voiceChannelId) === voiceRoute.key);
    const txBot = txBots.find((candidate) => routeVcKey(candidate.guildId, candidate.voiceChannelId) === voiceRoute.key);
    const displayBot = rxBot ?? txBot ?? (currentSnapshot.discord?.bots ?? []).find((candidate) => routeVcKey(candidate.guildId, candidate.voiceChannelId) === voiceRoute.key && candidate.health !== "STALE");
    const bus = currentSnapshot.buses.find((candidate) => (
      candidate.linkedDiscordGuildId === voiceRoute.guildId
      && candidate.linkedDiscordVoiceChannelId === voiceRoute.voiceChannelId
    ));
    const outputs = bus?.physicalOutputs?.length
      ? bus.physicalOutputs.map((binding) => "OUT " + (binding.output + 1)).join(" / ")
      : "未割当";
    const txInputLabels = new Set();
    for (const stem of voiceRoute.stems) {
      const input = localInputs.find(channel => channel.id === stem.sourceInputChannelId);
      if (input) txInputLabels.add(`${inputNameplate} · ${input.label}`);
    }

    const row = body.insertRow();
    row.className = voiceRoute.key === selectedRouteVcKey ? "selected" : "";
    const identity = document.createElement("button");
    identity.type = "button";
    const voiceName = group?.voiceChannelName ?? voiceRoute.stems[0]?.voiceChannelName ?? ("VC ···" + voiceRoute.voiceChannelId.slice(-4));
    identity.textContent = displayBot ? `${displayBot.label} · ${voiceName}` : voiceName;
    identity.className = group && group.status !== "ACTIVE" ? "warning" : "";
    const txState = voiceRoute.stems.some((stem) => stem.active) ? "送信中" : "停止";
    const rxSummary = group ? "RX: " + outputNameplate + " · " + outputs : "";
    const txSummary = voiceRoute.stems.length ? "TX: " + ([...txInputLabels].join(" / ") || "未接続") + "（" + txState + "）" : "";
    identity.title = [(displayBot?.guildName ?? voiceRoute.guildId) + " · " + (bus?.participantCount ?? 0) + "人", rxSummary, txSummary].filter(Boolean).join(" / ");
    identity.addEventListener("click", () => {
      selectedRouteVcKey = voiceRoute.key;
      if (expandedRouteVcs.has(voiceRoute.key)) expandedRouteVcs.delete(voiceRoute.key); else expandedRouteVcs.add(voiceRoute.key);
      ioOptionsSignature = "";
      routeOverviewSignature = "";
      renderIo(snapshot);
      renderRouteOverview(snapshot);
    });
    const label = document.createElement("th");
    label.scope = "row";
    label.append(identity);
    row.append(label);
    appendOutputCells(row, bus && group ? [bus] : [], false, identity.textContent);
    const cue = document.createElement("button");
    cue.type = "button";
    cue.className = "matrix-crosspoint matrix-cue" + (bus && currentSnapshot.monitorSourceId === bus.id ? " assigned" : "");
    cue.textContent = bus && currentSnapshot.monitorSourceId === bus.id ? "✓" : "—";
    cue.setAttribute("aria-pressed", String(Boolean(bus && currentSnapshot.monitorSourceId === bus.id)));
    cue.setAttribute("aria-label", `${identity.textContent}のVC MASTER CUE（1ソースのみ）`);
    cue.title = cue.getAttribute("aria-label");
    cue.disabled = !bus || !group || !physicalMonitorReady(currentSnapshot) || currentSnapshot.state === "FAULT";
    cue.addEventListener("click", () => {
      if (!snapshot || snapshot.state === "FAULT" || !physicalMonitorReady(snapshot) || !snapshot.buses.some((candidate) => candidate.id === bus.id)) return;
      sendCommand({ type: "SET_PFL", sourceId: snapshot.monitorSourceId === bus.id ? null : bus.id });
    });
    row.insertCell().append(cue);
    if (expandedRouteVcs.has(voiceRoute.key)) {
      for (const channel of currentSnapshot.channels.filter(channel => channel.kind === "DiscordUser" && channel.currentVoiceChannelId === voiceRoute.voiceChannelId)) appendDirectRow(channel);
    }
  }
  if (!routes.length && !localInputs.length && !currentSnapshot.buses.some(bus => Array.isArray(bus.groupSourceIds))) {
    const empty = document.createElement("p");
    empty.className = "route-overview-empty";
    empty.textContent = "—";
    elements.vcRouteList.replaceChildren(empty);
    return;
  }
  elements.vcRouteList.replaceChildren(table);
}

function applyMatrixDirect(channelId, output) {
  if (!snapshot || ["ON_AIR", "FAULT"].includes(snapshot.state)) return;
  const channel = snapshot.channels.find(channel => channel.id === channelId);
  if (!channel) return;
  if (output !== null && (snapshot.output?.state !== "READY" || !snapshot.output.devices?.some(device => device.id === snapshot.output.selectedDeviceId && device.backend === "portaudio") || !Number.isInteger(output) || output < 0 || output >= (snapshot.output?.activeChannelCount ?? 0) || selectedOutputConflict(snapshot, output, "MONO", { channelId }).length)) return;
  if (!confirm(`${channel.label}のDirect Outを${output === null ? "解除" : `OUT ${output + 1}へ割当`}しますか？`)) return;
  sendCommand(output === null ? { type: "CLEAR_DIRECT_OUTPUT", channelId } : { type: "SET_DIRECT_OUTPUT", channelId, output, tap: channel.directOutput?.tap ?? "PRE", confirmed: true });
}

function renderGroupBuses(current) {
  const select = elements.groupBusSelect, members = elements.groupBusMembers;
  const groups = current.buses.filter(bus => Array.isArray(bus.groupSourceIds));
  const sources = current.buses.filter(bus => !Array.isArray(bus.groupSourceIds) && bus.linkedDiscordVoiceChannelId);
  syncControlSelect(select, [{ value: "", label: "新規グループ" }, ...groups.map(bus => ({ value: bus.id, label: bus.label }))]);
  const selected = groups.find(bus => bus.id === select.value);
  const signature = JSON.stringify([select.value, sources.map(bus => [bus.id, bus.label]), selected?.groupSourceIds]);
  if (members.dataset.signature !== signature) {
    members.dataset.signature = signature;
    members.replaceChildren(...sources.map(bus => {
      const label = document.createElement("label"), box = document.createElement("input");
      box.type = "checkbox"; box.value = bus.id; box.checked = selected?.groupSourceIds.includes(bus.id) ?? false;
      label.append(box, document.createTextNode(bus.label)); return label;
    }));
  }
  const locked = ["ON_AIR", "FAULT"].includes(current.state);
  select.disabled = locked; elements.groupBusName.disabled = locked || Boolean(selected);
  elements.applyGroupBus.disabled = locked || !sources.length;
  elements.removeGroupBus.disabled = locked || !selected;
  for (const box of members.querySelectorAll("input")) box.disabled = locked;
}

function applyGroupBus() {
  if (!snapshot || ["ON_AIR", "FAULT"].includes(snapshot.state)) return;
  const sourceBusIds = [...elements.groupBusMembers.querySelectorAll("input:checked")].map(box => box.value);
  const busId = elements.groupBusSelect.value, name = elements.groupBusName.value.trim();
  if (!busId && !name) return showNotice("グループ名を入力してください", true);
  if (!confirm(`${sourceBusIds.length} VCをグループにまとめますか？\n各VC MIXのフェーダー・MUTEを反映します。既存の出力先は変更しません。`)) return;
  sendCommand(busId ? { type: "SET_GROUP_BUS_SOURCES", busId, sourceBusIds } : { type: "CREATE_VC_BUS", name, groupSourceIds: sourceBusIds });
}

function applyRouteOutput(busIds, output, mode, team = false) {
  if (!snapshot || snapshot.state === "ON_AIR" || snapshot.state === "FAULT") return;
  const buses = snapshot.buses.filter((bus) => busIds.includes(bus.id));
  if (!buses.length || buses.length !== busIds.length) return showNotice("VC MIXを再確認してください", true);
  const teamBuses = teamRxBuses(snapshot);
  if (!team && teamBuses.length > 1 && commonTeamOutput(teamBuses) && buses.some(bus => teamBuses.some(member => member.id === bus.id))) return showNotice("TeamBus行から変更してください", true);
  const bot = team ? null : routeBots(snapshot, ["RX", "DUPLEX", "SPARE"]).find((candidate) => candidate.guildId === buses[0].linkedDiscordGuildId && candidate.voiceChannelId === buses[0].linkedDiscordVoiceChannelId);
  const name = team ? `TeamBus（全${buses.length} RX VC合算）` : [bot?.label, buses[0].label].filter(Boolean).join(" · ");
  if (output === null) {
    const assigned = buses.filter((bus) => bus.physicalOutputs?.length);
    const before = [...new Set(assigned.flatMap((bus) => bus.physicalOutputs.map((binding) => binding.output + 1)))].join("/");
    if (!assigned.length || !confirm(`${name}の物理出力割り当てを解除しますか？\nOUT ${before} → 出力なし\n${assigned.length}個のVC MIXの割り当て全体が外れます。`)) return;
    for (const bus of assigned) sendCommand({ type: "CLEAR_BUS_OUTPUT", busId: bus.id });
    return;
  }
  const device = snapshot.output?.devices?.find((candidate) => candidate.id === snapshot.output.selectedDeviceId);
  if (mode !== "MONO" && mode !== "DUAL_MONO") return showNotice("出力方式を確認してください", true);
  if (buses.some((bus) => bus.physicalOutputs?.length > 2)) return showNotice("Advanced複数出力は自動変更しません。割り当てを解除してから設定してください", true);
  const width = mode === "DUAL_MONO" ? 2 : 1;
  if (device?.backend !== "portaudio" || snapshot.output?.state !== "READY" || !Number.isInteger(output) || output < 0 || output + width > snapshot.output.activeChannelCount) return showNotice("SETUPでMain出力デバイスを開始し、出力chを確認してください", true);
  const conflicts = selectedOutputConflict(snapshot, output, mode, { busIds });
  if (conflicts.length) return showNotice(`選択したPhysical OUTは${conflicts.join(" / ")}が使用中です`, true);
  const target = width === 2 ? `${output + 1}/${output + 2}（同じ音を複製）` : `${output + 1}`;
  const before = [...new Set(buses.flatMap((bus) => bus.physicalOutputs?.map((binding) => binding.output + 1) ?? []))].join("/") || "なし";
  if (!confirm(`${name}\n${snapshot.output.selectedDeviceName}\nOUT ${before} → OUT ${target}${team ? " へ合算" : ""}\n\n音の出力先が変わります。変更しますか？`)) return;
  for (const bus of buses) sendCommand({ type: "SET_BUS_OUTPUT", busId: bus.id, output, mode, ...(team ? { allowCollision: true } : {}), confirmed: true });
}

async function saveBotProfiles(event) {
  event.preventDefault();
  if (!localSettingsAvailable) return;
  if (!settingsSnapshot || snapshot?.state === "ON_AIR" || snapshot?.state === "FAULT") {
    showNotice("ON AIR / FAULT中はBot設定を変更できません", true);
    return;
  }
  if (!elements.setupForm.reportValidity()) return;
  const cards = [...elements.botProfileList.querySelectorAll(".bot-profile-card")];
  const bots = cards.map(botSettingsFromCard);
  const tokenChanged = bots.some((bot) => Boolean(bot.token));
  const prompt = tokenChanged
    ? "Bot設定と新しいTokenをこのPCへ保存しますか？\nTokenは保存後に再表示されません。接続は各Botの「接続確認」で開始します。"
    : "現在のBot設定を保存しますか？\n接続中Botの状態は変更しません。";
  const lanWarning = elements.lanAccessEnabled.checked && !settingsSnapshot.operator?.lanAccess ? "\n\nLAN公開を有効にします。同じLANの誰でも認証なしで操作できます。共有LANでは使用しないでください。" : "";
  if (!confirm(prompt + lanWarning)) return;

  elements.saveBotProfiles.disabled = true;
  elements.setupStatus.textContent = "保存中です";
  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: desktopJsonHeaders,
      body: JSON.stringify({ bots, operator: { port: Number(elements.appPort.value), lanAccess: elements.lanAccessEnabled.checked } }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? "設定を保存できませんでした");
    renderDesktopSettings(payload.settings);
    elements.setupStatus.textContent = "保存済み";
    showNotice("設定を保存しました。LAN公開・Port変更は再起動後に反映されます");

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.setupStatus.textContent = message;
    showNotice(message, true);
  } finally {
    elements.saveBotProfiles.disabled = false;
  }
}

function renderSetupRuntime(currentSnapshot) {
  const labels = {
    READY: "接続中",
    CONNECTING: "接続待ち",
    RECONNECTING: "再接続中",
    FAULT: "接続エラー",
    STALE: "切断済み",
    DISCONNECTED: "未接続",
  };
  const locked = currentSnapshot.state === "ON_AIR" || currentSnapshot.state === "FAULT";
  elements.appPort.disabled = locked;
  const runtimes = currentSnapshot.discord?.bots ?? [];
  const channels = currentSnapshot.discord?.availableVoiceChannels ?? [];
  for (const card of elements.botProfileList.querySelectorAll(".bot-profile-card")) {
    const setting = (name) => card.querySelector(`[data-setting="${name}"]`);
    const profileId = setting("id").value.trim();
    const runtimeCandidates = runtimes.filter((bot) => bot.profileId === profileId);
    const runtime = runtimeCandidates.find((bot) => bot.health === "READY")
      ?? runtimeCandidates.find((bot) => bot.health !== "STALE" && bot.health !== "DISCONNECTED")
      ?? runtimeCandidates[0]
      ?? null;
    const health = runtime?.health ?? "DISCONNECTED";
    card.dataset.runtimeHealth = health;
    let recovery = botRecoveries.get(profileId);
    if (recovery && locked) {
      clearTimeout(recovery.timeout);
      botRecoveries.delete(profileId);
      showNotice(`${recovery.label}の復旧を設定ロックにより中止しました`, true);
      recovery = null;
    }
    if (recovery?.phase === "disconnecting" && (!runtime || health === "DISCONNECTED" || health === "STALE")) {
      recovery.phase = "connecting";
      if (!sendCommand({ type: "CONNECT_DISCORD_BOT", profileId })) {
        clearTimeout(recovery.timeout);
        botRecoveries.delete(profileId);
        recovery = null;
      }
    }
    if (recovery?.phase === "connecting" && health === "READY") {
      clearTimeout(recovery.timeout);
      botRecoveries.delete(profileId);
      showNotice(`${recovery.label}を復旧しました`);
      recovery = null;
    }
    const recovering = Boolean(recovery);
    const voice = channels.find((channel) => channel.guildId === setting("guildId").value.trim() && channel.id === setting("voiceChannelId").value.trim());
    const runtimeState = card.querySelector('[data-field="runtime-state"]');
    const runtimeConnected = Boolean(runtime && health !== "DISCONNECTED" && health !== "STALE");
    card.dataset.runtimeConnected = String(runtimeConnected);
    const missing = [];
    if (card.dataset.tokenConfigured !== "true" && !setting("token").value) missing.push("Token");
    if (!setting("guildId").value.trim()) missing.push("Server ID");
    if (!setting("voiceChannelId").value.trim()) missing.push("VC ID");
    const incomplete = !runtimeConnected && setting("enabled").checked && missing.length > 0;
    const tone = recovering ? "warning" : health === "READY" ? "ready" : health === "FAULT" ? "danger" : health === "CONNECTING" || health === "RECONNECTING" || incomplete ? "warning" : "";
    runtimeState.textContent = recovering ? recovery.phase === "disconnecting" ? "切断確認中" : "再接続中" : incomplete ? "未設定" : !runtimeConnected && !setting("enabled").checked ? "無効" : labels[health] ?? health;
    runtimeState.className = `bot-profile-state ${tone}`;
    runtimeState.title = incomplete ? `${missing.join(" / ")}を詳細で設定してください` : "";
    card.dataset.statusTone = tone;
    const guildName = card.querySelector('[data-field="guild-name"]');
    const voiceName = card.querySelector('[data-field="voice-name"]');
    guildName.textContent = runtime?.guildName ?? (setting("guildId").value ? "Server未確認" : "Server未設定");
    voiceName.textContent = runtime?.voiceChannelName ?? voice?.name ?? (setting("voiceChannelId").value ? "VC未確認" : "VC未設定");
    guildName.title = guildName.textContent;
    voiceName.title = voiceName.textContent;
    for (const field of card.querySelectorAll("input, select")) field.disabled = locked || recovering;
    setting("id").readOnly = true;
    if (!locked && !recovering) updateBotProfileTxFields(card);
    refreshBotProfileLocationOptions(card);
    const connect = card.querySelector('[data-action="connect"]');
    const needsRecovery = health === "FAULT" || health === "RECONNECTING";
    connect.textContent = needsRecovery ? "復旧" : "接続";
    connect.classList.toggle("primary-action", needsRecovery);
    connect.disabled = locked || recovering || settingsDirty || !setting("enabled").checked || health === "READY" || health === "CONNECTING";
    card.querySelector('[data-action="disconnect"]').disabled = locked || recovering || !runtime || health === "DISCONNECTED" || health === "STALE";
    const remove = card.querySelector('[data-action="remove"]');
    remove.disabled = locked || runtimeConnected;
    remove.title = runtimeConnected ? "先にこのBotを切断してください" : "";
  }
  elements.saveBotProfiles.disabled = locked || settingsLoading || !settingsDirty;
  for (const field of [elements.lanAccessEnabled, elements.sharedGuildId, elements.importBotProfiles]) field.disabled = locked || !localSettingsAvailable || settingsLoading;
  elements.exportBotProfiles.disabled = !localSettingsAvailable || settingsLoading || !settingsSnapshot;
  updateBotProfileCount();
}

function renderRestart(currentSnapshot) {
  const recorderState = currentSnapshot.recorder?.state ?? "IDLE";
  const blocked = !localSettingsAvailable || restartRequested || shutdownRequested || currentSnapshot.state === "ON_AIR" || currentSnapshot.state === "FAULT" || recorderState !== "IDLE";
  elements.restartRouter.disabled = blocked;
  elements.shutdownRouter.disabled = blocked;
  elements.restartDetail.hidden = !blocked;
  elements.restartDetail.textContent = !localSettingsAvailable ? "このPCからのみ操作できます" : restartRequested
    ? "再起動しています"
    : currentSnapshot.state === "ON_AIR"
      ? "設定ロックをOFFにすると再起動・終了できます"
      : currentSnapshot.state === "FAULT"
        ? "先に障害を確認してください"
        : recorderState !== "IDLE"
          ? "録音処理が終わるまで再起動・終了できません"
          : "設定ロックOFF・録音停止中のみ再起動・終了できます";
}

function renderTxAssignments(currentSnapshot) {
  const stems = currentSnapshot.discord?.txStems ?? [];
  const inputs = currentSnapshot.channels.filter(channel => channel.kind === "LocalMonoInput");
  const connected = socket?.readyState === WebSocket.OPEN;
  const locked = !connected || ["ON_AIR", "FAULT"].includes(currentSnapshot.state);
  const signature = JSON.stringify([locked, currentSnapshot.emergencyMuted, currentSnapshot.input?.state,
    currentSnapshot.input?.selectedDeviceId, inputs.map(channel => [channel.id, channel.label]),
    stems.map(stem => [stem.profileId, stem.label, stem.state, stem.active, stem.voiceChannelId, stem.voiceChannelName, stem.audioMode, stem.sourceInputChannelId, stem.sourceInputRightChannelId, stem.sourceOutput])]);
  if (signature === txAssignmentSignature) return;
  txAssignmentSignature = signature;
  const table = document.createElement("table"); table.className = "route-matrix tx-input-matrix";
  const head = document.createElement("thead"), header = document.createElement("tr");
  const corner = document.createElement("th"); corner.textContent = "INPUT ＼ TX BOT"; header.append(corner);
  for (const stem of stems) {
    const cell = document.createElement("th"); cell.scope = "col";
    const name = document.createElement("strong"); name.textContent = stem.label ?? stem.profileId;
    name.title = name.textContent;
    const mode = document.createElement("small"); mode.textContent = `${stem.audioMode ?? "MONO"} · ${stem.state}`;
    const status = document.createElement("small");
    status.textContent = stem.sourceInputChannelId ? inputs.find(input => input.id === stem.sourceInputChannelId)?.label ?? "入力消失" : "入力未割当";
    status.title = status.textContent;
    cell.append(name, mode, status); header.append(cell);
  }
  head.append(header); table.append(head);
  const body = document.createElement("tbody");
  for (const input of [null, ...inputs]) {
    const row = document.createElement("tr"), label = document.createElement("th"); label.scope = "row";
    label.textContent = input?.label ?? "割り当て解除"; row.append(label);
    for (const stem of stems) {
      const cell = document.createElement("td"), button = document.createElement("button");
      const rightSelected = Boolean(input && stem.audioMode === "STEREO" && stem.sourceInputRightChannelId === input.id);
      const selected = stem.sourceInputChannelId === (input?.id ?? null) || rightSelected;
      const nextInput = input?.id.match(/^local-input:(\d+)$/)?.[1];
      const validPair = nextInput && inputs.some(channel => channel.id === `local-input:${Number(nextInput) + 1}`);
      button.type = "button"; button.className = `matrix-crosspoint${selected ? " assigned" : ""}`;
      button.textContent = selected ? input && stem.audioMode === "STEREO" ? rightSelected ? "R" : "L" : "✓" : "—"; button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `${input?.label ?? "解除"} → ${stem.label ?? stem.profileId}`);
      button.disabled = locked || stem.active || Boolean(input && !selected && stem.audioMode === "STEREO" && !validPair);
      button.addEventListener("click", () => setTxAssignmentInput(stem.profileId, selected ? null : input?.id ?? null));
      cell.append(button); row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  if (!stems.length) {
    const empty = document.createElement("p"); empty.textContent = "—";
    elements.txAssignmentList.replaceChildren(empty);
  } else elements.txAssignmentList.replaceChildren(table);
}

function setTxAssignmentInput(profileId, channelId) {
  const stem = snapshot?.discord?.txStems?.find(stem => stem.profileId === profileId);
  if (!stem || stem.active || ["ON_AIR", "FAULT"].includes(snapshot.state)) return;
  if (channelId !== null && !snapshot.channels.some(channel => channel.id === channelId && channel.kind === "LocalMonoInput")) return;
  if (channelId !== null && stem.audioMode === "STEREO") {
    const index = channelId.match(/^local-input:(\d+)$/)?.[1];
    if (!index || !snapshot.channels.some(channel => channel.id === `local-input:${Number(index) + 1}` && channel.kind === "LocalMonoInput")) return;
  }
  sendCommand({ type: "SET_TX_INPUT", profileId, channelId });
}

function operateTxAssignment(profileId, start) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const stem = snapshot?.discord?.txStems?.find(stem => stem.profileId === profileId);
  const input = snapshot?.channels.find(channel => channel.id === stem?.sourceInputChannelId);
  const right = snapshot?.channels.find(channel => channel.id === stem?.sourceInputRightChannelId);
  if (!stem || (start && (snapshot.state === "FAULT" || stem.active || stem.state !== "READY" || snapshot.emergencyMuted || input?.kind !== "LocalMonoInput" || (stem.audioMode === "STEREO" && right?.kind !== "LocalMonoInput") || snapshot.input?.state !== "READY" || !snapshot.input?.selectedDeviceId?.startsWith("pa:")))) return;
  if (!confirm(`${stem.label ?? profileId}の送信を${start ? "開始" : "停止"}しますか？\n${stem.voiceChannelName ?? stem.voiceChannelId} · ${input?.label ?? "入力未割当"}`)) return;
  sendCommand(start ? { type: "START_TX", profileId, confirmed: true } : { type: "STOP_TX", profileId, confirmed: true });
}

function renderTestTones(currentSnapshot) {
  const count = currentSnapshot.output?.activeChannelCount ?? 0;
  if (elements.outputTestTones.children.length !== count) {
    elements.outputTestTones.replaceChildren();
    for (let output = 0; output < count; output += 1) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = `OUT ${output + 1}`; button.dataset.output = String(output);
      button.addEventListener("click", () => toggleOutputTestTone(output));
      elements.outputTestTones.append(button);
    }
  }
  const active = new Set(currentSnapshot.output?.testToneOutputs ?? []);
  for (const button of elements.outputTestTones.children) {
    button.classList.toggle("active", active.has(Number(button.dataset.output)));
    button.setAttribute("aria-pressed", String(active.has(Number(button.dataset.output))));
    button.disabled = ["ON_AIR", "FAULT"].includes(currentSnapshot.state) || currentSnapshot.output?.state !== "READY";
  }
}

function toggleOutputTestTone(output) {
  if (!snapshot || ["ON_AIR", "FAULT"].includes(snapshot.state) || snapshot.output?.state !== "READY" || output >= snapshot.output.activeChannelCount) return;
  const active = !(snapshot.output.testToneOutputs ?? []).includes(output);
  sendCommand({ type: "SET_OUTPUT_TEST_TONE", output, active });
}

function meterDb(value) {
  if (!Number.isFinite(value) || value <= 0.000001) return -Infinity;
  return 20 * Math.log10(value);
}

function meterPercent(value) {
  const db = meterDb(value);
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function meterLabel(value) {
  const db = meterDb(value);
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : "−∞";
}

function interpolateCurve(value, valueIndex, resultIndex) {
  const first = FADER_CURVE[0], last = FADER_CURVE[FADER_CURVE.length - 1];
  if (value <= first[valueIndex]) return first[resultIndex];
  if (value >= last[valueIndex]) return last[resultIndex];
  for (let index = 1; index < FADER_CURVE.length; index += 1) {
    const upper = FADER_CURVE[index], lower = FADER_CURVE[index - 1];
    if (value <= upper[valueIndex]) return lower[resultIndex] + (value - lower[valueIndex]) / (upper[valueIndex] - lower[valueIndex]) * (upper[resultIndex] - lower[resultIndex]);
  }
  return last[resultIndex];
}

function dbToFaderPosition(value) {
  return Math.round(interpolateCurve(Math.max(-90, Math.min(12, value)), 0, 1) * 10);
}

function faderPositionToDb(value) {
  return Math.round(interpolateCurve(Math.max(0, Math.min(1000, value)) / 10, 1, 0) * 10) / 10;
}

function clampDb(value) {
  return Math.max(-90, Math.min(12, Number(value)));
}

function updateMeter(fill, output, meter, vertical = false) {
  const peak = meter?.peak ?? 0;
  fill.style[vertical ? "height" : "width"] = `${meterPercent(peak)}%`;
  if (output) output.textContent = meterLabel(peak);
  const track = fill.parentElement;
  if (!track) return;
  let rms = track.querySelector(".meter-rms"), hold = track.querySelector(".meter-peak-hold");
  if (!rms) { rms = document.createElement("i"); rms.className = "meter-rms"; track.append(rms); }
  if (!hold) { hold = document.createElement("i"); hold.className = "meter-peak-hold"; track.append(hold); }
  const now = performance.now(), percent = meterPercent(peak);
  if (percent >= Number(track.dataset.heldPeak ?? 0) || now >= Number(track.dataset.holdUntil ?? 0)) { track.dataset.heldPeak = String(percent); track.dataset.holdUntil = String(now + 1500); }
  rms.style[vertical ? "height" : "width"] = `${meterPercent(meter?.rms ?? 0)}%`;
  rms.style[vertical ? "width" : "height"] = "35%";
  hold.style[vertical ? "bottom" : "left"] = `${Math.min(99, Number(track.dataset.heldPeak))}%`;
  hold.classList.toggle("vertical", vertical);
  track.classList.toggle("clipping", peak >= 0.999);
  track.title = `Peak ${meterLabel(peak)} · RMS ${meterLabel(meter?.rms ?? 0)}${peak >= 0.999 ? " · CLIP" : ""}`;
}

function pickPrimaryBot(currentSnapshot) {
  const bots = (currentSnapshot.discord?.bots ?? []).filter((bot) => bot.role === "RX" || bot.role === "DUPLEX");
  const held = bots.find((bot) => bot.key === primaryBotKey);
  if (held && held.health !== "STALE" && held.health !== "DISCONNECTED") return held;
  const chosen = bots.find((bot) => bot.health === "READY")
    ?? bots.find((bot) => bot.health !== "STALE" && bot.health !== "DISCONNECTED")
    ?? held
    ?? bots[bots.length - 1]
    ?? null;
  primaryBotKey = chosen?.key ?? null;
  return chosen;
}

function mixBots(currentSnapshot) {
  return routeBots(currentSnapshot, ["RX", "DUPLEX"]);
}

function selectedMixBot(currentSnapshot) {
  if (selectedMixBotProfileId === "all") return null;
  const selected = mixBots(currentSnapshot).find((bot) => bot.profileId === selectedMixBotProfileId) ?? null;
  if (!selected) selectedMixBotProfileId = "all";
  return selected;
}

function renderMixBotFilter(currentSnapshot) {
  const bots = mixBots(currentSnapshot);
  const signature = JSON.stringify({
    selected: selectedMixBotProfileId,
    bots: bots.map((bot) => [bot.profileId, bot.label, bot.health, bot.voiceChannelName]),
  });
  if (signature === mixBotFilterSignature) return;
  mixBotFilterSignature = signature;
  const choices = [{ profileId: "all", label: "すべて" }, ...bots.map((bot) => ({ profileId: bot.profileId, label: bot.label }))];
  const buttons = choices.map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice.label;
    button.classList.toggle("active", choice.profileId === selectedMixBotProfileId);
    button.setAttribute("aria-pressed", String(choice.profileId === selectedMixBotProfileId));
    button.addEventListener("click", () => {
      if (selectedMixBotProfileId === choice.profileId) return;
      selectedMixBotProfileId = choice.profileId;
      mixBankIndex = 0;
      mixBotFilterSignature = "";
      if (snapshot) render(snapshot);
    });
    return button;
  });
  elements.mixBotFilter.replaceChildren(...buttons);
}

function participantSession(currentSnapshot, channel) {
  if (!channel?.discordUserId) return null;
  return (currentSnapshot.userSessions ?? []).find((session) => session.discordUserId === channel.discordUserId) ?? null;
}

function syncControlSelect(select, options) {
  const signature = JSON.stringify(options);
  if (select.dataset.options === signature) return;
  setSelectOptions(select, options);
  select.dataset.options = signature;
}

function participantDisplayName(currentSnapshot, channel) {
  if (!channel?.discordUserId) return channel?.label ?? "Discord participant";
  const profile = (currentSnapshot.userProfiles ?? []).find((candidate) => candidate.discordUserId === channel.discordUserId);
  return profile?.displayName || channel.label;
}

function liveParticipantOrder(current) {
  const offline = new Set((current.userSessions ?? []).filter((session) => !session.online).map((session) => session.discordUserId));
  const live = new Set(current.channels.filter((channel) => channel.kind === "DiscordUser" && channel.discordUserId && !offline.has(channel.discordUserId)).map((channel) => channel.discordUserId));
  return [...(current.userProfiles ?? [])].filter((profile) => live.has(profile.discordUserId))
    .sort((a, b) => a.preferredStripPosition - b.preferredStripPosition || a.discordUserId.localeCompare(b.discordUserId)).map((profile) => profile.discordUserId);
}

function moveParticipant(sourceUserId, targetUserId) {
  if (!snapshot || !["SETUP", "READY"].includes(snapshot.state) || sourceUserId === targetUserId) return;
  const order = liveParticipantOrder(snapshot);
  const from = order.indexOf(sourceUserId), to = order.indexOf(targetUserId);
  if (from < 0 || to < 0) return;
  order.splice(from, 1);
  order.splice(to, 0, sourceUserId);
  sendCommand({ type: "SET_USER_STRIP_ORDER", discordUserIds: order });
}

function visibleParticipants(currentSnapshot, bot, showAll = false) {
  if (!bot && !showAll) return [];
  const voiceChannelId = bot?.voiceChannelId || null;
  return currentSnapshot.channels.filter((channel) => {
    if (channel.kind !== "DiscordUser") return false;
    const session = participantSession(currentSnapshot, channel);
    if (session && !session.online) return false;
    if (!voiceChannelId) return true;
    const channelVoiceId = channel.currentVoiceChannelId ?? session?.currentVC ?? null;
    return channelVoiceId === voiceChannelId;
  }).sort((a, b) => (a.preferredStripPosition ?? Number.MAX_SAFE_INTEGER) - (b.preferredStripPosition ?? Number.MAX_SAFE_INTEGER));
}

function participantBot(currentSnapshot, channel) {
  const session = participantSession(currentSnapshot, channel);
  const voiceChannelId = channel.currentVoiceChannelId ?? session?.currentVC ?? null;
  return mixBots(currentSnapshot).find((bot) => bot.voiceChannelId === voiceChannelId) ?? null;
}

function selectChannel(channelId) {
  selectedChannelId = channelId;
  for (const [id, refs] of stripRefs) refs.node.classList.toggle("selected", id === channelId);
}

function queueFaderCommand(key, value, commandFactory, force = false) {
  const db = clampDb(value);
  queuedFaders.set(key, { db, commandFactory });
  pendingFaders.set(key, { db, expiresAt: performance.now() + 1400 });

  const dispatch = (now) => {
    const queued = queuedFaders.get(key);
    if (!queued) {
      faderFrames.delete(key);
      return;
    }
    const last = lastFaderSend.get(key) ?? 0;
    if (!force && now - last < 40) {
      faderFrames.set(key, requestAnimationFrame(dispatch));
      return;
    }
    queuedFaders.delete(key);
    faderFrames.delete(key);
    lastFaderSend.set(key, now);
    sendCommand(queued.commandFactory(queued.db));
  };

  const existing = faderFrames.get(key);
  if (force && existing) {
    cancelAnimationFrame(existing);
    faderFrames.delete(key);
  }
  if (!faderFrames.has(key)) faderFrames.set(key, requestAnimationFrame(dispatch));
}

function formatDb(value) {
  return Number(value).toFixed(1);
}

function syncFader(key, input, numberInput, serverValue) {
  const pending = pendingFaders.get(key);
  if (pending && Math.abs(pending.db - serverValue) < 0.06) pendingFaders.delete(key);
  else if (pending && performance.now() > pending.expiresAt) pendingFaders.delete(key);

  if (!activeFaders.has(key) && !pendingFaders.has(key)) {
    input.value = String(dbToFaderPosition(serverValue));
    numberInput.value = formatDb(clampDb(serverValue));
  }
}

function bindFader(input, numberInput, keyFactory, commandFactory) {
  let numberStartValue = input.value;
  const activateFader = () => activeFaders.add(keyFactory());
  const finishFader = () => {
    const key = keyFactory();
    if (!activeFaders.has(key)) return;
    activeFaders.delete(key);
    numberInput.value = formatDb(faderPositionToDb(Number(input.value)));
    queueFaderCommand(key, faderPositionToDb(Number(input.value)), commandFactory, true);
  };
  const activateNumber = () => {
    numberStartValue = input.value;
    activeFaders.add(keyFactory());
    numberInput.select();
  };
  const finishNumber = () => {
    const key = keyFactory();
    if (!activeFaders.has(key)) return;
    const raw = numberInput.value.trim();
    const numeric = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(numeric)) {
      activeFaders.delete(key);
      input.value = numberStartValue;
      numberInput.value = formatDb(faderPositionToDb(Number(numberStartValue)));
      showNotice("レベルは -90.0〜+12.0 dB の数値で入力してください", true);
      return;
    }
    const db = Math.round(clampDb(numeric) * 10) / 10;
    input.value = String(dbToFaderPosition(db));
    numberInput.value = formatDb(db);
    activeFaders.delete(key);
    queueFaderCommand(key, db, commandFactory, true);
    if (Math.abs(db - numeric) > 0.0001) showNotice("入力可能範囲の -90.0〜+12.0 dB に補正しました");
  };
  input.addEventListener("pointerdown", activateFader);
  input.addEventListener("focus", activateFader);
  input.addEventListener("pointerup", finishFader);
  input.addEventListener("blur", finishFader);
  input.addEventListener("input", () => {
    const key = keyFactory();
    activeFaders.add(key);
    numberInput.value = formatDb(faderPositionToDb(Number(input.value)));
    queueFaderCommand(key, faderPositionToDb(Number(input.value)), commandFactory);
  });
  input.addEventListener("change", finishFader);
  numberInput.addEventListener("focus", activateNumber);
  numberInput.addEventListener("input", () => {
    const raw = numberInput.value.trim();
    if (raw === "") return;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) input.value = String(dbToFaderPosition(clampDb(numeric)));
  });
  numberInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    finishNumber();
    numberInput.blur();
  });
  numberInput.addEventListener("blur", finishNumber);
}

function legacyPostChannels(currentSnapshot) {
  return currentSnapshot.channels.filter(channel => channel.kind === "DiscordUser"
    && (channel.mute || (Number.isFinite(channel.faderDb) && channel.faderDb !== 0)));
}

function restoreLegacyPost(channelId) {
  if (!localSettingsAvailable || !["SETUP", "READY"].includes(snapshot?.state)) return;
  const channel = legacyPostChannels(snapshot).find(channel => channel.id === channelId);
  if (!channel) return;
  if (!confirm(`${channel.label}の旧POST設定を0 dB / ONに戻しますか？\nPOST経路から音が出る場合があります。VC MIX送出・PRE・CUEの設定は変更しません。`)) return;
  // Restore level before opening the old mute. Never silently migrate stored profiles.
  if (sendCommand({ type: "SET_CHANNEL_FADER", channelId, db: 0 })) {
    sendCommand({ type: "SET_CHANNEL_MUTE", channelId, mute: false });
  }
}

function renderLegacyPostRecovery(currentSnapshot) {
  const channels = legacyPostChannels(currentSnapshot);
  elements.legacyPostRecovery.hidden = !localSettingsAvailable || channels.length === 0;
  const connected = socket?.readyState === WebSocket.OPEN;
  const signature = JSON.stringify([currentSnapshot.state, connected, channels.map(c => [c.id, c.label, c.faderDb, c.mute])]);
  if (elements.legacyPostList.dataset.signature === signature) return;
  elements.legacyPostList.dataset.signature = signature;
  elements.legacyPostList.replaceChildren(...channels.map(channel => {
    const row = document.createElement("div"); row.className = "io-route";
    const label = document.createElement("span");
    label.textContent = `${channel.label} · POST ${channel.faderDb.toFixed(1)} dB / ${channel.mute ? "OFF" : "ON"}`;
    const restore = document.createElement("button"); restore.type = "button";
    restore.textContent = "旧POST設定を解除";
    restore.disabled = !localSettingsAvailable || !connected || !["SETUP", "READY"].includes(currentSnapshot.state);
    restore.addEventListener("click", () => restoreLegacyPost(channel.id));
    row.append(label, restore); return row;
  }));
}

function createStrip(channel) {
  const node = elements.template.content.firstElementChild.cloneNode(true);
  const refs = {
    node,
    number: node.querySelector(".participant-number"),
    name: node.querySelector(".participant-name"),
    scope: node.querySelector(".participant-scope"),
    approval: node.querySelector(".approval-state"),
    allow: node.querySelector(".allow-button"),
    cue: node.querySelector(".cue-toggle"),
    busSendToggle: node.querySelector(".bus-send-toggle"),
    busSendFader: node.querySelector(".bus-send-fader"),
    busSendNumber: node.querySelector(".bus-send-number"),
    inputFill: node.querySelector(".input-meter-fill"),
    inputValue: node.querySelector(".input-meter-value"),
  };
  node.dataset.channelId = channel.id;
  refs.name.addEventListener("dragstart", (event) => {
    if (!["SETUP", "READY"].includes(snapshot?.state)) return event.preventDefault();
    event.dataTransfer.setData("text/plain", node.dataset.userId);
  });
  node.addEventListener("dragover", (event) => {
    if (["SETUP", "READY"].includes(snapshot?.state)) event.preventDefault();
  });
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    moveParticipant(event.dataTransfer.getData("text/plain"), node.dataset.userId);
  });
  node.addEventListener("click", () => selectChannel(node.dataset.channelId));
  node.addEventListener("keydown", (event) => {
    if (event.target !== node || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    selectChannel(node.dataset.channelId);
  });
  refs.allow.addEventListener("click", () => {
    const liveChannel = snapshot?.channels.find((candidate) => candidate.id === node.dataset.channelId);
    const session = participantSession(snapshot, liveChannel);
    if (!liveChannel?.discordUserId || !session) {
      showNotice("参加者の状態が変わりました。表示を確認してください", true);
      return;
    }
    sendCommand({
      type: "SET_PARTICIPANT_APPROVAL",
      channelId: liveChannel.id,
      discordUserId: liveChannel.discordUserId,
      approved: true,
      expectedSessionGeneration: session.sessionGeneration,
      expectedApprovalRevision: session.approvalRevision,
    });
  });
  refs.cue.addEventListener("click", () => {
    const channelId = node.dataset.channelId;
    sendCommand({ type: "SET_PFL", sourceId: snapshot?.monitorSourceId === channelId ? null : channelId });
  });
  refs.busSendToggle.addEventListener("click", () => {
    const liveChannel = snapshot?.channels.find((candidate) => candidate.id === node.dataset.channelId);
    const send = liveChannel?.vcSends?.[node.dataset.busId];
    if (liveChannel && send) {
      sendCommand({
        type: "SET_VC_SEND",
        channelId: liveChannel.id,
        busId: node.dataset.busId,
        mute: !send.mute,
      });
    }
  });
  bindFader(
    refs.busSendFader,
    refs.busSendNumber,
    () => `send:${node.dataset.channelId}:${node.dataset.busId ?? "none"}`,
    (db) => ({ type: "SET_VC_SEND", channelId: node.dataset.channelId, busId: node.dataset.busId ?? "", db }),
  );
  stripRefs.set(channel.id, refs);
  elements.participants.append(refs.node);
  return refs;
}

function renderParticipant(channel, refs, index, currentSnapshot, bus, showScope) {
  const session = participantSession(currentSnapshot, channel);
  const displayName = participantDisplayName(currentSnapshot, channel);
  const bot = participantBot(currentSnapshot, channel);
  const pending = session?.sessionApproval === "PENDING" || channel.approvalGateOpen !== true;
  refs.number.textContent = String(index + 1).padStart(2, "0");
  refs.name.textContent = displayName;
  refs.node.style.setProperty("--participant-color", /^#[0-9a-f]{6}$/i.test(channel.channelColor ?? "") ? channel.channelColor : "#3696f5");
  refs.name.draggable = ["SETUP", "READY"].includes(currentSnapshot.state);
  refs.name.title = "SETUP / READY中は名前をドラッグして並べ替え";
  refs.node.dataset.userId = channel.discordUserId;
  refs.node.style.order = String(index);
  refs.scope.textContent = `${bot?.label ?? "RX Bot"} · ${bot?.voiceChannelName ?? bus?.label ?? "VC確認中"}`;
  refs.scope.hidden = !showScope;
  refs.node.classList.toggle("pending", pending);
  refs.node.classList.toggle("selected", selectedChannelId === channel.id);
  refs.approval.textContent = pending ? "PENDING" : "APPROVED";
  refs.approval.classList.toggle("pending", pending);
  refs.allow.hidden = !pending;
  refs.allow.disabled = !session;

  const cueActive = currentSnapshot.monitorSourceId === channel.id;
  refs.cue.disabled = !physicalMonitorReady(currentSnapshot);
  refs.cue.classList.toggle("active", cueActive);
  refs.cue.setAttribute("aria-pressed", String(cueActive));
  refs.cue.setAttribute("aria-label", `${displayName} CUE`);

  const send = bus ? channel.vcSends?.[bus.id] : null;
  refs.node.dataset.busId = bus?.id ?? "";
  refs.busSendToggle.disabled = !send;
  refs.busSendFader.disabled = !send;
  refs.busSendNumber.disabled = !send;
  const sendOn = Boolean(send && !send.mute);
  refs.busSendToggle.textContent = sendOn ? "MIX ON" : "MIX OFF";
  refs.busSendToggle.classList.toggle("on", sendOn);
  refs.busSendToggle.classList.toggle("off", Boolean(send && !sendOn));
  refs.busSendToggle.setAttribute("aria-pressed", String(sendOn));
  refs.busSendToggle.setAttribute("aria-label", `${displayName} ${bus?.label ?? "VC MIX"} send ${sendOn ? "ON" : "OFF"}`);
  refs.busSendFader.setAttribute("aria-label", `${displayName} ${bus?.label ?? "VC MIX"} send level`);
  refs.busSendNumber.setAttribute("aria-label", `${displayName} ${bus?.label ?? "VC MIX"} send level numeric input`);
  if (send && bus) syncFader(`send:${channel.id}:${bus.id}`, refs.busSendFader, refs.busSendNumber, send.gainDb);

  updateMeter(refs.inputFill, refs.inputValue, channel.inputMeter ?? channel.meter, true);
}

function renderParticipants(currentSnapshot, bot, showAll) {
  const search = elements.mixSearch.value.trim().toLowerCase();
  const channels = visibleParticipants(currentSnapshot, bot, showAll).filter(channel => participantDisplayName(currentSnapshot, channel).toLowerCase().includes(search));
  const bankCount = Math.max(1, Math.ceil(channels.length / MIX_BANK_SIZE));
  mixBankIndex = Math.min(mixBankIndex, bankCount - 1);
  const bankStart = mixBankIndex * MIX_BANK_SIZE;
  const bankEnd = Math.min(channels.length, bankStart + MIX_BANK_SIZE);
  const bankIds = new Set(channels.slice(bankStart, bankEnd).map((channel) => channel.id));
  const liveIds = new Set(channels.map((channel) => channel.id));
  for (const [channelId, refs] of stripRefs) {
    if (!liveIds.has(channelId)) {
      refs.node.remove();
      stripRefs.delete(channelId);
      activeFaders.delete(`channel:${channelId}`);
      pendingFaders.delete(`channel:${channelId}`);
    }
  }

  if (!selectedChannelId || !bankIds.has(selectedChannelId)) selectedChannelId = channels[bankStart]?.id ?? null;
  for (const channel of channels) {
    if (!stripRefs.has(channel.id)) createStrip(channel);
  }
  channels.forEach((channel, index) => {
    const bus = selectedMixMaster(currentSnapshot, participantBot(currentSnapshot, channel));
    const refs = stripRefs.get(channel.id);
    refs.node.hidden = !bankIds.has(channel.id);
    renderParticipant(channel, refs, index, currentSnapshot, bus, showAll);
  });

  elements.mixBankPrev.disabled = mixBankIndex === 0;
  elements.mixBankNext.disabled = mixBankIndex >= bankCount - 1;
  elements.mixBankLabel.textContent = channels.length
    ? `CH ${String(bankStart + 1).padStart(2, "0")}–${String(bankEnd).padStart(2, "0")} / ${channels.length}`
    : "CH -- / 0";

  elements.emptyState.hidden = channels.length > 0;
  elements.participants.hidden = channels.length === 0;
  elements.participantCount.textContent = String(channels.length);
  const pendingCount = channels.filter((channel) => channel.approvalGateOpen !== true).length;
  elements.participantHelp.textContent = channels.length === 0
    ? "—"
    : pendingCount > 0 ? `${pendingCount}人にALLOWが必要です` : "全員APPROVEDです";
}

function selectedMixMaster(currentSnapshot, bot) {
  if (!bot) return null;
  const voiceChannelId = bot?.voiceChannelId;
  if (!voiceChannelId) return null;
  return currentSnapshot.buses.find((candidate) => candidate.linkedDiscordVoiceChannelId === voiceChannelId) ?? null;
}

function physicalMonitorReady(currentSnapshot) {
  const cueOutput = currentSnapshot.cueOutput;
  const cueDevice = cueOutput?.devices?.find((candidate) => candidate.id === cueOutput.selectedDeviceId);
  if (cueOutput?.state === "READY" && cueDevice?.backend === "portaudio") return true;
  const output = currentSnapshot.output;
  const device = output?.devices?.find((candidate) => candidate.id === output.selectedDeviceId);
  return Boolean(currentSnapshot.monitorOutput && output?.state === "READY" && device?.backend === "portaudio");
}

function createMasterStrip(bus) {
  const node = elements.masterTemplate.content.firstElementChild.cloneNode(true);
  const refs = {
    node,
    label: node.querySelector(".vc-master-label"),
    scope: node.querySelector(".vc-master-scope"),
    meter: node.querySelector(".vc-master-meter span"),
    fader: node.querySelector(".vc-master-fader"),
    number: node.querySelector(".vc-master-number"),
    cue: node.querySelector(".vc-master-cue"),
    mute: node.querySelector(".vc-master-mute"),
  };
  node.dataset.busId = bus.id;
  const header = node.querySelector("header");
  header.tabIndex = 0; header.setAttribute("role", "button");
  header.title = "このVCの参加者を表示";
  const select = () => {
    const liveBus = snapshot?.buses.find(candidate => candidate.id === node.dataset.busId);
    const bot = mixBots(snapshot).find(candidate => candidate.voiceChannelId === liveBus?.linkedDiscordVoiceChannelId && candidate.guildId === liveBus?.linkedDiscordGuildId);
    if (!bot) return;
    selectedMixBotProfileId = bot.profileId; mixBankIndex = 0;
    renderMixBotFilter(snapshot); renderParticipants(snapshot, bot, false); renderMasters(snapshot);
  };
  header.addEventListener("click", select);
  header.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
  refs.mute.addEventListener("click", () => {
    const liveBus = snapshot?.buses.find((candidate) => candidate.id === node.dataset.busId);
    if (liveBus) sendCommand({ type: "SET_BUS_MUTE", busId: liveBus.id, mute: !liveBus.mute });
  });
  refs.cue.addEventListener("click", () => {
    const liveBus = snapshot?.buses.find((candidate) => candidate.id === node.dataset.busId);
    if (liveBus) sendCommand({ type: "SET_PFL", sourceId: snapshot?.monitorSourceId === liveBus.id ? null : liveBus.id });
  });
  bindFader(
    refs.fader,
    refs.number,
    () => `master:${node.dataset.busId}`,
    (db) => ({ type: "SET_BUS_MASTER", busId: node.dataset.busId, db }),
  );
  masterRefs.set(bus.id, refs);
  elements.masterList.append(node);
  return refs;
}

function renderMasters(currentSnapshot) {
  const buses = currentSnapshot.buses;
  const liveIds = new Set(buses.map((bus) => bus.id));
  for (const [busId, refs] of masterRefs) {
    if (liveIds.has(busId)) continue;
    refs.node.remove();
    masterRefs.delete(busId);
    activeFaders.delete(`master:${busId}`);
    pendingFaders.delete(`master:${busId}`);
  }
  elements.masterPanel.hidden = buses.length === 0;
  for (const bus of buses) {
    const refs = masterRefs.get(bus.id) ?? createMasterStrip(bus);
    const bot = mixBots(currentSnapshot).find((candidate) => candidate.voiceChannelId === bus.linkedDiscordVoiceChannelId);
    refs.node.classList.toggle("selected", Boolean(bot && bot.profileId === selectedMixBotProfileId));
    refs.node.querySelector("header").setAttribute("aria-pressed", String(Boolean(bot && bot.profileId === selectedMixBotProfileId)));
    refs.label.textContent = bot?.label ?? bus.label;
    refs.label.title = refs.label.textContent;
    refs.scope.textContent = bot ? bus.label : "VC BUS";
    refs.scope.title = refs.scope.textContent;
    refs.fader.setAttribute("aria-label", `${bus.label} Master fader`);
    refs.number.setAttribute("aria-label", `${bus.label} Master level numeric input`);
    const busOn = !bus.mute;
    refs.mute.textContent = busOn ? "MASTER ON" : "MASTER MUTED";
    refs.mute.classList.toggle("on", busOn);
    refs.mute.classList.toggle("off", !busOn);
    refs.mute.setAttribute("aria-pressed", String(busOn));
    refs.mute.setAttribute("aria-label", `${bus.label} MASTER ${busOn ? "ON" : "MUTED"}`);
    const cueActive = currentSnapshot.monitorSourceId === bus.id;
    refs.cue.disabled = !physicalMonitorReady(currentSnapshot);
    refs.cue.classList.toggle("active", cueActive);
    refs.cue.setAttribute("aria-pressed", String(cueActive));
    refs.cue.setAttribute("aria-label", `${bus.label} CUE`);
    updateMeter(refs.meter, null, bus.inputMeter ?? bus.meter);
    syncFader(`master:${bus.id}`, refs.fader, refs.number, bus.masterDb);
  }
}

function renderOutputGuard(currentSnapshot) {
  const output = currentSnapshot.output;
  const selected = output?.devices?.find((device) => device.id === output.selectedDeviceId);
  const isMock = selected?.backend === "mock";
  const physicalOpen = Boolean(output?.selectedDeviceId && !isMock) || Boolean((output?.activeChannelCount ?? 0) > 0 && !isMock);
  elements.outputGuard.className = `status ${output?.state === "FAULT" ? "danger" : physicalOpen ? "ready" : "safe"}`;
  if (output?.state === "FAULT") elements.outputGuard.textContent = "出力: 障害";
  else if (physicalOpen) elements.outputGuard.textContent = "出力: ON";
  else if (isMock) elements.outputGuard.textContent = "出力: テスト";
  else elements.outputGuard.textContent = "出力: OFF";
}

function renderReceiverOwners(currentSnapshot) {
  const groups = configuredReceiverGroups(currentSnapshot);
  const activeCount = groups.filter((group) => group.status === "ACTIVE").length;
  const failedCount = groups.length - activeCount;
  elements.receiverGuard.textContent = groups.length
    ? failedCount ? `受信: ${failedCount} VC停止` : `受信: ${activeCount} VC正常`
    : "受信: 設定なし";
  elements.receiverGuard.className = `status ${groups.length ? failedCount ? "danger" : "safe" : "warning"}`;

  const signature = JSON.stringify({ appState: currentSnapshot.state, groups });
  if (signature === receiverOwnerSignature) return;
  receiverOwnerSignature = signature;

  elements.receiverOwnerSummary.textContent = `${groups.length} VC · ${activeCount} ACTIVE`;
  elements.receiverOwnerState.textContent = !groups.length ? "確認中" : failedCount ? `${failedCount} VC FAIL CLOSED` : "ALL ACTIVE";
  elements.receiverOwnerState.className = `receiver-state ${groups.length ? failedCount ? "danger" : "safe" : "warning"}`;

  const rows = groups.map((group) => {
    const section = document.createElement("section");
    section.className = "receiver-owner-group";
    const header = document.createElement("header");
    const identity = document.createElement("div");
    const vc = document.createElement("strong");
    const owner = document.createElement("small");
    vc.textContent = group.voiceChannelName || `VC ···${group.voiceChannelId.slice(-4)}`;
    owner.textContent = `OWNER ${group.ownerProfileId ?? "未選択"} · 自動切替なし`;
    identity.append(vc, owner);
    const state = document.createElement("span");
    state.className = `receiver-state ${group.status === "ACTIVE" ? "safe" : "danger"}`;
    state.textContent = group.status === "ACTIVE" ? "ACTIVE" : `FAIL CLOSED · ${group.status}`;
    header.append(identity, state);

    const candidates = document.createElement("div");
    candidates.className = "receiver-candidates";
    const candidateRows = group.receivers.map((receiver) => {
      const row = document.createElement("article");
      row.className = "receiver-candidate";
      const candidateIdentity = document.createElement("div");
      const role = document.createElement("span");
      role.textContent = `${receiver.role} · ${receiver.profileId}`;
      const label = document.createElement("strong");
      label.textContent = receiver.label;
      candidateIdentity.append(role, label);

      const health = document.createElement("span");
      health.className = `receiver-health ${receiver.health === "READY" ? "safe" : "danger"}`;
      health.textContent = `${receiver.health} · ${receiver.state}`;

      const action = document.createElement("button");
      action.type = "button";
      const healthyOnAirLock = currentSnapshot.state === "ON_AIR" && group.status === "ACTIVE";
      const canSwitch = receiver.state === "STANDBY"
        && receiver.health === "READY"
        && currentSnapshot.state !== "FAULT"
        && !healthyOnAirLock;
      if (receiver.state === "ACTIVE") action.textContent = "ACTIVE";
      else if (canSwitch) action.textContent = `SWITCH TO ${receiver.profileId}`;
      else if (healthyOnAirLock && receiver.state === "STANDBY") action.textContent = "OWNER SWITCH LOCKED";
      else if (currentSnapshot.state === "FAULT") action.textContent = "FAULT LOCKED";
      else action.textContent = receiver.state;
      action.disabled = !canSwitch;
      if (canSwitch) {
        action.addEventListener("click", () => {
          const prompt = `${group.voiceChannelName}のReceiver Ownerを${receiver.profileId}へ手動切替しますか？\n自動Failoverではありません。切替時にこのVCの受信音声は一度停止します。`;
          if (!confirm(prompt)) return;
          sendCommand({
            type: "SET_RECEIVER_OWNER",
            guildId: group.guildId,
            voiceChannelId: group.voiceChannelId,
            profileId: receiver.profileId,
            expectedCurrentOwner: group.ownerProfileId,
            expectedReceiverGeneration: group.generation,
            confirmed: true,
          });
        });
      }
      row.append(candidateIdentity, health, action);
      return row;
    });
    candidates.append(...candidateRows);
    section.append(header, candidates);
    return section;
  });
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "receiver-empty";
    empty.textContent = "—";
    rows.push(empty);
  }
  elements.receiverOwnerList.replaceChildren(...rows);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const remaining = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${remaining}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function formatSceneValue(value, parameter) {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (typeof value === "number") {
    const unit = /(Db|\.db$)/.test(parameter) ? " dB" : "";
    return `${value.toFixed(1)}${unit}`;
  }
  return String(value);
}

function renderScenes(currentSnapshot) {
  const scenes = currentSnapshot.scenes ?? [];
  if (selectedSceneId && !scenes.some((scene) => scene.id === selectedSceneId)) {
    selectedSceneId = null;
    scenePreview = null;
    scenePreviewSignature = "";
  }
  const currentScene = scenes.find((scene) => scene.id === currentSnapshot.currentSceneId);
  elements.sceneCurrent.textContent = currentScene?.name ?? "NO SCENE";
  elements.sceneCurrent.className = `session-state ${currentScene ? "safe" : ""}`;

  const optionsSignature = scenes.map((scene) => `${scene.id}:${scene.name}:${scene.createdAt}`).join("|");
  if (optionsSignature !== sceneOptionsSignature) {
    const preferred = selectedSceneId ?? currentSnapshot.currentSceneId ?? scenes[0]?.id ?? "";
    while (elements.sceneSelect.firstChild) elements.sceneSelect.firstChild.remove();
    if (scenes.length) {
      elements.sceneSelect.append(...scenes.map((scene) => new Option(scene.name, scene.id)));
    } else {
      elements.sceneSelect.add(new Option("保存済みSceneなし", ""));
    }
    selectedSceneId = scenes.some((scene) => scene.id === preferred) ? preferred : scenes[0]?.id ?? null;
    elements.sceneSelect.value = selectedSceneId ?? "";
    sceneOptionsSignature = optionsSignature;
  }

  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId);
  const previewMatches = Boolean(selectedScene && scenePreview?.sceneId === selectedScene.id);
  const changes = previewMatches ? scenePreview.changes ?? [] : [];
  const excludedParticipants = previewMatches ? scenePreview.excludedParticipants ?? [] : [];
  elements.sceneSelect.disabled = scenes.length === 0;
  elements.previewScene.disabled = !selectedScene;
  elements.overwriteScene.disabled = !selectedScene || currentSnapshot.state === "ON_AIR" || currentSnapshot.state === "FAULT";
  elements.deleteScene.disabled = !selectedScene || currentSnapshot.state === "ON_AIR" || currentSnapshot.state === "FAULT";
  elements.recallScene.disabled = !previewMatches || currentSnapshot.state === "FAULT";

  const applyCount = changes.filter((change) => !change.locked && !change.recallSafe).length;
  const protectedCount = changes.length - applyCount;
  elements.scenePreviewSummary.textContent = !selectedScene
    ? "Sceneを選んで変更を確認してください"
    : !previewMatches
      ? `${selectedScene.name}の変更を確認してください`
      : changes.length
        ? `適用 ${applyCount}件 / 保護・ロック ${protectedCount}件`
        : "現在値と同じです。変更はありません";
  if (previewMatches && excludedParticipants.length) {
    elements.scenePreviewSummary.textContent += " / 対象外 " + excludedParticipants.length + "人";
  }

  const nextPreviewSignature = JSON.stringify({
    selectedSceneId,
    appState: currentSnapshot.state,
    changes: previewMatches ? changes : null,
    excludedParticipants: previewMatches ? excludedParticipants : null,
  });
  if (nextPreviewSignature === scenePreviewSignature) return;
  scenePreviewSignature = nextPreviewSignature;
  const rows = changes.map((change) => {
    const row = document.createElement("article");
    row.className = "scene-change";
    const label = document.createElement("strong");
    label.textContent = change.label;
    label.title = change.parameter;
    const values = document.createElement("span");
    values.textContent = `${formatSceneValue(change.from, change.parameter)} → ${formatSceneValue(change.to, change.parameter)}`;
    const result = document.createElement("b");
    result.className = change.locked ? "locked" : change.recallSafe ? "safe" : "apply";
    result.textContent = change.locked ? "SAFETY LOCK" : change.recallSafe ? "RECALL SAFE" : "APPLY";
    row.append(label, values, result);
    return row;
  });
  rows.push(...excludedParticipants.map((name) => {
    const row = document.createElement("article");
    row.className = "scene-change";
    const label = document.createElement("strong");
    label.textContent = name;
    const values = document.createElement("span");
    values.textContent = "Scene保存後に参加";
    const result = document.createElement("b");
    result.className = "excluded";
    result.textContent = "対象外";
    row.append(label, values, result);
    return row;
  }));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = previewMatches ? "変更なし" : "—";
    rows.push(empty);
  }
  while (elements.scenePreviewList.firstChild) elements.scenePreviewList.firstChild.remove();
  elements.scenePreviewList.append(...rows);
}

function renderRecallSafe(currentSnapshot) {
  const safe = new Set(currentSnapshot.recallSafe ?? []);
  elements.recallSafeCount.textContent = `${safe.size} SAFE`;
  if (!elements.recallSafePanel.open) return;
  const filter = elements.recallSafeFilter.value.trim().toLowerCase();
  const parameters = (currentSnapshot.sceneParameters ?? []).filter(parameter => `${parameter.label} ${parameter.parameter}`.toLowerCase().includes(filter));
  const locked = ["ON_AIR", "FAULT"].includes(currentSnapshot.state);
  const signature = JSON.stringify([locked, filter, parameters.map(parameter => [parameter.parameter, parameter.label, safe.has(parameter.parameter)])]);
  if (elements.recallSafeList.dataset.signature !== signature) {
    elements.recallSafeList.dataset.signature = signature;
    elements.recallSafeList.replaceChildren();
    for (const parameter of parameters) {
      const label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span"), value = document.createElement("small");
      label.dataset.parameter = parameter.parameter;
      checkbox.type = "checkbox"; checkbox.checked = safe.has(parameter.parameter); checkbox.disabled = locked;
      checkbox.addEventListener("change", () => setRecallSafe(parameter.parameter, checkbox.checked));
      text.textContent = parameter.label;
      label.append(checkbox, text, value); elements.recallSafeList.append(label);
    }
  }
  for (const label of elements.recallSafeList.children) {
    const parameter = parameters.find(parameter => parameter.parameter === label.dataset.parameter);
    if (parameter) label.querySelector("small").textContent = `${parameter.parameter} · ${formatSceneValue(parameter.value, parameter.parameter)}`;
  }
}

function setRecallSafe(parameter, safe) {
  if (!snapshot || ["ON_AIR", "FAULT"].includes(snapshot.state) || !(snapshot.sceneParameters ?? []).some(item => item.parameter === parameter)) return;
  if (!sendCommand({ type: "SET_RECALL_SAFE", parameter, safe })) return;
  for (const change of scenePreview?.changes ?? []) if (change.parameter === parameter) change.recallSafe = safe;
  scenePreviewSignature = "";
  renderScenes(snapshot);
}

function clearEventLog() {
  if (!snapshot || ["ON_AIR", "FAULT"].includes(snapshot.state) || !confirm("イベントログの表示履歴を消去しますか？保存済みの運用ログファイルは消しません。")) return;
  sendCommand({ type: "CLEAR_EVENT_LOG", confirmed: true });
}

function renderRecorderTracks(tracks) {
  const kindLabels = { MATRIX: "MAIN", VC_BUS: "VC MIX PRE", DISCORD_USER: "USER PRE", LOCAL_INPUT: "INPUT PRE" };
  const keyedTracks = tracks.map((track, index) => ({ key: `${index}:${track.kind}`, track }));
  const liveKeys = new Set(keyedTracks.map((entry) => entry.key));
  for (const [trackKey, refs] of recorderTrackRefs) {
    if (!liveKeys.has(trackKey)) {
      refs.node.remove();
      recorderTrackRefs.delete(trackKey);
    }
  }
  elements.recorderTracks.querySelector(".session-empty")?.remove();
  for (const { key, track } of keyedTracks) {
    let refs = recorderTrackRefs.get(key);
    if (!refs) {
      const node = document.createElement("article");
      node.className = "recorder-track";
      const identity = document.createElement("div");
      const kind = document.createElement("span");
      const label = document.createElement("strong");
      identity.append(kind, label);
      const file = document.createElement("span");
      file.className = "recorder-file";
      const bytes = document.createElement("b");
      node.append(identity, file, bytes);
      refs = { node, kind, label, file, bytes };
      recorderTrackRefs.set(key, refs);
      elements.recorderTracks.append(node);
    }
    refs.kind.textContent = kindLabels[track.kind] ?? track.kind;
    refs.label.textContent = track.label;
    refs.file.textContent = track.fileName;
    refs.bytes.textContent = formatBytes(track.dataBytes);
  }
  if (!tracks.length) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "—";
    elements.recorderTracks.append(empty);
  }
}

function selectedRecordingTargets() {
  return Object.fromEntries(Object.entries(recorderSelection).map(([group, ids]) => [group, [...ids]]));
}

function renderRecordingTargets(currentSnapshot, busy) {
  const recorder = currentSnapshot.recorder;
  const outputCount = Math.min(64, Math.max(currentSnapshot.output?.activeChannelCount ?? 0, recorder.startedAt ? recorder.matrixOutput + 1 : 0, ...[...recorderSelection.outputs].map((output) => output + 1)));
  const groups = [
    { key: "outputs", list: elements.recorderOutputs, count: elements.recorderOutputsCount, choices: Array.from({ length: outputCount }, (_, id) => ({ id, label: `OUT ${id + 1}`, detail: "" })) },
    { key: "busIds", list: elements.recorderBuses, count: elements.recorderBusesCount, choices: currentSnapshot.buses.map((bus) => {
      const matchesVc = (candidate) => candidate.guildId === bus.linkedDiscordGuildId && candidate.voiceChannelId === bus.linkedDiscordVoiceChannelId;
      const bots = (currentSnapshot.discord?.bots ?? []).filter((bot) => matchesVc(bot) && ["RX", "DUPLEX", "SPARE"].includes(bot.role) && bot.health !== "STALE");
      const owner = currentSnapshot.discord?.receiverOwnership?.find(matchesVc)?.ownerProfileId;
      const bot = bots.find((candidate) => candidate.profileId === owner) ?? bots.find((candidate) => candidate.health === "READY") ?? bots[0];
      return { id: bus.id, label: bot ? `${bot.label} · ${bus.label}` : bus.label, detail: `${bus.participantCount ?? 0}人${bus.mute ? " · ミュート" : ""}` };
    }) },
    { key: "channelIds", list: elements.recorderUsers, count: elements.recorderUsersCount, choices: currentSnapshot.channels.map((channel) => ({
      id: channel.id, label: participantDisplayName(currentSnapshot, channel),
      detail: [participantBot(currentSnapshot, channel)?.voiceChannelName ?? currentSnapshot.buses.find((bus) => bus.linkedDiscordVoiceChannelId && bus.linkedDiscordVoiceChannelId === channel.currentVoiceChannelId)?.label ?? (channel.kind === "DiscordUser" ? "Discord" : "Input"), channel.approvalGateOpen === false ? "PENDING（無音）" : channel.mute ? "ミュート" : participantSession(currentSnapshot, channel)?.online === false ? "オフライン" : ""].filter(Boolean).join(" · "),
    })) },
  ];
  const liveKeys = new Set();
  let missing = 0;
  let selectedCount = 0;
  for (const group of groups) {
    const selected = recorderSelection[group.key];
    const available = new Set(group.choices.map((choice) => choice.id));
    const choices = [...group.choices, ...[...selected].filter((id) => !available.has(id)).map((id) => ({ id, label: recorderTargetRefs.get(`${group.key}:${id}`)?.name.textContent ?? recorder.tracks.find((track) => track.sourceId === id)?.label ?? id, detail: "対象がなくなりました" }))];
    group.count.textContent = `${selected.size}選択`;
    selectedCount += selected.size;
    for (const choice of choices) {
      const key = `${group.key}:${choice.id}`;
      liveKeys.add(key);
      let refs = recorderTargetRefs.get(key);
      if (!refs) {
        const node = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        const identity = document.createElement("span");
        const name = document.createElement("strong");
        const detail = document.createElement("small");
        identity.append(name, detail);
        node.append(input, identity);
        input.addEventListener("change", () => {
          if (!snapshot?.recorder?.selectionSupported || ["RECORDING", "STOPPING"].includes(snapshot.recorder.state)) return;
          input.checked ? recorderSelection[group.key].add(choice.id) : recorderSelection[group.key].delete(choice.id);
          if (snapshot) renderRecorder(snapshot);
        });
        refs = { node, input, name, detail, group: group.key, id: choice.id };
        recorderTargetRefs.set(key, refs);
        group.list.append(node);
      }
      refs.name.textContent = choice.label;
      refs.detail.textContent = choice.detail;
      refs.available = available.has(choice.id);
      refs.node.className = `recorder-choice${refs.available ? "" : " unavailable"}`;
      refs.input.checked = selected.has(choice.id);
      refs.input.disabled = busy || !recorder.selectionSupported;
      if (!refs.available) missing += 1;
    }
    if (choices.length) group.list.querySelector(".session-empty")?.remove();
    else if (!group.list.querySelector(".session-empty")) {
      const empty = document.createElement("p");
      empty.className = "session-empty";
      empty.textContent = "対象なし";
      group.list.append(empty);
    }
  }
  for (const [key, refs] of recorderTargetRefs) {
    if (!liveKeys.has(key)) { refs.node.remove(); recorderTargetRefs.delete(key); }
  }
  for (const button of elements.recorderTargets.querySelectorAll("button")) button.disabled = busy || !recorder.selectionSupported;
  elements.recorderSelectionSummary.textContent = !recorder.selectionSupported ? "本体を再起動して反映してください" : `${selectedCount}トラック${busy ? " · 対象固定" : missing ? ` · ${missing}件を選び直してください` : ""}`;
  elements.recorderSelectionSummary.className = !recorder.selectionSupported || (missing && !busy) ? "warning" : "";
  elements.startRecording.disabled = !recorder.selectionSupported || busy || selectedCount === 0 || missing > 0;
}

function renderRecorder(currentSnapshot) {
  const recorder = currentSnapshot.recorder;
  if (!recorder) {
    elements.recorderState.textContent = "UNAVAILABLE";
    elements.recorderState.className = "session-state warning";
    elements.startRecording.disabled = true;
    elements.stopRecording.disabled = true;
    return;
  }

  const busy = recorder.state === "RECORDING" || recorder.state === "STOPPING";
  const returnedToIdle = lastRecorderState !== recorder.state && recorder.state === "IDLE";
  if (!recorderSelection || returnedToIdle || (busy && recorderSessionStartedAt !== recorder.startedAt)) {
    const currentMix = selectedMixMaster(currentSnapshot, pickPrimaryBot(currentSnapshot));
    const preferredOutput = recorder.startedAt ? recorder.matrixOutput : currentMix?.physicalOutputs?.[0]?.output ?? 0;
    const selection = recorder.selection ?? {
      outputs: [preferredOutput],
      busIds: recorder.includeBuses ? currentSnapshot.buses.map((bus) => bus.id) : [],
      channelIds: recorder.includeUsers ? currentSnapshot.channels.map((channel) => channel.id) : [],
    };
    recorderSelection = Object.fromEntries(Object.entries(selection).map(([group, ids]) => [group, new Set(ids)]));
  }
  lastRecorderState = recorder.state;
  recorderSessionStartedAt = recorder.startedAt;

  elements.recorderState.textContent = ({ IDLE: "待機", RECORDING: "録音中", STOPPING: "保存中", FAULT: "FAULT" })[recorder.state] ?? recorder.state;
  elements.recorderState.className = `session-state ${recorder.state === "RECORDING" ? "recording" : recorder.state === "FAULT" ? "danger" : "safe"}`;
  elements.recorderDuration.textContent = formatDuration(recorder.durationSeconds);
  elements.recorderTrackCount.textContent = String(recorder.tracks.length);
  elements.recorderQueue.textContent = String(recorder.droppedBlocks);
  elements.recorderDiskFree.textContent = formatBytes(recorder.freeBytes);
  elements.recorderFolder.textContent = recorder.folder;
  elements.recorderMessage.textContent = recorder.message ?? "";
  elements.recorderMessage.hidden = !recorder.message;
  elements.stopRecording.disabled = recorder.state !== "RECORDING";
  renderRecordingTargets(currentSnapshot, busy);
  renderRecorderTracks(recorder.tracks);
}

function renderSession(currentSnapshot) {
  renderScenes(currentSnapshot);
  renderRecorder(currentSnapshot);
}

function counterDelta(value, baseline = 0) {
  const current = value ?? 0;
  const start = baseline ?? 0;
  return current >= start ? current - start : current;
}

function captureStatusBaseline(currentSnapshot) {
  const discord = currentSnapshot.discord ?? {};
  return {
    at: new Date(),
    discordPackets: discord.packets ?? 0,
    discordDecodeErrors: discord.decodeErrors ?? 0,
    txFrames: discord.tx?.framesSent ?? 0,
    txDrops: discord.tx?.droppedFrames ?? 0,
    outputFrames: currentSnapshot.output?.framesWritten ?? 0,
    inputFrames: currentSnapshot.input?.framesCaptured ?? 0,
    backpressure: currentSnapshot.output?.backpressureDrops ?? 0,
    recorderDrops: currentSnapshot.recorder?.droppedBlocks ?? 0,
    bots: new Map((discord.bots ?? []).map((bot) => [bot.profileId, { reconnects: bot.reconnectCount, txFrames: bot.txFrames, txDrops: bot.txDroppedFrames }])),
    sources: new Map((discord.sources ?? []).map((source) => [source.channelId, { packets: source.packets, samples: source.decodedSamples, errors: source.decodeErrors, gaps: source.sequenceGaps, drops: source.droppedSamples }])),
  };
}

function ageLabel(milliseconds) {
  if (milliseconds == null) return "—";
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function statusStatValue(label, value) {
  const cell = document.createElement("span");
  const caption = document.createElement("span");
  const number = document.createElement("b");
  cell.className = "stat-value";
  caption.textContent = label;
  number.textContent = value;
  cell.append(caption, number);
  return cell;
}

function statusStatsRow(label, detail, values) {
  const row = document.createElement("div");
  const identity = document.createElement("span");
  const name = document.createElement("strong");
  const description = document.createElement("small");
  identity.className = "stat-identity";
  name.textContent = label;
  description.textContent = detail;
  identity.append(name, description);
  row.append(identity, ...values.map(([caption, value]) => statusStatValue(caption, value)));
  return row;
}

function statusEmptyRow(message) {
  const row = document.createElement("div");
  row.className = "status-empty";
  row.textContent = message;
  return row;
}

function renderStatusBreakdown(currentSnapshot) {
  if (elements.statusView.hidden) return;
  const now = Date.now();
  if (now - statusBreakdownRenderedAt < 500) return;
  statusBreakdownRenderedAt = now;
  const discord = currentSnapshot.discord ?? {};
  const sources = discord.sources ?? [];
  const bots = discord.bots ?? [];
  const botRows = bots.map((bot) => {
    const botSources = sources.filter((source) => source.botId === bot.botId);
    const quality = botSources.reduce((total, source) => {
      const baseline = statusStatsBaseline?.sources.get(source.channelId);
      total.packets += counterDelta(source.packets, baseline?.packets);
      total.errors += counterDelta(source.decodeErrors, baseline?.errors);
      total.gaps += counterDelta(source.sequenceGaps, baseline?.gaps);
      total.drops += counterDelta(source.droppedSamples, baseline?.drops);
      return total;
    }, { packets: 0, errors: 0, gaps: 0, drops: 0 });
    const baseline = statusStatsBaseline?.bots.get(bot.profileId);
    return statusStatsRow(bot.label, `${bot.role} · ${bot.voiceChannelName ?? "VC未接続"}`, [
      ["STATE", bot.health],
      ["RX", `${botSources.length}U · ${quality.packets.toLocaleString()} pkt`],
      ["QUALITY", `E ${quality.errors} · G ${quality.gaps} · D ${quality.drops}`],
      ["PING", `WS ${bot.wsPingMs ?? "—"} · UDP ${bot.udpPingMs ?? "—"}`],
      ["TX / RECONNECT", `${counterDelta(bot.txFrames, baseline?.txFrames).toLocaleString()} / ${counterDelta(bot.txDroppedFrames, baseline?.txDrops)} · R ${counterDelta(bot.reconnectCount, baseline?.reconnects)}`],
    ]);
  });
  elements.statusBotCount.textContent = String(bots.length);
  elements.statusBotList.replaceChildren(...(botRows.length ? botRows : [statusEmptyRow("—")]));

  const channels = new Map(currentSnapshot.channels.map((channel) => [channel.id, channel]));
  const voiceChannels = new Map((discord.availableVoiceChannels ?? []).map((channel) => [channel.id, channel.name]));
  const userRows = sources.map((source) => {
    const channel = channels.get(source.channelId);
    const baseline = statusStatsBaseline?.sources.get(source.channelId);
    return statusStatsRow(participantDisplayName(currentSnapshot, channel), voiceChannels.get(source.voiceChannelId) ?? "VC", [
      ["PACKETS", counterDelta(source.packets, baseline?.packets).toLocaleString()],
      ["SAMPLES", counterDelta(source.decodedSamples, baseline?.samples).toLocaleString()],
      ["QUALITY", `E ${counterDelta(source.decodeErrors, baseline?.errors)} · G ${counterDelta(source.sequenceGaps, baseline?.gaps)} · D ${counterDelta(source.droppedSamples, baseline?.drops)}`],
      ["QUEUE", `${source.queuedMilliseconds} ms`],
      ["LAST", ageLabel(source.lastPacketAgoMs)],
    ]);
  });
  elements.statusUserCount.textContent = String(sources.length);
  elements.statusUserList.replaceChildren(...(userRows.length ? userRows : [statusEmptyRow("—")]));
}

function setStatusCard(valueElement, value, detailElement, detail, severity) {
  valueElement.textContent = value;
  detailElement.textContent = detail;
  detailElement.title = detail;
  valueElement.closest("article").className = `health-${severity.toLowerCase()}`;
}

function statusGuidance(currentSnapshot) {
  const root = currentSnapshot.operatorHealth?.rootCauses?.[0];
  const rootId = root?.id?.split(":")[0];
  const faultHelp = currentSnapshot.state === "FAULT"
    ? "原因を確認 → 上部「障害を確認」 → SETUPで手動復旧。音声は自動再開しません。"
    : "音量を下げ、SETUPで対象デバイスを確認・手動復旧してください。音声は自動再開しません。";
  const actions = {
    emergency: { title: "緊急停止中 · 全出力は無音", detail: currentSnapshot.state === "FAULT" ? faultHelp : "原因と機器を確認してから、上部の緊急停止を手動で解除してください。", view: "setup", target: ".io-panel" },
    input: { title: "入力デバイス障害", detail: faultHelp, view: "setup", target: ".io-input" },
    output: { title: currentSnapshot.output?.state === "FAULT" || currentSnapshot.state === "FAULT" ? "本線出力障害" : "本線デバイスが停止中", detail: currentSnapshot.state === "FAULT" ? faultHelp : "音量を下げ、SETUPで出力デバイスを確認・手動開始してください。", view: "setup", target: ".io-main" },
    discord: { title: "Discord接続を確認", detail: "SETUPで停止／障害のBotを確認。接続・復旧はBotごとに手動で行います。", view: "setup", target: ".bot-profile-toolbar" },
    receiver: { title: "VCの受信担当を確認", detail: "ROUTEで対象VCのReceiver Ownerを確認。自動切り替えは行いません。", view: "route", target: ".receiver-owner-panel" },
    approval: { title: "参加者の承認待ち", detail: "MIXで参加者を確認し、必要な人だけALLOWしてください。", view: "mix", target: "#participants" },
    "user-health": { title: "受信音声の品質を確認", detail: "統計で対象UserのGAP／DROP／最終受信を確認してください。", view: "status", target: ".status-stats" },
    "tx-health": { title: "Discord送信Botを確認", detail: "SETUPでTX Botの接続状態を確認。送信経路はROUTEで確認します。", view: "setup", target: ".bot-profile-toolbar" },
    recorder: { title: "録音障害 · Main影響なし", detail: "SESSIONで保存先・空き容量・録音状態を確認してください。", view: "session", target: "#recorder-title" },
    audio: { title: "音声処理の期限超過を検出", detail: "統計とログを確認。XRUNは累積値で、現在も発生中とは限りません。", view: "status", target: ".status-stats" },
    cue: { title: "Cue出力障害 · Mainは影響なし", detail: "本線を止めず、SETUPでCueデバイスを確認・手動復旧してください。", view: "setup", target: ".io-cue" },
  };
  const output = currentSnapshot.output;
  const device = output?.devices?.find((candidate) => candidate.id === output.selectedDeviceId);
  if (currentSnapshot.emergencyMuted) return actions.emergency;
  if (currentSnapshot.state === "FAULT") return currentSnapshot.input?.state === "FAULT" ? actions.input : actions.output;
  if (currentSnapshot.output?.state === "FAULT") return actions.output;
  if (currentSnapshot.input?.state === "FAULT") return actions.input;
  if (currentSnapshot.cueOutput?.state === "FAULT" && output?.state === "READY" && device?.backend === "portaudio" && root?.severity !== "CRITICAL" && rootId !== "output") return actions.cue;
  if (root && actions[rootId]) return actions[rootId];
  if (root) return { title: root.title, detail: root.summary, view: "status", target: ".status-stats" };
  if (output?.state !== "READY" || device?.backend !== "portaudio") return { title: "本線の物理出力は停止中", detail: "SETUPで出力デバイスを選択・開始してください。Mockでは音卓へ出力されません。", view: "setup", target: ".io-main" };
  const routing = mainOutputGuidance(currentSnapshot);
  if (routing.startsWith("出力先chが未設定")) return { title: "本線の出力先chが未設定", detail: "ROUTEでVC MIXまたはDirect Outの出力先を割り当ててください。", view: "route", target: "#vc-route-list" };
  if (!currentSnapshot.operatorHealth) return { title: "状態情報を確認中", detail: "最新状態への更新と操作接続を確認してください。", view: "status", target: ".status-stats" };
  return { title: "機器・接続に障害なし", detail: "実音声はMIXのALLOW・ミュート・レベルと音卓側で確認してください。", view: null };
}

function renderStatus(currentSnapshot) {
  const runtime = currentSnapshot.runtimeInfo;
  elements.statusRuntimeInfo.textContent = `BUILD ${runtime?.buildCommit ?? "unknown"} · 起動時のPC ROLE ${runtime?.pcRole ?? "UNCONFIGURED"} · START (UTC) ${runtime?.startedAt ?? "—"}`;
  const health = currentSnapshot.operatorHealth;
  const guidance = statusGuidance(currentSnapshot);
  const mainDevice = currentSnapshot.output?.devices?.find((device) => device.id === currentSnapshot.output.selectedDeviceId);
  const mainOpen = mainDevice?.backend === "portaudio" && currentSnapshot.output?.state === "READY";
  const severity = currentSnapshot.emergencyMuted || currentSnapshot.state === "FAULT" || currentSnapshot.output?.state === "FAULT" || currentSnapshot.input?.state === "FAULT" ? "CRITICAL"
    : health?.overallSeverity === "OK" && (!mainOpen || currentSnapshot.cueOutput?.state === "FAULT" || mainOutputGuidance(currentSnapshot).startsWith("出力先chが未設定")) ? "WARNING"
    : health?.overallSeverity ?? "WARNING";
  const severityLabels = { OK: "正常", WARNING: "確認", CRITICAL: "停止" };
  elements.statusOverall.textContent = severityLabels[severity] ?? severity;
  elements.statusOverall.className = `health-badge ${severity.toLowerCase()}`;

  elements.statusNextAction.textContent = guidance.title;
  elements.statusActionDetail.textContent = guidance.detail;
  elements.statusOpenRecovery.hidden = !guidance.view;
  elements.statusOpenRecovery.textContent = guidance.view ? `${guidance.view.toUpperCase()}で確認` : "確認";

  const systems = new Map((health?.system ?? []).map((item) => [item.id, item]));
  const appSeverity = currentSnapshot.emergencyMuted || currentSnapshot.state === "FAULT" ? "CRITICAL" : "OK";
  setStatusCard(elements.statusApplication, currentSnapshot.state, elements.statusApplicationDetail, currentSnapshot.emergencyMuted ? "Emergency Mute ON" : "Emergency Mute OFF", appSeverity);

  const configured = currentSnapshot.discord?.configuredBots ?? 0;
  const ready = currentSnapshot.discord?.readyBots ?? 0;
  setStatusCard(elements.statusDiscord, `${ready} / ${configured} READY`, elements.statusDiscordDetail, currentSnapshot.discord?.adapterState ?? "waiting", systems.get("discord")?.severity ?? "WARNING");

  const audioSeverity = systems.get("audio")?.severity ?? "WARNING";
  setStatusCard(elements.statusAudio, `${(currentSnapshot.callbackLoad * 100).toFixed(1)}%`, elements.statusAudioDetail, `XRUN ${currentSnapshot.xruns}`, audioSeverity);

  const output = currentSnapshot.output;
  const cueOutput = currentSnapshot.cueOutput;
  const input = currentSnapshot.input;
  const cueDevice = cueOutput?.devices?.find((device) => device.id === cueOutput.selectedDeviceId);
  const mainRouting = mainOutputGuidance(currentSnapshot);
  const mainBlocked = currentSnapshot.emergencyMuted || currentSnapshot.state === "FAULT";
  const mainSeverity = mainBlocked || output?.state === "FAULT" ? "CRITICAL" : !mainOpen || mainRouting.startsWith("出力先chが未設定") ? "WARNING" : systems.get("output")?.severity ?? "WARNING";
  const mainState = output?.state === "FAULT" ? "障害" : mainBlocked ? "安全停止中" : mainOpen ? "デバイス稼働中" : "物理出力なし";
  const mainDetail = mainBlocked || output?.state === "FAULT" ? `${audioDeviceNameplate(output?.selectedDeviceName)} · 原因確認後に手動復旧` : mainOpen ? `${audioDeviceNameplate(output.selectedDeviceName)} · ${mainRouting}` : "SETUPで機器を開始 · Mockは音卓へ出ません";
  setStatusCard(elements.statusIo, mainState, elements.statusIoDetail, mainDetail, mainSeverity);
  const cueOpen = cueDevice?.backend === "portaudio" && cueOutput?.state === "READY";
  const cueFault = cueOutput?.state === "FAULT";
  const mainMonitor = !cueOpen && !cueFault && physicalMonitorReady(currentSnapshot);
  setStatusCard(elements.statusCue, cueFault ? "障害 · Main影響なし" : cueOpen ? "独立デバイス稼働中" : mainMonitor ? "Main内Monitor" : "未使用／停止中", elements.statusCueDetail, cueFault ? "SETUPでCueだけ手動復旧" : cueOpen ? audioDeviceNameplate(cueOutput.selectedDeviceName) : mainMonitor ? "Mainの専用chへ出力 · ROUTEで確認" : "本線とは別経路 · 任意の試聴出力", cueFault ? "WARNING" : "OK");
  const inputOpen = input?.state === "READY" && input?.selectedDeviceId?.startsWith("pa:");
  setStatusCard(elements.statusInput, input?.state === "FAULT" ? "障害" : inputOpen ? "デバイス稼働中" : "未使用／停止中", elements.statusInputDetail, inputOpen ? `${audioDeviceNameplate(input.selectedDeviceName)} · ${input.activeChannelCount}ch` : input?.state === "FAULT" ? "入力依存の経路が停止 · 手動復旧が必要" : "Discord受信だけなら不要", input?.state === "FAULT" ? "CRITICAL" : "OK");

  const recorder = currentSnapshot.recorder;
  setStatusCard(elements.statusRecorder, recorder?.state ?? "UNAVAILABLE", elements.statusRecorderDetail, recorder ? `QUEUE ${recorder.queuedBlocks}/${recorder.maxQueuedBlocks} · DROP ${recorder.droppedBlocks}` : "Recorderなし", systems.get("recorder")?.severity ?? "WARNING");

  const discord = currentSnapshot.discord ?? {};
  const sources = discord.sources ?? [];
  const sequenceGaps = sources.reduce((sum, source) => sum + counterDelta(source.sequenceGaps, statusStatsBaseline?.sources.get(source.channelId)?.gaps), 0);
  const droppedSamples = sources.reduce((sum, source) => sum + counterDelta(source.droppedSamples, statusStatsBaseline?.sources.get(source.channelId)?.drops), 0);
  const tx = discord.tx;
  elements.statusStatsSince.textContent = statusStatsBaseline
    ? `${statusStatsBaseline.at.toLocaleTimeString("ja-JP")} からの表示差分 · Runtime累積値は保持`
    : "Runtime累積値";
  elements.statusStatRx.textContent = `${counterDelta(discord.packets, statusStatsBaseline?.discordPackets).toLocaleString()} packets`;
  elements.statusStatRxDetail.textContent = `DECODE ERROR ${counterDelta(discord.decodeErrors, statusStatsBaseline?.discordDecodeErrors).toLocaleString()}`;
  elements.statusStatSources.textContent = `${sources.length} sources`;
  elements.statusStatSourcesDetail.textContent = `GAP ${sequenceGaps} · DROP ${droppedSamples}`;
  elements.statusStatTx.textContent = tx?.active ? "ACTIVE" : "STOPPED";
  elements.statusStatTxDetail.textContent = `FRAME ${counterDelta(tx?.framesSent, statusStatsBaseline?.txFrames).toLocaleString()} · DROP ${counterDelta(tx?.droppedFrames, statusStatsBaseline?.txDrops).toLocaleString()}`;
  elements.statusStatIo.textContent = `OUT ${counterDelta(output?.framesWritten, statusStatsBaseline?.outputFrames).toLocaleString()}`;
  elements.statusStatIoDetail.textContent = `IN ${counterDelta(input?.framesCaptured, statusStatsBaseline?.inputFrames).toLocaleString()} · BACKPRESSURE ${counterDelta(output?.backpressureDrops, statusStatsBaseline?.backpressure).toLocaleString()}`;
  elements.statusStatRecorder.textContent = recorder ? `${recorder.queuedBlocks}/${recorder.maxQueuedBlocks}` : "—";
  elements.statusStatRecorderDetail.textContent = `DROP ${counterDelta(recorder?.droppedBlocks, statusStatsBaseline?.recorderDrops).toLocaleString()}`;
  renderStatusBreakdown(currentSnapshot);

  const events = currentSnapshot.alerts ?? [];
  elements.clearEventLog.disabled = ["ON_AIR", "FAULT"].includes(currentSnapshot.state);
  const levelFilter = elements.statusLogLevel.value || "ALL", textFilter = elements.statusLogFilter.value.trim().toLowerCase();
  const visible = events.filter(event => (levelFilter === "ALL" || event.level === levelFilter) && `${event.level} ${event.message}`.toLowerCase().includes(textFilter));
  elements.statusEventCount.textContent = `${visible.length}/${events.length} · INFO ${events.filter(e => e.level === "INFO").length} / WARNING ${events.filter(e => e.level === "WARNING").length} / CRITICAL ${events.filter(e => e.level === "CRITICAL").length}`;
  const signature = `${levelFilter}|${textFilter}|` + events.map((event) => `${event.at}:${event.level}:${event.message}`).join("|");
  if (signature === statusEventSignature) return;
  statusEventSignature = signature;
  const rows = visible.map((event) => {
    const row = document.createElement("div");
    const time = document.createElement("time");
    const level = document.createElement("span");
    const message = document.createElement("strong");
    time.textContent = new Date(event.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    level.textContent = event.level;
    level.className = `health-badge ${event.level === "INFO" ? "ok" : event.level.toLowerCase()}`;
    message.textContent = event.message;
    row.append(time, level, message);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "イベントはありません";
    rows.push(empty);
  }
  elements.statusEventList.replaceChildren(...rows);
}
function renderSummary(currentSnapshot, bot) {
  const productionLocked = currentSnapshot.state === "ON_AIR";
  const nextActions = {
    SETUP: "設定変更できます",
    READY: "設定変更できます",
    ON_AIR: "構成変更はロックされています",
    FAULT: "音声を止めたまま原因を確認してください",
  };
  elements.applicationState.textContent = currentSnapshot.state === "FAULT" ? "FAULT" : productionLocked ? "LOCKED" : "UNLOCKED";
  elements.nextAction.textContent = nextActions[currentSnapshot.state] ?? "現在の状態を確認してください";
  elements.applicationControl.textContent = currentSnapshot.state === "FAULT" ? "障害を確認" : `設定ロック: ${productionLocked ? "ON" : "OFF"}`;
  elements.applicationControl.className = `status safety-control ${currentSnapshot.state === "FAULT" ? "danger" : productionLocked ? "ready" : "warning"}`;
  if (selectedMixBotProfileId === "all") {
    const bots = mixBots(currentSnapshot);
    const ready = bots.filter((candidate) => candidate.health === "READY").length;
    const voiceChannels = new Set(bots.map((candidate) => candidate.voiceChannelId).filter(Boolean));
    elements.botState.textContent = `${ready} / ${bots.length} READY`;
    elements.botState.style.color = bots.length > 0 && ready === bots.length ? "var(--green)" : "var(--amber)";
    elements.botName.textContent = `${bots.length} RX Bot`;
    elements.voiceChannel.textContent = `${voiceChannels.size} VC`;
  } else {
    elements.botState.textContent = bot?.health ?? "NO PROFILE";
    elements.botState.style.color = bot?.health === "READY" ? "var(--green)" : bot ? "var(--amber)" : "var(--muted)";
    elements.botName.textContent = bot ? `${bot.label} / ${bot.role}` : "—";
    elements.voiceChannel.textContent = bot?.voiceChannelName ?? (bot?.voiceChannelId ? `VC ${bot.voiceChannelId}` : "未接続");
  }

  elements.emergencyState.textContent = currentSnapshot.emergencyMuted ? "緊急停止中（解除）" : "緊急停止";
  elements.emergencyState.className = `status safety-control emergency ${currentSnapshot.emergencyMuted ? "danger" : ""}`;
  renderOutputGuard(currentSnapshot);
}

function renderDesktopAccess() {
  const badge = document.querySelector("#lan-access-badge"), status = document.querySelector("#lan-access-status");
  badge.hidden = !desktopAccess.lanEnabled;
  document.body.classList.toggle("lan-published", Boolean(desktopAccess.lanEnabled));
  status.textContent = desktopAccess.lanEnabled ? (desktopAccess.urls ?? []).map(url => `LAN公開中: ${url}`).join("\n") || "LAN公開中（IPv4アドレス未検出）" : "このPCのみ（127.0.0.1）";
  for (const note of document.querySelectorAll("[data-local-access-note]")) note.hidden = localSettingsAvailable;
  if (!localSettingsAvailable) for (const root of document.querySelectorAll("[data-local-only]")) {
    for (const control of root.querySelectorAll("button, input, select, textarea")) control.disabled = true;
  }
}

function render(currentSnapshot) {
  snapshot = currentSnapshot;
  pickPrimaryBot(currentSnapshot);
  renderMixBotFilter(currentSnapshot);
  const bot = selectedMixBot(currentSnapshot);
  const showAll = selectedMixBotProfileId === "all";
  renderSummary(currentSnapshot, bot);
  renderTxMix(currentSnapshot, settingsSnapshot?.bots ?? [], socket?.readyState === WebSocket.OPEN);
  renderParticipants(currentSnapshot, bot, showAll);
  renderMasters(currentSnapshot);
  renderLegacyPostRecovery(currentSnapshot);
  renderIo(currentSnapshot);
  renderRouteOverview(currentSnapshot);
  renderReceiverOwners(currentSnapshot);
  renderStatus(currentSnapshot);
  renderSession(currentSnapshot);
  renderRecallSafe(currentSnapshot);
  renderRestart(currentSnapshot);
  renderTestTones(currentSnapshot);
  renderTxAssignments(currentSnapshot);
  renderExtendedDiagnostics(currentSnapshot);
  if (settingsSnapshot) renderSetupRuntime(currentSnapshot);
  renderDesktopAccess();
}

elements.mixSearch.addEventListener("input", () => { mixBankIndex = 0; if (snapshot) renderParticipants(snapshot, selectedMixBot(snapshot), selectedMixBotProfileId === "all"); });
elements.recallSafePanel.addEventListener("toggle", () => { if (snapshot) renderRecallSafe(snapshot); });
elements.recallSafeFilter.addEventListener("input", () => { if (snapshot) renderRecallSafe(snapshot); });
elements.clearEventLog.addEventListener("click", clearEventLog);
elements.statusLogLevel.addEventListener("change", () => { if (snapshot) renderStatus(snapshot); });
elements.statusLogFilter.addEventListener("input", () => { if (snapshot) renderStatus(snapshot); });
elements.extendedDiagnostics.addEventListener("toggle", () => { if (snapshot) renderExtendedDiagnostics(snapshot, true); });

elements.emergencyState.addEventListener("click", () => {
  if (!snapshot) return;
  if (!snapshot.emergencyMuted) {
    sendCommand({ type: "EMERGENCY_MUTE", active: true });
    return;
  }
  if (snapshot.state === "FAULT") {
    showNotice("先に障害を確認し、Audio I/Oを手動で復旧してください", true);
    return;
  }
  const output = snapshot.output;
  const outputDevice = output?.devices?.find((device) => device.id === output.selectedDeviceId);
  if (output?.state !== "READY") {
    if (outputDevice?.backend === "mock") {
      if (!confirm("Mock出力を再起動してREADYへ戻し、Emergency Muteを解除しますか？\n物理出力は開かず、設定ロックはOFFになります。")) return;
      if (snapshot.state !== "SETUP") sendCommand({ type: "SET_STATE", state: "SETUP", confirmed: true });
      sendCommand({ type: "SELECT_OUTPUT_DEVICE", deviceId: outputDevice.id });
      sendCommand({ type: "SET_STATE", state: "READY" });
      sendCommand({ type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: snapshot.emergencyEpoch });
      return;
    }
    if (snapshot.state !== "SETUP") {
      if (!confirm("解除には物理出力の手動復旧が必要です。\n設定ロックをOFFにしてSETUPを開きますか？\nEmergency Muteは維持されます。")) return;
      sendCommand({ type: "SET_STATE", state: "SETUP", confirmed: true });
    }
    showView("setup");
    showNotice("Audio I/Oで出力を明示的に再選択してから解除してください", true);
    return;
  }
  if (snapshot.state !== "SETUP" && snapshot.state !== "READY") {
    showNotice("設定ロックをOFFにしてSETUPへ戻してから解除してください", true);
    return;
  }
  if (!confirm("Emergency Muteを解除しますか？")) return;
  if (snapshot.state === "SETUP") sendCommand({ type: "SET_STATE", state: "READY" });
  sendCommand({ type: "EMERGENCY_MUTE", active: false, confirmed: true, expectedEmergencyEpoch: snapshot.emergencyEpoch });
});

elements.applicationControl.addEventListener("click", () => {
  if (!snapshot) return;
  if (snapshot.state === "FAULT") {
    if (!confirm("FAULTを確認済みにしてSETUPへ戻しますか？\nEmergency Muteは解除されません。Audio I/Oを手動で確認してください。")) return;
    sendCommand({ type: "ACKNOWLEDGE_FAULT", confirmed: true });
    return;
  }
  const locking = snapshot.state !== "ON_AIR";
  if (!confirm(locking
    ? "Production LockをONにしますか？\n構成変更はロックされます。"
    : "Production LockをOFFにして設定変更を許可しますか？")) return;
  sendCommand({ type: "SET_STATE", state: locking ? "ON_AIR" : "SETUP", confirmed: true });
});

elements.statusRefresh.addEventListener("click", async () => {
  elements.statusRefresh.disabled = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    statusBreakdownRenderedAt = 0;
    render(await response.json());
    showNotice("最新状態へ更新しました");
  } catch {
    showNotice("状態を更新できません。接続を確認してください", true);
  } finally {
    elements.statusRefresh.disabled = false;
  }
});

elements.statusReset.addEventListener("click", () => {
  if (!snapshot) return;
  statusStatsBaseline = captureStatusBaseline(snapshot);
  statusBreakdownRenderedAt = 0;
  renderStatus(snapshot);
  showNotice("Statsの表示基準をリセットしました");
});

elements.statusOpenRecovery.addEventListener("click", () => {
  if (!snapshot) return;
  const guidance = statusGuidance(snapshot);
  if (!guidance.view) return;
  showView(guidance.view);
  const target = document.querySelector(guidance.target);
  const details = target?.closest("details");
  if (details) details.open = true;
  target?.scrollIntoView({ block: "center" });
});
elements.restartRouter.addEventListener("click", async () => {
  if (!snapshot || elements.restartRouter.disabled) return;
  if (!confirm("ParaBus本体を再起動しますか？\nDiscord BotとAudio I/Oはいったん切断されます。\n物理Audio I/OとCUEは安全のため自動復帰しません。")) return;
  restartRequested = true;
  renderRestart(snapshot);
  try {
    const response = await fetch("/api/restart", {
      method: "POST",
      headers: desktopJsonHeaders,
      body: JSON.stringify({ confirmed: true }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? "再起動できませんでした");
    showNotice("ParaBus本体を再起動しています");
  } catch (error) {
    restartRequested = false;
    renderRestart(snapshot);
    showNotice(error instanceof Error ? error.message : "再起動できませんでした", true);
  }
});

elements.shutdownRouter.addEventListener("click", async () => {
  if (!snapshot || !localSettingsAvailable || elements.shutdownRouter.disabled) return;
  if (!confirm("ParaBus を終了しますか？\nDiscord Bot・Audio I/O・ランチャーを停止します。")) return;
  shutdownRequested = true;
  renderRestart(snapshot);
  try {
    const response = await fetch("/api/shutdown", { method: "POST", headers: desktopJsonHeaders, body: JSON.stringify({ confirmed: true }) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? "終了できませんでした");
    clearTimeout(reconnectTimer);
    showNotice("ParaBusを終了しています。このタブを閉じてください");
  } catch (error) {
    shutdownRequested = false;
    renderRestart(snapshot);
    showNotice(error instanceof Error ? error.message : "終了できませんでした", true);
  }
});

elements.showMix.addEventListener("click", () => showView("mix"));
elements.mixBankPrev.addEventListener("click", () => {
  mixBankIndex = Math.max(0, mixBankIndex - 1);
  if (snapshot) renderParticipants(snapshot, selectedMixBot(snapshot), selectedMixBotProfileId === "all");
});
elements.mixBankNext.addEventListener("click", () => {
  mixBankIndex += 1;
  if (snapshot) renderParticipants(snapshot, selectedMixBot(snapshot), selectedMixBotProfileId === "all");
});
elements.showRoute.addEventListener("click", () => showView("route"));
elements.showStatus.addEventListener("click", () => {
  showView("status");
  statusBreakdownRenderedAt = 0;
  if (snapshot) renderStatus(snapshot);
});
elements.showSession.addEventListener("click", () => showView("session"));
elements.showSetup.addEventListener("click", () => showView("setup"));
elements.setupOpenRoute.addEventListener("click", () => { showView("route"); elements.vcRouteList.focus({ preventScroll: true }); });
elements.routeOpenDevices.addEventListener("click", () => { showView("setup"); elements.ioOutputDevice.focus({ preventScroll: true }); });
elements.sceneSelect.addEventListener("change", () => {
  selectedSceneId = elements.sceneSelect.value || null;
  scenePreview = null;
  scenePreviewSignature = "";
  if (snapshot) renderScenes(snapshot);
});
elements.saveScene.addEventListener("click", () => {
  const name = elements.sceneName.value.trim();
  if (!name) {
    showNotice("Scene名を入力してください", true);
    elements.sceneName.focus();
    return;
  }
  if (sendCommand({ type: "SAVE_SCENE", name })) elements.sceneName.value = "";
});
elements.sceneName.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  elements.saveScene.click();
});
elements.previewScene.addEventListener("click", () => {
  if (!selectedSceneId) return;
  scenePreview = null;
  scenePreviewSignature = "";
  elements.scenePreviewSummary.textContent = "変更内容を取得しています";
  sendCommand({ type: "PREVIEW_SCENE", sceneId: selectedSceneId });
});
elements.overwriteScene.addEventListener("click", () => {
  const scene = snapshot?.scenes?.find((candidate) => candidate.id === selectedSceneId);
  if (!scene || !confirm("Scene「" + scene.name + "」を現在のMIXで上書きしますか？\nこの操作は元に戻せません。")) return;
  scenePreview = null;
  scenePreviewSignature = "";
  sendCommand({ type: "SAVE_SCENE", sceneId: scene.id, name: scene.name, confirmed: true });
});
elements.deleteScene.addEventListener("click", () => {
  const scene = snapshot?.scenes?.find((candidate) => candidate.id === selectedSceneId);
  if (!scene || !confirm(`Scene「${scene.name}」を削除しますか？\nこの操作は元に戻せません。`)) return;
  sendCommand({ type: "DELETE_SCENE", sceneId: scene.id, confirmed: true });
});
elements.recallScene.addEventListener("click", () => {
  const scene = snapshot?.scenes?.find((candidate) => candidate.id === selectedSceneId);
  if (!scene || scenePreview?.sceneId !== scene.id) {
    showNotice("先にSceneの変更を確認してください", true);
    return;
  }
  const changes = scenePreview.changes ?? [];
  const applyCount = changes.filter((change) => !change.locked && !change.recallSafe).length;
  const protectedCount = changes.length - applyCount;
  if (!confirm(`Scene「${scene.name}」をRecallしますか？\n適用 ${applyCount}件 / 保護・ロック ${protectedCount}件`)) return;
  if (sendCommand({ type: "RECALL_SCENE", sceneId: scene.id, confirmed: true })) {
    scenePreview = null;
    scenePreviewSignature = "";
  }
});
elements.recorderTargets.addEventListener("click", (event) => {
  const button = event.target.closest("[data-recording-select]");
  if (!button || !recorderSelection || !snapshot?.recorder?.selectionSupported || ["RECORDING", "STOPPING"].includes(snapshot.recorder.state)) return;
  const group = button.dataset.recordingSelect;
  if (!recorderSelection[group]) return;
  recorderSelection[group].clear();
  if (button.dataset.selected === "true") {
    for (const refs of recorderTargetRefs.values()) if (refs.group === group && refs.available) recorderSelection[group].add(refs.id);
  }
  if (snapshot) renderRecorder(snapshot);
});
elements.startRecording.addEventListener("click", () => {
  if (!snapshot?.recorder?.selectionSupported || ["RECORDING", "STOPPING"].includes(snapshot.recorder.state) || elements.startRecording.disabled) return;
  const selection = selectedRecordingTargets();
  const matrixOutput = selection.outputs[0] ?? 0;
  const includeUsers = selection.channelIds.length > 0;
  const includeBuses = selection.busIds.length > 0;
  const prompt = `選択した音声を録音しますか？\nMain Output: ${selection.outputs.map((output) => output + 1).join(", ") || "なし"}\nVC MIX: ${selection.busIds.length}件\nUser / Input: ${selection.channelIds.length}件\n対象は開始時に固定します。本線やCueの出力は変更しません。`;
  if (!confirm(prompt)) return;
  sendCommand({ type: "START_RECORDING", matrixOutput, includeUsers, includeBuses, selection, confirmed: true });
});
elements.stopRecording.addEventListener("click", () => {
  if (!confirm("録音を停止してWAV Headerを確定しますか？")) return;
  sendCommand({ type: "STOP_RECORDING", confirmed: true });
});
elements.setupForm.addEventListener("submit", saveBotProfiles);
elements.appPort.addEventListener("change", markSettingsDirty);
elements.lanAccessEnabled.addEventListener("change", markSettingsDirty);
elements.sharedGuildId.addEventListener("change", changeSharedGuild);
elements.exportBotProfiles.addEventListener("click", exportBotProfiles);
elements.importBotProfiles.addEventListener("change", importBotProfiles);
elements.addBotProfile.addEventListener("click", () => {
  addBotProfile()?.scrollIntoView({ behavior: "smooth", block: "center" });
});
elements.addBotTokens.addEventListener("click", addBotProfileTokens);
elements.addTxProfile.addEventListener("click", () => addBotProfile("TX", "", "TX"));
elements.addDuplexProfile.addEventListener("click", () => addBotProfile("BOT", "", "DUPLEX"));

elements.ioOutputDevice.addEventListener("change", () => {
  autoSelectSafetyEndpoint(elements.ioOutputDevice, elements.ioOutputEndpoint, snapshot?.output?.devices ?? [], "render");
  if (snapshot) renderIo(snapshot);
});
elements.ioCueOutputDevice.addEventListener("change", () => {
  autoSelectSafetyEndpoint(elements.ioCueOutputDevice, elements.ioCueOutputEndpoint, snapshot?.cueOutput?.devices ?? [], "render");
  if (snapshot) renderIo(snapshot);
});
elements.sharedCueMode.addEventListener("change", () => { if (snapshot) renderSharedCue(snapshot); });
elements.groupBusSelect.addEventListener("change", () => { if (snapshot) renderGroupBuses(snapshot); });
elements.applyGroupBus.addEventListener("click", applyGroupBus);
elements.removeGroupBus.addEventListener("click", () => {
  if (snapshot && !["ON_AIR", "FAULT"].includes(snapshot.state) && elements.groupBusSelect.value && confirm("グループを削除しますか？元のVCは残ります。")) sendCommand({ type: "REMOVE_VC_BUS", busId: elements.groupBusSelect.value, confirmed: true });
});
elements.sharedCueChannel.addEventListener("change", () => { if (snapshot) renderSharedCue(snapshot); });
elements.applySharedCue.addEventListener("click", applySharedCue);
elements.clearSharedCue.addEventListener("click", () => {
  if (snapshot?.state === "SETUP" && !elements.clearSharedCue.disabled && confirm("Main内のCue割当を解除しますか？")) sendCommand({ type: "SET_MONITOR_OUTPUT", output: null });
});
elements.ioInputDevice.addEventListener("change", () => {
  autoSelectSafetyEndpoint(elements.ioInputDevice, elements.ioInputEndpoint, snapshot?.input?.devices ?? [], "capture");
  updateInputChannelOptions();
  if (snapshot) renderIo(snapshot);
});
elements.ioOutputEndpoint.addEventListener("change", () => {
  if (snapshot) renderIo(snapshot);
});
elements.ioCueOutputEndpoint.addEventListener("change", () => {
  if (snapshot) renderIo(snapshot);
});
elements.ioInputEndpoint.addEventListener("change", () => {
  if (snapshot) renderIo(snapshot);
});
elements.refreshIo.addEventListener("click", () => {
  sendCommand({ type: "REFRESH_OUTPUT_DEVICES" });
  sendCommand({ type: "REFRESH_CUE_OUTPUT_DEVICES" });
  sendCommand({ type: "REFRESH_INPUT_DEVICES" });
  void loadWindowsEndpoints(true);
});
elements.applyIoOutput.addEventListener("click", () => {
  if (!snapshot) return;
  const device = selectedIoDevice(elements.ioOutputDevice, snapshot.output?.devices);
  const endpoint = windowsEndpointInventory.find((candidate) => candidate.id === elements.ioOutputEndpoint.value);
  if (!device || device.backend !== "portaudio" || (requiresWindowsEndpoint(device) && !endpoint)) return showNotice("物理出力と同名のWindows endpointを選択してください", true);
  const route = requiresWindowsEndpoint(device) ? `Windows endpoint: ${endpoint.name}` : `${device.hostApi} · ${device.maxOutputChannels}ch`;
  const prompt = `Main出力デバイスを開始／切り替えますか？\n${device.name}\n${route}\n\n保存済みのROUTEから音が出る場合があります。自動Fallback・自動再開は行いません。先に音量を下げてください。`;
  if (!confirm(prompt)) return;
  if (device.hostApi === "ASIO") return sendCommand({ type: "SELECT_OUTPUT_DEVICE", deviceId: device.id });
  if (!requiresWindowsEndpoint(device)) return sendCommand({ type: "SELECT_OUTPUT_DEVICE", deviceId: device.id });
  sendCommand({ type: "SELECT_OUTPUT_DEVICE", deviceId: device.id, windowsEndpointId: endpoint.id });
});
elements.closeIoOutput.addEventListener("click", () => {
  const mock = snapshot?.output?.devices?.find((device) => device.backend === "mock");
  if (!mock || !confirm(`Main出力デバイスを停止しますか？\n${snapshot.output?.selectedDeviceName ?? "Main"}\n本線の音が止まります。ROUTEの割り当ては保持し、Mockへ戻します。\nTX送信中は先にTXを停止してください。`)) return;
  sendCommand({ type: "SELECT_OUTPUT_DEVICE", deviceId: mock.id });
});
elements.applyIoCueOutput.addEventListener("click", () => {
  if (!snapshot) return;
  const device = selectedIoDevice(elements.ioCueOutputDevice, snapshot.cueOutput?.devices);
  const endpoint = windowsEndpointInventory.find((candidate) => candidate.id === elements.ioCueOutputEndpoint.value);
  if (!device || device.backend !== "portaudio" || device.hostApi === "ASIO" || (requiresWindowsEndpoint(device) && !endpoint)) return showNotice("Cue用出力と必要なWindows endpointを選択してください", true);
  if (snapshot.output?.state === "READY" && snapshot.output.selectedDeviceId === device.id) return showNotice("MainとCueに同じ物理デバイスは選べません", true);
  if (!confirm(`独立Cueデバイスを開始／切り替えますか？\n${device.name}\nStereo · ${device.hostApi}\n\n先にイヤホンの音量を下げてください。選択中のCUEがあれば音が出ます。Cueが故障してもMain出力は停止しません。`)) return;
  if (!requiresWindowsEndpoint(device)) return sendCommand({ type: "SELECT_CUE_OUTPUT_DEVICE", deviceId: device.id });
  sendCommand({ type: "SELECT_CUE_OUTPUT_DEVICE", deviceId: device.id, windowsEndpointId: endpoint.id });
});
elements.closeIoCueOutput.addEventListener("click", () => {
  const mock = snapshot?.cueOutput?.devices?.find((device) => device.backend === "mock");
  if (!mock || !confirm("独立Cueデバイスを停止しますか？\nMain出力には影響しません。")) return;
  sendCommand({ type: "SELECT_CUE_OUTPUT_DEVICE", deviceId: mock.id });
});
elements.routeMatrixMode.addEventListener("change", () => { if (snapshot) renderRouteOverview(snapshot); });
elements.routeMatrixPrev.addEventListener("click", () => { routeMatrixBank = Math.max(0, routeMatrixBank - 1); if (snapshot) renderRouteOverview(snapshot); });
elements.routeMatrixNext.addEventListener("click", () => { routeMatrixBank += 1; if (snapshot) renderRouteOverview(snapshot); });
elements.applyIoInput.addEventListener("click", () => {
  if (!snapshot) return;
  const device = selectedIoDevice(elements.ioInputDevice, snapshot.input?.devices);
  const endpoint = windowsEndpointInventory.find((candidate) => candidate.id === elements.ioInputEndpoint.value);
  const channelCount = Number(elements.ioInputChannels.value);
  if (!device?.id.startsWith("pa:") || (requiresWindowsEndpoint(device) && !endpoint) || !Number.isInteger(channelCount)) return showNotice("物理入力と同名のWindows endpointを選択してください", true);
  const route = requiresWindowsEndpoint(device) ? `Windows endpoint: ${endpoint.name}` : `${device.hostApi} · 最大${device.maxInputChannels}ch`;
  const prompt = `入力デバイスを開始／切り替えますか？\n${device.name}\n${route}\n${channelCount} channel\n\nこの操作だけではDiscordへ送信されません。送信先とInput ChはROUTEで設定します。`;
  if (!confirm(prompt)) return;
  if (device.hostApi === "ASIO") return sendCommand({ type: "SELECT_INPUT_DEVICE", deviceId: device.id, channelCount });
  if (!requiresWindowsEndpoint(device)) return sendCommand({ type: "SELECT_INPUT_DEVICE", deviceId: device.id, channelCount });
  sendCommand({ type: "SELECT_INPUT_DEVICE", deviceId: device.id, channelCount, windowsEndpointId: endpoint.id });
});
elements.closeIoInput.addEventListener("click", () => {
  const mock = snapshot?.input?.devices?.find((device) => device.id === "mock-studio-8");
  if (!mock || !confirm("入力デバイスを停止してMockへ戻しますか？\nTX送信中は先にTXを停止してください。")) return;
  sendCommand({ type: "SELECT_INPUT_DEVICE", deviceId: mock.id, channelCount: 1 });
});

fetch("/api/state", { cache: "no-store" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
  .then(render)
  .catch(() => showNotice("初期状態を取得できません。再接続を待っています", true));

renderDesktopAccess();
setConnection(false);
connect();
void loadDesktopSettings();
const requestedView = new URLSearchParams(location.search).get("view");
if (requestedView === "setup" || requestedView === "settings") showView("setup");
