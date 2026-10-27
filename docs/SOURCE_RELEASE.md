# ParaBus ソースとWindowsベータ配布

これはベータ版のソース一式です。検証範囲・既知の問題は[BETA.txt](BETA.txt)を参照してください。
SoundGrid / LV1での本番実機確認は未完了です。
[現在公開中のWindows x64 v0.1.0-beta.3](https://github.com/adilazkahadiko/ParaBus/releases/tag/v0.1.0-beta.3)には対応ソース・第三者表記を同梱します（下記の作成手順を参照）。
v0.1.0-beta.4は準備中・未公開です。公開日とリリースURLは公開時に確定します。
以下のbeta.4のコマンド例は公開準備用で、タグ・Releaseの作成を意味しません。
beta.4の公開時にはREADME・SECURITYなどの公開版リンクを更新するPRが別途必要です。

Windows ZIP版は新しい専用フォルダーへ展開し、`ParaBus.exe`を開いて通知領域のPBアイコンから操作します。
ソース版は下の導入を済ませてから`start-router.cmd`で起動します。ZIP版の起動にソース版の依存導入は不要です。

## 含めるもの・含めないもの

TypeScript / Rust source、UI、起動・ビルドscript、test、設定example、lockfile、LICENSE、
第三者表記と利用手順を含めます。Rust `Cargo.toml` / `Cargo.lock` / `rust-toolchain.toml`も残します。

実設定、Token、録音、log、既存Git履歴、`node_modules`、`target`、DLL / `.node` / EXE、SDK、
機器ドライバーは含めません。過去の開発ログ・KPT・設計メモ・検証履歴も公開候補から外します。
元のローカル資料は削除しません。
旧タブレット操作の試作コードはsourceに保管しますが、現行serverはそのリスナーを起動せず、
デスクトップにも設定を表示しません。再設計後の提供は別途判断します。

`release/release-manifest.json`は公開候補・配布物の対象管理に使います。
ローカルの調査判定・Release下書きは`release/private/`、生成物と検証候補は`target/`へ置き、Git対象から外します。
診断Bundleは`support/`、実行環境は`runtime/`・`bin/`、取得したSDK等は`native-source/`もGit対象外です。
`.gitignore`は新しい誤登録を防ぐもので、登録済みファイルや過去の履歴を除外するものではありません。
GitHub repository自体を公開する場合は、manifestの対象だけでなく全追跡ファイル・公開される履歴も確認します。

## 公開用Git履歴の準備

過去の個人メールを公開しない場合は、元リポジトリをprivateの保管用として保持し、
公開対象の追跡ソースだけを新規フォルダーへ書き出して新しいGit履歴を作ります。
`.git`・実設定・検証記録・実行フォルダーは持ち込みません。著作者表記と元LICENSEは保持します。
最初のcommitからGitHubのnoreplyを使い、元の履歴をmerge/pushしないでください。
旧native artifactのcommitは出自の記録として残し、対応するsource bytesはhashとarchiveで提供します。
公開切り替え時に非公開脆弱性報告を有効化し、SECURITY.mdの案内が実際に使えることを確認します。

## 候補の作成

Node 22を使い、レビュー済みの変更をGitへ記録してから実行します。

```powershell
# 許可された追跡ファイルだけから、ソース専用のレビュー候補を新規作成する
npm.cmd run stage:source
```

[manifest](../release/release-manifest.json)の`source`で対象を限定し、
`target/source-stage/stage-...`へコピーします。Rust build・依存導入・機器接続・公開はしません。
未追跡ファイルはコピーせず、許可対象に未ステージ変更がある場合は停止します。
バイナリ拡張子・非UTF-8内容・NUL・秘密ファイル名・symlinkを拒否し、entry一覧とSHA-256を記録します。
途中で失敗した`*-pending`を公開候補として使わないでください。

`stage:release`はRust EXEを含む実行用artifactなので、ソース公開には使いません。

## ソースからの導入

WindowsではNode.js 22.23.4以上23未満、Rust stable、Python 3、Visual Studio Build Toolsの
C++開発ツールを用意し、リポジトリのルートで実行します。音声依存のビルドに使う
`node-gyp`はVS 2026対応の12.1.0に固定しています。`--omit=dev`を付けないでください。

2026-10-21の[Node.jsセキュリティ修正版22.23.4](https://nodejs.org/en/blog/release/v22.23.4/)を最低版とします。
開発環境だけでなく、Windows ZIP内の`runtime/node.exe`も更新対象です。
CIは22.23.4を固定し、パッケージ検証で同梱Nodeの版を確認します。
既存の検証環境を更新する場合は停止してからNodeと同じ版のライセンスを交換し、
設定・録音・Support Bundleを保持してnative読み込みと起動・通常終了を再確認してください。

**セキュリティ注意:** 依存導入とnative buildは外部コードを実行します。レビュー済みlockfileと
正規npm registry / crate配布元を使い、取得物のLICENSE / COPYING / NOTICEを削除しないでください。

```powershell
# lockfileの依存を導入する。DLLを任意の転載サイトから取得しない
npm.cmd ci --legacy-peer-deps
# 停止呼び出しのJS修正を適用する（通常はpostinstallで適用済み。DLLは変更しない）
npm.cmd run patch:audio-native
# 音声bindingを読み込めることを確認する（機器列挙・stream開始はしない）
npm.cmd run check:audio-native
# Windowsのデバイス管理用Rust childをソースから生成する（音声機器は開かない）
cargo build --locked --release --bin router-core
# Opus native依存の導入状態を確認する（Discord・音声機器には接続しない）
npm.cmd run check:opus-native
```

各コマンドが成功してから`start-router.cmd`を使い、[Bot設定手順](DISCORD_RX.md)へ進みます。
起動・本体再起動・設定保存だけではBotは接続せず、SETUP → BOTSの各Botで「接続」を押します。
接続エラー・再接続中は「復旧」と表示されます。状態の確認はSETUPのBotカードとSTATUS → DISCORD / STATSを使います。
`npm ci`成功だけではoptional音声依存の導入成功を保証しません。確認が失敗したら起動に進まず、
`npm.cmd ci --legacy-peer-deps --foreground-scripts`でビルドエラーを確認してください。
**既存運用環境では再導入しないでください。** `npm ci`は`node_modules`を作り直すため、
手動で導入したASIO用DLLも失われます。停止した新規・検証用フォルダーで実行します。
トレイ起動時は依存を確認するだけで、自動ダウンロード・再ビルドはしません。
ASIO対応は[固定SDKからのビルド・隔離確認](ASIO_BUILD.md)を参照してください。
通常の導入だけでASIO対応・本番実機の安定性を保証しません。機器ドライバーはメーカー公式から取得します。

## 公開・配布前の確認

- [ ] 候補にToken・秘密鍵・個人情報・実設定・録音・DLL・SDKが含まれないことを確認する。
- [ ] 本体LICENSE・[第三者表記](../THIRD_PARTY_NOTICES.md)・source・test・ビルド手順が揃っていることを確認する。
- [ ] 実行用ZIPを配布する場合は、同梱するbinaryごとの対応source（[案内](CORRESPONDING_SOURCE.txt)）を用意する。

ファイル名監査や典型的なTokenの検査だけでは、安全性を保証しません。
秘密が混ざっていたら履歴を消すだけで済ませず、Tokenを失効・再発行してください。

## Windowsベータ版パッケージ

`scripts/collect-corresponding-source.ts`で固定sourceを取得し、npmのintegrityとCargo.lockの
checksumを全件照合します。`scripts/audit-corresponding-source.ts`で元LICENSE / COPYING /
NOTICE / AUTHORSを収集し、欠けている本文を固定VCS commitから補います。
registryのintegrityがないsourceと補足原文は`release/upstream-source-lock.json`のSHA-256で
検証します。既存cacheにも同じ検査を行い、未知URLや不一致は停止して原本の再レビューを求めます。
HPKEのMPL本文はMozilla原文を保持し、固定source archiveと各crate全体を添付します。

許諾が確定できない旧StackWalkerを含む`segfault-handler`は、任意のクラッシュ診断hookと
一緒に配布対象から除外します。`patch-naudiodon.ts`がhookを削除し、
`omit-crash-diagnostics.ts`が新規パッケージから不要なnative packageを除外します。
音声DLLは変更しません。通常のアプリログ・Support Bundleは引き続き利用できます。

`scripts/assemble-review-package.ts`はcleanな追跡source、CI由来のnative部品、公式Nodeから
新しいWindows ZIPを組み立てます。公開ベータの案内はWINDOWS_BETA.txtを参照してください。稼働済みフォルダーを再圧縮しません。
同じZIPにアプリ、corresponding-source.zip、案内、SHA256SUMSを収録し、受取人へ一式を渡します。
これはGitHub公開・Release作成・送信の自動実行ではありません。
原本prebuiltの完全な再現ビルドやSoundGrid実機の本番保証とは区別します。
native再利用の前提は`release/native-input-lock.json`で、ソースのbytes・依存manifest・
バイナリhashを検証します。旧CIのprivate Git履歴は不要です。
beta.2以降は元native入力を公開commit `28d27a491d21eee718237af1bcbf7c334ed9447f`から取得し、
元のsource・依存manifestのhashを別途検証してbinary-originへ収録します。
梱包用checkoutにはこの公開commitも必要です（shallow cloneの場合は公開originから履歴を取得）。
現行のJS依存更新とビルド案内の変更はapp/側に保持し、再利用バイナリの元ソースと区別します。
npm由来native部品は上流package情報と取得元CI commitを分けて記録します。

### 梱包・起動検証の防御

Windowsでは`archive-tool.ts`が`%SystemRoot%\System32\tar.exe`を明示して使います。
Git BashのGNU tarがPATHの先頭でも、Windowsのドライブ文字をremote hostとして解釈しません。
JS差し替えは許可した版とintegrityを両方固定し、archive内のリンク・特殊ファイル・
危険なパス・実行バイナリのシグネチャ・bin追加・依存変更を拒否します。
置換前後に本番依存のパス・名前・版を照合し、他platformのoptional依存はその依存枝ごと除外します。
segfault-handlerは意図的に除外し、元入力に残るnanヘッダーはlockと照合したうえで保持します。
入れ子のnode_modulesがある置換先は削除せず拒否します。途中失敗時は置換元を復元し、一時展開先を片付けます。

native再利用では、現行と元のsource入力集合を比較し、Rust・Cargo・toolchain・launcherの
hash変更を拒否します。既知のASIO案内変更だけは、変更前後の固定hashで許可します。
元入力の一覧・manifest・binary hash自体も、公開baselineの元lockと照合します。

実EXEのsmokeは、使用中のParaBusを通常終了した後に、未使用の新規展開先だけで実行します。
期待commitは配布タグ等から独立して取得し、引数へ渡します。展開先のBUILDだけを正解とは扱いません。
親のDISCORD_*・DBR_*等とNodeの注入オプションを除去し、空のBot rackで起動します。
正常終了・失敗時の後始末とも、検証用展開先のプロセスだけを対象にします。

```powershell
# 公開前はタグではなく、候補ZIPを梱包したcommitを指定します。
$expectedCommit = git rev-parse '<梱包対象のcommit>^{commit}'
runtime\node.exe scripts/windows-release-smoke.ts <target配下の新規展開先ParaBus> target\exe-smoke.json $expectedCommit
```

この開発用検証処理の修正で、公開済みbeta.2のZIP・タグを置き換えることはありません。

公開リポジトリでは両workflowのartifact uploadを停止します。ビルド・テストは継続します。
CIから実行版を配布する場合は、対応ソースと原文表記を揃えたうえでuploadを別途整備してください。
公開切り替えの直前には、private時に作った旧形式artifactが残っていないことも確認します。

```powershell
# Node 22.23.4で実行。clean-ci-baseは未使用のCI ZIPを展開した入力フォルダー。
# 運用中や設定済みのアプリフォルダーを入力にしない。
runtime\node.exe scripts/collect-corresponding-source.ts <clean-ci-base> target\review-sources
runtime\node.exe scripts/audit-corresponding-source.ts target\review-sources
# 変更はローカルcommitへ記録してから、新しい出力先に組み立てる。
runtime\node.exe scripts/assemble-review-package.ts <clean-ci-base> target\review-sources target\beta-output v0.1.0-beta.4
```
