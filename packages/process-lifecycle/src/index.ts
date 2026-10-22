/** Children use IPC for graceful shutdown on Windows too: child.kill(SIGTERM)
 * terminates a Windows process without running its JS signal handlers. */
export function watchLauncher(shutdown: () => void): void {
  const parent = Number(process.env.DBR_LAUNCHER_PID);
  if (!Number.isSafeInteger(parent) || parent <= 1) return;
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; shutdown(); } };
  process.on("message", message => {
    if (message && typeof message === "object" && "type" in message && message.type === "dbr-shutdown") stop();
  });
  process.once("disconnect", stop);
  const check = () => {
    if (!process.connected || process.ppid !== parent) { stop(); return; }
    try { process.kill(parent, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") stop();
    }
  };
  setInterval(check, 500).unref();
  check(); // Also catch a parent lost before this module finished loading.
}
