export const periodicPatterns = ["steady", "measured-like", "burst-100ms"] as const;
export const matrixPatterns = ["realistic", "severe", "regular"] as const;
export type Pattern = typeof periodicPatterns[number] | typeof matrixPatterns[number];

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
export function deliveryMs(packet: number, pattern: Pattern): number {
  const offsets = pattern === "measured-like" || pattern === "regular" ? [0, 20, 40, 100, 100, 100, 120, 140, 160, 180]
    : pattern === "burst-100ms" ? [0, 20, 40, 160, 160, 160, 160, 160, 160, 180] : null;
  return offsets ? Math.floor(packet / 10) * 200 + offsets[packet % 10] : packet * 20;
}
export interface Arrival { at: number; sentAt: number; sequence: number }

/** Separate speech/transport RNG streams for each person; ordered delivery never drops packets. */
export function schedule(person: number, durationMs: number, pattern: Pattern, seed: number) {
  const identity = Math.imul(person + 1, 0x9E3779B1);
  const speech = random(seed ^ identity), transport = random(seed ^ identity ^ 0x85EBCA6B);
  const uniform = (rng: () => number, low: number, high: number) => low + rng() * (high - low);
  const arrivals: Arrival[] = [];
  let talkAt = uniform(speech, 0, 3000), speechMs = 0, talkspurts = 0;
  let previousAt = -Infinity, holdUntil = -Infinity;
  const nextStallInterval = () => pattern === "severe" ? uniform(transport, 6_000, 18_000) : uniform(transport, 10_000, 30_000);
  let stallAt = nextStallInterval(), stalls = 0;
  while (talkAt < durationMs) {
    const talkEnd = Math.min(durationMs, talkAt + uniform(speech, 2000, 8000));
    speechMs += talkEnd - talkAt; talkspurts++;
    for (let sentAt = talkAt, frame = 0; sentAt < talkEnd; sentAt += 20, frame++) {
      let at: number;
      if (pattern === "realistic" || pattern === "severe") {
        // Ordinary +/-15ms spacing variation; severe uses the full +/-15ms envelope.
        const jitter = pattern === "severe" ? 15 : 7.5;
        at = sentAt + 15 + uniform(transport, -jitter, jitter);
        if (sentAt >= stallAt) {
          const gap = pattern === "severe" ? uniform(transport, 90, 120) : uniform(transport, 60, 90);
          holdUntil = Math.max(at, previousAt + gap); stallAt = sentAt + nextStallInterval(); stalls++;
        }
        at = Math.max(at, holdUntil);
        // Relay may forward two 20ms frames together, independently for every person.
        if (transport() < (pattern === "severe" ? .30 : .10)) at += 20;
      } else at = talkAt + deliveryMs(frame, pattern);
      at = Math.max(previousAt, at); previousAt = at;
      if (at < durationMs) arrivals.push({ at, sentAt, sequence: arrivals.length + 1 });
    }
    talkAt = talkEnd + uniform(speech, 300, 3000);
  }
  return { arrivals, speechMs, talkspurts, stalls };
}
