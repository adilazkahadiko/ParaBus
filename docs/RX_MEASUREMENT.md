# Discord RX の計測と第2段階の検討

## 今回の範囲

第1段階は計測・オフライン負荷テストだけで、音の修正ではない。
beta.4 (`ee56dfee4544b853f99b0520ca66d310817164ab`) から、40 ms の目標、30 ms の prefill、
80 ms の high water、120 ms の hard cap、補間・圧縮・quiet cut・ミックス・タイマーの作動条件を変更しない。
native バイナリ・依存ライブラリ・lockfile も変更しない。

背景にある「15分で2回ほど聞こえた途切れ」と、既存 Bundle の underrun 210 回は同じ指標ではない。
既存カウンターは話し終わりも数えるため、この210回を可聴の途切れと解釈しない。

## diagnostics の読み方

各 `discord.sources[].rxTiming` に次を追加する。既存の `underruns` は意味も値も維持する。

| 項目 | 意味 |
| --- | --- |
| `inSpeechUnderruns` | 不足した fill の直前・直後の accepted Opus packet が、ともに200 ms以内だった回数。境界200 msを含む。次の packet が来てから確定する |
| `endOfSpeechUnderruns` | 次の packet が200 ms以内に来なかった不足。話し終わり**候補**であり、長い通信停止も含む |
| `pendingUnderruns` | 次の packet を待つ未確定分。snapshot / fill / packet 観測時に200 ms超過を確定する |
| `unclassifiedUnderruns` | 固定256件の未確定領域を超えた観測。音の処理は続け、欠測を隠さない |
| `recentInSpeechUnderruns` | 話中不足の最近50件。`at` は不足時刻（UTC）、`previousPacketAgeMs` / `nextPacketDelayMs` は前後の間隔、`queuedBeforeMs` は不足した読み出し直前、`queuedAfterPacketMs` は次の packet の PCM enqueue 完了後の queue。decode 失敗時は到着時点の queue |
| `packetJitterWindows` | accepted Opus の到着間隔について `abs(interval - 20 ms)` の1分窓。decode 前に一度だけ観測。PCM enqueue の通知を二重計上しない |
| `fillJitterWindows` | `DiscordPcmSource.fill` 呼び出し間隔について `abs(interval - blockSize/sampleRate)` の1分窓。既定の基準は10 ms。prefill・無音・catch-up中も含め、内部の圧縮用読み出しは二重計上しない |
| `jitterResolutionMs` | 分位値のビン幅（1 ms、ビン上端と窓の最大値の小さい方）。1000 ms超の overflow bin はその窓の最大値で表す |
| `packetJitterExcludedGaps` | 200 msを超える packet 間隔を jitter 分位値から外した回数。最初の packet も分位値には入れない |

両方の jitter 窓は最近30分を保持し、それぞれ `startedAt` / `durationMs` / `samples` /
`p50Ms` / `p95Ms` / `p99Ms` / `maxMs` を持つ。集計途中の窓も返す。長い無音を到着 jitter と混ぜない。
到着バースト内の0 ms間隔は20 msのずれとして数える。符号付き偏差やネットワーク遅延ではない。
音の hot path は固定容量の領域への数値記録だけで、Date・履歴配列・分位値の生成は snapshot 時に行う。
新しい履歴は full diagnostics のみへ出し、既存の軽量 snapshot は話中累計だけを持つ。

これは音声認識ではない。200 ms以内の自然な短い間も「話中」に分類され得る。
回数の単位は既存の不足 fill で、途切れの長さ・聴感上のイベント数ではない。
prefill で待ったブロックは不足 fill として追加しない。履歴・カウンターの寿命は受信 source の世代まで。

operational log は1秒ごとの既存 health 観測で増分を集め、60秒以上ごとに最大1行だけ
`RX in-speech underruns: count=N` を出す。話中の増分がない分は出さない。
全体の `discord.rxDiagnostics.inSpeechUnderruns` は退室した source も含む累計で、短時間で作成・破棄された
source の増分もログへ残す。名前・IDはこの要約自体に入れない。

