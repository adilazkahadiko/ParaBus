# 開発・リリースチェックリスト

この文書には現行の確認項目と、過去Phaseの実装・検証記録が含まれます。チェック状態は当時の記録を保持しており、
今回の文書更新やメンテナーのbeta.2短時間接続試験だけで変更していません。
現行のデスクトップ画面はMIX / ROUTE / STATUS / SESSION / SETUPです。旧画面・旧構成の記録は該当節に注記します。

## A. 要求確認

- [ ] 対象Phaseと設計書のAcceptanceを引用せず自分の言葉で確認した。
- [ ] 利用者向け画面、起動手順、開発者資料のどれを変更するか特定した。
- [ ] UI文言・文書・ログの使用言語を確認した。
- [ ] 実機、token、外部accountが必要な検証と、localだけで完了できる検証を分けた。

## B. Discord / Security

- [ ] Discord / libraryの現行仕様を公式資料で再確認した。
- [ ] DAVEを無効化していない。
- [ ] `selfDeaf: false`、受信専用Botは`selfMute: true`になっている。
- [ ] Bot tokenは`.env` / process environment以外に保存していない。
- [ ] `.env`が`.gitignore`対象である。
- [ ] tokenがAPI response、WebSocket、UI、log、test fixtureへ出ていない。
- [ ] TX Bot User ID除外が維持されている。
- [ ] Discord dependency更新後にlogin、VC list、join、receiveをlive testした。

## C. Audio Safety

- [ ] sample rateは48 kHz、block sizeは意図した値である。
- [ ] audio callback内にnetwork / disk I/O / sleep / lock待機を入れていない。
- [ ] decodeとallocationをaudio callback外で行っている。
- [ ] 欠落sourceはsilenceになり、stale表示される。
- [ ] live Opusを再接続後に再送しない。
- [ ] Emergency Muteがdirect、bus、matrixの全出力を無音にする。
- [ ] device loss時に自動fallbackせずFAULTへ入る。
- [ ] limiter無効化とON AIR遷移の確認操作が維持されている。
- [ ] peak表示がsample peakなら`dBFS`、true peak実装後だけ`dBTP`と表示する。
- [ ] LUFS-M / S / Iのwindowとresetが壊れていない。
- [ ] 実deviceはoperatorが明示選択するまで開いていない。
- [ ] device消失時にWindows defaultへfallbackしない。
- [ ] interleave buffer pool枯渇時に待機せずdropを計測する。

## D. IPC

- [ ] audio payloadをJSON化していない。
- [ ] magic、version、length、最大frame sizeを検証している。
- [ ] split frameとcoalesced frameのtestが通る。
- [ ] User識別tupleの4 IDを欠落させていない。
- [ ] queue上限とdrop数を観測できる。
- [ ] invalid frameでCore全体が停止しない。

## E. Windows Launcher / Tray

- [ ] Windows ZIP版は`ParaBus.exe`、ソース版は`start-router.cmd`を実際に経由して起動testした。
- [ ] tray iconが表示され、二重起動しない。
- [ ] UI、マニュアル、設定、再起動、ログ、終了が動く。
- [ ] Bot未設定で起動し、SETUP → BOTSから設定を保存できる。
- [ ] 依存不足を通知・logで確認でき、自動installせず起動を止める。
- [ ] Core起動失敗時にtrayが消えず、logへ移動できる。
- [ ] 終了時にCore / Adapterの子processが残らない。
- [ ] test用port / named pipeをcleanupした。
- [ ] 日本語を含むPS1がUTF-8 BOM付きである。
- [ ] PowerShell parserとWindows実起動の両方を確認した。

## F. UI / Manual

- [ ] sliderと数値入力の値が同期する。
- [ ] dBFS目盛り、現在値、LUFS単位が画面上で読める。
- [ ] Discord未接続 / 接続済み状態を識別できる。
- [ ] browserで実表示し、console errorがない。
- [ ] manualのquick startが最初の画面内にある。
- [ ] manualが外部font / CDNなしでも読める。
- [ ] manualのtray menuと現在の実装が一致する。
- [ ] troubleshootingに直近の失敗事例を追加した。

## G. Test / Release

- [ ] `npm.cmd run typecheck`が単独で成功する。
- [ ] `npm.cmd test`が単独で成功する。
- [ ] `npm.cmd run test:load`でdeadline missが0である。
- [ ] 途中commandのexit codeを明示的に検査した。
- [ ] npm audit結果を確認した。
- [ ] DEVLOGの到達点・制約・次Phaseを更新した。
- [ ] KPTの新しいProblemをchecklistまたは自動testへ反映した。
- [ ] READMEとHTML manualの起動方法が一致する。

## H. Phase 2 SoundGrid実機

