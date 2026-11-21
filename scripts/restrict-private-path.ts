import { resolve } from "node:path";
import { protectPrivatePath } from "../services/router-core-sim/src/private-files.ts";

// Tray-only permission repair. No configuration contents are passed to this process.
const path = process.argv[2];
if (!path) process.exitCode = 1;
else try { await protectPrivatePath(resolve(path)); } catch { process.exitCode = 1; }
