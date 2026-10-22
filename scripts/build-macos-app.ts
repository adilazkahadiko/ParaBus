import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function buildMacApp(packageRoot: string): string {
  const root = resolve(packageRoot);
  if (!existsSync(join(root, "runtime/node")) || !existsSync(join(root, "scripts/start-router-macos.sh")) || !existsSync(join(root, "release-build-info.json"))) throw new Error("Expected an assembled ParaBus package");
  const app = join(root, "ParaBus.app");
  if (existsSync(app)) throw new Error("ParaBus.app already exists; use a fresh package directory");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "macos-app-entry.sh"), join(app, "Contents/MacOS/ParaBus"));
  chmodSync(join(app, "Contents/MacOS/ParaBus"), 0o755);
  writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>ParaBus</string>
<key>CFBundleDisplayName</key><string>ParaBus</string>
<key>CFBundleIdentifier</key><string>local.adil.parabus</string>
<key>CFBundleExecutable</key><string>ParaBus</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/build-macos-app.ts <package-directory>");
  console.log(buildMacApp(process.argv[2]));
}
