import { archiveTool } from "./archive-tool.ts";
// Read upstream archives without extracting or executing them. Preserve notices verbatim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verifyPinnedSource } from "./verified-source.ts";

const root = resolve(process.argv[2]);
const downloads = JSON.parse(readFileSync(join(root, "SOURCE_DOWNLOADS.json"), "utf8")).records as { path: string; url: string; sha256: string }[];
const supplemental: { path: string; url: string; sha256: string }[] = [];
const result: { path: string; name: string; license: string; licenseFiles: string[]; supplemental?: string[] }[] = [];
const notices: string[] = [];
const treeCache = new Map<string, string[]>();
const read = (archive: string, entry: string) => execFileSync(archiveTool(), ["-xOf", archive, entry], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const isNotice = (path: string) => /(^|\/)(licen[sc]e[^/]*|copying[^/]*|notice[^/]*|copyright[^/]*|authors(?:\.[^/]*)?)$/i.test(path);
async function fetchFile(path: string, url: string) {
  const file = join(root, path);
  let bytes: Buffer;
  if (existsSync(file)) bytes = readFileSync(file);
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  verifyPinnedSource(url, bytes);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
  if (!supplemental.some(r => r.path === path)) supplemental.push({ path, url, sha256: createHash("sha256").update(bytes).digest("hex") });
  return bytes.toString("utf8");
}
for (const record of downloads.filter(r => r.path.endsWith(".crate") || r.path.startsWith("npm/"))) {
  const file = join(root, record.path);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), record.sha256, `Changed source archive: ${record.path}`);
  const entries = execFileSync(archiveTool(), ["-tf", file], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split(/\r?\n/);
  const licenseFiles = entries.filter(e => !e.endsWith("/") && isNotice(e));
  if (!licenseFiles.length) {
    for (const entry of entries.filter(e => /^[^/]+\/readme(?:\.md|\.txt)?$/i.test(e))) {
      const text = read(file, entry);
      if (/Permission is hereby granted, free of charge/.test(text) && /THE SOFTWARE IS PROVIDED/.test(text) && /Copyright/i.test(text)) licenseFiles.push(entry);
    }
  }
  let license: string, name: string, repository: string | undefined, commit: string | undefined;
  if (record.path.endsWith(".crate")) {
    const metadata = read(file, entries.find(e => /^[^/]+\/Cargo.toml$/.test(e))!);
    license = metadata.match(/^license = "([^"]+)"/m)?.[1]!;
    name = record.path.split("/").at(-1)!;
    repository = metadata.match(/^repository = "([^"]+)"/m)?.[1];
    const vcsPath = entries.find(e => e.endsWith("/.cargo_vcs_info.json"));
    if (vcsPath) commit = JSON.parse(read(file, vcsPath)).git.sha1;
    if (/^winapi-(i686|x86_64)-pc-windows-gnu-0\.4\.0\.crate$/.test(name)) {
      // Legacy target import-library packages predate cargo_vcs_info. The parent
      // winapi 0.3.9 tag explicitly includes these 0.4.0 subpackages under its licenses.
      commit = "796a8e6c2971dc2ff1bcff166e6671284f9b5b6b";
      const target = name.startsWith("winapi-i686") ? "i686" : "x86_64";
      const manifest = await fetchFile(`upstream-notices/winapi-${target}-0.4.0-Cargo.toml`, `https://raw.githubusercontent.com/retep998/winapi-rs/${commit}/${target}/Cargo.toml`);
      assert.match(manifest, /version = "0\.4\.0"/);
      assert.ok(manifest.includes(name.replace("-0.4.0.crate", "")));
    }
  } else {
    const pkg = JSON.parse(read(file, entries.find(e => /^[^/]+\/package.json$/.test(e))!));
    license = pkg.license; name = `${pkg.name}@${pkg.version}`;
    if (!licenseFiles.length) {
      const response = await fetch(`https://registry.npmjs.org/${pkg.name}/${pkg.version}`);
      assert.ok(response.ok); const metadata = await response.json() as { repository: string | { url: string }; gitHead?: string };
      repository = typeof metadata.repository === "string" ? metadata.repository : metadata.repository.url;
      commit = metadata.gitHead;
      if (name === "tr46@0.0.3") {
        // Upstream added its missing MIT text while still at 0.0.3. Verify the
        // executable JS is identical before using that fixed commit's notice.
        repository = "https://github.com/jsdom/tr46";
        commit = "3a6f29721e7063b9ffd421e461a54beae6170001";
        const original = await fetchFile("upstream-notices/tr46-0.0.3-index.js", `https://raw.githubusercontent.com/jsdom/tr46/${commit}/index.js`);
        assert.equal(original.replaceAll("\r\n", "\n"), read(file, "package/index.js").replaceAll("\r\n", "\n"));
        const manifest = await fetchFile("upstream-notices/tr46-0.0.3-package.json", `https://raw.githubusercontent.com/jsdom/tr46/${commit}/package.json`);
        assert.equal(JSON.parse(manifest).version, "0.0.3");
      }
    }
  }
  assert.ok(license, `Missing license: ${name}`);
  const item: typeof result[number] = { path: record.path, name, license, licenseFiles };
  result.push(item);
  for (const entry of licenseFiles) notices.push(`\n===== ${name}: ${entry} =====\nSource: ${record.url}\nArchive SHA256: ${record.sha256}\n\n${read(file, entry)}\n`);
  if (!licenseFiles.length && license === "MPL-2.0") {
    // HPKE carries MPL notices in source headers rather than a LICENSE file.
    // Preserve its full checksum-verified crate and fixed VCS source; supply Mozilla's text.
    item.supplemental = ["upstream-notices/MPL-2.0.txt"];
    continue;
  }
  if (!licenseFiles.length) {
    const github = repository?.match(/github.com[/:]([^/]+\/[^/#]+?)(?:\.git)?(?:$|\/)/)?.[1];
    assert.ok(github && commit && /^[a-f0-9]{40}$/.test(commit), `Missing fixed VCS source: ${name}, ${repository}, ${commit}`);
    const key = `${github}/${commit}`;
    let tree = treeCache.get(key);
    if (!tree) {
      const response = JSON.parse(execFileSync("gh", ["api", `repos/${github}/git/trees/${commit}?recursive=1`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
      assert.equal(response.truncated, false);
      tree = response.tree.filter((e: { type: string; path: string }) => e.type === "blob" && isNotice(e.path) && e.path.split("/").length <= 3).map((e: { path: string }) => e.path);
      treeCache.set(key, tree!);
    }
    assert.ok(tree!.length, `No upstream notices: ${name}`);
    item.supplemental = [];
    for (const path of tree!) {
      const local = `upstream-notices/${github.replaceAll("/", "__")}/${commit}/${path}`;
      const url = `https://raw.githubusercontent.com/${github}/${commit}/${path}`;
      const text = await fetchFile(local, url);
      notices.push(`\n===== ${name}: upstream ${path} =====\nSource: ${url}\n\n${text}\n`);
      item.supplemental.push(local);
    }
  }
}
for (const record of downloads.filter(r => r.path.startsWith("upstream-notices/"))) {
  notices.push(`\n===== ${record.path} =====\nSource: ${record.url}\n\n${readFileSync(join(root, record.path), "utf8")}\n`);
}
writeFileSync(join(root, "DEPENDENCY_LICENSE_INVENTORY.json"), JSON.stringify(result, null, 2) + "\n");
writeFileSync(join(root, "SUPPLEMENTAL_NOTICES.json"), JSON.stringify(supplemental, null, 2) + "\n");
writeFileSync(join(root, "THIRD_PARTY_ARCHIVE_NOTICES.txt"), notices.join("\n"));
console.log(JSON.stringify({ packages: result.length, supplemented: result.filter(r => r.supplemental?.length).length, missing: result.filter(r => !r.licenseFiles.length && !r.supplemental?.length).length, noticeBytes: notices.join("\n").length }));
