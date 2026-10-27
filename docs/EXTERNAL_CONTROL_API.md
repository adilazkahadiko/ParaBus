# 外部操作 API v1

本書は Stream Deck プラグイン、Bitfocus Companion モジュール、curl などに共通する、ParaBus 外部操作 API の実装契約である。本文の「必須」「拒否する」は実装時の要件を表す。プラグインとモジュールは別リポジトリで開発し、本書だけで相互運用できることを目標とする。

**状態: 設計仕様、未実装。** 調査対象は `main` の `d6de003f350a9e22733c1dbc4928811704b4a6b5`。本変更は仕様書と配布 manifest の登録だけであり、以下の `/external/v1/*`、トークン管理、外部操作停止ボタン、外部用 revision はまだ存在しない。現行の事実は末尾の「現状調査」に分離する。それ以外は v1 で実装する契約であり、現行で利用できる機能を意味しない。

## 目次

1. [範囲と接続方式](#1-範囲と接続方式)
2. [機器登録と認証](#2-機器登録と認証)
3. [権限と全命令の分類](#3-権限と全命令の分類)
4. [HTTP と共通メッセージ](#4-http-と共通メッセージ)
5. [対象の指定と revision](#5-対象の指定と-revision)
6. [外部操作の一覧](#6-外部操作の一覧)
7. [フェーダーと連続操作](#7-フェーダーと連続操作)
8. [TX のアームとテイク](#8-tx-のアームとテイク)
9. [段階 B の二段階確認](#9-段階-b-の二段階確認)
10. [状態配信とメーター](#10-状態配信とメーター)
11. [一発停止・可視化・切断時の動作](#11-一発停止可視化切断時の動作)
12. [流量制限・記録・Support Bundle](#12-流量制限記録support-bundle)
13. [エラーと HTTP ステータス](#13-エラーと-http-ステータス)
14. [版と機能の発見](#14-版と機能の発見)
15. [脅威モデル](#15-脅威モデル)
16. [将来の拡張](#16-将来の拡張)
17. [未決事項](#17-未決事項)
18. [実装 PR で必要なテスト](#18-実装-pr-で必要なテスト)
19. [現状調査](#19-現状調査)

## 1. 範囲と接続方式

v1 は同じ PC のネイティブクライアント専用とし、**操作画面とは別ポートで `127.0.0.1` にだけ bind** する。既定ポートの推奨値は `4175`、ベース URL は `http://127.0.0.1:4175/external/v1`。ポートはローカルの SETUP で変更できる。クライアントは URL を設定可能にし、操作画面のポートから推測しない。ポートの変更は再起動後に反映する。

操作画面の LAN 公開を ON にしても、この listener の bind 先は変わらず、外部操作 API は LAN に公開されない。`0.0.0.0`、`::`、LAN アドレスへの bind 設定は v1 では受け付けない。IPv6 listener は v1 では作らない。接続元も IPv4 ループバックであることを検査する。bind 失敗時に別アドレスや別ポートへ自動的に広げず、外部操作だけを利用不可にして操作画面へ通知する。

同一ポートの別パス案はポート設定が少なくなる一方、操作画面を LAN 公開したときに外部 API の経路も同じ listener に載る。別 listener なら bind の段階で境界を作れ、認証、CORS、流量制限、停止を独立して扱えるため、別ポート案を採用する。操作画面の既存 HTTP/WS や保持されている Tablet 試作経路を外部 API として再利用しない。

全 HTTP と WS upgrade で `Host` は設定済みポートを含む厳密な `127.0.0.1:<port>` のみ許可する。`localhost`、任意の DNS 名、欠落・重複 Host、転送ヘッダーから導いた Host は拒否する。`Forwarded` / `X-Forwarded-*` による接続元の上書きやプロキシ動作はサポートしない。

v1 はブラウザページからの利用を受け付けない。HTTP/WS とも `Origin` ヘッダーがあれば値が `null` やループバックでも拒否する。`Sec-Fetch-Site` がある要求も拒否し、CORS 許可ヘッダーは返さない。`OPTIONS` の preflight は拒否する。Cookie、URL query、WS subprotocol による認証は提供しない。

この拒否条件で、Stream Deck プラグイン本体の Node 20 系、Companion モジュールの Node ランタイムからの正当な HTTP / WS 接続を拒否しないことを実装の受入条件とする。クライアントは Bearer を付与し、ブラウザを模した `Origin` / `Sec-Fetch-Site` を明示的には付けない。`Sec-Fetch-Mode` 単独を拒否理由にしない。**各 Node 版の fetch / WebSocket が自動付与するヘッダーと、採用する WS 実装は現時点で未確認**であり、ヘッダーが付かないとは断定しない。プラグイン実装時に実クライアントで確認し、Authorization ヘッダーを指定できる WS 実装を選定する。ブラウザ拒否を緩めたり、URL にトークンを載せたりして回避しない。

Stream Deck の Property Inspector はブラウザとして扱い、ParaBus API を直接呼ばない。設定変更・状態表示はプラグイン本体とのメッセージを経由し、API の呼び出しとトークン保持は Node 側の本体で行う。

## 2. 機器登録と認証

外部操作は既定で無効。機器とは物理デバイスではなく、トークンを持つクライアント設定の単位である。ローカルの SETUP にある「接続する機器」で、機器名を登録してトークンを発行する。登録、有効化、権限変更、再発行、取り消しは、接続元がこの PC であることと操作画面の nonce / Origin 認証を満たす管理操作に限定する。外部 API にこれらの管理操作は設けない。

- `deviceId`: ParaBus が発行する不透明な ID。機器名は 1〜80 文字で制御文字を禁止し、画面ではテキストとして描画する。
- トークン: 暗号学的乱数 32 bytes 以上から生成し、発行応答で一度だけ表示する。再表示 API は作らない。
- 永続保存する秘密情報はトークンの SHA-256 ハッシュだけ。比較は一定時間比較とし、平文を保存・復元しない。機器名、`deviceId`、権限、失効情報は別の非秘密メタデータである。
- 機器ごとに即時取り消し可能。再発行は旧トークンを取り消す。取り消し・権限変更時は該当機器の全 `armId` と実行待ち要求を失効し、WS も閉じる。
- 全外部エンドポイントと WS upgrade に `Authorization: Bearer <token>` を必須とする。トークンは操作画面の起動ごとの nonce を代用せず、操作画面にも使えない。
- トークンの平文・ハッシュ・Authorization ヘッダーをログ、例外、state、Support Bundle に含めない。発行時以外の画面、DOM、URL、クリップボードへの自動コピーにも残さない。
- 平文は発行応答と認証処理に必要なメモリ内だけで扱う。機器側の保存先は利用者の管理対象となる。

機器側でもトークンはプロファイルや設定の書き出しに含まれない場所へ保存する。Stream Deck はボタンごとの設定に保存せず、プラグインの全体設定を候補とする。Companion は秘密用の入力欄を候補とする。**製品・バージョンごとの保存先、書き出し対象、秘密欄の保護範囲は未確認**であり、プラグイン実装時に確認する。候補の場所でもエクスポートへ含まれるなら採用せず、書き出されない専用の保存先を選ぶ。Property Inspector にトークンを再送して表示させず、接続済みかどうかだけを返す。

段階 A は有効な全トークンに与える。段階 B は操作名ごとの `allowedTierBOperations` に明示登録する。既定は空で、包括的な「全命令可」は作らない。段階 C の許可設定は存在しない。表示名を読む `readDisplayNames` は操作権限と別の権限で、既定 `false` とする。

## 3. 権限と全命令の分類

「A: 常に可」は、追加の段階 B 権限と二段階確認が不要という意味である。認証、有効化、入力制約、既存ロック、FAULT、安全状態、revision 検査を免除しない。B はトークンごとの該当操作の許可と ParaBus 側の二段階確認が必要。C は外部から使用不可とする。

次表は現行 `ControlCommand` の全 56 種類の `type` を列挙する。同じ `type` でも引数によって段階が異なるものは、互いに重ならない条件に分解する。新しい内部命令や新しい引数の意味は、明示的に分類するまで拒否する。実装では `ControlCommand["type"]` に対する網羅的な分類定義とテストを置き、未分類・重複・意図しない外部公開を検出する。

| 内部命令 | 段階 | 外部契約・条件 |
| --- | --- | --- |
| `SET_STATE` | A / B / C | `ON_AIR` への設定ロック ON は A。`ON_AIR` → `SETUP` のロック OFF は B。それ以外の状態遷移は C |
| `SET_CHANNEL_FADER` | A / B | 参加者フェーダー。adjust は A、set は床適用後の上昇量が +6 dB 以下なら A、超過なら B（第 7 節） |
| `SET_CHANNEL_MUTE` | A | 参加者ミュート |
| `SET_USER_CHANNEL_COLOR` | C | 色 |
| `SET_USER_STRIP_ORDER` | C | 並び順 |
| `RESET_USER_STRIP_ORDER` | C | 並び順リセット |
| `SET_PARTICIPANT_APPROVAL` | C | 参加者の承認 |
| `SET_USER_TRUSTED` | C | Trusted の変更 |
| `SET_RECEIVER_OWNER` | C | 受信オーナー |
| `SET_VC_SEND` | A / B | ミュートとゲイン adjust は A、ゲイン set は第 7 節で A / B を判定。Bus 紐付けや Group Bus への直接 Send は含まない |
| `SET_BUS_MASTER` | A / B | Bus マスター。adjust は A、set は第 7 節で A / B を判定 |
| `SET_BUS_MUTE` | A | Bus ミュート |
| `SET_BUS_OUTPUT` | C | 出力割り当て |
| `CLEAR_BUS_OUTPUT` | C | 出力割り当て解除 |
| `SET_BUS_BINDING` | C | Bus と VC の紐付け |
| `CREATE_VC_BUS` | C | Bus 作成 |
| `SET_GROUP_BUS_SOURCES` | C | グループのソース |
| `REMOVE_VC_BUS` | C | Bus 削除 |
| `SET_NEW_PARTICIPANT_POLICY` | C | 新規参加者の扱い |
| `SET_BUS_COMPRESSOR` | B | Bus コンプの有効化と各パラメーター |
| `SELECT_OUTPUT_DEVICE` | C | 出力デバイス選択 |
| `REFRESH_OUTPUT_DEVICES` | C | 出力デバイス再列挙 |
| `SELECT_CUE_OUTPUT_DEVICE` | C | Cue デバイス選択 |
| `REFRESH_CUE_OUTPUT_DEVICES` | C | Cue デバイス再列挙 |
| `SELECT_INPUT_DEVICE` | C | 入力デバイス選択 |
| `REFRESH_INPUT_DEVICES` | C | 入力デバイス再列挙 |
| `SET_DIRECT_OUTPUT` | C | Direct Output 割り当て |
| `CLEAR_DIRECT_OUTPUT` | C | Direct Output 解除 |
| `SET_OUTPUT_TEST_TONE` | C | テストトーン |
| `SET_LIMITER` | B | 有効化・解除とも B。ON_AIR の構造ロックと SETUP 以外の解除禁止は保持 |
| `RESET_LOUDNESS` | A | Bus ラウドネスリセット |
| `SET_PFL` | A | 参加者・Bus の PFL と解除 |
| `SET_MONITOR_OUTPUT` | C | Monitor 出力割り当て |
| `EMERGENCY_MUTE` | A / B | `active:true` は A、`active:false` は B |
| `SAVE_SCENE` | C | シーン保存・上書き |
| `PREVIEW_SCENE` | A | 読み取り専用プレビュー |
| `RECALL_SCENE` | B | プレビューを含む確認後の呼び出し |
| `DELETE_SCENE` | C | シーン削除 |
| `SET_RECALL_SAFE` | C | Recall Safe |
| `CLEAR_EVENT_LOG` | C | ログ表示履歴の消去 |
| `SET_TX_SOURCE` | C | TX の Matrix 出力ソース変更 |
| `SET_TX_INPUT` | C | TX のローカル入力変更 |
| `SET_TX_MASTER` | A / B | Bot ごとの TX マスター。adjust は A、set は第 7 節で A / B を判定 |
| `ASSIGN_TX_VOICE_CHANNEL` | C | TX の VC 割り当て |
| `CONNECT_DISCORD_BOT` | C | Bot 接続 |
| `DISCONNECT_DISCORD_BOT` | C | Bot 切断 |
| `START_TX` | A | 明示した Bot 1 つの開始。`profileId` 省略は禁止 |
| `SET_TX_TARGETS` | A | 設定済み Bot の集合を選ぶアーム。入力・VC・送り先区分の設定変更は不可 |
| `START_ARMED` | A / B | 対象 1 つかつ ALL TEAMS に該当しなければ A。2 つ以上または ALL TEAMS は B。空集合のテイクは拒否 |
| `CLEAR_ALL` | A | 全 TX の停止とアーム解除 |
| `STOP_TX` | A | 明示した Bot 1 つの停止。`profileId` 省略は禁止 |
| `START_RECORDING` | B | 明示した録音対象で開始 |
| `STOP_RECORDING` | B | 録音停止要求 |
| `DEVICE_LOST` | C | 内部障害通知 |
| `INPUT_DEVICE_LOST` | C | 内部障害通知 |
| `ACKNOWLEDGE_FAULT` | C | FAULT 確認・復旧 |

本体の終了・再起動、設定保存、セッション終了など `ControlCommand` 外の管理 HTTP 操作も C とする。内部の命令名を受け付ける汎用 API は作らない。

API は認証・段階・引数・revision を判定した後、既存のサーバー制御経路と `ControlPlane` を使う。エンジンや TX controller の状態を直接変更して検査を迂回しない。内部で必要な `confirmed:true` は、A の許可判定を完了したとき、または B の execute を完了できると判定したときだけ API が付与する。外部入力の `confirmed` は不正なフィールドとして拒否する。

特に `expectedEmergencyEpoch`、TX targets の `expectedRevision`、緊急ミュート中・FAULT 中の TX 開始拒否、出力準備と presence monitoring、Rust silent stream による状態遷移制限、Recall Safe とシーンの既存パラメーターロックを保持する。B の許可もこれらを解除しない。ロック ON は `SET_STATE ON_AIR` に対応し、READY / SETUP からのみ要求できる。すでに ON_AIR なら副作用なしで成功し、FAULT では拒否する。ロック OFF は ON_AIR から SETUP に戻す操作であり、READY への移行や緊急ミュート解除は伴わない。すでに SETUP なら確認済み execute は副作用なしで成功する。READY / FAULT での OFF は拒否する。

## 4. HTTP と共通メッセージ

以下のパスはすべて別 listener のベース URL に続ける。

| メソッド・パス | 用途 |
| --- | --- |
| `GET /info` | 版・機能・制限・現在の起動 ID |
| `GET /state` | WS と同じ最小 state を 1 回取得 |
| `GET /ws` | WS upgrade、状態とメーター購読専用 |
| `POST /actions` | 段階 A の即時実行 |
| `POST /arm` | 段階 B の確認を構える |
| `POST /execute` | 段階 B の確認を実行 |

HTTP は UTF-8 JSON、POST は `Content-Type: application/json` を必須とする。要求ボディは最大 16 KiB。圧縮ボディ、バッチ、未知のフィールド、不明な操作、型違い、NaN / Infinity、整数が必要な箇所の小数、重複 JSON キーを拒否する。HTTP と WS の全認証応答に `Cache-Control: no-store` を付ける。リダイレクトしない。

共通成功応答は `{ "ok":true, "requestId":"...", "instanceId":"...", "revision":42, "data":{} }`。GET の応答は `requestId` を持たない。`GET /state` の `data` は第 10 節の state そのものである。`data` は操作別に下記で定め、返す内容がなければ `{}` とする。成功は要求を受理して既存制御処理を実行したことを表し、Discord への到達や録音ファイルの完了を保証しない。クライアントは state で `active` や録音状態を追跡する。

`POST /actions` と `POST /arm` の要求:

```json
{
  "requestId": "9dc7c1f2-6419-4fa2-8e8e-c9627775d9d6",
  "instanceId": "30451aa1-9253-4af0-b4ce-cd82c3890392",
  "operation": "channel.fader.adjust",
  "args": { "target": { "kind": "user", "discordUserId": "100000000000000001" }, "deltaDb": -1 }
}
```

`requestId` と `instanceId` は必須の UUID 文字列。`instanceId` は `info` / `state` から得て、再起動前の値は `STALE_REVISION` にする。`expectedRevision` は actions / arm に任意の正整数として付けられるが、クライアントが最後に観測した state の参照値としてだけ扱い、全体の revision の一致を実行条件にはしない。toggle、B の arm / execute、scene.preview にも全体一致を要求しない。競合の検査には第 5 節の操作別の値・世代・依存関係を使う。GET 後の関連状態が変わった場合は新 state を取得し、利用者の意図を再評価する。

同一機器の `requestId` は全 POST 経路を通じて 60 秒間重複排除する。同一のパスと正規化済み payload の再送は同じ結果を返し、再実行しない。別内容への再利用は `INVALID`。失敗結果も同じ期間保持するため、失敗を直して送るときは新しい `requestId` が必要。`execute` の重複排除を `armId` 消費より先に確認する。キャッシュは機器ごと最大 2048 件とし、未期限の項目を押し出さず、新規要求を `RATE_LIMITED` にする。認証・失効・無効化はキャッシュ参照より先に検査する。

通信断後の結果不明な操作は 60 秒以内に同じ `requestId` で問い合わせ直せる。ただし相対フェーダー、トグル、テイクを新 ID で自動再送しない。期限を過ぎた再送は新しい要求になり得るため、state を取得して手動で再操作する。再接続時に過去の操作キューを再生しない。

## 5. 対象の指定と revision

### ID と参加者

| 対象 | 指定 |
| --- | --- |
| Bus | `busId`: state に現れた不透明な文字列をそのまま保存。ラベルから生成しない |
| TX Bot | `profileId`: 設定された英数字・`_`・`-` の 1〜32 文字。送り先は `destination` で検証できる |
| 送り先区分 | `TEAM_01`〜`TEAM_20`、`INTERVIEW`、`SPARE`。`ALL_TEAMS` は選択方式であり区分 ID ではない |
| シーン | `sceneId`: state から取得する 1〜128 文字の不透明な文字列。新規生成は現行では UUID だが、読込済み ID を UUID に限定しない。番号や名前を ID として使わない |
| 固定参加者 | `{"kind":"user","discordUserId":"100000000000000001"}` |
| 並び順の参加者 | `{"kind":"slot","scope":{"kind":"all"},"index":1,"expectedParticipantsRevision":17}` |

Discord User ID は 17〜20 桁の **文字列** のまま扱い、JSON number に変換しない。固定参加者は登録済みユーザーに結び付け、要求時点のオンライン channel に解決する。オフラインなら `NOT_FOUND` とし、保存プロファイルを変更したり、再入室まで操作を予約したりしない。

並び順は 1 始まりで、オンライン Discord 参加者だけを対象とする。`scope` は全参加者の `{"kind":"all"}`、または VC に紐付く Bus の `{"kind":"bus","busId":"..."}`。後者は当該 VC のみを対象にし、Group Bus や VC 未紐付け Bus は `INVALID` とする。オンラインかつスコープ内の参加者を `preferredStripPosition` 昇順、同順位なら `discordUserId` の文字列昇順で並べ、隙間を詰めた順番とする。画面の ALL / VC 表示に対応する順番であり、Bot カード番号やオフラインの保存位置ではない。スコープと並びは ParaBus が state 内で配信する。

`expectedParticipantsRevision` は slot 指定で必須。入退室、再入室、VC 移動、並び順、対象 Bus の世代が変わったら増加し、古い番号を別人へ適用しない。固定参加者も解決後の対象がコミットまでに変われば拒否する。内部 `sessionGeneration` は再入室で常に増えるわけではないため、それだけを対象の寿命判定に使わない。API は別途オンライン出現の世代を追跡する。

現行の channel ID は `discord-user:<guildId>:<voiceChannelId>:<userId>` で VC 移動により変わる。固定ボタンの永続キーには使わない。自動 Bus の ID は `discord-vc:<guildId>:<voiceChannelId>`、手動 Bus の ID は名前由来と衝突用の接尾辞であり、削除後の再作成で同じ ID になり得る。API は内部 ID だけで同一物と判断せず、同じ起動中の削除・再作成を revision と対象世代で検出する。Bot の削除・再登録にも同じ規則を適用する。

### 外部用 revision

`instanceId` は起動ごとに新しく発行する。外部用 `revision` と `participantsRevision` は 1 以上の安全な整数で、同一起動中は単調増加する。前者はメーター・時刻・接続数を除く公開操作状態と安全依存関係の変更、後者は参加者の対応付けの変更で増加する。内部 `ControlPlane.revision` の単なる別名にはしない。操作画面からの変更、Discord の入退室・TX 状態、安全状態、対象の削除と再作成も観測する。値が元に戻る ABA でも世代は元に戻さない。

全体の `revision` は state の配信・取得と新旧の判別に使い、操作の競合検出には使わない。任意の `expectedRevision` を付けてもこの規則は変わらない。操作ごとに照合するものは次表に限定する。全操作に共通して認証、有効化、`instanceId`、対象の存在・同一性、権限、既存の安全検査を適用する。

| 操作 | 照合する値・依存関係 | 競合の条件 |
| --- | --- | --- |
| `*.mute.toggle`（参加者・Bus・Send） | 対象自身の現在の mute と必須の `args.expectedMute:boolean` | 不一致なら `STALE_REVISION` と現在の mute を返す。他対象のフェーダーや入退室では拒否しない |
| `*.mute.set` | 明示した `args.mute` と実行時の対象 | 現在値の一致は要求せず、同じ値への set は副作用なしで成功 |
| フェーダー adjust / A の set | 対象の現在 dB、床適用後の上昇量、同一機器・同一対象の dB 枠 | 実行時の値で分類・制限する。無関係な変更では拒否しない |
| フェーダー B の set | arm 時の対象世代とそのフェーダー値の世代、固定した目標 dB | 対象の再作成・同じフェーダーの変更で `STALE_REVISION`。他のフェーダーや対象外の入退室は依存しない |
| `emergency.set(active:false)` | 必須の `expectedEmergencyEpoch`、arm 時の emergencyEpoch、READY / FAULT とデバイス回復・準備状態 | epoch の変更は `STALE_REVISION`、現在の安全条件違反は `LOCKED` |
| `settings.lock.set(locked:false)` | arm 時の設定ロック状態の世代、状態遷移と既存の安全条件 | 関連する状態遷移は `STALE_REVISION`、現在の禁止条件は `LOCKED` |
| `bus.limiter.set` / `bus.compressor.set` | 対象 Bus の世代と変更するパラメーターの世代、既存ロック | 対象・該当パラメーター変更は `STALE_REVISION`。同じ Bus の masterDb など対象外の値には依存しない |
| `scene.preview` → `scene.recall` | シーン内容の版、実際の差分（from / to）、適用・除外対象の世代、Recall Safe、パラメーターロック | プレビューから arm、arm から execute の各段階で差分を再評価し、関連する変更だけを `STALE_REVISION` にする |
| `recording.start` / `recording.stop` | 録音セッション・状態の世代。開始は選択した出力・Bus・参加者の世代も固定 | 関連する録音状態や選択対象の変更だけを `STALE_REVISION` にする。未選択参加者の入退室には依存しない |
| `tx.targets.set` / `tx.take` | 必須の `expectedTargetsRevision` と対応する内部 targets revision。B の take は関連する profile 集合・送り先・入力・Bot 世代と状態も固定 | 関連する TX 対応・状態変更は `STALE_REVISION`、開始の安全禁止は `LOCKED` |
| slot 指定を含む全操作 | 必須の `expectedParticipantsRevision`、scope と index で解決した本人 | 参加者対応の変更は `STALE_REVISION`。この検査は全体 revision と分離して維持 |
| その他の A 操作 | 明示した対象と実行時の既存安全条件 | 全体 revision や無関係な対象の変更を理由に拒否しない |

B の依存関係は arm 時に ParaBus が保存し、execute 時に照合する。個別の値・対象世代は変更の後に値が元へ戻っても世代を戻さず、ABA を検出する。ただし toggle は**現在の boolean 値**だけを比較し、履歴の一致は要求しない。slot 指定では、無関係な参加者の入退室でも `participantsRevision` が変われば安全のため拒否する。この明示的な例外を固定ユーザー指定や参加者に依存しない操作へ広げない。

検査と実行はサーバー側の同じ直列化された制御処理で行う。相対値の現在値、toggle の現在状態、slot の解決、B の依存関係もこの処理内で確定する。複数機器・操作画面が同時に操作しても古い読み取りで上書きしない。

## 6. 外部操作の一覧

外部から受け付ける操作名は次表だけ。`target` は第 5 節の参加者指定、`busId` / `profileId` / `sceneId` は同節の ID。`expectedRevision` など共通フィールドは `args` の外に置く。`*.set` の boolean は明示値であり toggle とは別の操作である。

| 外部操作 | 段階 | `args` | 対応する内部命令 |
| --- | --- | --- | --- |
| `channel.fader.adjust` / `channel.fader.set` | adjust は A、set は A / B（第 7 節） | `target`, `deltaDb` / `db` | `SET_CHANNEL_FADER` |
| `channel.mute.set` / `channel.mute.toggle` | A | `target`, set は `mute:boolean`、toggle は `expectedMute:boolean` | `SET_CHANNEL_MUTE` |
| `bus.fader.adjust` / `bus.fader.set` | adjust は A、set は A / B（第 7 節） | `busId`, `deltaDb` / `db` | `SET_BUS_MASTER` |
| `bus.mute.set` / `bus.mute.toggle` | A | `busId`, set は `mute:boolean`、toggle は `expectedMute:boolean` | `SET_BUS_MUTE` |
| `send.fader.adjust` / `send.fader.set` | adjust は A、set は A / B（第 7 節） | `target`, `busId`, `deltaDb` / `db` | `SET_VC_SEND` の `db` のみ |
| `send.mute.set` / `send.mute.toggle` | A | `target`, `busId`, set は `mute:boolean`、toggle は `expectedMute:boolean` | `SET_VC_SEND` の `mute` のみ |
| `tx.fader.adjust` / `tx.fader.set` | adjust は A、set は A / B（第 7 節） | `profileId`, `deltaDb` / `db` | `SET_TX_MASTER` |
| `pfl.set` | A | `source:null` または `source:{kind:"channel",target}` または `source:{kind:"bus",busId}` | `SET_PFL` |
| `loudness.reset` | A | `busId` | `RESET_LOUDNESS` |
| `scene.preview` | A | `sceneId` | `PREVIEW_SCENE` |
| `scene.recall` | B | `sceneId`, `previewId` | `RECALL_SCENE` |
| `emergency.set` | A / B | `active:true` は A。`active:false,expectedEmergencyEpoch` は B | `EMERGENCY_MUTE` |
| `settings.lock.set` | A / B | `locked:true` は A、`locked:false` は B | 制約付き `SET_STATE` |
| `bus.limiter.set` | B | `busId`, `enabled:boolean` | `SET_LIMITER` |
| `bus.compressor.set` | B | `busId` と下記パラメーターを 1 つ以上 | `SET_BUS_COMPRESSOR` |
| `tx.start` / `tx.stop` | A | `profileId` | `START_TX` / `STOP_TX` |
| `tx.clear` | A | `{}` | `CLEAR_ALL` |
| `tx.targets.set` | A | 第 8 節 | `SET_TX_TARGETS` |
| `tx.take` | A / B | `expectedTargetsRevision` | `START_ARMED` |
| `recording.start` | B | `selection:{outputs:number[],busIds:string[],participants:target[]}` | `START_RECORDING` |
| `recording.stop` | B | `{}` | `STOP_RECORDING` |

コンプのパラメーターは `enabled:boolean`、`thresholdDb` (-60〜0)、`ratio` (1〜20)、`attackMs` (0.1〜200)、`releaseMs` (10〜2000)、`makeupDb` (-12〜24)。省略した値は変更しない。リミッターは enabled のみとし、天井など内部パラメーターは公開しない。

`recording.start` の `selection` は空集合不可。`outputs` は 0 始まりで state の `outputCount` 未満、最大 64。`busIds` は最大 32、`participants` は最大 112。各配列の重複は禁止。参加者は arm 時点でオンライン対象へ固定し、execute 時の変更は拒否する。内部の `selection.channelIds` に解決し、`matrixOutput` は最初の選択出力または出力 0、`includeUsers:false,includeBuses:false` とともに渡す。後二者による全対象の自動展開には依存しない。出力が存在しない、対象が欠けた、録音中・停止処理中の場合は既存の制約に従い拒否する。保存パスの指定や全新規参加者の自動追加は提供しない。

`scene.preview` は全体の `expectedRevision` を要求せず、副作用なしでその時点の差分を返す。成功の `data` は `previewId`、`sceneId`、`changes`、`excludedParticipantCount`。`changes` の要素は `{target,field,from,to,recallSafe,locked}` とし、`target` は `{kind:"channel",target:<固定参加者>}`、`{kind:"bus",busId}`、または `{kind:"other",id:<不透明ID>}`。`field` は保存された内部パラメーター名の文字列、`from` / `to` は number / boolean / string / null、後二つは boolean。`from` が存在しない場合は null とする。`label` など名称フィールドは `readDisplayNames:false` なら `from` / `to` を null にする。内部 snapshot 全体、参加者の除外理由の生文字列やパスは返さない。

`previewId` は機器・シーン内容の版・差分と安全依存関係に結び付く一時 ID で、有効期限は 30 秒。B の arm と execute でその差分を再確認し、差分・適用や除外の対象・関連する安全条件が変わったら `STALE_REVISION`、期限切れ・別機器・未知の ID は `INVALID`。表示名権限で秘匿した from / to もサーバーでは実値で比較する。シーンに関係のないフェーダーや、差分と適用・除外対象に影響しない参加者の入退室では失効させない。成立した arm はプレビューを取り込むため、その後は arm の期限を適用する。Recall Safe、既存のスキップ対象、ロックされたパラメーターは変更しない。シーン経由で既存のラベルや順番などが復元され得ることもプレビューに含めるが、外部からシーン内容や任意の内部命令を注入することはできない。

フェーダー・ミュート・設定ロック・リミッターの成功 `data` は `{value:<確定したnumberまたはboolean>}`。`emergency.set` は `{value:<active>,emergencyEpoch:<現在値>}`、コンプは `{value:<state と同じ compressor オブジェクト>}`。PFL は `{source:<正規化したsource>}`、`loudness.reset` と `scene.recall` と録音操作は `{}`。TX 操作は `{targetsRevision:<更新後の値>}`、TX フェーダーは `{value:<db>}`。B arm と execute の応答は第 9 節に従う。

## 7. フェーダーと連続操作

参加者、Bus マスター、VC Send、TX マスターは同じ規則を使う。基本操作は `*.adjust` の `deltaDb` で、有限の非ゼロ数を受け付ける。目標値は `currentDb + deltaDb` を現行の -90〜+12 dB へ飽和させたものとする。`*.set` の `db` は有限の -90〜+12 dB を受け付ける。下げ幅には相対量の制限を設けず、下げる絶対値も範囲内なら許可する。

上昇量は **-40 dB を床**として、`increaseDb = max(0, targetDb - max(currentDb, -40))` で数える。床以下の上昇は 0 と数え、1 要求の A 上限と連続操作の dB 枠には計上しない。-90 → -40 は 0、-90 → -34 は +6、-90 → 0 は +40、-20 → 0 は +20、-3 → 0 は +3 と数える。下げる操作の計上は常に 0 で、dB 枠を消費も回復もさせない。

| 操作と床適用後の上昇量 | 段階・受付 | dB の速度制限 |
| --- | --- | --- |
| `*.adjust`、`increaseDb <= 6`（下げる操作を含む） | A。1 要求あたり最大 +6 dB | 機器ごと・同一対象ごとに +20 dB/秒、burst +10 dB。計上量 0 は消費しない |
| `*.adjust`、`increaseDb > 6` | `INVALID`。黙って切り詰めない | 実行しない |
| `*.set`、`increaseDb <= 6`（下げる操作を含む） | A | adjust と同じ dB 枠を共有 |
| `*.set`、`increaseDb > 6` | B。同じ操作名の権限と arm / execute を必須にする | 確認済みの単発絶対値変更として dB 枠の対象外。通常の POST 流量制限は適用 |

`*.set` の段階は、`tx.take` と同様に args の目標値と対象の現在値から ParaBus が判定する。大幅 set を `/actions` に送ったら、該当操作名の B 権限があれば `CONFIRMATION_REQUIRED`、なければ `TIER_FORBIDDEN` とし、上昇量の理由だけで `INVALID` にしない。例えば「0 dB に戻す」の長押しは `channel.fader.set` の `db:0` を arm して execute できる。B が例外となるのは A の 1 回 +6 dB と連続操作用 dB 枠だけで、-90〜+12 dB の範囲、対象世代・該当フェーダー値の依存関係、既存安全検査、確認の最短時間と期限は保持する。

B の arm 応答の summary は対象、現在値、目標値、床適用後の上昇量を含める。arm 後にそのフェーダーが変わったら `STALE_REVISION` とし、A へ自動降格して実行しない。別フェーダーの変更では失効させない。フェーダー以外のシーンリコールやコンプ変更にはこの量制限を適用せず、B の差分確認で扱う。

Send が未作成の場合は暗黙のルート作成をせず `NOT_FOUND` とする。フェーダー変更で mute を解除せず、ミュート変更でもゲインを変えない。承認待ちの参加者に対するレベル変更も承認ゲートを開かない。

長押しは機器側が 1 ステップずつ送る。推奨は ±1 dB を 50〜100 ms 間隔で、前回の応答を見てから次を送る。上昇は毎秒 10〜20 dB となり、+20 dB/秒・burst +10 dB の dB 枠に収まる。50 ms は機器の通常 POST 枠 20 要求/秒も使い切るので、他の操作を併用するときは 100 ms を基本とする。床以下の復帰は量制限で足止めせず、例えば `db:-40` への A の set を使える。ParaBus は「押している間」「n 秒間」の自走操作や継続ジョブを作らない。切断後は追加ステップがなくなり、その時点の値で止まる。HTTP タイムアウト時に未到達と推測して別 ID で再送しない。

全ミュート toggle（参加者・Bus・Send）は `args.expectedMute:boolean` を必須とする。対象の現在の mute が一致すれば、その値を反転する。不一致なら既にほかの経路で目的の状態になっているものとして、状態を変えず `STALE_REVISION` と `current:{mute:<現在値>}` を返す。プラグインは現在値で表示を直し、自動的に再 toggle しない。全体の `expectedRevision` は要求せず、他対象のフェーダー変更や無関係な入退室で拒否しない。slot 指定の参加者対応検査は例外として維持する。

ミュート `.set` は冪等で、同じ boolean 値の再設定は副作用なしで成功する。押したときの見た目どおりの状態にしたいクライアントには、toggle より明示的な `.set` を推奨する。相対 adjust と toggle は冪等ではなく、大幅フェーダー set が B になる場合の確認・重複排除も省略しない。

## 8. TX のアームとテイク

現行 TX は Bot ごとに音源を持ち、同じローカル入力を複数 Bot に割り当てられる。外部 v1 はその設定を読むだけで、入力、音声モード、VC、送り先区分を変更しない。Matrix 出力ソースの旧形式も現行には存在するが、外部から切り替える機能は C とする。

`tx.start` / `tx.stop` は明示された Bot 1 つの操作。`tx.start` は既存の開始検査を通し、他の live Bot を停止しない。`tx.stop` はその Bot のみ停止し、現行どおりアームは保持する。複数 Bot を切り替える操作にはテイクを使う。

`tx.targets.set` の `args` は次のいずれかと `expectedTargetsRevision`（必須）:

- `{"selection":{"kind":"profiles","profileIds":["TX01"]},"expectedTargetsRevision":5}`
- `{"selection":{"kind":"destinations","destinations":["TEAM_01","INTERVIEW"]},"expectedTargetsRevision":5}`
- `{"selection":{"kind":"allTeams"},"expectedTargetsRevision":5}`

選択は集合の**置き換え**で、送信は始めない。profiles / destinations は最大 22、重複不可。空配列はアーム解除だけを行い、live は停止しない。destinations は設定済みの一意な Bot に解決し、未設定なら `NOT_FOUND`。allTeams は設定済み `TEAM_*` の全 Bot を選び、INTERVIEW / SPARE は含めない。TEAM_01〜20 の全枠の設定を要求せず、設定済み TEAM が 0 なら `NOT_FOUND`。解決した profile 集合と選択方式を API が記録する。

外部 `expectedTargetsRevision` は state の `tx.targetsRevision` と一致させ、内部の `SET_TX_TARGETS.expectedRevision` / `START_ARMED.expectedRevision` へ対応付ける。外部の選択方式の変更も追跡するため、外部 targetsRevision は内部値の単なる転送にはしない。両方を同時に検査し、操作画面からの変更でも古い要求を拒否する。

`tx.take` は args に `expectedTargetsRevision` を必須とし、実行時の**アーム集合そのもの**をテイクする。live でアームにない Bot を停止してから、選択された Bot を開始する。空集合なら `INVALID` とする。2 つ以上の profile、allTeams 選択、または現行の `isAllTeamsArmed()` が真なら B。その他の 1 つだけなら A。TEAM Bot が 1 つしかない構成でも、その全 TEAM を選択したテイクは B とする。`/actions` で B のテイクを送ると、権限があれば `CONFIRMATION_REQUIRED`、なければ `TIER_FORBIDDEN`。

Bot 1 つの明示的な `tx.start` は A である。複数宛先をまとめて実行するバッチや、確認不要の複数開始操作は提供しない。1 つずつの開始でも機器ごとの流量制限と既存の安全検査を受ける。

テイクの B arm は profile 集合、送り先対応、入力、Bot 世代、選択方式、targetsRevision に結び付ける。どれかが変わったら実行を拒否する。グループ開始失敗時は現行の停止・緊急 flush 処理を維持する。`tx.clear` は確認不要で全 Bot の TX を停止し、アームも解除する。プラグイン切断自体は CLEAR_ALL も START も送らない。

## 9. 段階 B の二段階確認

1. 構える: `POST /arm` に B の `operation`、全 `args`、共通 ID を送る。全体の `expectedRevision` は任意の参照値であり、一致を要求しない。ParaBus がトークンの該当 B 権限、対象、操作ごとの依存関係、既存ロックと安全条件を検査する。この段階では操作状態を変えない。
2. 応答: `data` は `{armId,operation,tier:"B",summary,minimumHoldMs:1000,expiresInMs:5000}`。`armId` は推測困難な 128 bit 以上の一時 ID。`summary` は秘密や Discord 表示名を含まない短い説明で、機器は実行内容を利用者に表示する。
3. 実行する: `POST /execute` に `{requestId,instanceId,armId}` だけを送る。操作名や引数は再送・上書きできない。成功応答は保存済み操作の通常の `data` を返す。

推奨値を v1 の既定として、ParaBus の単調時計で **arm 受理から 1000 ms 以上、5000 ms 未満** の execute を有効にする。1000 ms 未満なら `ARM_TOO_EARLY`、5000 ms 以上なら `ARM_EXPIRED`。時刻はクライアント申告を使わない。機器は押下で arm、継続押下 1 秒後に execute、離したら execute しない方式を基本とする。ParaBus が確認できるのは経過時間であり、物理的な押下継続や人の意図自体を証明するものではない。

`armId` は機器、トークンの権限世代、起動、操作名、正規化した引数、解決済み対象の世代、**その操作だけの依存関係**に結び付く。全体の revision には結び付けない。execute では同じ機器か、有効化・権限が維持されているかを確認し、第 5 節の表に従って保存した依存関係と既存安全条件を再検査する。emergencyEpoch、参加者対応、シーン内容、録音状態、TX 入力・送り先・Bot 状態、該当フェーダーの値は、当該操作に関係するものだけを含める。メーター、uptime、関係のないフェーダー、対象外の参加者の入退室は含めない。slot 指定だけは必須の expectedParticipantsRevision を維持する。

例えば固定対象の Bus ミュートの操作中に別の参加者が入退室しても、緊急ミュート解除の確認中に別フェーダーが動いても、それだけでは失敗させない。シーン recall は preview 時、arm 時、execute 時の差分と関連する依存関係を照合し、差分に関係しない変更では失効させない。関連する値・対象世代の変更は `STALE_REVISION`、現在の安全禁止は `LOCKED`、権限剥奪は `TIER_FORBIDDEN`、失効トークンは `UNAUTHORIZED` とする。

arm は 1 回限り。認証済みの正しい機器による execute の照合で消費し、早過ぎ・期限切れ・競合・ロックなどの失敗でも再利用できない。再試行は利用者が改めて構える。未知・別機器・消費済み `armId` は区別せず `ARM_INVALID` とする。期限切れの未使用 arm は発行から 60 秒まで失効記録を保持し、その機器の最初の execute に `ARM_EXPIRED` を返せるようにする。以後は `ARM_INVALID` でよい。同じ execute の同じ `requestId` の再送だけは重複排除した結果を返す。別機器の照合では正しい機器の arm を消費しない。

機器あたり有効 arm は最大 1 個で、新しい arm が成立したら前のものを取り消す。切断・停止・失効・再起動で保持中の arm を破棄する。HTTP だけの機器では TCP 接続の終了を機器の切断とは扱わず、arm は最大 5 秒で消える。A の操作を `/arm` に送るのは `INVALID`。B を `/actions` に送っても実行せず確認手順を要求する。B の許可自体がない要求には arm を発行しない。

## 10. 状態配信とメーター

`GET /state` と WS の `state` は外部用の明示的な projection とし、操作画面の `desktopSnapshot` を転送しない。トークン、設定ファイル、デバイス列挙、ディスクパス、ギルド情報、内部エラー、生ログ、シーンの全保存値、Trusted 管理情報、受信オーナー管理情報は含めない。

state の JSON 形は次のとおり。`?` は任意フィールドを表す説明用表記であり実際の JSON キーには付けない。配列内のオブジェクトもここに列挙したフィールドだけを公開する。

| フィールド | 型・内容 |
| --- | --- |
| `instanceId`, `revision`, `participantsRevision` | 第 5 節の UUID / 整数 / 整数。revision は state の新旧判別用、participantsRevision は slot の対応検査用 |
| `enabled` | boolean。有効な通常 state では true |
| `state`, `settingsLocked` | `SETUP\|READY\|ON_AIR\|FAULT`、`state === "ON_AIR"` の boolean |
| `emergencyMuted`, `emergencyEpoch` | boolean、現在の安全 epoch の整数 |
| `outputCount` | 録音で選択できる Main 出力数、0〜64 |
| `participants` | オンライン参加者の配列。`{discordUserId,faderDb,mute,sends:[{busId,db,mute}],displayName?}` |
| `registeredUsers` | 固定指定の選択肢。`{discordUserId,online,displayName?}` の配列。オフラインのレベルは含めない |
| `participantOrders` | `{scope,users:string[]}` の配列。all と VC Bus ごとの順序。各 users は Discord User ID |
| `buses` | `{busId,kind:"vc"\|"group"\|"other",masterDb,mute,limiterEnabled,compressor:{enabled,thresholdDb,ratio,attackMs,releaseMs,makeupDb}}` の配列 |
| `pfl` | 第 6 節 `pfl.set` と同じ `source` の値 |
| `tx` | `{targetsRevision,armedProfileIds:string[],liveProfileIds:string[],selectionKind:"profiles"\|"destinations"\|"allTeams",allTeams:boolean,takeTier:"A"\|"B"\|null,bots:[...]}` |
| `tx.bots[]` | `{profileId,destination:string\|null,state:"NO_BOT"\|"NOT_READY"\|"READY"\|"SENDING"\|"FAULT",active,masterDb,sourceInputChannelIds:string[],sourceMode:"localInput"\|"legacyMatrix"\|"unassigned"}`。入力 ID は読み取り専用で保持・編集不要 |
| `recorder` | `{state:"IDLE"\|"RECORDING"\|"STOPPING"\|"FAULT"}` |
| `scenes`, `currentSceneId` | `{sceneId}` の配列、不透明なシーン ID 文字列または null |
| `permissions` | この機器の `{allowedTierBOperations:string[],readDisplayNames:boolean}` |

`takeTier:null` はアーム集合が空の場合。`selectionKind` は起動時 profiles とし、操作画面からアーム集合が変更されたら profiles に戻す。`allTeams` は現在の集合での判定を表す。Bus / シーン / Bot の自由なラベルは v1 state に含めず、ID と送り先区分で識別する。

toggle の `expectedMute` は対象の `participants[].mute`、`buses[].mute`、または `participants[].sends[].mute` から取得する。公開 state の revision が増えただけで未実行操作や arm を失効させない。B の依存関係の世代はサーバーが保持し、操作ごとの検査に使う。クライアントが全体 revision からそれを推測する必要はない。

Discord の表示名は既定で含めない。ローカル SETUP でその機器に `readDisplayNames:true` を許可したときのみ、`participants` / `registeredUsers` の `displayName` に出す。制御文字を除去し最大 80 文字に制限する。プラグインは表示用の非信頼文字列としてエスケープし、ログ・共有設定・遠隔同期へ自動出力しない。ユーザー ID も個人に結び付く情報であり、名前を省いた state も公開情報とは扱わない。

WS は認証成功後、ただちに `{type:"state",payload:<state>}` を送り、その後は変更があったとき最大 10 Hz で**完全な projection** を配信する。購読者は差分の取りこぼし処理を必要としない。通常の state にメーターは含めない。操作要求は WS では受け付けず、HTTP に統一する。

メーター購読メッセージ:

```json
{"type":"meters.subscribe","requestId":"deaf2ad5-582c-40b6-bda5-76a74db8db38","sources":[{"kind":"bus","busId":"interview"}],"hz":10}
```

sources は `{kind:"channel",target:<固定参加者>}`、`{kind:"bus",busId}`、`{kind:"tx",profileId}`。slot 指定は受け付けない。最大 32 個、重複不可、hz は整数 1〜10 で、上限超過は `INVALID`。`{type:"meters.unsubscribe",requestId}` で停止する。再 subscribe は置き換え。応答は `{type:"result",requestId,payload:{ok:true,data:{hz:10}}}`（unsubscribe の data は `{}`）。失敗は同じ envelope 内に第 13 節のエラーを入れる。各 requestId は UUID とし、不正なメッセージで有効な ID がなければ応答の requestId を null にする。未知の type は `INVALID`。初回 subscribe で存在しない対象は `NOT_FOUND` とし、購読を部分的に更新しない。

配信は `{type:"meters",instanceId,sequence,values:[{source,peak,rms,clip,stale}]}`。`sequence` は WS ごとの単調増加整数、peak / rms は 0 以上の線形振幅、clip / stale は boolean。1 を超える振幅はあり得る。TX の現行ソースに rms / clip がなければそれらは null とし、推測値を作らない。対象消失は `stale:true,peak:0,rms:null,clip:null` として通知し、自動的に他の参加者へ置き換えない。

WS は機器あたり最大 2 接続、全体最大 16 接続。購読は切断で消え、再接続で勝手に復元しない。送信待ちが 256 KiB を超えたらメーターを捨て、なお state を送れなければ close `1013`。ping を 15 秒ごとに送り、45 秒 pong がなければ切断する。再接続は 1 秒から最大 30 秒の指数バックオフと jitter を使い、状態を取得し直す。認証・無効化で閉じられたら自動再接続を停止する。

## 11. 一発停止・可視化・切断時の動作

操作画面のメイン画面に **「外部操作を止める」** を置き、ON_AIR / FAULT 中も即時に使えるようにする。この停止は外部 API に新たな操作として公開しない。ローカルの操作画面から操作でき、操作画面を LAN 公開している場合も管理操作の接続元検査を省略しない。

停止処理を外部操作のコミットと同じ制御列に載せ、無効化を確定してから後続の操作を拒否する。全 arm、プレビュー、未実行の要求を破棄し、認証済み HTTP には `503 {ok:false,code:"DISABLED",message:"External control is disabled"}` を返す。listener はループバックに残してこの応答を可能にする。既にコミット済みの操作は巻き戻さない。

既存 WS には可能なら `{type:"error",payload:{ok:false,code:"DISABLED",message:"External control is disabled"}}` を送って close `4003`、新規 upgrade は 503。トークン取り消し時は該当 WS を close `4001` とし、新規 HTTP / upgrade は 401。close reason に機器名・トークン・引数は入れない。通知前に切断される場合もあるので、close code だけで結果を推測しない。

再有効化はこの PC の SETUP で明示的に行う。停止後の自動復帰はない。有効化状態は保存し、通常のアプリ再起動だけでは停止状態を解除しない。トークンは停止だけでは取り消さない。

メイン画面に外部操作の有効・無効、接続中の機器数、機器名を表示する。WS と直近 30 秒以内の認証成功 HTTP を活動中と数え、同じトークンの複数接続は機器 1 台とする。「登録済み」と「活動中」を区別し、HTTP だけの機器も表示できるようにする。この管理情報は外部 state に含めない。

プラグインの停止・クラッシュ・WS 切断・認証期限切れで、音声状態は何も変えない。ミュート解除、TX 開始・停止、録音停止、フェーダー復元、ロック解除などの自動操作は一切行わない。外部操作の停止ボタンも音声を停止するボタンではなく、以降の外部制御を遮断するもの。音声の一発停止には既存の緊急ミュートまたは `tx.clear` を使う。

## 12. 流量制限・記録・Support Bundle

推奨値を v1 の既定とする。数値は `/info` の limits でも広告する。機器はサーバーが広告する上限以下で送る。

| 対象 | 制限と超過時の扱い |
| --- | --- |
| 機器の通常 POST | actions / arm / execute 合計で token bucket 20 要求/秒、burst 20。超過は 429、実行・キューイングしない |
| 同一フェーダーの A の上昇 | 機器ごと・対象ごとに +20 dB/秒、burst +10 dB。第 7 節の `max(0,targetDb-max(currentDb,-40))` を adjust / set で共有して計上。床以下と下げる操作は消費せず、超過は 429。確認済み B の大幅 set はこの dB 枠の対象外だが、通常 POST 枠は適用 |
| 安全方向の予約枠 | `emergency.set(active:true)`、`tx.stop`、`tx.clear`、`settings.lock.set(locked:true)` は通常枠が枯渇しても別枠 5 要求/秒、burst 5 で受け付ける。無効化・認証・既存安全検査は共通 |
| GET と WS 購読変更 | 機器ごと合計 10 要求/秒、burst 10。メーター配信そのものは購読 Hz で制限 |
| 全体の実行要求 | 全機器合計で通常 100 要求/秒、burst 100。予約枠は別に合計 20 要求/秒、burst 20 |
| 未認証・認証失敗の要求 | listener 全体で 10 要求/秒、burst 20。超過は 429、ログを増幅しない。認証済みの正当な機器の 20 要求/秒枠とは分離し、この枠を正常接続の上限にはしない |

429 は `Retry-After` に切り上げた待ち秒数を返す。クライアントは待った後に新しい状態と意図を確認し、滞留した長押しステップをまとめて送らない。通常枠が残れば安全方向の操作はまず通常枠を使う。予約枠でも過剰要求を無制限には通さない。受理処理は直列化し、並列要求を使って上限や B の時間検査を迂回できないようにする。

外部操作は operational log に、時刻、機器の名前と `deviceId`、外部操作名、段階 A / B / C、処理段階（`action` / `arm` / `execute`）、結果（`SUCCESS` またはエラーコード）、`requestId` を残す。未知操作の拒否は段階 C として記録する。通常操作の成功・失敗を追跡できるようにし、生の request、Authorization、トークン、hash、`armId`、`previewId`、参加者表示名を記録しない。再送は元の結果と重複排除した旨を記録し、実行回数に重ねて数えない。既存 logger が追加フィールドを保持しない場合も、安全な固定形式の message にして必要情報を失わない。

認証失敗は IP や送信されたトークンをキーに無制限に記録せず、listener 全体で最初の 1 件と以後 60 秒ごとの抑制件数だけを残す。流量制限拒否も機器ごと 60 秒の集計にまとめる。古いクライアントの再接続でログが増え続けないようにする。機器名は登録時に正規化し、ログ改行や UI 注入を防ぐ。

Support Bundle の外部操作情報は **`{deviceCount:number,enabled:boolean}` だけ**。deviceCount は取り消していない登録機器数であり、接続数や名前の配列は含めない。機器名、deviceId、権限、トークンの平文とハッシュ、arm / preview、直近操作履歴、接続元を追加しない。operational log / console log の Bundle 出力からも外部操作の機器情報と個別履歴を除外する。単にトークンの文字列をマスクする方式に頼らず、設定ファイルは Bundle の入力 allowlist に加えず、公開 projection を固定する。

## 13. エラーと HTTP ステータス

HTTP のエラーボディは `{ "ok":false, "code":"STALE_REVISION", "message":"Related state changed; refresh before retry" }` を基本形とする。toggle の現在値不一致では、同じ形に `"current":{"mute":true}`（値は現在の boolean）を追加して必ず返す。機器はこれで表示を訂正できる。他のエラーでは current を省略し、snapshot 全体は返さない。`message` は人向けの安全な説明で、クライアントの分岐には安定した `code` を使う。内部例外・パス・秘密・Discord の生応答は出さない。WS 購読エラーも同じオブジェクトを payload に使う。HTTP 解析自体が成立しない通信は接続を閉じてよい。

| HTTP | `code` | 意味 |
| --- | --- | --- |
| 400 | `INVALID` | 不正 JSON、未知フィールド、範囲外、未定義の操作・経路・メソッド、A を arm など |
| 401 | `UNAUTHORIZED` | Bearer 欠落、不正、取り消し済み。`WWW-Authenticate: Bearer` を返す |
| 403 | `HOST_FORBIDDEN` | Host / 接続元の検査失敗 |
| 403 | `ORIGIN_FORBIDDEN` | ブラウザ要求、Origin / Fetch Metadata / preflight の拒否 |
| 403 | `TIER_FORBIDDEN` | C、未分類の内部命令、該当 B 権限なし |
| 404 | `NOT_FOUND` | 許可された操作の対象がない・オフライン・送り先未設定 |
| 409 | `CONFIRMATION_REQUIRED` | B を actions で要求。arm からやり直す |
| 409 | `ARM_TOO_EARLY` | 最短時間に達していない。arm は消費される |
| 409 | `ARM_INVALID` | 不明・別機器・消費済み arm |
| 410 | `ARM_EXPIRED` | 正しい機器の arm が期限切れ |
| 409 | `LOCKED` | ON_AIR、FAULT、緊急ミュート、デバイス準備、録音状態などによる拒否 |
| 409 | `STALE_REVISION` | 起動 ID、対象自身の expectedMute、対象世代、TX targets revision、emergencyEpoch、シーン差分など操作の依存関係の競合。全体の公開 revision の差だけでは返さない。mute 不一致は current.mute を含める |
| 413 | `INVALID` | ボディ・WS メッセージの 16 KiB 超過 |
| 415 | `INVALID` | JSON 以外の Content-Type、非対応の Content-Encoding |
| 429 | `RATE_LIMITED` | 流量、接続数、重複排除キャッシュ容量の超過 |
| 503 | `DISABLED` | 外部操作が無効化・停止済み |
| 503 | `UNAVAILABLE` | 必要な backend がない・利用不可 |
| 500 | `INTERNAL` | 未分類の内部失敗。安全な固定文だけを返す |

判定順は、接続元 / Host / ブラウザ拒否、認証（失敗時は未認証枠）、外部操作の有効化、機器流量制限、入力の形と操作名の検証、重複排除、引数・現在状態による権限分類、確認・操作別の依存関係・対象・既存安全検査、実行とする。認証しない相手には無効化状態や対象の存在を返さない。キャッシュ済みの B 結果も現在の該当権限を再確認してから返す。`tx.take` とフェーダー set は認証済み state と引数から必要な段階を判定し、A の場合に B 権限を要求しない。B と判定したら対象の詳細エラーより先に該当権限を検査する。execute では認証・有効化の後に arm の所有者と権限を再確認する。C の既知の内部命令名を送った場合も実行せず `TIER_FORBIDDEN` とする。

既存 `CommandResult.code:"STALE_STATE"` は `STALE_REVISION` に変換する。既存の `confirmationRequired` は確認が欠けた場合だけ `CONFIRMATION_REQUIRED` に対応させる。ロック、対象欠落、backend 不在などは実装で型付きの判定に分け、内部日本語エラー文の部分一致だけで外部コードを決めない。今回その実装は変更しない。

## 14. 版と機能の発見

`GET /external/v1/info` は通常の成功 envelope の `data` に以下を返す。無効時も認証後は `DISABLED` とする。

```json
{
  "apiVersion": "1.0",
  "paraBusVersion": "0.1.0",
  "features": ["state.ws", "meters.subscribe", "confirmation.armExecute", "fader.relative", "fader.absolute", "participants.slot", "participants.user", "tx.targets"],
  "operations": [
    { "name": "channel.fader.adjust", "tiers": ["A"] },
    { "name": "channel.fader.set", "tiers": ["A", "B"] },
    { "name": "bus.fader.set", "tiers": ["A", "B"] },
    { "name": "send.fader.set", "tiers": ["A", "B"] },
    { "name": "tx.fader.set", "tiers": ["A", "B"] },
    { "name": "tx.take", "tiers": ["A", "B"] }
  ],
  "limits": {
    "maxBodyBytes": 16384,
    "actionRatePerSecond": 20,
    "actionBurst": 20,
    "faderMaxIncreaseDb": 6,
    "faderIncreaseFloorDb": -40,
    "faderIncreaseDbPerSecond": 20,
    "faderIncreaseBurstDb": 10,
    "minimumHoldMs": 1000,
    "armExpiresMs": 5000,
    "maxMeterHz": 10,
    "maxMeterSources": 32,
    "maxWsPerDevice": 2,
    "deduplicationMs": 60000
  },
  "permissions": { "allowedTierBOperations": [], "readDisplayNames": false }
}
```

これは形の例であり、`operations` は第 6 節の全対応操作を 1 操作 1 要素で返す。`.adjust` / `.set` なども個別に列挙する。`tiers` は取り得る段階で、全 4 系統のフェーダー set は A / B、adjust は A とする。`faderMaxIncreaseDb` は床適用後の A の 1 回上限、`faderIncreaseDbPerSecond` と `faderIncreaseBurstDb` は A の連続操作用 dB 枠。B の大幅 set は第 7 節の例外を使う。permissions はこのトークンの許可である。`paraBusVersion` は実行中のパッケージ版を使い、例の値を固定しない。共通 envelope の `instanceId` も接続時に読む。未提供機能は feature と operations の両方から除き、要求には `INVALID` を返す。

v1 内の互換性変更は操作・任意レスポンスフィールド・機能の追加だけ。既存の意味、段階、安全上限、必須フィールド、エラーコードの意味を変える場合は v2 とする。クライアントは未知の応答フィールドや feature を無視し、未対応の操作を送らない。サーバーが未知要求フィールドを拒否することとは両立する。

## 15. 脅威モデル

| 対象とする脅威 | 対応 |
| --- | --- |
| CSRF・悪意あるブラウザページ | Cookie 認証なし、Bearer 必須、Origin / Fetch Metadata / CORS 拒否、ブラウザ WS 拒否 |
| DNS rebinding | ループバック固定 bind に加え厳密な Host 検査。DNS 名や転送ヘッダーを信頼しない |
| トークン漏えい | 一度だけ表示、hash のみ保存、URL 禁止、ログ・state・Bundle の allowlist、機器ごとに即時取り消し |
| 誤操作・古いボタン状態 | C の禁止、B の権限と確認、プレビュー、epoch / revision / 対象世代検査、最小 state |
| 長押し・連続操作の暴走 | 自走なし、上昇量と速度制限、重複排除、切断後キューを再生しない、一発停止 |
| 送りすぎ・再接続による負荷 | 機器・全体の流量制限、購読 Hz 上限、backpressure、認証失敗ログ集計 |

Node の fetch / WS 接続とブラウザページからの要求を混同しない。実 Node ランタイムの接続成功とブラウザ拒否の両方を試験し、自動ヘッダーの実態は第 1 節の未確認事項として確認する。Property Inspector はプラグイン本体を経由し、ブラウザへトークンを返さない。機器側の保存も、プロファイル・設定の書き出し経由の漏えいを防ぐ必要がある。Stream Deck の全体設定や Companion の秘密欄が本当に書き出し対象外かは未確認であり、プラグイン実装時に確認する。名前が「全体」「秘密」であることだけでは保護を保証しない。

**対象外:** 同じユーザー権限で動く悪意あるローカルプロセス。このプロセスはプラグインの設定に保存したトークンやプロセスメモリを読める可能性がある。ループバックと Bearer は OS 内の同一ユーザーを隔離しない。トークンを盗んだプロセスは当該機器になりすませるし、B の待ち時間も人の意思の証明にはならない。OS の侵害や同一ユーザー内のプロセス隔離を本 API の保証範囲に含めない。

## 16. 将来の拡張

以下は設計の置き場所だけを確保し、v1 の機能・要求フィールドには含めない。

- LAN: 別の接続ポリシーとしてトークンごとの「LAN 可」、IP 許可リスト、通信の保護を定義する。
- ブラウザ（HTML）: 別の browser access ポリシーとして CORS の許可リストを定義する。
- TX ルーティング: ParaBus 内ミックスを TX ソースにするモデルと、「音 × TX Bot」の表を定義する。

## 17. 未決事項

未実装であるため次の製品・実装判断は未確認であり、実装 PR のレビューで確定する。プラグインが依存する操作名、対象指定、権限、安全検査、確認の意味は本書で固定し、未決を理由に緩めない。

| 未決事項 | 推奨案 |
| --- | --- |
| 既定ポート 4175 の配布環境での競合 | 4175 を採用し、SETUP に実際の URL と bind 失敗を表示する。自動的なポート探索はしない。機器側は URL を編集可能にする |
| 外部機器登録ファイルの配置と OS 保護 | 既存の settings root 配下に専用ファイルを置き、OS で当該ユーザーのみ読み書き可能にする。hash とメタデータだけを保存し、Bundle と release の収集対象外にする |
| ローカル SETUP の機器管理画面の配置・文言 | 接続する機器、B の操作別許可、表示名の許可、取り消しを 1 画面にまとめる。メイン画面には停止と活動中機器だけを常時表示する |
| 20 要求/秒、A の上昇 20 dB/秒・burst 10 dB、メーター 10 Hz の実負荷 | 床 -40 dB と B の大幅 set を含め、本書の既定値でシミュレーター負荷試験を行う。初回 v1 リリース前に必要なら本書と info を同時修正し、リリース後は黙って変更しない |
| 現行の文字列中心の内部拒否理由の型付け方法 | 外部公開に必要なロック・対象欠落・backend 不在の判定を型付き結果へ整理し、第 13 節のコードへ安定して対応付ける。エラー文字列の解析は避ける |
| Stream Deck の Node 20 系・Companion の採用 Node 版と fetch / WS の自動ヘッダー | プラグイン実装時に版と WS 実装を固定して実測する。Bearer を付与でき、ブラウザ用 Origin / Sec-Fetch-Site を送らない構成で接続試験する |
| 機器側の全体設定・秘密欄とエクスポートの実際の範囲 | プラグイン実装時に実際の書き出しで確認する。トークンが含まれる保存先は使わず、Property Inspector と共有設定へ返さない |

## 18. 実装 PR で必要なテスト

今回はテストコードを追加しない。実装 PR では実 Bot・音声機器を使わない単体・統合試験を基本に、以下を必須とする。

1. `ControlCommand` 全 type の分類網羅、引数分岐、既定拒否、外部操作 allowlist。命令追加時の未分類をコンパイルまたはテストで検出する。C と管理 HTTP、`confirmed` の注入を拒否する。
2. 外部無効が初期値、SETUP のローカル認証、機器登録、一度だけの表示、hash のみ保存、機器単位失効、権限変更、再発行。操作画面 nonce と外部トークンの相互流用を拒否する。プラグイン側では実際のプロファイル・設定書き出しにトークンが含まれないこと、Property Inspector の直接 API 接続がなく、本体経由でもトークンを返さないことを試験する。
3. 127.0.0.1 以外へ bind しないこと、操作画面 LAN ON/OFF の独立性、bind 失敗時の非公開、Host 欠落・重複・DNS 名・転送ヘッダー、非ローカル接続拒否。
4. CSRF、DNS rebinding、Origin `null` / ローカル / 外部、Sec-Fetch-Site、simple request、preflight、ブラウザ WS、query / subprotocol / Cookie 認証を拒否する。一方で Sec-Fetch-Mode 単独は拒否せず、Stream Deck の実 Node 20 系、Companion の採用 Node ランタイムで、実際の fetch と採用 WS クライアント（ヘッダーをモックしない）から Bearer 付き HTTP / WS 接続が成功することを検証する。Node 22.23.4 のサーバーとの組み合わせで、自動付与ヘッダー・preflight の有無・Authorization 送信を確認し、Node / WS 実装の版と観測結果を記録する。
5. A 全操作の入力と内部マッピング、B の操作別権限、A/B 分岐、既存 STRUCTURAL_COMMANDS、FAULT、READY、緊急ミュート、silent stream、presence monitoring の検査を維持する。
6. B の 999 / 1000 / 4999 / 5000 ms 境界を注入した単調時計で試験。使い捨て、別機器、改変、二重 execute、別 requestId、同じ requestId、再 arm、失効、停止、再起動、WS 切断を検証する。
7. 全 4 系統のフェーダーで床 -40 dB の計算、-90 → -40 の計上 0、-90 → -34 の計上 +6、+6 境界、adjust 超過の INVALID、set 超過の B 分類・権限・確認を検証する。「0 dB に戻す」が B execute で成功し、burst 10 dB で永久拒否されないこと。A の毎秒 +20 dB・burst +10 dB、1 dB / 50〜100 ms の継続成功、adjust / set の共有枠、床以下と下降で枠を消費・回復しないこと、同時並列の超過を検証する。相対下降の量制限なし、-90〜+12 dB の飽和、絶対値の範囲、非有限数、Send 不在、mute と承認ゲート保持も確認する。
8. 参加者・Bus・Send の toggle に必須の expectedMute、一致時だけの反転、不一致時の STALE_REVISION と current.mute、同じ値への set の冪等性を検証する。expectedRevision の省略・指定・古い参照値にかかわらず、別フェーダーの変更や無関係な参加者の入退室があっても toggle と B execute が成功すること。反対に B の該当依存関係・自身のフェーダーの変更では拒否すること。旧 instanceId、入退室・再入室・VC 移動、slot の expectedParticipantsRevision とスコープ、同順位、固定ユーザーのオフライン、対象削除・同 ID 再作成と ABA を検証する。toggle の boolean 比較と、B の依存世代比較の違いも確認する。
9. TX の profiles / destinations / allTeams、未設定・重複、TEAM 0 / 1 / 複数、INTERVIEW / SPARE、空アーム、1 対象 A、複数または全 TEAM B、targetsRevision、Bot・入力変更、緊急ミュート・FAULT 拒否、グループ失敗時停止、CLEAR_ALL と個別停止の違い。
10. シーン preview / recall、表示名の秘匿、previewId の期限・所有者・内容変更、Recall Safe、除外対象、既存パラメーターロック。preview → arm → execute の差分が変われば STALE、差分に関係のない変更なら成功すること（秘匿した実値も比較）。録音の選択固定・対象消失・二重開始・停止処理中・保存失敗と、未選択参加者の入退室で確認が失効しないこと。
11. 外部 state の厳密なフィールド allowlist と名前の opt-in、GET / WS の一致、公開 revision の独立性、メーター購読上限、対象消失、再購読、backpressure、heartbeat と接続数制限。
12. 一発停止と実行が競合しても停止確定後にコミットしないこと、HTTP 503 と WS close、arm / 待ち要求の破棄、再起動でも停止維持、明示再有効化、機器表示の重複排除と HTTP 活動判定。
13. 機器・全体・未認証の流量と安全方向の予約枠、正常機器の 20 要求/秒を未認証枠で拒否しないこと、429 / Retry-After、重複排除 60 秒と容量、無効化・失効後のキャッシュ、切断後の自走・自動復元・キュー再生がないこと。
14. operational log の機器名・段階・結果と注入耐性、認証失敗の 60 秒集計、平文・hash・arm の非記録。Bundle のファイル allowlist とログ経由の漏えい、外部情報が機器数と有効・無効だけであること。
15. 全エラーの HTTP 対応・安全な message、内部 STALE_STATE 変換、unknown fields と JSON サイズ、info の実版・完全な操作一覧と機能発見、v1 の既存クライアントとの互換性。
16. release manifest の通常版・source 版の両方に本書が含まれること。指定 Node と既存の全自動テストで回帰確認する。

## 19. 現状調査

以下は `d6de003f350a9e22733c1dbc4928811704b4a6b5` のコードを読んだ根拠である。行番号はその commit のもの。リンクはリポジトリ内ファイルへ向け、`file:line` を併記する。外部 API の新設計を「実装済み」と裏付けるものではない。Bot 接続、音声機器の稼働、run ディレクトリの変更による確認は行っていない。

| 確認した現行の事実 | 根拠 (`file:line`) |
| --- | --- |
| ControlCommand の全定義、内部結果の STALE_STATE | [packages/shared-types/src/index.ts](../packages/shared-types/src/index.ts):660–724 |
| 操作画面 POST と HTTP 応答、WS upgrade と最初の desktopSnapshot | [services/router-core-sim/src/server.ts](../services/router-core-sim/src/server.ts):454–458, 500–536 |
| DEVICE_LOST / INPUT_DEVICE_LOST は操作画面の外部入力から拒否。既存サーバー経路は silent stream を検査し、成功時に scene store 等を更新 | [services/router-core-sim/src/server.ts](../services/router-core-sim/src/server.ts):128–158 |
| 起動 nonce 生成、Origin と nonce の検査、ローカル接続元・Host の判定、操作画面 LAN bind | [services/router-core-sim/src/desktop-control-auth.ts](../services/router-core-sim/src/desktop-control-auth.ts):10–45, 60–73; [services/router-core-sim/src/server.ts](../services/router-core-sim/src/server.ts):207–219, 313–315 |
| GET /api/state は Host 検査後に nonce なしで desktopSnapshot を返す。これは現状記録だけで、今回変更しない | [services/router-core-sim/src/server.ts](../services/router-core-sim/src/server.ts):310–332 |
| desktopSnapshot は profiles、sessions、Discord、system、Rust、health 等を統合。Tablet は保持中の試作品 | [services/router-core-sim/src/server.ts](../services/router-core-sim/src/server.ts):160–174, 187 |
| 認証失敗を現行では要求ごとに記録する | [services/router-core-sim/src/server.ts](../services/router-core-sim/src/server.ts):207–213 |
| ON_AIR の STRUCTURAL_COMMANDS の一覧と追加、実行入口での拒否。全 B が ON_AIR で可能なわけではない | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):26–33, 169–174 |
| フェーダー / Send / TX master の数値範囲、コンプ各値の範囲、epoch / targets revision の型検査 | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):54–97 |
| 参加者フェーダーと mute の保存、Send の暗黙既定値・Group Bus 拒否 | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):178–202 |
| Bus ID の手動生成と衝突回避 | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):314–329 |
| リミッター解除は SETUP のみ、ラウドネスリセット、PFL | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):444–460 |
| 緊急ミュート解除には confirmed、READY、デバイス回復、expectedEmergencyEpoch が必要 | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):482–498 |
| シーン preview、呼び出しの確認と差分、UUID 発行、適用時の FAULT 拒否と Recall Safe / パラメーターロック | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):517–543, 847, 921–988 |
| 保存済みシーンの ID 読み込みは UUID に限定せず、1〜128 文字の文字列を受け付ける | [services/router-core-sim/src/scene-store.ts](../services/router-core-sim/src/scene-store.ts):19–28 |
| TX master は FAULT で拒否、入力変更は ON_AIR / FAULT で拒否、アームの revision、緊急ミュート / FAULT で開始拒否、個別開始停止・録音の確認 | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):575–649 |
| 設定ロックは独立フラグではなく ON_AIR 遷移。出力・入力・presence・リミッターを検査、FAULT 脱出は別途確認が必要 | [services/router-core-sim/src/control-plane.ts](../services/router-core-sim/src/control-plane.ts):808–832; [services/router-core-sim/public/app.js](../services/router-core-sim/public/app.js):2933–2937 |
| Bot ごとに TX ソース・master・ローカル入力を保存。入力割り当てで他 Bot の利用を排除しない。ステレオは隣接入力 | [services/router-core-sim/src/discord-ingest.ts](../services/router-core-sim/src/discord-ingest.ts):680–715 |
| 個別 START、profile 集合のアーム、全 TEAM 判定、2 対象以上または全 TEAM の確認、テイクとグループ開始失敗時の全停止 | [services/router-core-sim/src/discord-ingest.ts](../services/router-core-sim/src/discord-ingest.ts):738–798 |
| CLEAR_ALL はアーム解除と全停止。個別 STOP は live を消すが armed は消さない | [services/router-core-sim/src/discord-ingest.ts](../services/router-core-sim/src/discord-ingest.ts):801–845 |
| 送り先区分の 22 値、profile ID の形式、送り先の重複禁止と未設定 null | [packages/shared-types/src/index.ts](../packages/shared-types/src/index.ts):7–9; [services/discord-adapter/src/bot-config.ts](../services/discord-adapter/src/bot-config.ts):83–95 |
| channel と自動 VC Bus の ID 形式、VC Bus のリンクと生成 | [services/router-core-sim/src/discord-ingest.ts](../services/router-core-sim/src/discord-ingest.ts):112–117, 1496–1510 |
| メーターの peak / rms は線形振幅で、clip は peak >= 1 | [services/router-core-sim/src/dsp.ts](../services/router-core-sim/src/dsp.ts):270–310 |
| ユーザープロファイルの永続キーと整列。ID は 17〜20 桁。再入室時に既存 profile を復元 | [services/router-core-sim/src/user-profile-store.ts](../services/router-core-sim/src/user-profile-store.ts):138–164 |
| セッションと現在の channel / VC、offline 化。再入室でも既存 sessionGeneration を再利用する場合がある | [services/router-core-sim/src/user-session-registry.ts](../services/router-core-sim/src/user-session-registry.ts):29–79 |
| 画面のオンライン全員の整列と VC ごとの表示。表示名は profile から取得 | [services/router-core-sim/public/app.js](../services/router-core-sim/public/app.js):1691–1701, 1714–1724 |
| 録音の明示 selection は outputs / busIds / channelIds。選択の検証と開始時の固定 | [packages/shared-types/src/index.ts](../packages/shared-types/src/index.ts):275–280; [services/router-core-sim/src/recorder.ts](../services/router-core-sim/src/recorder.ts):153–175 |
| operational log は既存イベントを sanitize して JSONL 保存し、任意の追加フィールドをそのままは保存しない | [services/router-core-sim/src/operational-log.ts](../services/router-core-sim/src/operational-log.ts):8, 32–53 |
| Bundle は raw snapshot ではなく projection。ログも許可した診断メッセージへ変換するため、将来の外部情報も明示的な除外が必要 | [services/router-core-sim/src/support-bundle.ts](../services/router-core-sim/src/support-bundle.ts):26–72; [services/router-core-sim/src/support-bundle-worker.ts](../services/router-core-sim/src/support-bundle-worker.ts):39–44, 64–111, 146–164 |
| 終了・再起動は ControlCommand 外の HTTP。ローカル・nonce・確認・状態・録音を検査 | [services/router-core-sim/src/server.ts](../services/router-core-sim/src/server.ts):437–451 |
| docs は通常版で files と docs prefix、source 版で個別列挙。両方へ本書を登録する | [release/release-manifest.json](../release/release-manifest.json):16–17, 55–56, 77–79（変更前） |
| 指定 Node と標準全テスト、Rust / core-ipc、typecheck の実行方法 | [package.json](../package.json):16–26, 33–34; [.github/workflows/test-packages.yml](../.github/workflows/test-packages.yml):35–40, 69–75 |

本書で新設する外部専用の権限・確認時間・流量制限・revision・projection の保証は、この調査で現行実装の存在を確認したものではない。実装 PR は第 18 節で検証し、本書との一致を確認して初めて提供する。
