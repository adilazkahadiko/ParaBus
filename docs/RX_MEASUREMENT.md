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
| `jitterResolutionMs` | 分位値のビン幅（1 ms、ビン上端と窓の最大値の小さい方）。250 ms超の overflow bin はその窓の最大値で表す。記録の `maxMs` 自体は250 msで切らない |
| `packetJitterExcludedGaps` | 200 msを超える packet 間隔を jitter 分位値から外した回数。最初の packet も分位値には入れない |

両方の jitter 窓は最近30分を保持し、それぞれ `startedAt` / `durationMs` / `samples` /
`p50Ms` / `p95Ms` / `p99Ms` / `maxMs` を持つ。集計途中の窓も返す。長い無音を到着 jitter と混ぜない。
到着は本体で accepted Opus を処理し始めた時点の値。ネットワークだけでなく、Bot側の中継・IPCへの受け渡し・
本体のevent loopの待ちも含む。2フレームをまとめて渡した場合の間隔はほぼ0 msになり、20 msのずれとして数える。
符号付き偏差やネットワーク遅延を直接測る値ではない。
音の hot path は固定容量の領域への数値記録だけで、Date・履歴配列・分位値の生成は snapshot 時に行う。
`packetJitterWindows` / `fillJitterWindows` / `recentInSpeechUnderruns` は、必要時の診断取得
（既存の `GET /api/state`）と Support Bundle だけへ返す。1秒ごとの `broadcastState(true)`、
WS初回・操作後の状態送信では、この3項目の生成自体を省く。件数と既存の queue/output 履歴は維持する。
UIがこの3項目を参照していないことを確認し、回帰テストも追加した。

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
target\review-pr1\node22\node.exe tests/rx-load/run.ts --seconds=65 --seed=20261029 --output=target\rx-load\matrix.json
target\review-pr1\node22\node.exe tests/rx-load/run.ts --seconds=900 --seed=20261029 --case=20:realistic --progress --output=target\rx-load\long-20-realistic.json
```

Node 22.23.4 で、1・5・10・20人 × 次の3パターンを直列実行する。既定は各65秒（合計約13分）。
通常の `tests/*.test.ts` には含めない。5～900秒を指定でき、結果の出力先と模擬設定は target 配下だけ。
各ケースは別プロセスで decoder を作り直す。native decode の100 packet分を各人で warmup し、
測定から除く。ミックスの初回処理は含める。

| パターン | 人ごとに独立した配送モデル | 不規則な空き |
| --- | --- | --- |
| `realistic` | 通常の配送遅延15±7.5 ms。10%のpacketでさらに20 ms待つ中継を模擬し、順序を保ってまとめて届ける | 10～30秒の乱数間隔（平均20秒）で60～90 ms |
| `severe` | 通常の配送遅延15±15 ms。30%のpacketでさらに20 ms待つ | 6～18秒の乱数間隔（平均12秒）で90～120 ms |
| `regular` | 旧 `measured-like` と同じ0,20,40,100,100,100,120,140,160,180 msの200 ms周期 | 規則的な60 ms間隔（20 ms基準から+40 ms） |

seedはuint32で既定20261029。人ごとの乱数列を作り、さらに発話と配送の乱数列を分離する。
全パターンで発話2～8秒・無音0.3～3秒を繰り返し、最初の発話を0～3秒ずらす。
同じseedなら各人の発話予定はパターン間で同じだが、配送の揺れは人ごとに独立する。
旧 `steady` / `measured-like` / `burst-100ms` も `--case=人数:パターン` で選択できる。
OS / event loop / decode の遅れも到着時刻へ乗る。予定時刻どおりに受け取ったことにはしない。

`realistic` は実測のqueue p95約60 msを目安にした**仮説モデル**で、実際の配送時系列の再生ではない。
聴こえた「15分で2回」と `inSpeechUnderruns` は単位が異なり、その2回に乱数を合わせていない。
短い不足や200 ms以内の自然な間も計数され得るため、計測回数をそのまま可聴の途切れと呼ばない。

経路は fixture Opus → `DiscordIngestServer.ingest` の既存 RX gate → 本物の `@discordjs/opus` decoder →
`DiscordPcmSource` → 承認済み `AudioChannel` → VC Bus → matrix の PCM 出力。
Bot / IPC listener / PortAudio / Rust device 管理は開始しない。受信メタデータもメモリ内の模擬データだけ。
無音で負荷を省略していないことを、非ゼロかつ有限の出力で検査する。

本体と負荷テストは `desktop-state.ts` の状態生成関数を共有する。1秒ごとに本体と同じ
control・参加者・プロフィール・session・Discord・system・runtime・scheduler・operatorHealth等を生成し、
`{type:"state", payload:...}` を JSON.stringify する。Discordの既存履歴は `ingest.snapshot(now,true,false)` で含める。
新しい3種類の詳しい履歴は定期送信と同じく含めない。既定64出力、Main/Cue/inputは未選択の非物理backend、
録音はIDLE、Rust/shadowは無効、systemのネットワーク一覧は空として、実機I/Oなしで同じschemaを作る。
合計時間（snapshot生成・sanitize・health判定・JSON化）、JSON.stringify単独の時間、UTF-8 bytesを分けて記録する。
socketへの書き込みや物理出力の時間は含めない。

終了時の同一データに対し、旧送信形式（3履歴あり）と新形式を交互の順で100回ずつ生成・JSON化する。
双方のwarmupは10回。これを `pairedStateJson` に記録し、測定本体のevent loop等には含めない。
履歴ビン上限は両者とも250 msで、比較は送信内容を変えた効果を分けて見るものである。
`--state-mode=previous` なら測定中の1 Hz送信も旧形式にできる。

`eventLoop` は Node の `monitorEventLoopDelay(resolution:1)` の p99 / max（ms）。
これは1 ms timerの観測遅延で、decode 時間や「10 ms締切からの超過」と同じ量ではない。
`decode` は native wrapper 1 packet の同期呼び出し時間の p50 / p95 / p99 / max、
`processBlock` は実ミックス1ブロックの同じ分位値。分位値は測定区間の実サンプルから計算し、分位値を平均しない。
配送した総 packet 数が本物の decoder に入ったこと、decode error 0、分類領域の欠測0を確認する。
`inSpeechPerPerson15Min` は件数×900/(人数×実行秒数)で、無音も含むwall timeで換算する。
発話時間あたりの値でも、15分実行していないケースを15分観測した値でもない。
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

レビュー後の断続発話・乱数モデルでも、この数値範囲はA/B試験の候補として据え置く。
ただし、目標値だけを変えて話頭のprefillを30 msに固定したままにはせず、選んだ量を話頭のため直しにも反映する案とする。
10～30秒に一度の空きはpacket全体の1%未満になり得るため、上のp99式だけでは扱わず、
話中不足の発生・最近の実際の空きも補助条件にする。200 ms以内の自然な間を誤分類する可能性には注意する。
実測の「聴こえた2回」と合成テストの不足回数を直接対応付けて、初期80 ms等へ変更する根拠はまだない。
hard capを押したバーストで破棄が出ることも検証対象とし、queueを厚くするだけで改善済みとは扱わない。

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
  断続発話・15分の計測後もこの遅延予算は候補として据え置く。JSON生成時間やqueue量から達成したと推定せず、
  選択したprefillを含めてpacket受理→出力sampleの対応を追い、次のA/B試験で検証する。
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

## レビュー後の負荷測定（2026-10-29）

Windows x64 / Node 22.23.4、seed=20261029。20人・現実的900秒を1回、その後12条件を各65秒、
すべて直列で実行し、他のテストは並行実行していない。他のデスクトッププロセスまでは隔離していない。
13ケースで予定した937,241 packetすべてを実decoderに渡し、decode errorと計測欠測は0だった。
換算値は無音を含む1人・15分あたりの不足判定で、可聴の途切れの回数ではない。
「終端候補」も既存の不足fillに基づく値で、発話回数そのものではない。

| 人数 | 条件 | 秒 | 話中件数 / 人15分換算 | 終端候補 | loop p99 / max ms | 状態生成+JSON p99 / max ms | JSON bytes 平均 / 最大 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | realistic | 65 | 9 / 124.62 | 9 | 2.920 / 4.952 | 3.596 / 3.596 | 14839 / 15336 |
| 1 | severe | 65 | 11 / 152.31 | 9 | 2.912 / 5.218 | 3.860 / 3.860 | 14979 / 15459 |
| 1 | regular | 65 | 10 / 138.46 | 9 | 2.910 / 4.616 | 3.370 / 3.370 | 14801 / 15280 |
| 5 | realistic | 65 | 40 / 110.77 | 49 | 2.935 / 5.857 | 4.395 / 4.395 | 33541 / 34472 |
| 5 | severe | 65 | 52 / 144.00 | 49 | 2.914 / 5.218 | 3.809 / 3.809 | 34163 / 35295 |
| 5 | regular | 65 | 55 / 152.31 | 49 | 2.916 / 6.599 | 3.636 / 3.636 | 33340 / 34272 |
| 10 | realistic | 65 | 71 / 98.31 | 96 | 3.031 / 6.574 | 4.409 / 4.409 | 56240 / 57594 |
| 10 | severe | 65 | 112 / 155.08 | 96 | 2.998 / 6.468 | 4.687 / 4.687 | 57520 / 59488 |
| 10 | regular | 65 | 109 / 150.92 | 96 | 3.105 / 6.459 | 4.711 / 4.711 | 55929 / 57375 |
| 20 | realistic | 65 | 154 / 106.62 | 190 | 3.490 / 7.234 | 5.542 / 5.542 | 101626 / 104246 |
| 20 | severe | 65 | 243 / 168.23 | 190 | 3.529 / 6.849 | 4.802 / 4.802 | 104250 / 107854 |
| 20 | regular | 65 | 219 / 151.62 | 190 | 3.412 / 6.914 | 5.224 / 5.224 | 101048 / 103642 |
| 20 | realistic | 900 | 2187 / 109.35 | 2680 | 3.422 / 16.146 | 2.379 / 4.879 | 119821 / 138639 |

65秒の1 Hz JSON標本は64件なので、nearest-rankのp99は最大値に一致する。900秒の標本は899件。
20人・900秒のmix処理はp99 0.993 ms / 最大7.804 ms、packetのdecodeはp99 0.0536 ms / 最大1.0304 ms。
900秒の実発話予定は計約13,492秒（全員のwall timeの約75%）、発話は2,697回だった。

破棄はsevereの1/5/10/20人でそれぞれ2,840 / 12,409 / 29,278 / 55,314 samples、
900秒realisticで2,400 samples。それ以外は0。これは既存hard capの動作であり、音を改善する合格試験ではない。
特に900秒の結果を「途切れなし」と扱わない。

### 20人の旧・新送信形式の比較

同じ終了時データを100回ずつ交互に生成した比較。`previous` は詳しい3履歴を含む旧形式、
`periodic` は新形式。snapshotの生成も計る合計と、JSON.stringify単独の時間を分けた。
実時間の1 Hz試験は新形式であり、この表は旧head全体を再実行して音切れの差を比較したものではない。

| 条件（20人） | 秒 | 送信形式 | bytes 平均 / 最大 | 生成+JSON p99 / max ms | stringify p99 / max ms |
| --- | --- | --- | --- | --- | --- |
| realistic | 65 | previous | 142733 / 142776 | 2.344 / 2.801 | 1.208 / 1.443 |
| realistic | 65 | periodic | 103909 / 103928 | 1.624 / 1.671 | 0.768 / 0.869 |
| severe | 65 | previous | 161431 / 161479 | 2.560 / 2.677 | 1.286 / 1.773 |
| severe | 65 | periodic | 107702 / 107720 | 1.739 / 2.052 | 0.773 / 0.775 |
| regular | 65 | previous | 154349 / 154395 | 2.186 / 2.215 | 1.084 / 1.095 |
| regular | 65 | periodic | 103538 / 103556 | 1.705 / 1.801 | 0.730 / 0.759 |
| realistic | 900 | previous | 399212 / 399245 | 5.080 / 5.388 | 2.581 / 2.934 |
| realistic | 900 | periodic | 140890 / 140902 | 1.714 / 1.751 | 1.059 / 1.071 |

15分後のデータではbytes平均が約65%、合計時間のp99が約66%減った。これを音切れ改善の証明とはしない。
900秒の各人・各完成1分窓のqueue p95は52～90 msで、70～80 msの窓も多かった。
実測の約60 msより厚い窓があり、聴こえた2回にも較正済みではないため、初期60 ms・40～100 ms・20 ms刻み、
遅延予算p99 120 ms / 最大140 msの数値は候補として据え置き、前述のprefill連動・まれな空きの補助条件を加える。
20人のmix p99は約1 msのままだが、event loopには16 ms級の観測がある。同期decodeだけに原因を帰さず、
状態生成・GC・スケジューラも含むprofileを行ってからworker化を判断する。

Node 22.23.4の全テスト499件中495成功・4skip・失敗0。PCMのbit一致を維持し、
seed再現性、独立した発話・配送、定期状態からの3履歴除外、診断・Bundleでの保持、UI未参照、250 ms超のmax保持を検証した。
raw結果・ログは `target/rx-review-20261029-000300/` の `matrix.json` / `long-20-realistic.json` に保存した。

## 初回の規則的負荷測定（c1b2141、比較用）

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
