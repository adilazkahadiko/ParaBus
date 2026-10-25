import { win32 } from "node:path";

/** GNU tar on Git Bash interprets C: archive paths as remote hosts. */
export function archiveTool(platform: NodeJS.Platform = process.platform, systemRoot = process.env.SystemRoot ?? "C:\\Windows"): string {
  return platform === "win32" ? win32.join(systemRoot, "System32", "tar.exe") : "tar";
}

export function windowsPowerShell(systemRoot = process.env.SystemRoot ?? "C:\\Windows"): string {
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
