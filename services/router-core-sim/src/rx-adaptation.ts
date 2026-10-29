/** Bounded source-lifetime memory: not reset by underruns, clear(), or talkspurts. */
export class RxAdaptation {
  targetMs = 60;
  hardCapMs = 140;
  #windowAt = -1;
  #lastPacketAt = -Infinity;
  #lastFillAt = -Infinity;
  #fillDebtMs = 0;
  #maxBurstMs = 10;
  #jitter = new Uint32Array(252);
  #packets = 0;
  #stable = 0;
  #shortages = 0;
  #floorMs = 40;
  #increase = false;
  #growthCeilingMs = 80;
  #lastJitterMs = 0;
  packet(now: number): void {
    const interval = now - this.#lastPacketAt;
    if (interval >= 0 && interval <= 100) { this.#jitter[Math.min(251, Math.ceil(Math.abs(interval - 20)))]++; this.#packets++; }
    this.#lastPacketAt = now;
    this.window(now);
  }
  fill(now: number, durationMs: number): void {
    // Net demand, not an arbitrary callback-gap threshold: closely spaced
    // blocks consume reserve, elapsed wall time replenishes it. This neither
    // splits a slow catch-up nor merges two callbacks just because mixing was busy.
    this.#fillDebtMs = Math.max(0, this.#fillDebtMs - (now - this.#lastFillAt)) + durationMs;
    this.#maxBurstMs = Math.max(this.#maxBurstMs, this.#fillDebtMs);
    this.#lastFillAt = now; this.window(now);
  }
  shortage(increase = true): void { this.#shortages++; this.#stable = 0; if (increase) this.#increase = true; }
  boundary(talkStart: boolean): void {
    if (this.#increase) { this.targetMs = Math.max(this.targetMs, Math.min(this.#growthCeilingMs, Math.max(this.#floorMs, this.targetMs + 20))); this.#increase = false; }
    else if (this.#floorMs > this.targetMs) this.targetMs = this.#floorMs;
    else if (talkStart && this.#stable >= 3 && this.targetMs > this.#floorMs) { this.targetMs -= 20; this.#stable = 0; }
  }
  private window(now: number): void {
    if (this.#windowAt < 0) this.#windowAt = now;
    if (now - this.#windowAt < 5000) return;
    let count = 0, jitter = 0;
    for (let i = 0; i < this.#jitter.length; i++) { count += this.#jitter[i]; if (count >= Math.ceil(this.#packets * .95)) { jitter = i; break; } }
    if (this.#packets >= 50) this.#lastJitterMs = jitter;
    jitter = this.#lastJitterMs; // Silence/sparse data is not evidence of zero jitter.
    // Two envelopes, not their sum: a stalled main loop makes BOTH observations
    // bursty. Avoid charging the same stall twice. Independent deficits still
    // raise one step at the next refill boundary.
    const arrivalReserveMs = 40 + Math.max(0, jitter - 5);
    // A large late batch needs a tighter queue ceiling to bound accepted-PCM
    // latency; ordinary arrivals need room for the receiver's catch-up drain.
    this.hardCapMs = jitter > 15 ? 130 : 140;
    // A transient timer stall cannot be repaired by permanently storing 100ms.
    // Leave 100ms for sustained arrival variation; fill-only recovery is <=80ms.
    this.#growthCeilingMs = arrivalReserveMs > 80 ? 100 : 80;
    const reserveMs = Math.max(Math.min(80, 20 + this.#maxBurstMs), arrivalReserveMs);
    this.#floorMs = Math.min(100, Math.max(40, Math.ceil(reserveMs / 20) * 20));
    this.#stable = !this.#shortages && this.#packets >= 50 ? this.#stable + 1 : 0;
    this.#windowAt = now; this.#jitter.fill(0); this.#packets = 0; this.#maxBurstMs = 10; this.#shortages = 0;
  }
}
