# Discord受信の起動方法

## Windows ZIP版の起動

新しい専用フォルダーへ展開し、**`ParaBus.exe`を開いてください**。通知領域の「PB」アイコンを
ダブルクリックするか、右クリックして **UIを開く** を選ぶと操作画面を開けます。アイコンが見当たらない場合は、
通知領域の`^`を押して隠れているアイコンを表示してください。既存の運用フォルダーへ上書きしないでください。

## ソース版の起動（Windows）

[ソースからの導入](SOURCE_RELEASE.md#ソースからの導入)を済ませ、プロジェクトフォルダーの
**`start-router.cmd`をダブルクリック**してください。CMD画面は閉じ、通知領域のPBアイコンから操作します。
起動時に依存の自動インストールは行いません。ZIP版の手順は[README](../README.ja.md#windows用zip)を参照してください。

どちらの起動方法でも、Botは未接続で待機します。PBアイコンの **Discord Bot設定を開く** または
操作画面の **SETUP → BOTS** から設定し、保存後に対象Botの **接続** を押してください。
**使用** にチェックが入っていても、設定保存・起動・ParaBus本体再起動だけではDiscordへ接続しません。

通知領域のアイコンでは次の操作ができます。

- ダブルクリック: UIを開く
- 右クリック → UIを開く
- 右クリック → マニュアルを開く
- 右クリック → Discord Bot設定を開く
- 右クリック → 設定ファイルを直接開く
- 右クリック → 再起動
- 右クリック → ログを開く
- 右クリック → 終了

Discordへ接続せず画面だけ試したい場合は、Botの **接続**・**復旧** を押さず、音声デバイスも開始しないでください。

## 終了方法

実行PCの **SETUP → ParaBus を終了**、または通知領域のPBアイコンを右クリックして **終了** を選び、確認します。
設定ロックがOFFで、FAULT状態ではなく、録音停止・保存完了していることが必要です。
Core・Discord接続・ランチャーを終了します。ブラウザーのタブを閉じただけでは終了せず、LANの別PCからも終了できません。

## 設定を変更する場合

通知領域のPBアイコンから **Discord Bot設定を開く** を選ぶか、**SETUP → BOTS** を開きます。
各Botの **詳細** で名前・役割・Server ID・VC ID・Tokenを入力し、**使用** にチェックを入れて **設定を保存** を押します。
保存だけでは接続中Botの状態は変わりません。保存済みBotはカードの **接続** / **切断** で個別に操作します。
接続エラー・再接続中は **接続** が **復旧** になり、確認後に1回だけ切断して再接続します。

Guild / VC IDやTokenを変更した接続中Botは、保存後に一度切断して再接続してください。
個別切断しても **使用** の保存値は変わりませんが、次回起動・本体再起動時は未接続で待機します。
接続後の通信断に対する自動復帰は維持します。画面からの設定保存・接続・切断・復旧は、設定ロック中（ON_AIR）とFAULT中は操作できません。
切断・復旧には確認が必要です。

既存Botトークンは画面へ再表示されず「設定済み」とだけ表示されます。空欄のまま保存すれば現在値を
保持し、新しい値を入力した場合だけ更新します。Token本体は `.env` にだけ保存され、状態API、
Bot Rack JSON、ログ、Gitには含まれません。

## まず1 Botで送受信する

通常は、現在のBotのRoleを **RX+TX（双方向）** にします。同じVoiceConnectionでDiscord音声を受信し、
物理入力の音声をDiscordへ送信できます。RX用とTX用に同じTokenを2回登録しないでください。

直接ファイルを管理する場合のRole名は `DUPLEX` です。

```json
{"id":"BOT01","label":"送受信 Bot 01","role":"DUPLEX","txSubtype":"GAME","txAudioMode":"STEREO","tokenEnv":"DISCORD_BOT_TOKEN_BOT01","guildId":"...","voiceChannelId":"...","enabled":true}
```

## 複数Bot / RX最大24・TX最大22・合計最大24を設定する

**SETUP → BOTS** で **＋ RX+TX**、**＋ RX** または **＋ TX** を押します。各Botの **詳細** で名前・役割・
Server ID・VC ID・Tokenを入力します。TX / RX+TXでは **TX MODE** のMONO / STEREOも選びます。
内部Profile IDは固定で、画面から編集しません。RX+TXは受信枠・送信枠を各1つ使い、合計では1台と数えます。

直接ファイルを管理する上級者向けには、次の形式も引き続き利用できます。

```json
{"id":"RX01","label":"RX TEAM 01","role":"RX","tokenEnv":"DISCORD_BOT_TOKEN_RX01","guildId":"...","voiceChannelId":"...","enabled":true}
```

`tokenEnv`はトークンそのものではなく、`.env`に書く環境変数名です。

```text
DISCORD_BOT_RACK_FILE=discord-bots.json
DISCORD_BOT_TOKEN_RX01=Bot 1のトークン
DISCORD_BOT_TOKEN_RX02=Bot 2のトークン
DISCORD_BOT_TOKEN_TX_GAME01=GAME TX Botのトークン
DISCORD_BOT_TOKEN_TX_CASTER01=CASTER TX Botのトークン
DISCORD_BOT_TOKEN_TX_COMMENTARY01=COMMENTARY TX Botのトークン
DISCORD_BOT_TOKEN_TX_IFB01=IFB TX Botのトークン
```

物理入力をDiscordへ送る場合はTX profileも使えます。以下のGAME / CASTER / COMMENTARY / IFBは
互換用の`txSubtype`を持つ設定例で、現行UIでの固定Stem選択や4 TX上限を意味しません。

```json
{"id":"TX_GAME01","label":"TX GAME","role":"TX","txSubtype":"GAME","txAudioMode":"STEREO","tokenEnv":"DISCORD_BOT_TOKEN_TX_GAME01","guildId":"...","voiceChannelId":"...","enabled":true}
{"id":"TX_CASTER01","label":"TX CASTER","role":"TX","txSubtype":"CASTER","txAudioMode":"MONO","tokenEnv":"DISCORD_BOT_TOKEN_TX_CASTER01","guildId":"...","voiceChannelId":"...","enabled":true}
{"id":"TX_COMMENTARY01","label":"TX COMMENTARY","role":"TX","txSubtype":"COMMENTARY","txAudioMode":"MONO","tokenEnv":"DISCORD_BOT_TOKEN_TX_COMMENTARY01","guildId":"...","voiceChannelId":"...","enabled":true}
{"id":"TX_IFB01","label":"TX IFB","role":"TX","txSubtype":"IFB","txAudioMode":"MONO","tokenEnv":"DISCORD_BOT_TOKEN_TX_IFB01","guildId":"...","voiceChannelId":"...","enabled":true}
```

トークンをJSONへ直接書かないでください。保存・接続後は **SETUP → BOTS** の各カードで、接続先と
**接続中** / **未接続** / **接続エラー** などの状態を確認します。全BotのREADY台数と設定台数は **STATUS → DISCORD** の
`n / N READY`、各BotのSTATE・PING・TX / RECONNECTは **STATUS → STATS → BOTS** で確認します。
操作画面のタブは **MIX / ROUTE / STATUS / SESSION / SETUP** です。接続・切断・復旧の操作は **SETUP → BOTS** で行います。

## コマンドから起動する場合

ソース版をターミナルから起動する場合は、導入済みのプロジェクトフォルダーで実行します。

```powershell
npm.cmd run app
```

初回は[ソースからの導入](SOURCE_RELEASE.md#ソースからの導入)を済ませ、音声依存とRust管理本体を確認します。
起動時の自動インストールは行いません。既存の運用フォルダーで再導入するとASIO用DLLも失われるため、
導入・ビルドは停止した新規・検証用フォルダーで行ってください。

## Botに必要な権限

Botが対象ボイスチャンネルを表示・接続・発言できるようにしてください。RX BotはSelf Muteで受信だけ、
TX BotはSelf Deafで送信だけ、DUPLEX BotはSelf Mute / DeafともOFFで送受信します。DAVE暗号化は常に有効です。

## 動作確認

Discordで誰かが話すと、そのユーザー専用のチャンネルとメーターが自動で追加されます。新しい
ユーザーのVC送信レベルは安全のため `-12 dB` から始まります。

全BotのREADY台数と設定台数は **STATUS → DISCORD** の `n / N READY`、個別の接続状態は **SETUP → BOTS** の各カードで確認します。
MIX上部の **RX BOT** は表示対象の受信Botを示し、全Botの接続数とは区別します。
接続できない場合は、各BotのServer ID・VC ID・Tokenの設定済み状態と接続権限を確認してください。
参加者の受信品質は **STATUS → STATS → USERS** のPACKETS・QUALITY・QUEUE・LASTで確認できます。

## 補足: 内部の音声経路

Discord側で復号されたOpus音声を、ローカルIPC経由でRouter Coreへ送ります。Core側で48 kHz PCMへ
復号し、ユーザーごとのメーターとミキサーへ入力します。Core停止中の音声は再接続後に再生せず破棄
するため、古い会話が遅れて配信されることはありません。

Coreはproductionで`@discordjs/opus` native decoderを使います。起動時に48 kHz mono / 20 msの
load・create・decodeを一度だけself-checkし、失敗時はRXを無音でfail closedにします（Bot processや
audio graphは停止しません）。`opusscript`はoffline fixtureのみで、実運用への暗黙fallbackはありません。
配布前はclean install後に`npm run check:opus-native`を実行してください。

## 受信警告の切り分け

状態APIの `discord.rxDiagnostics` と `discord.sources[].rxTiming` に技術用カウンターを出します。
通常画面の操作項目や、承認・Receiver所有権・再接続時の安全停止は変わりません。

- `rejectedOpus`: 本体が音声を拒否した理由別の件数。`health:RECONNECTING` は再接続中の安全停止、
  `socketAuthority` / `receiverAuthority` は所有権不一致、`sourceGeneration` は古いVC在籍世代です。
- `adapterIpc`: Adapterプロセスの音声破棄・書込み滞留。複数Botが同じIPCを共有しても1接続につき1件です。
  `backpressureWrites` は書込みがキューに入った回数で、音声破棄ではありません。Bot状態送信時に更新します。
- `ipcBatches`: 本体が一度のIPC読取りで処理した最大Opus数・バイト数・処理時間。
- `rxTiming.lastOverflow`: バッファ溢れ時の時刻、直前の残量、投入・破棄サンプル数、到着間隔とIPCバッチ。
  到着間隔には無音区間も含まれるため、そのまま通信遅延とは扱いません。

増分と溢れ時の状況は既存の `logs/operational-YYYY-MM-DD.jsonl` に記録します。
ローカル連番の欠落はDiscord回線のパケット損失とは限りません。RXバッファ容量は
12ブロック（標準設定で最大120ms）です。RX専用の目標は40ms、不足からの復帰待ちは30msです。
80ms超が続いたら近無音のカットまたは最大5サンプルの補間で遅延を減らします。実機での確認方法とカウンタの注意点は[ベータ検証ガイド](BETA.txt)を参照してください。
音声スケジューラも最大12ブロックまで追従し、揺れの解消後に不要な遅延を残しません。反映には本体再起動が必要です。

診断情報を共有する際はSupport Bundleを使い、表示名など個人情報が残っていないか確認してください。生ログ・設定原本・録音は添付しないでください。
診断項目にはToken・音声データを含めません。カウンターはプロセス再起動時に、Userのタイミング情報は
在籍世代の変更時にリセットされます。`adapterIpc` は現在の接続のみで、切断・再接続時に表示合計が変わるため、
前後の合計だけで正確な損失を決めず接続状態と併せて判断します。
