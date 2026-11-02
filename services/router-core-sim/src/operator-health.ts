import type {
  OperatorHealthSnapshot,
  OperatorRootCauseSnapshot,
  OperatorSeverity,
  OperatorSystemHealthSnapshot,
  OperatorUserHealthSnapshot,
  RouterSnapshot,
} from "../../../packages/shared-types/src/index.ts";
import { safeOperatorError, sanitizeOperatorMessage } from "./operator-sanitize.ts";

const IMPORTANT_EVENT = /started|stopped|state changed|ready|on air|fault|emergency|scene|joined|left|moved|pending|approved|revoked|trusted|receiver|owner|device|record|output|routing|setup/i;
const PRIORITY: Record<OperatorSeverity, number> = { OK: 0, WARNING: 1, CRITICAL: 2 };

// Keep repeated recent faults visible for 30s, rather than latching lifetime totals; state is delivered about once/sec.
const RX_QUALITY_WINDOW_MS = 30_000;
const RX_QUALITY_BUCKET_MS = 1_000;
type RxCounters = { packets: number; gaps: number; drops: number; speechUnderruns: number };
type RxQualityBucket = RxCounters & { at: number };
type RxQualityState = { identity: string; observedAt: number; previous: RxCounters; buckets: RxQualityBucket[] };

/** Operator-only memory: never adds histories or counters to the 1 Hz state payload. */
export class OperatorHealthTracker {
  #sources = new Map<string, RxQualityState>();

  derive(snapshot: RouterSnapshot, now = performance.now()): OperatorHealthSnapshot {
    const warnings = new Set<string>();
    const next = new Map<string, RxQualityState>();
    const sessions = new Map(snapshot.userSessions?.map(session => [session.discordUserId, session.sessionGeneration]));
    for (const source of snapshot.discord?.sources ?? []) {
      const counters: RxCounters = { packets: source.packets, gaps: source.sequenceGaps, drops: source.droppedSamples,
        speechUnderruns: source.rxTiming?.inSpeechUnderruns ?? 0 };
      const identity = JSON.stringify([source.botId, source.guildId, source.voiceChannelId, source.userId, sessions.get(source.userId)]);
      const previous = this.#sources.get(source.channelId);
      // An initial/retired/reset source, or an unobserved 30s interval, cannot date its lifetime totals.
      // Establish a baseline instead of treating old totals as newly audible problems.
      if (!previous || previous.identity !== identity || now < previous.observedAt || now - previous.observedAt >= RX_QUALITY_WINDOW_MS
        || (Object.keys(counters) as (keyof RxCounters)[]).some(key => counters[key] < previous.previous[key])) {
        next.set(source.channelId, { identity, observedAt: now, previous: counters, buckets: [] });
        continue;
      }
      const delta: RxCounters = { packets: counters.packets - previous.previous.packets, gaps: counters.gaps - previous.previous.gaps,
        drops: counters.drops - previous.previous.drops, speechUnderruns: counters.speechUnderruns - previous.previous.speechUnderruns };
      const buckets = previous.buckets.filter(bucket => now - bucket.at < RX_QUALITY_WINDOW_MS);
      if (delta.packets || delta.gaps || delta.drops || delta.speechUnderruns) {
        let bucket = buckets.at(-1);
        if (!bucket || now - bucket.at >= RX_QUALITY_BUCKET_MS) {
          bucket = { at: now, packets: 0, gaps: 0, drops: 0, speechUnderruns: 0 };
          buckets.push(bucket);
        }
        bucket.packets += delta.packets; bucket.gaps += delta.gaps;
        bucket.drops += delta.drops; bucket.speechUnderruns += delta.speechUnderruns;
      }
      // At most 30 one-second buckets per active source; frequent GET/command snapshots share a bucket.
      // Expiry uses its start, so coalescing never keeps an old problem alive beyond 30 seconds.
      const totals = buckets.reduce((sum, bucket) => ({ packets: sum.packets + bucket.packets, gaps: sum.gaps + bucket.gaps,
        drops: sum.drops + bucket.drops, speechUnderruns: sum.speechUnderruns + bucket.speechUnderruns }),
      { packets: 0, gaps: 0, drops: 0, speechUnderruns: 0 });
      // Drops can lose PCM immediately; >=2 in-speech shortages distinguish repeated interruptions from an isolated fill.
      // GAP alone is weaker evidence: require increases in >=2 separate one-second buckets AND >5% missing
      // of received+missing packets. A single RTP numbering jump (even 52) must not latch the live warning.
      const gapWarning = source.sequenceGapsKnown !== false && buckets.filter(bucket => bucket.gaps > 0).length >= 2
        && totals.gaps / (totals.packets + totals.gaps) > .05;
      if (totals.drops > 0 || totals.speechUnderruns >= 2 || gapWarning) warnings.add(source.channelId);
      next.set(source.channelId, { identity, observedAt: now, previous: counters, buckets });
    }
    this.#sources = next;
    return deriveOperatorHealth(snapshot, warnings);
  }
}