- [ ] SoundGrid DriverがPortAudio一覧へ表示される。
- [ ] 48 kHzでstreamを開ける。
- [ ] 期待する64 output channelsが報告される。
- [ ] OUT 1〜64のtest toneがLV1の同番号channelへ届く。
- [ ] 複数Discord UserをPREで別chへ同時送出できる。
- [ ] POSTへ切り替えるとアプリFaderが反映される。
- [ ] device切断時に全出力が無音となりFAULTへ入る。
- [ ] device復帰時に自動再選択せずoperator操作を要求する。
- [ ] 24時間連続でxrun、backpressure drop、memory増加を監視する。

## I. Phase 3 Multi Bot / 20 VC

- [ ] `discord-bots.json`へtokenそのものを書かず、`tokenEnv`だけを記録した。
- [ ] `discord-bots.json`が`.gitignore`対象である。
- [ ] 20 VC試験の受信Botを20台にそろえ、profile IDとBot / Guild / VC targetが重複していない（現行上限はRX24・TX22・合計24）。
- [ ] 20 BotすべてでDAVE、`selfDeaf: false`、`selfMute: true`を維持している。
- [ ] SETUP → BOTSで接続状態と接続先、STATUS → STATS → BOTSでSTATE、WS / UDP PING、TX / RECONNECTを確認できる。
- [ ] STATUS → STATS → USERSでPACKETS、QUALITY、QUEUE、LASTを確認できる。
- [ ] 15秒heartbeat欠落がSTALE表示になる。
- [ ] 自動再接続が同じBot・Guild・VCだけを使い、別VCへ移動しない。
- [ ] 1接続断が他の19接続とAudio Engineを停止させない。
- [ ] Adapter IPC再接続後に古いOpusを再送しない。
- [ ] 実Discord 20 VCで24時間、reconnect、memory、packet gap、decode errorを記録した。

## J. Phase 4 VC MIX

現行MIXの参加者フェーダーとMIX ON/OFFはVC MIXへの送出操作です。Busの処理・Policyなど、
以下には内部機能の確認項目も含み、すべてを現行UIから編集する手順ではありません。

- [ ] DiscordのBot / Guild / VC identityごとに別mono Busが生成される。
- [ ] User Direct OutputとVC Send levelが互いに影響しない。
- [ ] SAFEの新規Userが-12 dB / OPENで作成される。
- [ ] HOLDの新規UserがSend Muteで作成される。
- [ ] PRESETの新規Userが指定default levelで作成される。
- [ ] Policy変更が既存Userの手動Send値を上書きしない。
- [ ] MIXで参加者のINメーター、VC MIX送出フェーダー、MIX ON/OFF、CUEを確認・操作できる。
- [ ] MIXのVC MIXでMasterフェーダー、MASTER ON / MASTER MUTED、CUEを確認・操作できる。
- [ ] Compressor threshold / ratio / attack / release / makeupとGRが一致する。
- [ ] Safety Limiterがdefault ONで、GRが表示される。
- [ ] ON AIR中はBus追加・削除・Policy変更を拒否し、Send操作は継続できる。
- [ ] Bus削除で該当SendとMatrix routeだけが削除される。
- [ ] 事前チェックなしの複数人InterviewをアプリだけでMixする実運用testを行った。

## K. Phase 5 Broadcast Safety

Bus処理の単位など、現行画面に入力欄がない項目は旧詳細UIの確認項目です。現行画面の操作手順としては扱いません。

- [ ] トップバーの設定ロックON/OFFで確認が出て、ONはON_AIR、OFFはSETUPへ遷移する（READYは内部状態）。
- [ ] FAULT中の`SET_STATE`が拒否され、`ACKNOWLEDGE_FAULT`だけでSETUPへ戻る。
- [ ] FAULT確認後もEmergency Muteが維持され、別の確認なしに解除されない。
- [ ] ON AIR中にdevice、output mapping、VC assignment、Bus構造、Scene削除を変更できない。
- [ ] ON AIR中もFader、Mute、PFL、VC Send、Scene Recallを操作できる。
- [ ] Scene保存対象にchannel順・表示名・trim・fader・mute・Send、Bus processing、Matrixが含まれる。
- [ ] Sceneにtoken、device、Bot接続、Guild / VC assignmentが含まれない。
- [ ] SESSION → SCENEの「変更を確認」で差分と`APPLY` / `RECALL SAFE` / `SAFETY LOCK`を確認してから適用する。
- [ ] Recall SafeのparameterはScene Recall後も現在値を維持する。
- [ ] Ratioは`:1`、Attack / Releaseは`ms`、gain系は`dB`で表示される。
- [ ] Event Log消去に確認が必要で、消去操作の監査eventが残る。
- [ ] Phase 5 safety自動testと実browser操作確認を完了した。

## L. Phase 6 Discord TX

