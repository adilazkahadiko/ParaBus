const $ = (selector) => document.querySelector(selector);
const refs = {
  pairScreen: $("#pair-screen"), pairForm: $("#pair-form"), pairCode: $("#pair-code"), pairError: $("#pair-error"), app: $("#tablet-app"),
  connection: $("#connection"), routerState: $("#router-state"), emergency: $("#emergency"), offline: $("#offline-overlay"), toast: $("#toast"),
  nav: [...document.querySelectorAll("nav button")], views: [...document.querySelectorAll(".view")], busSelect: $("#bus-select"), busName: $("#bus-name"), busMute: $("#bus-mute"),
  busMeter: $("#bus-meter"), busDb: $("#bus-db"), busLufs: $("#bus-lufs"), busMaster: $("#bus-master"), busMasterNumber: $("#bus-master-number"),
  busLimiter: $("#bus-limiter"), participantCount: $("#participant-count"), participants: $("#participants"), masterList: $("#vc-master-list"), engineLoad: $("#engine-load"), engineDetail: $("#engine-detail"),
  discordReady: $("#discord-ready"), discordDetail: $("#discord-detail"), alertCount: $("#alert-count"), botList: $("#bot-list"), txList: $("#tx-list"), updatedAt: $("#updated-at"),
  recorderState: $("#recorder-state"), recorderDuration: $("#recorder-duration"), trackCount: $("#track-count"), queueState: $("#queue-state"), dropCount: $("#drop-count"),
  diskFree: $("#disk-free"), trackList: $("#track-list"), recorderMessage: $("#recorder-message"), sceneList: $("#scene-list"),
};
let socket, reconnectTimer, snapshot, selectedBusId = "", participantSignature = "", toastTimer;
const masterCards = new Map();

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value ?? ""); return node.innerHTML; }
function peakDb(value) { return value <= 0.000001 ? "−∞" : (20 * Math.log10(value)).toFixed(1); }
function meterPercent(value) { return Math.max(0, Math.min(100, (20 * Math.log10(Math.max(value, .00001)) + 60) / 60 * 100)); }
function lufs(value) { return !Number.isFinite(value) || value <= -70 ? "−∞" : Number(value).toFixed(1); }
function bytes(value) { if (value === null || value === undefined) return "—"; const units=["B","KB","MB","GB","TB"]; let n=value,i=0; while(n>=1024&&i<units.length-1){n/=1024;i++} return `${n.toFixed(i>1?1:0)} ${units[i]}`; }
function duration(seconds) { const value=Math.max(0,Math.floor(seconds??0)); return `${String(Math.floor(value/3600)).padStart(2,"0")}:${String(Math.floor(value%3600/60)).padStart(2,"0")}:${String(value%60).padStart(2,"0")}`; }
function showToast(message) { refs.toast.textContent=message; refs.toast.classList.add("visible"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>refs.toast.classList.remove("visible"),2500); }

async function restoreSession() {
  try {
    const response = await fetch("/api/state", { cache:"no-store" });
    if (!response.ok) return;
    snapshot = await response.json(); refs.pairScreen.hidden = true; refs.app.hidden = false; render(snapshot); connect();
  } catch { /* ペアリング画面を表示 */ }
}

refs.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault(); refs.pairError.textContent = ""; const code = refs.pairCode.value.replace(/\D/g, "");
  try {
    const response = await fetch("/api/pair", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({code}) });
    const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error ?? "接続できませんでした");
    refs.pairScreen.hidden = true; refs.app.hidden = false; connect();
  } catch (error) { refs.pairError.textContent = error instanceof Error ? error.message : String(error); }
});
refs.pairCode.addEventListener("input", () => { const digits=refs.pairCode.value.replace(/\D/g,"").slice(0,8); refs.pairCode.value=digits.length>4?`${digits.slice(0,4)} ${digits.slice(4)}`:digits; });

