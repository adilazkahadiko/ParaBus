/** Never forward Bot credentials (plaintext or ciphertext) to child environments. */
export function withoutBotTokens(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^DISCORD_BOT_TOKEN/i.test(name)));
}

/** Preserve OS-only configuration without passing credentials through child env. */
export function consumeBotTokens(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const tokens: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(environment)) if (/^DISCORD_BOT_TOKEN/i.test(name)) {
    tokens[name] = environment[name]; delete environment[name];
  }
  return tokens;
}

/** Launcher stdin is a bounded, one-shot JSON handoff, never a command argument. */
export async function readLauncherTokenInput(): Promise<NodeJS.ProcessEnv> {
  const inherited = consumeBotTokens();
  if (process.env.DBR_LAUNCHER_MANAGED !== "1") return inherited;
  return new Promise((resolve, reject) => {
    let text = "", complete = false;
    const cleanup = () => { clearTimeout(timer); process.stdin.off("data", data); process.stdin.off("end", end); process.stdin.off("error", fail); process.stdin.pause(); text = ""; };
    const fail = () => { if (complete) return; complete = true; cleanup(); reject(new Error("Bot設定の受け渡しに失敗しました")); };
    const data = (chunk: Buffer) => { text += chunk.toString("utf8"); if (Buffer.byteLength(text) > 1024 * 1024) fail(); };
    const end = () => {
      try {
        const parsed = JSON.parse(text) as { tokens?: unknown };
        if (!parsed.tokens || typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) return fail();
        const tokens: NodeJS.ProcessEnv = { ...inherited };
        for (const [name, value] of Object.entries(parsed.tokens)) {
          if (!/^DISCORD_BOT_TOKEN[A-Z0-9_]*$/i.test(name) || typeof value !== "string" || value.length > 16384) return fail();
          tokens[name] = value;
        }
        complete = true; cleanup(); resolve(tokens);
      } catch { fail(); }
    };
    const timer = setTimeout(fail, 5_000);
    process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", fail); process.stdin.resume();
  });
}

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