- [ ] TX profileがrole `TX`、MONO / STEREO、専用tokenEnvを持ち、既存Subtypeは互換項目として保持される。
- [ ] TX BotはSelf Deaf ON、Self Mute OFFで、Discord receive streamを作らない。
- [ ] Coreが登録済みTX Bot User IDのUSER_META / OPUSをRX Graphへ追加しない。
- [ ] Studio input deviceをoperatorが明示選択し、自動fallbackしない。
- [ ] ROUTE → TX ASSIGNMENTで物理入力chをTX Botへ割り当てられる。
- [ ] 割り当てたInputのPOST音声がTX Adapterへ届き、物理OUTやBusの割り当てを必要としない。
- [ ] MONOは入力1ch、STEREOは選択chと次の入力chをL/Rに使用する。
- [ ] TX開始・停止に確認が必要で、送信中はSource / input deviceを変更できない。
- [ ] ON AIR中はTX Source / input device変更を拒否し、緊急STOPは実行できる。
- [ ] MIX → TX MASTERSで送信状態・音量・メーター、STATUS → STATSでTXのframes / dropを確認できる。
- [ ] Input device lossでTXを停止し、Critical Eventを残す。
- [ ] 実Discord / SoundGridでStudio Audio ReturnとTX→RX非混入を確認した。

## M. Phase 7 Multiple TX Stems

4 Stemは当時の試験構成で、現行のTX上限ではありません。固定のStem選択やTX Bot Pool専用画面はなく、
SETUP → BOTS、ROUTE → TX ASSIGNMENT、MIX → TX MASTERS、STATUS → STATSで設定・操作・確認します。

- [ ] 設定がRX最大24・TX最大22・合計最大24の上限を超えると拒否される。
- [ ] 4 Stem試験ではGAMEをSTEREO、CASTER / COMMENTARY / IFBをMONOに設定する（固定の必須構成ではない）。
- [ ] 4 Stemがそれぞれ入力割り当て、sequence、PCM buffer、meter、frame / dropを持つ。
- [ ] 1 Stemの開始・停止・Source変更が他のStemへ影響しない。
- [ ] 4 Stem同時送信中も古いPCMをqueueせず、backpressureをStem別dropとして数える。
- [ ] SETUP → BOTSにBot名・役割・接続先・接続状態、STATUS → STATSにSTATEとTX / RECONNECTが表示される。
- [ ] SETUP → BOTSで接続先VCを変更・保存し、対象Botを切断して再接続する。
- [ ] 設定ロック中（ON_AIR）とFAULT中は画面からBot設定・接続操作やTX入力割り当てを変更できない。
- [ ] 旧構想のMix Minus用OUTから本人Sourceを除外し、他Stemへ影響しないことを確認する（現行UIの操作手順ではない）。
- [ ] 4 TX BotすべてがSelf Deafで、4つのBot User IDすべてがCore側でも除外される。
- [ ] Input device lossですべての送信中Stemが停止する。
- [ ] 実Discord VCで4 BotのPersonal VolumeとVC移動を確認した。

## N. Discord Bot設定ページ

- [ ] GET Settings APIがToken値を返さず、`tokenConfigured`だけを返す。
- [ ] Token入力がpassword fieldで、保存後に空欄へ戻る。
- [ ] Token空欄保存で既存`.env`値が保持される。
- [ ] 新規Tokenが`.env`だけへ入り、`discord-bots.json`、状態API、WebSocket、Logへ入らない。
- [ ] SETUP → BOTSの詳細で名前・役割・TX MODE・Server / VC IDを編集でき、内部Profile IDは固定、Subtypeは互換項目として保持する。
- [ ] 有効BotがRX最大24、TX最大22、合計最大24を超える設定を拒否する（DUPLEXはRX・TXを各1枠使う）。
- [ ] 重複Profile ID / tokenEnv、不正なDiscord ID、未設定Tokenを保存時に拒否する。
- [ ] 設定ファイルを一時ファイル経由で更新し、中途半端なJSONを残さない。
- [ ] cross-originからの設定POSTを拒否する。
- [ ] `DBR_LAN_ACCESS=1`でもSettings APIはloopback以外から利用できない（`HOST=0.0.0.0`だけでは公開しない）。
- [x] 旧PhaseではBot有効 / 無効の保存をVC接続 / 切断へライブ反映した（当時の記録。現行の保存は接続中Botの状態を変えず、接続・切断は明示操作）。
- [x] 保存済みBotを設定画面から個別接続 / 切断でき、ほかのBotとAudio Engineを維持する。
- [x] Adapterはactive Bot 0台でもCore IPCを維持し、後から接続commandを受けられる。
- [x] Bot接続はON AIR中に拒否し、個別切断は確認を必須にする。
- [x] Bot control IPCへTokenを含めず、接続時にAdapter内だけで`.env`を再読込する。
- [x] 実browserで未保存設定からの接続拒否、runtime表示、console error 0件を確認する。
- [x] 実Discord VCでBot単位の接続と切断が成功し、全体再起動が不要である。
- [ ] `.env`と`discord-bots.json`がGit追跡対象外である。