function highest(values: readonly OperatorSeverity[]): OperatorSeverity {
  return values.reduce<OperatorSeverity>((result, value) => PRIORITY[value] > PRIORITY[result] ? value : result, "OK");
}

function vcName(snapshot: RouterSnapshot, voiceChannelId: string | null | undefined): string {
  if (!voiceChannelId) return "—";
  return sanitizeOperatorMessage(snapshot.discord?.availableVoiceChannels.find((channel) => channel.id === voiceChannelId)?.name ?? "Unknown VC", "Unknown VC");
}

function systemHealth(snapshot: RouterSnapshot): OperatorSystemHealthSnapshot[] {
  const discord = snapshot.discord;
  const configured = discord?.configuredBots ?? 0;
  const ready = discord?.readyBots ?? 0;
  const discordSeverity: OperatorSeverity = configured === 0 ? "WARNING" : ready === configured ? "OK" : ready === 0 ? "CRITICAL" : "WARNING";
  const discordSummary = configured === 0 ? "Not configured" : ready === configured ? `${ready} Bots ready` : `${ready}/${configured} Bots ready`;
  const inputFault = snapshot.input?.state === "FAULT";
  const audioSeverity: OperatorSeverity = snapshot.emergencyMuted || snapshot.state === "FAULT" || inputFault ? "CRITICAL" : snapshot.xruns > 0 ? "WARNING" : "OK";
  const audioSummary = snapshot.emergencyMuted ? "Emergency mute active" : inputFault ? "Input unavailable · paths fail closed" : snapshot.state === "FAULT" ? "Outputs fail closed" : snapshot.xruns > 0 ? "Realtime deadline warning" : "Realtime engine ready";
  const outputSeverity: OperatorSeverity = snapshot.output?.state === "READY" ? "OK" : snapshot.output?.state === "FAULT" ? "CRITICAL" : "WARNING";
  const outputSummary = snapshot.output?.state === "READY" ? (snapshot.output.selectedDeviceName ?? "Output ready") : snapshot.output?.state === "FAULT" ? "Output unavailable" : "Output stopped";
  const recorderSeverity: OperatorSeverity = snapshot.recorder?.state === "FAULT" ? "WARNING" : "OK";
  const recorderSummary = snapshot.recorder?.state === "RECORDING" ? "Recording" : snapshot.recorder?.state === "FAULT" ? "Recorder fault · output continues" : "Idle";
  return [
    { id: "discord", label: "Discord", severity: discordSeverity, summary: discordSummary },
    { id: "audio", label: "Audio Engine", severity: audioSeverity, summary: audioSummary },
    { id: "output", label: "Output", severity: outputSeverity, summary: outputSummary },
    { id: "recorder", label: "Recorder", severity: recorderSeverity, summary: recorderSummary },
  ];
}