function connect() {
  clearTimeout(reconnectTimer); socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.addEventListener("open", () => setConnected(true)); socket.addEventListener("close", () => { setConnected(false); reconnectTimer=setTimeout(connect,1500); });
  socket.addEventListener("message", (event) => { const message=JSON.parse(event.data); if(message.type==="state"||message.type==="meters"){snapshot=message.payload;render(snapshot)} if(message.type==="command-result"&&!message.payload.ok)showToast(message.payload.error??"操作できませんでした"); if(message.type==="error")showToast(message.payload); });
}
function setConnected(connected) { refs.connection.textContent=connected?"接続中":"切断"; refs.connection.className=`badge ${connected?"online":"offline"}`; refs.offline.classList.toggle("visible",!connected); for(const card of masterCards.values())card.querySelectorAll("button, input").forEach(control=>control.disabled=!connected); }
function command(payload) { if(socket?.readyState!==WebSocket.OPEN)return showToast("再接続まで操作できません"); socket.send(JSON.stringify({type:"command",payload})); }

refs.nav.forEach((button)=>button.addEventListener("click",()=>{refs.nav.forEach((item)=>item.classList.toggle("active",item===button));refs.views.forEach((view)=>view.hidden=view.dataset.page!==button.dataset.view)}));
refs.busSelect.addEventListener("change",()=>{selectedBusId=refs.busSelect.value;participantSignature="";render(snapshot)});
refs.busMute.addEventListener("click",()=>{const bus=currentBus();if(bus)command({type:"SET_BUS_MUTE",busId:bus.id,mute:!bus.mute})});
refs.busMaster.addEventListener("input",()=>{refs.busMasterNumber.value=Number(refs.busMaster.value).toFixed(1);const bus=currentBus();if(bus)command({type:"SET_BUS_MASTER",busId:bus.id,db:Number(refs.busMaster.value)})});
refs.busMasterNumber.addEventListener("change",()=>{const value=Math.max(-90,Math.min(12,Number(refs.busMasterNumber.value)));refs.busMaster.value=String(value);refs.busMasterNumber.value=value.toFixed(1);const bus=currentBus();if(bus)command({type:"SET_BUS_MASTER",busId:bus.id,db:value})});
refs.emergency.addEventListener("click",()=>{if(snapshot?.emergencyMuted)return showToast("解除はDesktopで確認して行ってください");if(confirm("全出力を緊急ミュートしますか？"))command({type:"EMERGENCY_MUTE",active:true})});
function currentBus(){return snapshot?.buses?.find((bus)=>bus.id===selectedBusId)??snapshot?.buses?.[0]}

function render(data) {
  if(!data)return;const buses=data.buses??[];if(!selectedBusId||!buses.some((bus)=>bus.id===selectedBusId))selectedBusId=buses[0]?.id??"";
  const options=buses.map((bus)=>bus.id).join("|");if(refs.busSelect.dataset.signature!==options){refs.busSelect.innerHTML=buses.map((bus)=>`<option value="${escapeHtml(bus.id)}">${escapeHtml(bus.label)}</option>`).join("");refs.busSelect.dataset.signature=options}refs.busSelect.value=selectedBusId;
  refs.routerState.textContent=data.state;refs.routerState.style.color=data.state==="ON_AIR"?"var(--red)":data.state==="READY"?"var(--amber)":"var(--green)";refs.emergency.classList.toggle("active",data.emergencyMuted);refs.emergency.textContent=data.emergencyMuted?"緊急ミュート中":"緊急ミュート";
  renderMix(data,currentBus());renderMasters(data);renderMonitor(data);renderRecorder(data.recorder);renderScenes(data.scenes??[]);
}

function masterLabel(data, bus) {
  // Tablet projections omit binding IDs: only use an unambiguous VC-name match.
  if(data.buses.filter(candidate=>candidate.label===bus.label).length!==1)return bus.label;
  const matches=(data.discord?.bots??[]).filter(bot=>["RX","DUPLEX"].includes(bot.role)&&bot.voiceChannelName===bus.label);
  return matches.length===1 ? matches[0].label : bus.label;
}