## O. 1 Bot RX/TX双方向

- [ ] `DUPLEX`がRX上限とTX上限をそれぞれ1枠使い、1接続として起動する。
- [ ] Voice接続が`selfDeaf: false` / `selfMute: false`で、ReceiverとAudio Playerの両方を持つ。
- [ ] DUPLEX BotのVC Bus / User RX SourceとTX Stemが同時に生成される。
- [ ] 自分自身のBot User IDをRX Source化せず、ほかのVC参加者は受信できる。
- [ ] 同じTokenを複数profileへ設定した場合は保存時とAdapter起動時の両方で拒否する。
- [ ] 設定画面で「RX+TX（双方向）」、受信1枠・送信1枠として表示される。
- [ ] 実Discordの1 Bot試験でSETUPのBotカードが「接続中」、STATUS → DISCORDが`1 / 1 READY`になり、MIX → TX MASTERSで送信状態を確認できる。
- [ ] TX開始前に送信先と物理入力の経路を確認し、受信音声を同じVCへ無条件に戻さない。

## P. Phase 8 Recorder

- [ ] 録音開始・停止が確認必須で、開始時点のTrack構成が画面へ表示される。
- [ ] Matrix Program、VC Bus、User / Local Inputを別々のmono WAVへ記録できる。
- [ ] WAVが48 kHz、IEEE float format 3、32-bit、RIFF / data size確定済みである。
- [ ] `AudioEngine.processBlock()`内にdisk I/Oがなく、Recorder Queueがboundedである。
- [ ] Queue超過時はRecorderだけFAULTとなり、Audio Engineのblock処理が継続する。
- [ ] Folder unavailable / disk slow相当testでRouter global stateがFAULTにならない。
- [ ] SESSION → RECORDERで空き容量・DROPPED・TRACKSを、STATUS → STATSのRECORDERでQueue / DROPを確認できる。
- [ ] 4 GiB到達前に録音を安全停止し、不正なWAV Headerを作らない。
- [ ] `recordings/`がGit管理対象外で、音声内容をAPI / WebSocket / Logへ含めない。

## Q. Phase 9 Tablet Control