function userHealth(snapshot: RouterSnapshot, rxWarnings: ReadonlySet<string>): OperatorUserHealthSnapshot[] {
  const sessions = new Map((snapshot.userSessions ?? []).map((session) => [session.discordUserId, session]));
  const sources = new Map((snapshot.discord?.sources ?? []).map((source) => [source.channelId, source]));
  return snapshot.channels.map((channel) => {
    const session = channel.discordUserId ? sessions.get(channel.discordUserId) : undefined;
    const source = sources.get(channel.id);
    const owner = channel.currentVoiceChannelId
      ? snapshot.discord?.receiverOwnership.find((entry) => entry.voiceChannelId === channel.currentVoiceChannelId)
      : undefined;
    const approvalState = channel.kind === "DiscordUser" ? (session?.sessionApproval ?? (channel.approvalGateOpen ? "APPROVED" : "PENDING")) : "NOT REQUIRED";
    let severity: OperatorSeverity = "OK";
    let reason = channel.kind === "DiscordUser" ? "Approved / Active" : "Local source";
    if (approvalState === "PENDING") {
      severity = "WARNING";
      reason = "Approval pending · audio blocked";
    } else if (owner && owner.status !== "ACTIVE") {
      severity = "CRITICAL";
      reason = owner.status === "CONFLICT" ? "Receiver authority conflict · audio blocked" : owner.status === "DISCONNECTED" ? "Receiver owner disconnected" : "Receiver owner unselected";
    } else if (channel.meter.stale || rxWarnings.has(channel.id)) {
      severity = "WARNING";
      reason = channel.meter.stale ? "RX audio stale" : "RX quality warning";
    }
    const activeReceiver = owner?.receivers.find((receiver) => receiver.state === "ACTIVE");
    return {
      channelId: channel.id,
      label: channel.label,
      severity,
      reason,
      currentVC: vcName(snapshot, channel.currentVoiceChannelId ?? session?.currentVC),
      rxState: channel.kind === "DiscordUser" ? (channel.meter.stale ? "STALE" : source ? "RECEIVING" : "WAITING") : "LOCAL",
      packetGaps: source?.sequenceGaps ?? 0,
      droppedPackets: source?.droppedSamples ?? 0,
      queuedMilliseconds: source?.queuedMilliseconds ?? 0,
      lastAudioAgoMs: source?.lastPacketAgoMs ?? null,
      approvalState,
      receiverOwner: activeReceiver?.label ?? (owner?.status === "CONFLICT" ? "CONFLICT" : owner?.status === "DISCONNECTED" ? "DISCONNECTED" : owner?.status === "UNSELECTED" ? "UNSELECTED" : "—"),
    };
  });
}

function rootCauses(snapshot: RouterSnapshot, system: OperatorSystemHealthSnapshot[], users: OperatorUserHealthSnapshot[]): OperatorRootCauseSnapshot[] {
  const causes: OperatorRootCauseSnapshot[] = [];
  if (snapshot.emergencyMuted) causes.push({
    id: "emergency", severity: "CRITICAL", title: "Emergency mute active", summary: "All outputs are silent", details: ["Emergency Mute has priority over every route and approval state."], actionView: "scenes",
  });
  if (snapshot.input?.state === "FAULT") {
    const error = safeOperatorError("audio-input");
    causes.push({ id: "input", severity: "CRITICAL", title: error.summary, summary: "Input-dependent paths muted", details: [error.action], actionView: "io" });
  }
  if (snapshot.output?.state === "FAULT" || (snapshot.state === "FAULT" && snapshot.input?.state !== "FAULT")) {
    const error = safeOperatorError("audio-output");
    causes.push({ id: "output", severity: "CRITICAL", title: error.summary, summary: "Outputs muted", details: [error.action], actionView: "io" });
  } else if (snapshot.output && snapshot.output.state !== "READY" && snapshot.state !== "FAULT" && !snapshot.emergencyMuted) {
    causes.push({ id: "output", severity: "WARNING", title: "Audio output stopped", summary: "No physical output is active", details: ["Select and start an output device before going ON AIR."], actionView: "io" });
  }
  const discord = system.find((item) => item.id === "discord")!;
  if (discord.severity !== "OK") causes.push({
    id: "discord", severity: discord.severity, title: discord.severity === "CRITICAL" ? "Discord connection unavailable" : "Discord setup incomplete", summary: discord.severity === "CRITICAL" ? "Receive paths closed" : discord.summary, details: ["Bot connectivity is aggregated by current readiness."], actionView: "bot-rack",
  });
  for (const receiver of snapshot.discord?.receiverOwnership ?? []) {
    if (receiver.status === "ACTIVE") continue;
    const standby = receiver.receivers.filter((candidate) => candidate.state === "STANDBY" && candidate.health === "READY").map((candidate) => candidate.label);
    causes.push({
      id: `receiver:${receiver.voiceChannelId}`,
      severity: receiver.status === "DISCONNECTED" || receiver.status === "CONFLICT" ? "CRITICAL" : "WARNING",
      title: `${sanitizeOperatorMessage(receiver.voiceChannelName ?? "Discord VC", "Discord VC")} receiver ${receiver.status === "CONFLICT" ? "authority conflict" : receiver.status === "DISCONNECTED" ? "disconnected" : "unselected"}`,
      summary: receiver.status === "CONFLICT" ? "Duplicate authority · RX fail closed" : standby.length ? `${standby.join(", ")} standby available` : "RX remains fail closed",
      details: [receiver.status === "CONFLICT" ? "Resolve duplicate receiver authority before selecting an owner." : "Automatic failover is disabled.", ...(standby.length ? [`Standby: ${standby.join(", ")}`] : [])],
      actionView: "bot-rack",
    });
  }
  const pending = users.filter((user) => user.approvalState === "PENDING");
  if (pending.length) causes.push({ id: "approval", severity: "WARNING", title: `${pending.length} participant${pending.length === 1 ? "" : "s"} pending`, summary: "Approval Gate is blocking audio", details: pending.slice(0, 8).map((user) => user.label), actionView: "mixer" });
  const otherUserWarnings = users.filter((user) => user.severity !== "OK" && user.approvalState !== "PENDING" && !user.reason.startsWith("Receiver owner"));
  if (otherUserWarnings.length) causes.push({ id: "user-health", severity: highest(otherUserWarnings.map((user) => user.severity)), title: `${otherUserWarnings.length} participant health warning`, summary: "Open user details for RX quality", details: otherUserWarnings.slice(0, 8).map((user) => `${user.label}: ${user.reason}`) });
  const txWarnings = (snapshot.discord?.receiverOwnership ?? []).flatMap((entry) => entry.transmitters.filter((bot) => bot.health !== "READY").map((bot) => `${entry.voiceChannelName ?? "Discord VC"}: ${bot.label}`));
  if (txWarnings.length) causes.push({ id: "tx-health", severity: "WARNING", title: `${txWarnings.length} TX return${txWarnings.length === 1 ? "" : "s"} unavailable`, summary: "Receive ownership is unchanged", details: txWarnings, actionView: "bot-rack" });
  if (snapshot.recorder?.state === "FAULT") {
    const error = safeOperatorError("recorder");
    causes.push({ id: "recorder", severity: "WARNING", title: "Recorder fault", summary: "Program output continues", details: [`${error.summary}. ${error.action}`], actionView: "recorder" });
  }
  if (!snapshot.emergencyMuted && snapshot.state !== "FAULT" && snapshot.xruns > 0) causes.push({ id: "audio", severity: "WARNING", title: "Audio realtime warning", summary: "Deadline miss detected", details: ["Open Diagnostics for callback and XRUN counters."] });
  return causes.sort((left, right) => PRIORITY[right.severity] - PRIORITY[left.severity]);
}