function masterCard(busId) {
  const card=document.createElement("article");card.className="vc-master panel";card.dataset.bus=busId;
  card.innerHTML='<div class="bus-heading"><div class="vc-master-name"><h2></h2><small></small></div><div class="vc-master-actions"><button class="cue" aria-pressed="false">CUE</button><button class="mute" aria-pressed="false">MUTE</button></div></div><div class="meter-row"><div class="meter"><i></i></div><strong data-db>−∞ dBFS</strong><span data-lufs>−∞ LUFS-M</span></div><div class="level-control"><input type="range" min="-90" max="12" step="0.1"><input type="number" min="-90" max="12" step="0.1"><span>dB</span></div>';
  const range=card.querySelector('input[type="range"]'),number=card.querySelector('input[type="number"]');
  range.addEventListener("input",()=>{number.value=Number(range.value).toFixed(1);command({type:"SET_BUS_MASTER",busId,db:Number(range.value)})});
  number.addEventListener("change",()=>{
    const value=Number(number.value);
    if(!number.value.trim()||!Number.isFinite(value)){const bus=snapshot?.buses.find(bus=>bus.id===busId);number.value=String(bus?.masterDb??0);return showToast("レベルは -90〜+12 dB の数値で入力してください")}
    const db=Math.max(-90,Math.min(12,value));range.value=String(db);number.value=db.toFixed(1);command({type:"SET_BUS_MASTER",busId,db});
  });
  card.querySelector(".mute").addEventListener("click",()=>{const bus=snapshot?.buses.find(bus=>bus.id===busId);if(bus)command({type:"SET_BUS_MUTE",busId,mute:!bus.mute})});
  card.querySelector(".cue").addEventListener("click",()=>command({type:"SET_PFL",sourceId:snapshot?.monitorSourceId===busId?null:busId}));
  return card;
}

function renderMasters(data) {
  const buses=data.buses??[],liveIds=new Set(buses.map(bus=>bus.id));
  for(const [id,card] of masterCards){if(!liveIds.has(id)){card.remove();masterCards.delete(id)}}
  for(const bus of buses){
    let card=masterCards.get(bus.id);if(!card){card=masterCard(bus.id);masterCards.set(bus.id,card);refs.masterList.append(card)}
    const label=masterLabel(data,bus),cueActive=data.monitorSourceId===bus.id;
    card.querySelector("h2").textContent=label;card.querySelector("small").textContent=label===bus.label?"VC BUS":bus.label;
    card.classList.toggle("cue-active",cueActive);
    const mute=card.querySelector(".mute"),cue=card.querySelector(".cue"),range=card.querySelector('input[type="range"]'),number=card.querySelector('input[type="number"]');
    mute.classList.toggle("active",bus.mute);mute.textContent=bus.mute?"MUTED":"MUTE";mute.setAttribute("aria-pressed",String(bus.mute));mute.setAttribute("aria-label",`${label} MUTE`);
    cue.classList.toggle("active",cueActive);cue.setAttribute("aria-pressed",String(cueActive));cue.setAttribute("aria-label",`${label} CUE`);
    range.setAttribute("aria-label",`${label} Master fader`);number.setAttribute("aria-label",`${label} Master dB`);
    if(document.activeElement!==range&&document.activeElement!==number){range.value=String(bus.masterDb);number.value=Number(bus.masterDb).toFixed(1)}
    const meter=bus.inputMeter??bus.meter;
    card.querySelector(".meter i").style.width=`${meterPercent(meter.peak)}%`;card.querySelector("[data-db]").textContent=`${peakDb(meter.peak)} dBFS`;card.querySelector("[data-lufs]").textContent=`${lufs(bus.meter.loudnessMomentary)} LUFS-M`;
    card.querySelectorAll("button, input").forEach(control=>control.disabled=socket?.readyState!==WebSocket.OPEN);
  }
}

