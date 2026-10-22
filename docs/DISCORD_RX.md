# Discord受信の起動方法

## いちばん簡単な起動方法（Windows）

プロジェクトフォルダーにある **`start-router.cmd` をダブルクリック**してください。黒いCMD画面は
すぐ閉じ、その後はタスクバー右端の通知領域に常駐します。アイコンが見当たらない場合は、通知領域の
`^` を押して隠れているアイコンを表示してください。

初回だけ日本語のDiscord Bot設定ページが開きます。Bot名、Guild ID、Voice Channel ID、Bot Tokenを
入力して「Botを有効化」をチェックし、「設定を保存」を押します。対象Botだけが再起動なしでVCへ接続します。

2回目以降は **`start-router.cmd` をダブルクリック**し、SETUPの対象Botで **接続** を押します。
「使用する」がONでも、起動・ParaBus本体再起動だけではDiscordへ接続しません。

通知領域のアイコンでは次の操作ができます。

- ダブルクリック: UIを開く
- 右クリック → UIを開く
- 右クリック → マニュアルを開く
- 右クリック → Discord Bot設定を開く
- 右クリック → 設定ファイルを直接開く
- 右クリック → 再起動
- 右クリック → ログを開く
- 右クリック → 終了

Discordへ接続せず画面だけ試したい場合は、Botの接続操作や新しい有効化をせず起動してください。
Bot未接続・無音で待機します。

## 終了方法

通知領域のアイコンを右クリックし、「終了」を選びます。CoreとDiscord接続がまとめて終了します。

## 設定を変更する場合

通知領域のParaBus（PB）アイコンから **Discord Bot設定を開く** を選び、画面で編集・保存します。有効 / 無効の変更は
対象BotのVC接続へすぐ反映されます。保存済みBotはカードの **VCへ接続** / **VCから切断** でも個別操作できます。

Guild / VC IDやTokenを変更した接続中Botは、保存後に一度切断して再接続してください。
個別切断しても「使用する」の保存値は変わりませんが、次回起動・本体再起動時は未接続で待機します。
接続後の通信断に対する自動復帰は維持します。接続開始はON AIR中に拒否され、切断は確認後に実行できます。

既存Botトークンは画面へ再表示されず「設定済み」とだけ表示されます。空欄のまま保存すれば現在値を
保持し、新しい値を入力した場合だけ更新します。Token本体は `.env` にだけ保存され、状態API、
Bot Rack JSON、ログ、Gitには含まれません。

## まず1 Botで送受信する

通常は、現在のBotのRoleを **RX+TX（双方向）** にします。同じVoiceConnectionでDiscord音声を受信し、
GAME StemをDiscordへ送信できます。RX用とTX用に同じTokenを2回登録しないでください。

直接ファイルを管理する場合のRole名は `DUPLEX` です。

```json
{"id":"BOT01","label":"送受信 Bot 01","role":"DUPLEX","txSubtype":"GAME","txAudioMode":"STEREO","tokenEnv":"DISCORD_BOT_TOKEN_BOT01","guildId":"...","voiceChannelId":"...","enabled":true}
```

## 複数Bot / 最大20 RX + 4 TXを設定する

設定ページで **+ 送受信Bot**、**+ RX Bot** または **+ TX Bot** を押します。各BotのProfile ID、表示名、Role、
Guild ID、Voice Channel ID、Tokenを入力してください。TXではStemとMONO / STEREOも選びます。

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

Studio Returnを使う場合はTX profileも追加します。

```json
{"id":"TX_GAME01","label":"TX GAME","role":"TX","txSubtype":"GAME","txAudioMode":"STEREO","tokenEnv":"DISCORD_BOT_TOKEN_TX_GAME01","guildId":"...","voiceChannelId":"...","enabled":true}
{"id":"TX_CASTER01","label":"TX CASTER","role":"TX","txSubtype":"CASTER","txAudioMode":"MONO","tokenEnv":"DISCORD_BOT_TOKEN_TX_CASTER01","guildId":"...","voiceChannelId":"...","enabled":true}
{"id":"TX_COMMENTARY01","label":"TX COMMENTARY","role":"TX","txSubtype":"COMMENTARY","txAudioMode":"MONO","tokenEnv":"DISCORD_BOT_TOKEN_TX_COMMENTARY01","guildId":"...","voiceChannelId":"...","enabled":true}
{"id":"TX_IFB01","label":"TX IFB","role":"TX","txSubtype":"IFB","txAudioMode":"MONO","tokenEnv":"DISCORD_BOT_TOKEN_TX_IFB01","guildId":"...","voiceChannelId":"...","enabled":true}
```

トークンをJSONへ直接書かないでください。設定保存後、UIの**BOT RACK**タブで接続数、Gateway / Voice状態、
Ping、再接続回数を確認します。必要なら設定タブの**VCへ接続** / **VCから切断**でBotごとに操作します。

## コマンドから起動する場合

ターミナルを使う場合も1コマンドです。

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

画面上部が `DISCORD RX 接続済み数/設定数` にならない場合は、`.env` とBot RackのサーバーID・ボイスチャンネルID、Botの
接続権限を確認してください。

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