/** Pure projection; use OperatorHealthTracker for RX warnings based on observed counter deltas. */
export function deriveOperatorHealth(snapshot: RouterSnapshot, rxWarnings: ReadonlySet<string> = new Set()): OperatorHealthSnapshot {
  const system = systemHealth(snapshot);
  const users = userHealth(snapshot, rxWarnings);
  const receivers = (snapshot.discord?.receiverOwnership ?? []).map((entry) => {
    const owner = entry.receivers.find((receiver) => receiver.state === "ACTIVE") ?? entry.receivers.find((receiver) => receiver.profileId === entry.ownerProfileId);
    return {
      voiceChannel: sanitizeOperatorMessage(entry.voiceChannelName ?? "Discord VC", "Discord VC"),
      severity: entry.status === "ACTIVE" ? "OK" as const : entry.status === "DISCONNECTED" || entry.status === "CONFLICT" ? "CRITICAL" as const : "WARNING" as const,
      owner: owner?.label ?? "No active owner",
      ownerState: entry.status,
      standby: entry.receivers.filter((receiver) => receiver.state === "STANDBY" && receiver.health === "READY").map((receiver) => receiver.label),
      transmitters: entry.transmitters.map((bot) => ({ label: bot.label, state: bot.health === "READY" ? "OK" as const : "WARNING" as const })),
    };
  });
  const roots = rootCauses(snapshot, system, users);
  const recentEvents = (snapshot.alerts ?? [])
    .filter((event) => IMPORTANT_EVENT.test(event.message))
    .slice(0, 8)
    .map((event) => ({ at: event.at, severity: event.level === "CRITICAL" ? "CRITICAL" as const : event.level === "WARNING" ? "WARNING" as const : "OK" as const, message: sanitizeOperatorMessage(event.message, "Operator event") }));
  const overallSeverity = highest([...system.map((item) => item.severity), ...users.map((user) => user.severity), ...receivers.flatMap((receiver) => [receiver.severity, ...receiver.transmitters.map((transmitter) => transmitter.state)])]);
  const first = roots[0];
  return {
    overallSeverity,
    system,
    users,
    receivers,
    rootCauses: roots,
    recentEvents,
    headerAlert: first ? { severity: first.severity === "CRITICAL" ? "CRITICAL" : "WARNING", message: `${first.severity} — ${first.title} — ${first.summary}` } : null,
  };
}
