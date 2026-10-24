# ParaBus

[English](README.md) | **日本語**

Discordの音声を参加者・VCごとに受信し、ミックス・録音・物理出力するWindows向け音声ルーターです。
本線（Main）とCue（試聴）を別のデバイスへ出力でき、物理入力からDiscordへの送信にも対応します。

> **ベータ版です。** 正式な安定版・本番運用の合格を意味しません。
> 先に[既知の問題・現場での確認項目](docs/BETA.txt)を確認し、必ず予備の音声経路を用意してください。
> 唯一の送出経路として無検証で使用しないでください。

## できること

- Discordの参加者・VC（ボイスチャンネル）ごとの受信、音量調整、ミックス
- Main / Cueへの音声出力、物理入力からDiscordへの送信
- 録音、ブラウザーでの操作、信頼できるLAN内の別PCからの操作

操作方法は[マニュアル](docs/manual.html)（GitHubでコードとして表示される場合はダウンロードしてブラウザーで開く）、
Botの準備は[Discord設定](docs/DISCORD_RX.md)を参照してください。

## ダウンロード

**Windows x64 ベータ版：[v0.1.0-beta.1](https://github.com/adilazkahadiko/ParaBus/releases/tag/v0.1.0-beta.1)**

[ParaBus-windows-x64-v0.1.0-beta.1.zip をダウンロード](https://github.com/adilazkahadiko/ParaBus/releases/download/v0.1.0-beta.1/ParaBus-windows-x64-v0.1.0-beta.1.zip) ／
[SHA256SUMS.txt](https://github.com/adilazkahadiko/ParaBus/releases/download/v0.1.0-beta.1/SHA256SUMS.txt)

Node.js・対応ソース・第三者表記を同梱しています。新しい専用フォルダーへ展開してください。

GitHubが表示する「Source code (zip)」は開発用ソースであり、起動用アプリではありません。

## 必要環境

- Windows x64と、使用するオーディオ機器のメーカー製ドライバー
- Discord Botと、接続先VCで必要な権限（[設定手順](docs/DISCORD_RX.md)）
- ソースから導入する場合のみ：Node.js 22.23.4以上23未満、Rust、ネイティブビルド環境

Windowsを中心に実機検証しています。macOS向けの起動・ビルド処理もありますが、
Windowsと同じ実機確認状況ではありません。

## 起動

### Windows用ZIP

新しい専用フォルダーへ展開し、同梱ファイルを一緒に置いてください。Node.jsは同梱済みです。

`ParaBus.exe`を開き、通知領域の「PB」アイコンから操作画面を開きます。
SmartScreenが出たら、取得元を確認したうえで「詳細情報」→「実行」を選びます。

<details>
<summary>macOS向け検証パッケージ</summary>

`ParaBus.app`をダブルクリックします。警告が出たら「完了」で閉じ、
システム設定 →「プライバシーとセキュリティ」→「このまま開く」で許可し、もう一度ダブルクリックします。

Apple Developer署名・公証は行っていません。隔離属性の解除は展開フォルダー内だけで、
Gatekeeper全体は無効化しません。

</details>

取得元が不明なファイルは実行せず、OS全体の保護を無効化しないでください。
既存の運用フォルダーへ上書きしないでください。

### ソースから起動

[ソースからの導入](docs/SOURCE_RELEASE.md#ソースからの導入)を実行してから、
`start-router.cmd`（Windows）または`start-router.command`（macOS）で起動します。

### Botの接続と終了

Botは起動時に未接続で待機します。SETUPでBotを設定し、対象Botの「接続」を押してください。

終了は実行PCの **SETUP → ParaBus を終了** です。設定ロックOFF・障害確認済み・録音停止／保存完了が必要です。
ブラウザーのタブを閉じるだけでは終了せず、LAN接続した別PCからは終了できません。

## セキュリティと不具合報告

- Token・実設定・録音・ログを公開しないでください。
- LANからの操作画面は信頼できるネットワーク内だけで使用し、インターネットへポート転送しないでください。
- 不具合報告には版・OS・機器・再現手順・発生時刻を添えてください。
  機密の可能性がある報告は公開Issueに書かず、まず保守者へ相談してください。
- 診断データが必要な場合はSupport Bundleを使います。中身を確認してから共有し、
  実行フォルダー全体・設定原本・録音は添付しないでください。

## 開発者向け

依存導入は外部コードを実行します。運用中のフォルダーでは実行せず、専用の開発環境を使用してください。
導入・ネイティブビルドは[ソースからの導入](docs/SOURCE_RELEASE.md#ソースからの導入)、
ASIO対応は[ASIOビルド](docs/ASIO_BUILD.md)、Linuxは[Linux開発環境](docs/LINUX_DEV.md)を参照してください。

| 場所 | 内容 |
| --- | --- |
| `services/` | 操作画面・音声処理・Discord接続 |
| `packages/` | プロセス間通信などの共通コード |
| `crates/` | Rust製の管理・音声処理・Windowsランチャー |
| `tests/` | 自動テスト、模擬データ、負荷検証 |
| `tests/core-ipc/` | Rustとの結合テスト |
| `scripts/`・`release/release-manifest.json` | 起動・ビルド・配布対象の管理 |
| `docs/` | 利用手順・ベータの制限・ライセンス資料 |

```powershell
npm.cmd run typecheck      # TypeScriptの型チェック
npm.cmd test               # 通常の自動テスト（Rust結合テストは別）
npm.cmd run test:rust      # Rustの単体テスト
npm.cmd run test:core-ipc  # Rustをビルドして結合テスト
```

負荷試験・明示的な実機試験は通常テストには含めません。
内部のパッケージ名や設定キーには旧称DBRが残っています。既存設定との互換性のため、
表示を整える目的だけで一括変更しないでください。

## 開発でのAI利用

ParaBusはバイブコーディングで作られています。コード・テスト・文書のほぼすべてを、
作者の指示のもとAIコーディングエージェント（Codex・Claude Code）が書いています。
作者は目的の決定・実機での動作確認・公開の判断を行っていますが、
専門の音声・セキュリティエンジニアのように全行をレビューしてはいません。あしからずご了承ください。

本番で使う場合は予備の音声経路を用意し、必要に応じてご自身でコードを確認してください。
不具合報告・修正の提案は歓迎します。

## ライセンス

Copyright (C) 2026 ParaBus contributors.

本体は[GPL-3.0-only](LICENSE)、無保証です。
第三者コードには[それぞれのライセンス](THIRD_PARTY_NOTICES.md)が適用されます。

ParaBus — Developed by Adil Azka<br>
Built with Codex and Claude Code