Support Bundle は新項目を明示的な許可リストで投影し、履歴を50件・窓を30件に制限する。
新項目は日時と数値だけ。既存の source・参加者の関連付けは Bundle ごとの既存 HMAC 別名を使い、
表示名・Discord ID・その対応表・salt は書き出さない。数値だけの新ログ文法も許可する。

## オフライン負荷テスト

```powershell
target\review-pr1\node22\node.exe tests/rx-load/run.ts --seconds=65 --output=target\rx-load\results.json
```

Node 22.23.4 で、1・5・10・20人 × 次の3パターンを直列実行する。既定は各65秒（合計約13分）。
通常の `tests/*.test.ts` には含めない。5～300秒を指定でき、結果の出力先は target 配下だけ。
各ケースは別プロセスで decoder を作り直す。native decode の100 packet分を各人で warmup し、
測定から除く。ミックスの初回処理は含める。

| パターン | packet 10個の配送予定時刻（ms、200 ms周期） | 設計上の正方向の間隔ずれ p95 |
| --- | --- | --- |
| `steady` | 0,20,40,60,80,100,120,140,160,180 | 0 ms |
| `measured-like` | 0,20,40,100,100,100,120,140,160,180 | +40 ms |
| `burst-100ms` | 0,20,40,160,160,160,160,160,160,180 | +100 ms（120 msの空き、最大6 packet同時配送） |

実際の到着時刻には OS / event loop / decode の遅れも乗る。表の p95 は入力予定の正方向のずれであり、
diagnostics の絶対値 histogram とは定義が異なる。各人の配送時刻をそろえ、同時バーストを負荷にする。
実測に近い振幅の合成パターンであり、Bundle の queue p95 を packet 間隔 p95 と見なした再現ではない。
周期が一定なので、現行 playout が最初の不足の後に厚い queue で安定する場合がある。
これだけで、まれな途切れの頻度や実 Discord の DTX・自然音声・長時間動作は再現できない。

経路は fixture Opus → `DiscordIngestServer.ingest` の既存 RX gate → 本物の `@discordjs/opus` decoder →
`DiscordPcmSource` → 承認済み `AudioChannel` → VC Bus → matrix の PCM 出力。
Bot / IPC listener / PortAudio / Rust device 管理は開始しない。受信メタデータもメモリ内の模擬データだけ。
無音で負荷を省略していないことを、非ゼロかつ有限の出力で検査する。

`eventLoop` は Node の `monitorEventLoopDelay(resolution:1)` の p99 / max（ms）。
これは1 ms timerの観測遅延で、decode 時間や「10 ms締切からの超過」と同じ量ではない。
`decode` は native wrapper 1 packet の同期呼び出し時間の p50 / p95 / p99 / max、
`processBlock` は実ミックス1ブロックの同じ分位値。分位値は測定区間の実サンプルから計算し、分位値を平均しない。
人数分の総 packet 数が本物の decoder に入ったこと、decode error 0、分類領域の欠測0を確認する。
最後に201 ms待って終端候補を確定するが、この待ち時間は event-loop / decode の測定には含めない。
意図的に起こす underrun や overflow の件数自体はこの第1段階の失敗条件にしない。

## PCM の不変性

変更前 beta.4 の `discord-pcm-source.ts` から、3人・12,000ブロック（2分相当）・2出力の基準を生成した。
slow sender の展開、圧縮、quiet PCM、バースト、overflow、無音、clear を含み、混合した Float32 PCM の SHA-256 は
`3a3fc5bb5b339dcd3c45060daabb6ca8570c532e37a1fe686ff310e9177738f4`。
`tests/helpers/rx-pcm-trace.ts` と `tests/rx-observations.test.ts` で、計測を通した結果との完全一致を検査する。
既存の補間・prefill・タイマー・ring・native fixture のテストも維持する。

## 第2段階の設計案（未実装）

以下は今回の測定で優先度を判断するための案。値は確定した製品仕様ではない。

### ためる量の調整