function renderMix(data,bus){
  if(!bus)return;refs.busName.textContent=bus.label;refs.busMute.classList.toggle("active",bus.mute);refs.busMute.textContent=bus.mute?"MUTED":"MUTE";refs.busMeter.style.width=`${meterPercent(bus.meter.peak)}%`;refs.busDb.textContent=`${peakDb(bus.meter.peak)} dBFS`;refs.busLufs.textContent=`${lufs(bus.meter.loudnessMomentary)} LUFS-M`;
  if(document.activeElement!==refs.busMaster)refs.busMaster.value=bus.masterDb;if(document.activeElement!==refs.busMasterNumber)refs.busMasterNumber.value=Number(bus.masterDb).toFixed(1);refs.busLimiter.textContent=bus.limiterEnabled?`Limiter ON · GR ${Number(bus.limiterGainReductionDb).toFixed(1)} dB`:"Limiter OFF";refs.participantCount.textContent=`${bus.participantCount}人`;
  const signature=`${bus.id}:${data.channels.map((channel)=>channel.id).join("|")}`;if(signature!==participantSignature){refs.participants.replaceChildren(...data.channels.map((channel)=>participantCard(channel)));participantSignature=signature}
  for(const channel of data.channels){const card=refs.participants.querySelector(`[data-channel="${CSS.escape(channel.id)}"]`);if(!card)continue;const send=channel.vcSends[bus.id]??{gainDb:-90,mute:true};card.querySelector(".meter i").style.width=`${meterPercent(channel.meter.peak)}%`;card.querySelector("[data-db]").textContent=`${peakDb(channel.meter.peak)} dBFS`;card.querySelector(".mute").classList.toggle("active",send.mute);card.querySelector(".mute").textContent=send.mute?"MUTED":"MUTE";card.querySelector(".pfl").classList.toggle("active",data.monitorSourceId===channel.id);const range=card.querySelector('input[type="range"]'),number=card.querySelector('input[type="number"]');if(document.activeElement!==range)range.value=send.gainDb;if(document.activeElement!==number)number.value=Number(send.gainDb).toFixed(1)}
}

function participantCard(channel){
  const card=document.createElement("article");card.className="participant";card.dataset.channel=channel.id;card.innerHTML=`<div class="participant-head"><div><h3>${escapeHtml(channel.label)}</h3><small>${escapeHtml(channel.kind)}</small></div><div class="participant-actions"><button class="pfl">PFL</button><button class="mute">MUTE</button></div></div><div class="meter-row"><div class="meter"><i></i></div><strong data-db>−∞ dBFS</strong></div><div class="level-control"><input type="range" min="-90" max="12" step="0.1" aria-label="${escapeHtml(channel.label)} send level"><input type="number" min="-90" max="12" step="0.1" aria-label="${escapeHtml(channel.label)} send dB"><span>dB</span></div>`;
  const range=card.querySelector('input[type="range"]'),number=card.querySelector('input[type="number"]');range.addEventListener("input",()=>{number.value=Number(range.value).toFixed(1);command({type:"SET_VC_SEND",channelId:channel.id,busId:selectedBusId,db:Number(range.value)})});number.addEventListener("change",()=>{const value=Math.max(-90,Math.min(12,Number(number.value)));range.value=value;number.value=value.toFixed(1);command({type:"SET_VC_SEND",channelId:channel.id,busId:selectedBusId,db:value})});card.querySelector(".mute").addEventListener("click",()=>{const current=snapshot.channels.find((item)=>item.id===channel.id)?.vcSends[selectedBusId]??{mute:true};command({type:"SET_VC_SEND",channelId:channel.id,busId:selectedBusId,mute:!current.mute})});card.querySelector(".pfl").addEventListener("click",()=>command({type:"SET_PFL",sourceId:snapshot.monitorSourceId===channel.id?null:channel.id}));return card;
}

