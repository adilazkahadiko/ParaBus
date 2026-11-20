# Security Policy

**English** | 日本語は下にあります

## Reporting a vulnerability

Do not open a public issue for security problems or anything that may contain bot tokens,
personal data or confidential production information.

Report privately from this repository's **Security** tab → **Report a vulnerability**.
Include the ParaBus version (BUILD COMMIT), OS, and steps to reproduce.
Do not attach bot tokens, real settings files, recordings or full app folders.

If a token may have leaked, revoke and regenerate it in the Discord Developer Portal first.

## Supported versions

ParaBus is in beta. The current Windows release is [v0.1.0-beta.7](https://github.com/adilazkahadiko/ParaBus/releases/tag/v0.1.0-beta.7).
Fixes target the latest commit on `main`; update to the latest beta when a fix is released.

---

## サポート対象

現在のWindowsベータ版はv0.1.0-beta.7です。修正はmainの最新コミットを対象とし、修正版のベータが公開されたら更新してください。

## 外部操作API

外部操作APIは同じPCの`127.0.0.1`だけで受け付けます（既定ポート`4175`）。他のPCやLANからは使えません。
ParaBus側に保存するトークンはSHA-256ハッシュだけで、平文は保存しません。
登録ファイル`external-control.json`は配布ZIPにもSupport Bundleにも含めません。
外部操作用トークンが漏れた可能性がある場合は、同じPCのSETUP →「接続する機器」で対象機器を「取り消し」、または「再発行」してください。再発行すると旧トークンは使えなくなります。

## 脆弱性の報告

セキュリティ上の問題や、Bot Token・個人情報・案件情報を含む可能性がある内容は、公開Issueに書かないでください。

このリポジトリの **Security** タブ → **Report a vulnerability** から非公開で報告してください。
版（BUILD COMMIT）・OS・再現手順を添え、Token・実設定・録音・実行フォルダー全体は添付しないでください。

Tokenが漏れた可能性がある場合は、まずDiscord Developer Portalで失効・再発行してください。