**Tablet操作は現在保留中です。** 現行serverは、旧設定が有効でもTablet用リスナーを起動しません。
以下のチェックは保存された試作版の検証記録であり、現行版でTablet操作を利用できることを意味しません。
専用画面・有効化手順は現在のデスクトップUIにありません。再設計後の提供は別途判断します。
根拠：[SOURCE_RELEASE.md](SOURCE_RELEASE.md#含めるもの含めないもの)、`services/router-core-sim/src/server.ts:170–172`。

- [x] Tablet serverは明示的な有効化が必要で、Desktop管理serverと別port / endpointである。
- [x] 起動ごとの8桁pairing codeをHttpOnly / SameSite sessionへ交換する。
- [x] 認証なしのState / WebSocket / Commandを拒否し、5回失敗を5分間rate limitする。
- [x] commandはdeny-by-defaultで、OPERATORのlive mix操作だけを許可する。
- [x] State、Device、Matrix構造、Bot / Token、TX、Recorder開始停止をTabletから拒否する。
- [x] Emergency MuteはTabletからONにできるが、解除はDesktopの確認操作だけである。
- [x] Tablet snapshotにToken、Bot / Guild / User ID、IPC endpoint、録音folder / file名、Scene値が含まれない。
- [x] Quick MixでVC Send / Mute / PFL、Bus Master / Muteをフェーダーと数値の両方で操作できる。
- [x] User / Bus meterへ現在のdBFS、BusへLUFS-Mを表示する。
- [x] MonitorでEngine、Discord Bot、TX、Alertを、Recorderでstate / queue / disk / trackを監視できる。
- [x] Tablet切断時にAudio、ON AIR、TX、Recorder stateを変更しない。
- [x] pairing後にpair画面が残らず、各tabのhidden状態が正しく切り替わる。
- [x] 768 × 1024実browserで日本語表示、touch target、pairing、数値入力、Mute、tab遷移、console error 0件を確認した。
- [ ] 実iPad / Android TabletとWindows Firewall Private profileで同一LAN接続を確認した。
- [ ] Wi-Fi切断 / sleep / roaming後に再接続し、配信音声と操作値が保持されることを実機確認した。

## R. Phase 10 Rust Core migration

以下は移行開発時の記録で、旧Settings / Monitor専用管理画面の実機確認や、旧Node版・旧導入処理の検証も含みます。
現行の状態表示はSTATUS → 詳細診断、機器設定はSETUP → AUDIO DEVICESです。旧silent streamの専用操作画面はありません。
現行のNode要件は22.23.4以上23未満で、トレイは依存を自動導入しません。過去の試験件数・チェック状態は更新していません。

- [x] TypeScriptのControl API、`RouterSnapshot`、`ControlCommand`、Audio Graph、Safety invariantを棚卸しした。
- [x] Rust workspace / `router-core`を既存Node referenceを変更せず追加した。
- [x] management IPCをlocal child-process stdin/stdout、NDJSON v1、request ID相関として分離した。
- [x] IPC lineを64 KiBに制限し、過大line破棄後に次frameから復帰できる。
- [x] Healthがprotocol version、implementation、PID、uptimeを返す。
- [x] State Snapshotが`RouterSnapshot`互換のglobal fieldsと空のgraph projectionを返す。
- [x] `SET_STATE` command round-tripがrevisionと次Snapshotへ反映される。
- [x] 未移行commandを明示拒否し、TypeScript production ownershipを維持する。
- [x] Audio Graph / safety limiter未移行中はRust側の`ON_AIR`をfail closedにする。
- [x] Rust unit test、Clippy、Node↔Rust process integration testが成功する。
- [x] TypeScript既存65 testと64 sources × 64 outputs load testを再実行し、deadline miss 0である。
- [x] Bot単位ライブ制御追加後のTypeScript全71 test、Rust unit 5 test、Node↔Rust 2 testが成功する。
- [x] Discord binary IPC v1をRustでdecodeし、TypeScriptと同じbinary fixtureのmetadataが一致する。
- [x] Rust stream decoderがsplit / coalesced frame、invalid type、64 KiB超過を検査し、bufferを1 frame以下に保つ。
- [x] Rust Discord queueがframe数 / 合計byte数の上限、oldest drop、drop counterを持つ。
- [x] `DISCORD_RUST_SHADOW=1`の明示時だけ、inbound metadata frameをRust childへlive mirrorする。
- [x] `OPUS` / `TX_PCM`をshadow対象外とし、payload本文をSnapshot / Logへ出さない。
- [x] pending上限、stdin backpressure時のframe単位drop、child faultをTypeScript production pathから分離する。
- [x] Rust shadow childへBot Tokenや無関係な親process環境変数を継承しない。
- [x] `RouterSnapshot.discord.shadow`でmatch / mismatch / drop / pending / process errorを監視できる。
- [x] TypeScript全74 test、Rust unit 10 test、Clippy warning 0、Phase 10 Node 5 test、64 × 64 deadline miss 0を確認する。
- [x] 運用DUPLEX BotでVC切断→再接続と約5分のshadow acceptanceを行い、metadata 91 / 91一致、mismatch / drop / pending / unexpected / process error 0、Bot reconnect 0を確認した。検証後はshadowをOFFへ戻した。
- [ ] 運用Botの実Discord IPCでshadowをlong-runし、metadata差分0を確認する。
- [x] Rust最小Audio Graph（1入力 / PRE・POST / 1 VC Bus / Limiter）のblock出力、4 meter、Emergency Mute ON / OFF transitionをTypeScriptと機械比較する。
- [x] HPF、channel / Bus Compressor、Loudness、複数source summingをRustへ移植し、310 block連続でTypeScriptと機械比較する。
- [x] Rust preallocated Audio Graph単体で64 sources × 4 buses × 64 outputs / 2,000 blockの10 ms deadline miss 0をrelease buildで確認する。
- [x] TypeScript全78 test、Phase 10 Node 9 test、Rust unit 17 test、Clippy warning 0、TypeScript / Rust両load testのdeadline miss 0を確認する。
- [x] Rust固定block SPSC queueがboundedで、順序保持、full拒否、1 producer / 1 consumer並行転送を満たす。
- [x] offline callbackが入力underrunを完全な無音、出力fullを待機なしdropとしてcounterへ記録する。
- [x] device lossと非有限inputがpanicせずfail-closedし、再接続flagだけではFAULTを解除しない。
- [x] callback hot pathにnetwork / disk I/O / sleep / lock待機を入れず、bufferを事前確保する。
- [x] 64 sources × 4 buses × 64 outputs / 2,000 blockのqueue往復込みrelease試験でallocation 0、10 ms deadline miss 0を確認する。
- [x] TypeScript全78 test、Phase 10 Node 9 test、Rust unit 23 test、Clippy warning 0、全3 load testのdeadline miss 0を確認する。
- [x] 実Core Audio callback、MMCSS thread priority、device disconnectをWindows実機で検証する。
- [x] 実Core Audio device format変更をWindows実機で検証する。
- [x] `ROUTER_CORE_OWNERSHIP`が既定`typescript`、`rust-shadow`、`rust-canary`、`rust-production`を明示的に識別する。
- [x] `rust-shadow`でもeffective ownerをTypeScriptに保ち、旧`DISCORD_RUST_SHADOW=1`を新flag未設定時だけ互換利用する。
- [x] 不正なownership値を値自体のlog反映なしで拒否し、未完成のcanary / productionを理由付きで起動拒否する。
- [x] ownershipを起動時だけ解決し、runtime commandや配信中の自動fallbackを追加しない。
- [x] TypeScript全85 test、Phase 10 Node 9 test、Rust unit 23 test、Clippy warning 0を確認する。
- [x] Rust Core Audio render境界が明示device ID、48/96 kHz、10 ms、Float32、1〜64 channelだけを受け入れる。
- [x] 48 kHz / 480-frame planar graph outputを事前確保bufferでinterleaved出力へ変換し、96 kHz endpointでは960 frameへ線形変換する。
- [x] output underrunを完全な無音とし、device loss、format変更、callback buffer不一致をtyped FAULTへlatchedする。
- [x] device再検出だけではFAULTを解除せず、停止中に生成されたstale output blockをstart時に破棄する。
- [x] operator stopは出力を無音にするが、それ自体をdevice FAULTとして扱わない。
- [x] TypeScript全85 test、Phase 10 Node 9 test、Rust unit 31 test、Clippy warning 0、render込みcallback loadのallocation / deadline miss 0を確認する。
- [x] Windows WASAPI active render endpointをcallback外で列挙し、friendly nameと不透明Endpoint IDを取得する。
- [x] Endpoint IDの完全一致だけで明示選択し、未選択時や選択device消失時に既定deviceへfallbackしない。
- [x] 空ID・重複IDをtransactionalに拒否し、fake provider testとWindows read-only acceptanceを通す。
- [x] TypeScript全85 test、Phase 10 Node 9 test、Rust unit 37 test、Clippy warning 0を確認する。
- [x] 明示Endpoint IDだけを`IAudioClient3`へ渡し、preflightとstream開始直前でformat / periodを再検証する。
- [x] 48/96 kHz Float32、1〜64ch、対応する10 ms period（480/960 frame）の場合だけshared event streamを初期化する。
- [x] `GetBuffer` / `ReleaseBuffer`を同一render threadで10 ms単位に対にし、初期bufferをsilenceにする。
- [x] driver bufferの端数frameをgraphへ渡さず、処理可能な完全periodだけをboundedに取り出す。
- [x] render threadをMMCSS `Pro Audio`へ登録し、登録・priority失敗時はstreamを開始しない。
- [x] device invalidation、period不整合、adapter fault、preflight後のformat変更をfail closedで終了する。
- [x] TypeScript全85 test、Phase 10 Node 9 test、Rust unit 41 test、Clippy warning 0を確認し、物理stream testを明示ID必須のignored gateに分離する。
- [x] TypeScript / Rust graph / Rust callback各loadの10 ms deadline miss 0とcallback hot-path allocation 0を維持する。
- [x] Rust management IPCでWASAPI active render一覧をread-only取得し、列挙先頭 / Windows既定deviceを暗黙選択しない。
- [x] `select_wasapi_endpoint`はrefresh済みEndpoint IDの完全一致だけを保持し、不正IDをerrorへ反射しない。
- [x] `preflight_wasapi_endpoint`は選択済みIDだけを検査し、format / engine periodと`streamStarted: false`を返す。
- [x] `RouterSnapshot.wasapi`へ選択、availability、preflight readiness、descriptor、stream停止状態を投影する。
- [x] Rust management IPCのrequest / responseを64 KiBへ制限し、oversize responseをbounded errorで拒否する。
- [x] 型check、TypeScript全85 test、Phase 10 Node 12 test、Rust unit 42 test、Clippy warning 0でread-only一覧、暗黙選択なし、未選択preflight拒否、snapshot反映を確認する。
- [x] `rust-shadow`起動時だけRust management childをproduction Node lifecycleへ接続し、effective ownerをTypeScriptに維持する。
- [x] management childへBot Tokenや無関係な親環境変数を継承せず、専用cross-process testで漏えいなしを確認する。
- [x] WASAPI list / select / clear / preflight Desktop APIをloopback限定とし、POSTをsame-originかつSETUP限定にする。
- [x] 旧Settingsで一覧・明示選択・preflightを操作し、旧Monitorでprocess、選択名、availability、format、stream停止を表示した（旧管理UIの記録）。
- [x] Endpoint IDを一般State / WebSocket / Tablet / Logから除外し、local WASAPI API内だけで扱う。
- [x] 旧管理UIの実browserでactive endpoint 12件、暗黙選択なし、SETUP外lock、旧Monitor反映、console error 0を確認した。
- [x] 明示選択・preflight・確認なしではsilent streamを開始せず、RUNNING中のendpoint変更とSETUP離脱を拒否する。
- [x] stopをSETUP外でも利用可能にし、snapshotへSTOPPED / RUNNING / FAULT、MMCSS、callback / underrunを投影する。
- [x] silent acceptanceへProgram Audio producerを接続せず、TypeScriptをproduction Output ownerに維持する。
- [x] 1秒snapshot同期でrender thread終了をFAULTへ反映し、自動restart / default endpoint fallbackを行わない。
- [x] application shutdown時はbounded stopを待ってからRust childを閉じ、MMCSSをrender thread上でrevertする。
- [x] operator選択済みAudient EVO4で96 kHz / 960-frame silent stream、MMCSS、start / stopをWindows実機検証する。
- [x] device / resource invalidationを同じtyped FAULTへ正規化し、選択ID保持・AVAILABLE NO・preflight破棄・fallbackなしを自動テストする。
- [x] operator選択済みEVO4をRUNNING中に実disconnectし、FAULT / AVAILABLE NO / preflight破棄 / fallbackなしを確認する。
- [x] EVO4再接続後も自動restartせず、同じ選択の再列挙・preflightでSTOPPEDへ安全に復旧する。
- [x] operator選択済みEndpoint IDで実format変更時のFAULTをWindows実機検証し、Endpoint ID変更時も選択名保持・AVAILABLE NO・preflight破棄・fallbackなしを確認する。
- [x] WASAPI silent acceptance lifecycleとsnapshotをRust production management processへ接続する。
- [x] Program Audio未接続のWASAPI silent long-run soakを、operatorが開始済みのstreamに対するread-only監視ツールで実機確認した。Audient EVO4 96 kHz / 960 frames、MMCSS、600秒、121 poll、callback / underrun差分60010 / 60010、Discord 1/1 voice-ready、Recorder IDLEでPASSし、停止後62428 / 62428へ後退なし、STOPPED・errorなし・AVAILABLE / PREFLIGHT trueを確認した。
- [ ] 実Device、Discord audio、全Control / Snapshot parity完了後にcanary / productionの起動拒否を段階解除する。
- [ ] 実Device / Discord acceptance完了前にRustを既定production ownerへしない。
- [x] Program Audio shadow用の独立した`PGM1` v1 binary contract、TypeScript encoder / stream decoder、Rust decoder / bounded queue、offline cross-process parityを追加した。
- [x] `rust-shadow`でTypeScriptが受理した`SETUP` / `READY`、PFL、Emergency MuteをRust management childへ順序維持で再生し、担当Snapshot fieldの一致を本番ownership非変更で比較する。
- [x] ControlPlane実行境界で全Control commandの必須field、strict boolean / enum、有限数値範囲を検証し、不正commandはstate / revision不変で拒否する。
- [x] Scene Recallはlive target全件を共有validatorで先に検証し、invalid value時に部分適用しない。DSPはnon-finite input / state / outputを同一blockで無音化して次blockへ汚染を残さない。
- [x] Rust realtime graphはBus Matrixの未実装PRE tapを明示拒否する。
- [x] Discord participant lifecycleはDBR1 v1 `sourceGeneration`で関連付け、matching `USER_LEFT`だけがdecoder / PCM queue / runtime / AudioEngine channelとmatrix / monitorを回収する。OPUS単独・old generation・duplicate leaveでは再生成／混入しない。
- [x] `BOT_META` authority takeoverは旧socket sourceを回収し、late old socket frame / closeがcurrent Bot stateを奪わない。Adapterの実VoiceState leave、stream end/error、current-authority IPC closeは冪等に扱い、stream / sequence / timestamp / generation stateを回収する。u32 sequence wrapは許可し、old/reordered packetを巨大gapへ加算しない。
- [x] local IPC reconnectではbounded hookが`BOT_META`、status、current `USER_META`だけを順にresyncする。OPUS / USER_LEFT / old audio payload / secretを再送せず、next live OPUSだけを新authority sourceへ受理する。
- [x] Discord RX production decoderをexact `@discordjs/opus` native bindingへ固定し、process startのload / create / 48 kHz mono 20 ms decode self-check失敗時はsourceを生成せず無音fail-closedにする。
- [x] native decoderのUSER_LEFT / takeover cleanupはidempotent dispose（bindingにdelete APIなし）で回収し、fixed payload fixtureの960 sample / finite / hashとoffline `opusscript` referenceを検査する。
- [x] 20 / 80 native decoder benchmarkはpacket/s、p95 / p99 / max、deadline miss、RSS delta、decode errorだけをbounded JSONで出力し、encoder生成をhot loop外へ置く。
- [x] `@discordjs/node-pre-gyp`配下の`tar`を限定overrideでexact 7.5.22へ更新し、production `npm audit --omit=dev`を0件にする。
- [x] release Node engineを`>=22.18 <23`へ固定し、Node 22.18 win-x64 ABI127のclean `npm ci`でnative prebuiltと48 kHz mono decodeを確認する。
- [x] TypeScript AudioEngineはtopology変更をcallback外execution planへ反映し、通常callbackでMap / Set lookup・iterator・plan rebuildを行わない。
- [x] callback中のpublic topology Map / Set mutationは変更前に拒否し、そのblockの全outputをzero、saturating fault counterを増加、Emergency Mute不変、次block復帰を自動testで確認する。
- [x] `topologyMutationFaults`はsecret-free numeric `RouterSnapshot` / Tablet projectionへ投影し、load harnessはfault / deadline missをfailureにする。
- [x] Windows TypeScript reference release stageはtracked exact/prefix allowlistだけをunique directoryへcopyし、source realpath、reparse / traversal、秘密entry名、fake ignored secretを自動testで拒否する。
- [x] stage manifest lockはallowlisted tracked sourceのpath / SHA-256、artifact auditはentry名だけを記録し、実秘密内容を読まない。
- [x] Windows TypeScript production用のread-only MMDevice management binaryをallowlisted stageの`bin/`へ同梱し、manifest lockで検証する。
- [ ] ZIP / installer / code signing / native dependency signingとRust Audio ownership binary acceptanceを、allowlisted stageを唯一の入力としてrelease acceptanceに追加する。
- [x] AudioChannel `vcSends` observerはattach / detachされ、preexisting send、direct set / delete / clear、Scene reorderの複合mutationは次blockへ反映される。
- [x] 64 × 64 warmup 100 + 2,000 block harnessでavg / p95 / p99 / max / deadline miss、heap / RSS、passive GC eventをsanitized JSONとして出し、Node 22 production / Node 24 development evidenceを区別する。
- [x] Windows x64 / Node 22の旧release stageで`npm ci --omit=dev --legacy-peer-deps`後に`npm run check:opus-native`を実行し、ABI127 native prebuiltを確認した（当時のtray初回導入を含む。現行trayは自動導入しない）。
- [ ] 追加のWindows target archを配布対象にする場合は、archごとに同じclean install gateを実行する。Node 24 ABI137は公式prebuilt未提供のためrelease対象外とする。
- [x] PGM1は48 kHz / 480-frame / output-major planar Float32 LE / 1..64ch、sequence、有限sample、frame / byte boundをfail closedで検査する。overflowは最古shadow frameのみdropする。
- [x] Program Audio PGM1をpreallocated 4-block wire handoffでlive TypeScript processing loopからRust shadowへfeedし、native wire copy / sequence / hash / Peak / IPCをaudio path外で処理する。pipe backpressureはhandoff内で待ち、overflow / child faultはshadowだけをdropし、旧MONITORへ比較・queue・drop・errorを投影した（現行の表示先はSTATUS → 詳細診断）。
- [ ] Program Audio PGM1 live shadowのhash / Peak / queue dropを実Discord・64ch条件で長時間比較し、mismatch / unexpected / process error 0を確認する。

## S. Desktop Monitor / Log（旧画面の検証記録）

現行UIにMONITOR / LOGタブはありません。状態・統計はSTATUS → STATS / 詳細診断、イベントはSTATUS → LOGへ統合されています。
以下の実browser確認・試験件数・チェック状態は、旧画面での記録として保持します。

- [x] MONITORタブでAudio Engine、Discord、Output、Recorder、Rust shadow、AlertのHealthを文字と色の両方で確認できる。
- [x] sample rate、buffer、callback load、XRUN、output drop、PFL sourceを一画面で確認できる。
- [x] Discord decode、TX、Recorder、Rust shadowのqueue / drop / mismatch / process errorを確認できる。
- [x] process CPU / RSS / JS heap、system memory、録音disk、uptime、network interfaceを確認できる。
- [x] Host telemetryを1秒cacheし、MAC address、Token、音声内容をDesktop Snapshotへ追加しない。
- [x] Bot HealthとUser RX QualityをMONITOR内でも確認でき、RX QUALITYを回線品質そのものと表記しない。
- [x] LOGタブで最新100 EventのINFO / WARNING / CRITICAL件数、level filter、文字列filterを利用できる。
- [x] Event Log消去は確認必須かつON AIR中無効で、Scene Safetyと同じbounded監査logを参照する。
- [x] 全tab target / view対応とJavaScript ID参照の一意性を自動testへ固定した。
- [x] 実browserでMONITOR / LOG切替、実Discord Bot READY、filter、空結果、日本語表示、console error 0件を確認した。
- [x] TypeScript全78 test、Phase 10 Node 5 test、Rust unit 10 test、64 × 64 deadline miss 0を確認した。