function renderMonitor(data){
  refs.engineLoad.textContent=`${(data.callbackLoad*100).toFixed(1)}%`;refs.engineDetail.textContent=`${(data.sampleRate/1000).toFixed(0)} kHz · XRUN ${data.xruns}`;const discord=data.discord;refs.discordReady.textContent=discord?`${discord.readyBots} / ${discord.configuredBots}`:"—";refs.discordDetail.textContent=discord?`${discord.connectedAdapters} adapter · ${discord.adapterState}`:"未接続";refs.alertCount.textContent=`${data.alertSummary?.warning??0} / ${data.alertSummary?.critical??0}`;refs.updatedAt.textContent=new Date().toLocaleTimeString("ja-JP");
  refs.botList.innerHTML=discord?.bots?.length?discord.bots.map((bot)=>`<div class="status-item"><div><strong>${escapeHtml(bot.label)}</strong><small>${escapeHtml(bot.voiceChannelName??"VC名未取得")}</small></div><span class="mono">${bot.wsPingMs??"—"} / ${bot.udpPingMs??"—"} ms</span><span class="health ${String(bot.health).toLowerCase()}">${escapeHtml(bot.health)}</span></div>`).join(""):'<div class="status-item"><div><strong>Bot未設定</strong><small>Desktopの設定画面で追加します</small></div></div>';
  refs.txList.innerHTML=discord?.txStems?.length?discord.txStems.map((stem)=>`<div class="status-item"><div><strong>${escapeHtml(stem.label??"TX Return")}</strong><small>${escapeHtml(stem.subtype??"CUSTOM")} · ${escapeHtml(stem.voiceChannelName??"VC名未取得")}</small></div><span class="mono">${peakDb(stem.peak)} dBFS</span><span class="health ${String(stem.state).toLowerCase()}">${escapeHtml(stem.state)}</span></div>`).join(""):'<div class="status-item"><div><strong>TX Stemなし</strong><small>Returnはまだ設定されていません</small></div></div>';
}

function renderRecorder(recorder){
  if(!recorder)return;refs.recorderState.textContent=recorder.state;refs.recorderState.style.color=recorder.state==="RECORDING"||recorder.state==="FAULT"?"var(--red)":"var(--green)";refs.recorderDuration.textContent=duration(recorder.durationSeconds);refs.trackCount.textContent=recorder.tracks.length;refs.queueState.textContent=`${recorder.queuedBlocks} / ${recorder.maxQueuedBlocks}`;refs.dropCount.textContent=`DROP ${recorder.droppedBlocks}`;refs.dropCount.style.color=recorder.droppedBlocks?"var(--red)":"var(--muted)";refs.diskFree.textContent=bytes(recorder.freeBytes);refs.recorderMessage.textContent=recorder.message??"";refs.trackList.innerHTML=recorder.tracks.length?recorder.tracks.map((track)=>`<div class="status-item"><div><strong>${escapeHtml(track.label)}</strong><small>${escapeHtml(track.kind)}</small></div><span class="mono">${bytes(track.dataBytes)}</span></div>`).join(""):'<div class="status-item"><div><strong>録音トラックなし</strong><small>Desktopから録音を開始すると表示されます</small></div></div>';
}

function renderScenes(scenes){
  const signature=scenes.map((scene)=>`${scene.id}:${scene.name}:${scene.createdAt}`).join("|");if(refs.sceneList.dataset.signature===signature)return;refs.sceneList.dataset.signature=signature;refs.sceneList.innerHTML=scenes.length?scenes.map((scene)=>`<button class="scene" data-id="${escapeHtml(scene.id)}"><strong>${escapeHtml(scene.name)}</strong><small>${new Date(scene.createdAt).toLocaleString("ja-JP")}</small></button>`).join(""):'<div class="safety-note">保存済みシーンはありません。Desktopで作成してください。</div>';refs.sceneList.querySelectorAll(".scene").forEach((button)=>button.addEventListener("click",()=>{const scene=scenes.find((item)=>item.id===button.dataset.id);if(scene&&confirm(`シーン「${scene.name}」を呼び出しますか？\n現在のミックス値が変更されます。`))command({type:"RECALL_SCENE",sceneId:scene.id,confirmed:true})}));
}

restoreSession();
