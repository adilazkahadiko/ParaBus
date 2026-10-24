# ParaBus

**English** | [日本語](README.ja.md)

A Windows audio router for Discord. ParaBus receives voice per participant and per voice channel,
then mixes, records and outputs it to physical audio devices.
Main (program) and Cue (monitoring) can go to separate devices, and physical inputs can be sent back to Discord.

> **Beta.** This is not a stable release and has not passed production use.
> Read the [known issues and field checklist](docs/BETA.txt) first,
> and always keep a backup audio path. Do not use ParaBus as your only, untested broadcast path.

## Features

- Receive Discord audio per participant and per voice channel, with level control and mixing
- Separate Main / Cue outputs, and physical input → Discord transmit
- Recording, browser-based control, and remote control from another PC on a trusted LAN

Docs are currently in Japanese: [operator manual](docs/manual.html) (download and open it in a browser if GitHub shows it as code)
and [Discord bot setup](docs/DISCORD_RX.md).

## Download

**Windows x64 beta: [v0.1.0-beta.2](https://github.com/adilazkahadiko/ParaBus/releases/tag/v0.1.0-beta.2)**

[Download ParaBus-windows-x64-v0.1.0-beta.2.zip](https://github.com/adilazkahadiko/ParaBus/releases/download/v0.1.0-beta.2/ParaBus-windows-x64-v0.1.0-beta.2.zip) ·
[SHA256SUMS.txt](https://github.com/adilazkahadiko/ParaBus/releases/download/v0.1.0-beta.2/SHA256SUMS.txt)

The ZIP includes Node.js, corresponding source and third-party notices. Extract it into a new folder.

GitHub's "Source code (zip)" is the development source, not a runnable app.

## Requirements

- Windows x64 and the manufacturer's driver for your audio interface
- A Discord bot with the required permissions in the target voice channels ([setup](docs/DISCORD_RX.md))
- Source builds only: Node.js >= 22.23.4 and < 23, Rust and a native build toolchain

ParaBus is tested mainly on Windows. macOS launch and build scripts exist,
but macOS has not been verified on real hardware to the same level.

## Getting started

### Windows ZIP

Extract the ZIP into a new, dedicated folder and keep all bundled files together. Node.js is included.

Open `ParaBus.exe`, then open the control screen from the "PB" icon in the notification area.
If SmartScreen appears, confirm where the file came from, then choose "More info" → "Run anyway".

<details>
<summary>macOS test package</summary>

Double-click `ParaBus.app`. If a warning appears, close it, then allow the app in
System Settings → Privacy & Security → "Open Anyway" (「このまま開く」 on Japanese macOS), and double-click again.

The app is not signed or notarized by an Apple Developer ID. It removes the quarantine attribute only inside
the extracted folder and never disables Gatekeeper system-wide.

</details>

Do not run files from unknown sources, and do not disable OS-wide protection.
Never extract over an existing production folder.

### From source

Follow [installing from source](docs/SOURCE_RELEASE.md#ソースからの導入), then start with `start-router.cmd` (Windows)
or `start-router.command` (macOS).

### Connecting bots and shutting down

Bots start disconnected. Configure them in SETUP and press "Connect" for each bot.

To quit, use **SETUP → ParaBus を終了** on the PC running ParaBus. Settings lock must be off,
faults acknowledged, and recording stopped and saved. Closing the browser tab does not quit ParaBus,
and it cannot be shut down from another PC on the LAN.

## Security and bug reports

- Never publish bot tokens, real settings, recordings or logs.
- Use the LAN control screen only on a trusted network. Do not port-forward it to the internet.
- Bug reports: include the version, OS, audio devices, steps to reproduce and the time it happened.
  If a report may contain confidential information, contact the maintainer instead of opening a public issue.
- For diagnostics, use a Support Bundle. Check its contents before sharing; do not attach the whole app folder,
  original settings or recordings.

## Development

Installing dependencies runs third-party code. Use a dedicated development folder, never a production one.
See [installing from source](docs/SOURCE_RELEASE.md#ソースからの導入) for setup and native builds,
[ASIO build](docs/ASIO_BUILD.md) for ASIO support, and [Linux development](docs/LINUX_DEV.md).

| Path | Contents |
| --- | --- |
| `services/` | Control UI, audio processing, Discord connection |
| `packages/` | Shared code such as inter-process communication |
| `crates/` | Rust device management, audio processing, Windows launcher |
| `tests/` | Automated tests, simulators, load tests |
| `tests/core-ipc/` | Integration tests against the Rust core |
| `scripts/`, `release/release-manifest.json` | Launch, build and packaging |
| `docs/` | Manuals, beta limitations, license texts |

```powershell
npm.cmd run typecheck      # TypeScript type check
npm.cmd test               # Node tests (excludes Rust integration)
npm.cmd run test:rust      # Rust unit tests
npm.cmd run test:core-ipc  # Build Rust, then run integration tests
```

Load tests and explicit hardware tests are not part of the regular test run.
Some internal package names and setting keys still use the former name "DBR".
Keep them for compatibility with existing settings; do not rename them for cosmetic reasons.

## AI in development

ParaBus is vibe-coded. Almost all of the code, tests and documentation were written by AI coding agents
(Codex and Claude Code) under the maintainer's direction.
The maintainer sets the goals, tests on real hardware and decides what gets released,
but does not review every line the way a professional audio or security engineer would.

Please keep that in mind: keep a backup audio path, and review the code yourself before relying on it in production.
Bug reports and fixes are welcome.

## License

Copyright (C) 2026 ParaBus contributors.

ParaBus is licensed under [GPL-3.0-only](LICENSE) and comes with no warranty.
Third-party code is covered by [its own licenses](THIRD_PARTY_NOTICES.md).

ParaBus — Developed by Adil Azka<br>
Built with Codex and Claude Code