最初の候補は初期60 ms、最小40 ms、最大100 ms、20 ms刻み。hard cap は120 msを維持する。
直近の到着・fill jitter の p99 と話中不足の有無から次の目標を選び、200 ms超の packet の切れ目で
次の話を開始するときだけ変更する。話の途中で増減・PCM の挿入や切り捨てはしない。
候補式は `clamp(ceil20(20 + arrivalJitterP99 + fillJitterP99 + 20), 40, 100)`。
少ないサンプルだけで縮めず、連続した安定窓と次の話の切れ目を待つ。
100 ms級の空きは上限だけで必ず吸収できるとは約束せず、残る不足は次の補間案と併せて評価する。

### 不足瞬間の補間、PLC / FEC

[Opus decoder API](https://opus-codec.org/docs/opus_api-1.5/group__opus__decoder.html) では、
PLC は欠落を示す NULL/0 と欠落時間に一致した frame size、FEC は `decode_fec=1` を使う。
FEC は次 packet の冗長情報と追加の待ち時間が必要で、Discord から対象情報が来るかは未確認。
sequence gap 0 の到着遅れに、FEC がそのまま解決策になるとは判断しない。

固定依存 `@discordjs/opus@0.10.0` の同梱ソース・型定義を確認した。
`decode(Buffer)` は `opus_decode(..., MAX_FRAME_SIZE, 0)` 固定で、`MAX_FRAME_SIZE` は5760。
frame size / FEC の引数を JS API から選べず、現行 ParaBus wrapper も960 samplesだけを受け付ける。
既存 native に空 Buffer を渡すオフライン確認では5760 samples（120 ms）が返り、production wrapper は拒否した。
返った120 msを20 msへ切って採用すると decoder の状態を進め過ぎるため採らない。
現状の API で正しい20 ms PLC / FECを使えるとは扱わず、必要なら別PRで binding の契約・native 再検証を行う。
今回 native や依存の変更はしない。開発用 `opusscript` への production fallback も追加しない。

最初の補間評価は20 ms単位、連続最大40 ms程度。無音・話し終わりを延ばさない条件、遅れて届いた実 packet と
decoder 状態の扱いを先に決める。単純な波形反復の採用は未決とし、実音声の聴感と録音で比較する。

### decode を別スレッドへ移すか

packet あたりの decode と event loop / processBlock を分けて判断する。
人数増加で event loop の締切超過が継続し、profile で同期 decode の集中に起因すると確認できたときに検討する。
候補の判断基準は20人で decode のバースト処理 p99 が3 msを超える、または10 msブロックの締切超過が反復すること。
今回の packet 単位の p99 に人数を掛けた値を、実測のバースト p99 と呼ばない。
worker に移す場合は source ごとの decoder 状態・順序・世代を守り、転送 queue と遅延を有限にする。
worker が遅れたときに古い音を無制限に再生しない設計とし、その通信コストも別途測る。

### 遅れの上限と合格基準の候補

- ローカルの packet 受理からミックス出力までを、p99 120 ms以下・最大140 ms以下にする案。
  queue の120 ms上限に、最大20 msの処理・スケジューラ余裕を見込む。Discord のネットワーク区間とOS・機器の出力遅延は別測定。
  今回の queue / jitter 計測はこの遅延そのものの検証ではなく、第2段階で sample の出自を追う試験を追加する。
- 揺れなし・1～20人で話中 underrun 0、decode error / 非有限PCM / source誤結合 0、余分な遅延蓄積0。
- 実測に近い揺れで、第1段階に対し話中不足を増やさず、残った不足・PLC適用回数・欠落時間を分けて測る。
  聴感では少なくとも同一音源15分を反復し、途中の無音化・語頭欠けがないことを確認する。
- +100 msの揺れでは上限を守り、PLCは40 ms以内、古い音の再生・話し終わりの引き延ばし0。
  吸収し切れないケースを隠さず記録し、短い65秒試験だけで本番合格にしない。
- 20人の実時間負荷試験を最低15分、別途録音を含む実機確認を実施。decode / mixer の p99 が10 ms以内、
  event loop の10 ms超の停止を反復させず、発生した最大値は原因とともに評価する。

根拠となる実装は `audio-timing.ts`（計測）、`discord-ingest.ts`（decode前到着・enqueue後queue）、
`discord-pcm-source.ts`（fill入口）、`support-bundle.ts` / `support-bundle-worker.ts`（投影・匿名化）。
native の調査箇所は固定npm packageの `src/node-opus.cc` の `Decode`、`src/node-opus.h` の `MAX_FRAME_SIZE`、
`typings/index.d.ts` の `decode`、同梱 `deps/opus/include/opus.h` の `opus_decode` 契約。

## 今回の負荷測定結果

2026-10-28、Windows x64 / Node 22.23.4 / 同一PCで各65秒を1回ずつ直列実行した。
他のテストは同時実行していないが、デスクトップの他プロセスまで隔離した測定ではない。
1・5・10・20人の4条件で、計351,000 packetの全件が native decoder を通った。
全ケースで decode error / droppedSamples / unclassifiedUnderruns は0。

| 人数 | 揺れ | event loop p99 / max ms | 話中不足（全員合計） | decode / packet p99 / max ms | mix / block p99 / max ms |
| --- | --- | --- | --- | --- | --- |
| 1 | steady | 2.879 / 4.334 | 0 | 0.0647 / 0.1451 | 0.123 / 2.195 |
| 1 | measured-like | 2.511 / 4.139 | 1 | 0.0610 / 0.1857 | 0.128 / 2.035 |
| 1 | burst-100ms | 2.734 / 4.227 | 1 | 0.0595 / 0.2229 | 0.124 / 2.128 |
| 5 | steady | 2.798 / 4.159 | 0 | 0.0553 / 0.2771 | 0.343 / 4.024 |
| 5 | measured-like | 2.818 / 3.734 | 5 | 0.0491 / 0.2176 | 0.301 / 3.846 |
| 5 | burst-100ms | 2.839 / 3.985 | 5 | 0.0511 / 0.2309 | 0.310 / 3.928 |
| 10 | steady | 2.701 / 4.002 | 0 | 0.0450 / 0.3139 | 0.556 / 5.266 |
| 10 | measured-like | 2.720 / 3.781 | 10 | 0.0483 / 0.1722 | 0.549 / 3.253 |
| 10 | burst-100ms | 2.742 / 4.252 | 10 | 0.0491 / 0.2278 | 0.580 / 3.952 |
| 20 | steady | 2.769 / 5.095 | 0 | 0.0479 / 1.8707 | 1.011 / 4.739 |
| 20 | measured-like | 2.939 / 6.287 | 20 | 0.0415 / 0.2223 | 0.987 / 4.774 |
| 20 | burst-100ms | 2.806 / 6.898 | 20 | 0.0445 / 0.2632 | 1.015 / 5.084 |

今回の合成揺れでは、各人に最初の不足が1件出た後は queue が厚くなって安定した。
最初の1分窓の queue p95 は `measured-like` が60 ms、`burst-100ms` が120 msで、
到着揺れを吸収しても遅れが増えるトレードオフを確認できる。短時間の単一波形・規則的な配送であり、
実音声15分の2回の途切れや、自然な話の切れ目まで再現した結果ではない。

20人でも mix p99 は約1 ms、event-loop max は約6.9 msだった。
今回の条件では decode の別スレッド化を優先する根拠は弱く、まず実使用で新しい話中カウンターと
到着/fillの窓を収集し、話の切れ目での目標量と遅延上限を調整する検証を優先する。
PLCは残る短い不足の候補だが、現行bindingの契約では採用できず別途の検証が必要。
20人の65秒試験から、112人や長時間・別PCでの余裕を保証しない。

検証は Node 22.23.4 の通常テスト495件中491成功・4skip・失敗0、TypeScript型チェック成功。
新テストでは200 ms境界・終端・50件保持・30分窓・IPC/PCM通知の二重計上防止・退室後の全体累計・
分単位のログ抑制・Bundleの許可リストと匿名化・変更前PCMとの完全一致を確認した。
生の負荷結果・全テストログ・native PLCプローブは実行時の `target/rx-stage1-20261028-231709/` に保存した。
