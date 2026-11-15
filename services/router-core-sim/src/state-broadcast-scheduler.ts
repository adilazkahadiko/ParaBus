/** Coalesce external mutations before building a desktop snapshot, at most every 50ms. */
export function stateBroadcastScheduler(broadcast: () => void) {
  let pending: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (pending) return;
      pending = setTimeout(() => { pending = undefined; broadcast(); }, 50);
      pending.unref();
    },
    cancel() { if (pending) clearTimeout(pending); pending = undefined; },
  };
}
