# Discord RX 第2段階：RTP 計測と再生バッファー

## 根拠と範囲

`ebe3c5b` の実機計測（20261029T110734Z / 111000Z）で報告された、到着 jitter p99 3～4 ms、
fill jitter p50 10 ms / p95・p99 33 ms、数サンプルの残りからのため直し、100～220 ms の受信停止を優先した。
これらは利用者の実機結果であり、今回その機器を稼働して再測定した値ではない。
第1段階の規則的・乱数配送だけの試験を、実機の途切れの再現済みデータとは扱わない。

音を変更するのは TypeScript の Discord RX playout。依存・lockfile・native・engine のタイマーは変更しない。
PLC / FEC / decoder の worker 化も実装しない。PRE 録音のタップは従来の `channel.processed` のままで、
新しい playout の prefill・フェード・既存の処理を通った結果が記録される。

## A：本物の RTP と観測できる範囲

`@discordjs/voice@0.19.2` の同じ `VoiceUDPSocket` の `message` を、追加の前後リスナーで観測する。
RTP v2 / PT 120 / 12 bytes以上を確認し、offset 2 の16 bit sequence、4 の32 bit timestamp、8 の SSRC を読む。
`receiver.ssrcMap.get(ssrc).userId` で関連付ける。別 socket・別 UDP bind・独自の復号はしない。
既存 receiver の復号・DAVE・subscription を通って実際に `data` が出たときだけ、その UDP イベントの情報を使う。
未認証のヘッダーを FIFO に積まないため、復号失敗で以後の packet とずれることがない。

依存する内部は `connection.state.networking.state.udp`、networking の `stateChange`、
`receiver.ssrcMap` / `onUdpMessage`、およびその handler → parse/decrypt → `stream.push` の同期的な順序。
UDP リスナーの順序も各利用時に検査する。接続・UDP の入れ替え時に observer を付け直し、終了時に外す。
ライブラリのファイル・メソッドを patch / 置換しない。
`speaking` の `start` 内で subscription と `data` リスナーを作った直後に `stream.read(0)` を呼び、
Node Readable の最初の `push` から同じ UDP イベント内で `data` が出るようにする（無音終了後の再作成時も同様）。
固定版の本物の VoiceReceiver と AES-GCM の模擬 UDP packet を使ったオフラインテストで関連付けを検査する。

内部が変わった、SSRC が不明、ストリームが後から buffered data を流した、などの場合は従来の合成番号へ戻る。
観測の例外は音声処理へ伝播させない。DBR1 v1 の OPUS 専用 flags `REAL_RTP=1` / `RTP_RESET=2` で区別する。
送信や制御の flags とは型ごとに別の意味。SSRC が変わった最初の packet と、合成／実 RTP の切替で比較基準を作り直す。
実 RTP は16 bit、timestamp は32 bitの wrap を扱い、重複・逆順を既存の受信 gate で拒否する。
これは合成番号では見えなかった重複・逆順も判定する変更で、意図的に古い packet を decoder へ渡さない。

`sequenceGaps` は互換性のため数値を維持し、`sequenceGapsKnown` を追加した。
source の世代中に合成 packet を含んだ場合、または現在が合成番号なら `false`。画面の GAP / G は「不明」と表示する。
「0」を実ネットワークで消失なしという意味に読み替えない。
実 RTP を比較できた区間の消失数は、別途 `rxTiming.rtp.missingPackets` と coverage の
`realPackets` / `syntheticPackets` で確認する。fallback を挟む区間の消失は推定しない。

| 分類 | 判定と限界 |
| --- | --- |
| `loss` | 実 sequence の前進が2以上。欠けた番号数も加算。ネットワーク・復号失敗・Adapter/IPC の破棄のどこで失われたかは断定しない |
| `senderPause` | sequence は1進み、timestamp は960超進む。20 ms / 48 kHz の現行受信契約に対する送信側の空き。自然な発話の切れ目も含む |
| `delayed` | 30 ms超の到着間隔で sequence / timestamp が1 / 960続き、さらに次の連続 packet が5 ms以内に来てまとめ届きを裏付ける |
| `unknown` | 合成番号・比較基準なし・上の証拠を満たさない空き。連続 RTP で空きがあっても、まとめ届きが未確認の間はここに置く |
| `fillBurst` | 30 ms以内の実 RTP の連続到着で起きた不足。fill側の不足候補で、Windows由来と原因を確定した値ではない。RTP gap の件数には加えない |

`rxTiming.rtp.counts` は空きの**イベント数**、`gapWindows` は分類ごとの到着間隔の1分窓
（p50 / p95 / p99 / max、最近30窓）。分位値のビンは1 ms、1000 ms超も実際の最大値を保持する。
`recentInSpeechUnderruns[].classification` と `inSpeechByKind` は不足 fill の分類。
まとめ届きの証拠は次の packet で確定し、該当する最近の記録と累計を更新する。
`microInSpeechUnderruns` は queuedBefore ≤0.5 ms かつ previousPacketAge ≤20 ms の話中不足。
以前の「前後とも200 ms以内」の意味は変えない。それを超えて終端候補になった停止も、RTP gap の loss 計測からは消えない。
消失と送信側の休止が重なる場合はlossを優先する。gapの長さは自然な休止も含み得る到着間隔で、
その全時間分の音声が失われたと断定しない。
`playout.microShortages` は終端も含む微小残量の読み出し回数、`playout.silenceMs` は自然な無音やprefillも含む
元のPCMを供給できなかった時間。話中だけの確定値には `rxTiming.microInSpeechUnderruns` を使う。
`playout.targetBlocks` は40 / 60 / 80 / 100 msの各目標でfillした回数（無音中を含む）。

Support Bundle はこれらを固定した分類名と日時・数値だけに投影する。
生の sequence / timestamp / SSRC、ユーザー名・ID・UDP 内容は新しい記録に出さない。
既存の参加者の関連付けは Bundle の HMAC 別名のまま。
gapWindows も必要時の診断 GET / Bundle 専用で、1 Hz の WS 状態には生成しない。

## B：採用した目標・ため直し・上限

| 項目 | 規則 |
| --- | --- |
| 初期・範囲 | 60 ms、40～100 ms、20 ms刻み |
| 記憶 | source の寿命中保持。clear・不足・200 ms超の切れ目で消さない |
| 観測窓 | 5秒。到着 jitter p95、実時間の経過を差し引いたfillの連続需要、話中不足を観測。到着の推定は50 packet以上の窓で更新し、無音・少数の窓では前の推定を保持。診断では引き続きp99も記録 |
| fillの連続需要 | 各fillで `debt = max(0, previousDebt - elapsedMs) + blockMs`。窓内の最大を使う。瞬間的な4ブロックなら40 ms、処理中に経過した時間は差し引く。話の切れ目ではリセットしない |
| 次の下限 | `clamp(ceil20(max(min(80, 20 + maxFillDebtMs), 40 + max(0, packetJitterP95Ms - 5))), 40, 100)`。fillには1 packetと連続需要（上限80 ms）、到着には2 packetと通常の揺れを確保し、大きい方を採る |
| 増加 | 不足により待ち直す境界で、fillBurst または微小型の話中不足があれば即1段。fillだけに対する増量は80 msまで。100 msは継続する到着の揺れがそれを要求するときに限る。実消失・送信停止・まれな到着停止の件数だけでは増やさない |
| 減少 | packet が50個以上あり、話中不足のない安定窓が3つ続いた後、200 ms超の切れ目後の開始時だけ1段。話中には下げない |
| prefill | 話頭・不足後とも選択した目標まで待つ。最初の未再生 packet の受理から `min(target, 60 ms)` を上限とし、短い発話も捨てずに再生。timer自体の発火遅れは別途遅延に含める |
| 微小な残り | queued ≤0.5 ms、前の packet から20 ms以内なら、残りを出して不足分だけ無音にする。長い prefill へ戻らず、次の packet を次の fill から再生。欠けた語頭を捏造・再送・飛ばし読みしない |
| high water | `min(target + 20 ms, 100 ms)`、既存の200 ms holdを維持。圧縮終了は target。緩い伸ばしは EWMA が target−20 ms未満のときだけ |
| 物理 ring / hard cap | 140 ms（14 blocks）。通常の到着では140 msの容量を使い、到着jitter p95が15 ms超なら130 msを上限とする。capの選択もため直し・話頭の境界だけ。全てのcap破棄を同じ `droppedSamples` に加算し、別のカウンターに隠さない |

変更する目標のために話中の PCM を挿入・削除しない。
既存の少数サンプルの clock 補正と静かな区間の短縮は残し、その基準だけを目標へ連動させる。
旧方式の「packet の20 msの山谷を含む EWMA < target」のまま初期60 msへ変えると、
伸ばしで余分に厚くなり破棄が出たため、伸ばしの開始を target−20 msへ移した。
予備試験でこの問題を確認して修正し、最終 A/B では破棄を別に比較する。

さらに、p99のまれな到着停止と不足の全分類で目標を100 msまで増やし、ringを160 msへ広げた予備案は、
severe の遅延 p99 130 ms / 最大158 msとなり棄却した。
通常の到着揺れはp95で選び、まれな大きな空きは診断のp99/maxと分類で残す。
実機で多かったfill側の微小不足を増量のきっかけとし、prefillの時間上限を60 msへ絞った。
停止のたびに待ち時間を大きくして、遅延を溜め続ける方針は採らない。

「5 ms未満の呼び出し間隔なら同じburst」とする途中案も、20人で別のcallbackまで結合し、
目標100 ms・86 samplesの破棄増加を起こしたため棄却した。
上の連続需要は callback の境界を推定せず、経過した実時間を必ず差し引く。
main threadの待ちで到着とfillの両方が乱れる場合を二重加算しないよう、2種類の余裕は和ではなく最大を使う。
独立した不足が残れば、次のため直しで1段増やすフィードバックを併用する。

その後の15分試験でも、timer由来で目標が100 msへ偏ると2,553 samplesの破棄増加が出た。
fillに対する余裕は `min(80, 20 + maxFillDebtMs)`、到着に対する余裕は上表の式で選ぶ。
到着間隔100 msまではcontrollerの候補に入れるが、まれな停止はp95へ影響しない。
到着側の余裕が80 ms超のときだけ100 msへの増加を許す。既に100 msの状態を話中に下げることはしない。
全ての話中不足は安定窓を中断するが、loss等だけで増量はしない。
通常の到着では、decoder受理直後の新しいpacketをtimerのまとめ処理で捨てない余地として物理140 msを使う。
大きな到着batchでは、長いqueueを残し過ぎない130 msのcapを使う。これを通常の待ち量にはしない。
`playout.hardCapMs` で選ばれた上限を診断できる。

遅延予算は packet の Core 受理 → ミックス出力 sample の p99 ≤120 ms / 最大 ≤140 ms。
130 / 140 msの ring を根拠にこの予算を満たしたとはしない。負荷試験では sample の出自を追って直接測る。
OSが長時間停止する場合まで140 msを保証するものではなく、任意の停止をバッファーで吸収する設計でもない。
200 ms超の古い queue を捨てる既存の防御は維持する。上限を超える実測があれば合格扱いにしない。

## C：途切れの端

旧 RX source にはこの端のフェードはなかった。3 ms（48 kHzで144 samples）の fade-in / fade-out を追加した。
再開時は最初の実 PCM をゼロから立ち上げ、尽きる位置がブロック中なら末尾をゼロへ落とす。
ブロック境界で尽きて事前に予測できない場合、次の不足ブロックの先頭で直前の終端値を3 msだけゼロへ落とす。
数サンプルの残りしかない場合も終端値から3 ms以内で落とす。
波形のループ・過去の発話の再生・decoder の進行は行わず、PLC の代用とはしない。
clear / 退室 / 安全ゲートの遮断は既存どおり優先する。

## 出力の検証と違いの理由

`tests/helpers/beta4-discord-pcm-source.ts` は beta.4 と同じPCMを出す、第1段階（`ebe3c5b`）の計測付きsourceを比較専用に凍結したもの。
旧方式の既存テストと2分の mix の bit一致 golden はこの参照に対して維持する。
新方式に旧 golden が一致するとは主張しない。意図する違いは20 ms以上の初期待ち、
境界の3 ms fade、微小不足後の待ち直し回避、適応目標と clock 補正の基準の変更。
無揺れの一定 PCM では初期の20 ms差を整列した後の出力一致を検査し、短い語頭・残り・古い音を再生しないことも検査する。
PRE 録音は実 WAV のサンプルを新 playout 後の `channel.processed` と照合する。
既存の録音・承認・緊急ミュート・FAULT・退室のテストを維持し、prefill 上限と ring 容量に依存する期待値のみ更新した。

## D：PLC / FEC の次の選択肢（調査のみ）

現行 `@discordjs/opus@0.10.0` は frame_size=5760 / decode_fec=0 固定。
20 ms分の PLC に必要な960 samplesを指定できず、FEC の選択もできない。
空 Buffer の120 ms結果を切り取る方法は decoder の状態を進め過ぎるため使わない。
[libopus の契約](https://opus-codec.org/docs/opus_api-1.5/group__opus__decoder.html)に合わせた binding が必要。

| 案 | 変更の大きさ・署名への影響 | ライセンス・性能・判断 |
| --- | --- | --- |
| 現在の binding を拡張し native を再ビルド | JS API・C++ binding・配布物の差し替え。追加 DLLを避けて静的リンクしても `.node` 自体が新バイナリ | wrapper MIT、libopus BSD-3-Clause。現行に近い性能が期待できるが未測定。正確な PLC/FEC API、全バイナリの署名・再配布検証が必要 |
| 別 native binding / Rust 側へ統合 | 新依存か既存 native の変更、bridge・decoder世代・順序・queue の設計が必要。動的 DLLならその署名も対象 | ライセンスは選定した wrapper ごとに確認。libopus 部分はBSD。高速でも IPC/worker の待ちを含む end-to-end の再試験が必要 |
| libopus を WASM にし必要な API を公開 | 新しいビルド成果物・wrapper・起動時compile・メモリ管理が必要。追加のWindows DLL/.nodeを避けられる | libopus BSD、wrapperの許諾も整理。SIMD利用やコピーを含め20人で測るまで性能同等とは言わない。署名問題を増やしにくい候補として比較を推奨 |
| 既存 devDependency の opusscript をそのまま採用 | production への依存変更になり、今は採らない。JS公開decodeもframe size/FECを選べない | wrapper MIT、同梱libopus BSD。JS/WASMだからそのまま正しい20 ms PLCが使えるわけではない |

Opus の許諾は[公式のライセンス](https://opus-codec.org/license/)を確認した。
Smart App Control は exe だけでなく DLL 等も対象で、新 native が既存バイナリと同じ信頼で動くとは仮定しない。
新しい native の採用には[Microsoft の署名案内](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)と
[全バイナリを対象にする案内](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control)に沿った確認が必要。
WASM でも既存 Node・ランチャーの信頼は引き続き必要で、SAC を回避できるという意味ではない。設定変更や無効化は今回行わない。

RTP の sequence / timestamp / SSRC には Opus 内の FEC が入っているかを示す bit はない。
[RFC 7587 §3.3](https://www.rfc-editor.org/rfc/rfc7587.html#section-3.3)の in-band FEC は Opus payload 側の冗長情報。
A のヘッダーだけでは確認できず、今回は実 Discord 接続も行わないため「Discord から FEC が来ている」は未確認。
将来、対応 decoder で次 packet の FEC と通常復号を状態整合を保って調べる必要がある。

## E：スケジューラー（案のみ）

現在は `server.ts` が単調時計の10 ms期限を `setTimeout` で待ち、遅れた分を同じ callback で catch-upする。
ASIOの出力時計があるときは既にそちらを優先する。この PR ではどちらも変更しない。
実機の fill 窓は timer の問題と整合するが、Windows の timer 分解能自体を直接測った証拠ではない。

| 案 | 効果・制限 | 優先度 |
| --- | --- | --- |
| catch-up 間で event loop に一度譲る、期限管理と受信処理の公平性を検証 | JSだけで試せるが、まとめ処理を遅らせるだけでは出力不足を増やす。sample clockと出力queueを含むA/Bが必要 | まず別PRの小さな検証。busy loop・常時setImmediateで精度を買わない |
| `timeBeginPeriod(1)` と対応する終了処理 | native 呼び出しが必要。Windows 11では最小化等で高分解能が保証されない。電力・ライフサイクルへの影響も測る | 案だけ。恒久的な解決とみなさない |
| high-resolution waitable timer + 専用thread / MMCSS | native変更とbridgeが必要。高精度待機は改善候補だがJSのevent loopを同期させるだけでは同じ詰まりが残る | WASAPI/既存callback系との境界を設計してから |
| 機器 callbackをsample clockの主にする | 本来の出力需要で進められるが、非ASIO出力のnative経路・録音/TX・有限queueの統合が大きい | 長期案。native変更は実装しない |

[Nodeのtimer](https://nodejs.org/api/timers.html#scheduling-timers)は正確な発火時刻を保証しない。
[timeBeginPeriod](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod)、
[high-resolution timer](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw)、
[MMCSS](https://learn.microsoft.com/en-us/windows/win32/procthread/multimedia-class-scheduler-service)の一次資料を参照した。
decode の worker 化は、引き続き同期 decode が実際に締切超過の主因と確認された場合に限って検討する。

## F：A/B の条件と読み方

```powershell
target\review-pr1\node22\node.exe tests/rx-load/run.ts --ab --seconds=65 --seed=20261029 --output=target\rx-stage2\matrix-bounded.json
target\review-pr1\node22\node.exe tests/rx-load/run.ts --ab --seconds=900 --seed=20261029 --case=20:hardware --output=target\rx-stage2\long20-bounded.json
target\review-pr1\node22\node.exe tests/rx-load/exact-steady.ts --seconds=65 --output=target\rx-stage2\exact-steady.json
```

1 / 5 / 10 / 20人、steady / realistic / hardware / severe の16条件と、20人hardwareの900秒。
旧・新は同じ実時間の packet 予定と scheduler を受けるペアで、両方を本物の native decoder・ミックスへ通す。
旧方式は ring 120 ms、新方式は物理140 ms / 選択cap 130～140 ms。各ケースは別子プロセス、全ケースを直列実行する。
旧方式の音の規則は40 / 30 / 80 / 120 msの基準で、計測・受信gate・stateは共通にしている。
beta.4のバイナリを別起動した比較ではない。seedは配送・発話の予定を再現し、実時間の結果はOS負荷でも変わる。
event loop は両方を同時に処理した Node プロセスの値で、個々の方式の独立した CPU benchmark ではない。
物理デバイス・Bot・音声ストリーム・録音は開始しない。1 Hzの実画面相当の状態生成・JSON化も両方で行う。
frame size / decoder / 入力fixture / 承認 / gain / matrix は共通。

試験のpacket配送までmainの粗いtimerに依存すると、「揺れなし」にも15 ms級の到着差が混ざるため、
最終試験の待機は専用workerの `Atomics.wait` とmessageによるwakeを使う（spinしない）。
配送・fillの予定を同じloopで順に処理し、fill側だけ指定のcatch-upを行う。
実際のCore受理時刻と実際のmix完了時刻を使うため、配送予定どおりだったと仮定した遅延にはしない。
これは試験用の独立した配送時計を用意する変更で、本体のscheduler変更・高精度設定変更ではない。

- steady：20 ms配送、断続発話。
- realistic / severe：第1段階の独立seedつき配送と断続発話を維持する。
- hardware：到着に0～3 msの独立乱数差。10～30秒ごとに packet を連続して**永久に落とし**、
  100～220 ms級の受信の空きを作る。後から配送しない。fill wake の間隔は
  `20,43,20,20,43,17,20,43,17 ms` を反復し、実 scheduler と同じ期限の catch-upをする。
  p50約10 / p95約33 msのfill jitterを狙うモデルで、実機時系列そのものではない。
  43 ms待ちと10 ms期限の位相により、主に2～4ブロック、一部で5ブロックも起こる保守的な条件。
  実機で報告された「約3分30件」という件数へ合わせて packet を増減していない。

delayは各accepted packetのサンプル数・受理時刻をFIFOで追い、実際に読み出したsampleを含む
`engine.processBlock()` の完了までをsample加重で測る。ring破棄・clear・quiet cutは出力sampleに数えない。
補間時の読み出した端点も含める保守的な計測で、p50/p95/p99は1 msビン上端、maxは実値。
queue量やRTTからの推定ではない。物理出力のbuffer・機器・Discordネットワーク区間は含めない。
このため遅延の良化だけで破棄を隠さず、hard cap破棄を併記する。
追跡は固定64枠の数値領域を使い、packetや読み出しごとの追跡objectを作らない。
終端に残る未再生PCMと生成したfadeの値は、実際に出力した復号sampleの分布には含めない。

不足はfill単位、換算は件数×900/(人数×秒数)。無音時間はsourceの実PCMを供給できなかったsample数/48で、
自然な無音・prefill・終端も含む（fadeの値や元音源のゼロ振幅を無音判定した値ではない）。
`activeSilenceMs` は次のpacketの送信時刻との間が260 ms以内の区間に絞る補助値で、話頭のprefillも含む。
`silenceRuns` は不足の連続長と、再開時のRTPで判定したloss等の件数・合計・最大を保存する。
最初の待ちは `startup`、消失と送信側の休止が重なったrunは `lossWithPause` と分け、純粋なlossの表から除く。
発話の切れ目と可聴の中断を同一視しない。目標値の分布はfillブロック数（自然な無音中も含む）。

`exact-steady.ts` は別の機能基準試験。1 / 5 / 10 / 20人それぞれ、本物のdecoder・同じミックスを65秒分通し、
model clockの到着・fill間隔を完全に一定にする。状態JSONと有限・非ゼロPCMも検査する。
既定はmodel時間を速く進め、実行時間は `wallSeconds` に別記する。`--realtime` で実時間の待機も選べる。
この時計の制御は試験プロセスだけで、実時間の遅延・event loop性能を証明する試験ではない。
主表のsteadyは配送予定の名前で、実際のCore到着・fillにはホストの揺れがあるため、両者を混同しない。

## 最終測定（2026-10-29）

Windows x64 / Node 22.23.4 / seed 20261029。以下は上記の採用案を使った測定で、棄却した途中案の値を混ぜない。
実行中のplayout・計測コードのSHA-256を `target/rx-stage2/tested-source-hashes.json` に保存する。

20人・hardware 900秒では各方式669,345 packetを受理した。
微小型の話中不足は旧425件 → 新5件（1人・15分換算21.25 → 0.25、約98.8%減）、cap破棄は0 → 0。
全ての話中不足は1,426 → 649件で、旧はloss 645 / fillBurst 781、新はloss 644 / fillBurst 5。
新方式の遅延はp50 71 / p95 99 / p99 109 / 最大133.841 ms、旧は36 / 62 / 72 / 95.553 ms。
loopは両方を処理した共通値でp99 5.562 / 最大27.771 ms。
新目標はfill回数の約0.9%が60 ms、約99.1%が80 ms、終了時は全員80 ms・cap 140 msだった。
消失による無音は残り、pure lossのrunは旧645件・計93,778.146 ms・最大219.083 ms、
新644件・計97,582.542 ms・最大229.021 ms（いずれも20人合計）。PLC/FECなしで欠けた音が戻ったとは主張しない。

この900秒の完成した1分窓は各方式300窓。
新fill jitterはp50 9 ms / p95 32～33 ms / p99 33～35 ms、到着jitterはp95 4～9 ms / p99 5～12 msの範囲。
分位値の平均ではなく各窓の範囲であり、途中の窓はここから除いた。
実機の到着p99 3～4 msより大きく、配送用worker・同一processの旧新両方の処理・OS等の影響を含む。
fillの分布は実機に近いが、可聴の途切れ件数まで較正したモデルではない。

全条件の表と最終テスト結果は以下にまとめる。

分類別換算は L=loss / S=senderPause / D=delayed / F=fillBurst / U=unknown。記載のない分類は0。
無音合計は自然な休止・話頭のprefillを含む全員分の合計で、可聴の話中断だけの長さではない。
分位値は1 msビン上端と実測最大の小さい方、maxは実値（表は丸め）。loopは旧新共通。


|人数|条件・秒|話中 旧→新|分類別 人15分換算 旧→新|微小 旧→新|無音合計 秒 旧→新|cap破棄 samples 旧→新|遅延 p50/p95/p99/max ms 旧→新|新target 40/60/80/100 %|loop p99/max ms（共通）|
|---|---|---|---|---|---|---|---|---|---|
|1|steady 65|0 → 0|0 → 0|0 → 0|15.6 → 15.6|0 → 0|35/49/50/50.5 → 35/59/59/60.3|72.4/27.6/0/0|2.583/4.723|
|1|realistic 65|9 → 4|D:110.77 U:13.85 → D:55.38|0 → 0|15.7 → 15.7|0 → 0|40/83/89/97 → 56/88/103/117.1|0/100/0/0|2.435/6.234|
|1|hardware 65|7 → 3|L:41.54 F:55.38 → L:41.54|4 → 0|16.1 → 16.2|0 → 0|36/63/70/80.3 → 65/96/107/119.7|0/9.5/90.5/0|2.636/4.874|
|1|severe 65|11 → 2|D:69.23 F:13.85 U:69.23 → U:27.69|0 → 0|15.7 → 15.7|2365 → 1440|43/70/97/119.9 → 64/93/109/129.9|0/16.9/83.1/0|2.447/6.627|
|5|steady 65|0 → 0|0 → 0|0 → 0|83.6 → 83.8|0 → 0|33/47/49/50.5 → 34/58/59/60.5|72.1/27.9/0/0|2.861/6.468|
|5|realistic 65|38 → 11|D:80.31 F:5.54 U:19.38 → D:27.69 U:2.77|0 → 0|83.9 → 84|0 → 0|38/75/87/113.2 → 52/78/91/117.1|0/100/0/0|2.677/5.919|
|5|hardware 65|27 → 9|L:24.92 F:49.85 → L:24.92|13 → 0|85.8 → 86|0 → 0|36/62/71/82.3 → 69/98/108/121.4|0/11/89/0|2.888/6.963|
|5|severe 65|52 → 12|D:94.15 F:5.54 U:44.31 → D:19.38 U:13.85|0 → 0|84.3 → 84.2|11862 → 9115|43/86/102/119.6 → 64/106/119/129.8|0/15.1/84.9/0|2.701/7.004|
|10|steady 65|0 → 0|0 → 0|0 → 0|164.9 → 165.3|0 → 0|33/47/50/51 → 34/58/60/60.8|72.7/27.3/0/0|2.843/6.267|
|10|realistic 65|72 → 23|D:83.08 F:4.15 U:12.46 → D:29.08 U:2.77|0 → 0|165.5 → 165.7|0 → 0|39/76/88/113.3 → 53/80/90/117.4|0/100/0/0|2.767/7.152|
|10|hardware 65|53 → 21|L:29.08 F:44.31 → L:29.08|23 → 0|169.4 → 169.8|0 → 0|36/62/71/82.4 → 69/99/108/122|0/12.9/87.1/0|3.338/7.741|
|10|severe 65|111 → 31|D:112.15 F:5.54 U:36 → D:31.85 U:11.08|0 → 0|166.5 → 166.2|29728 → 23952|44/88/103/119.7 → 65/105/119/130.1|0/15.9/84.1/0|2.859/6.197|
|20|steady 65|0 → 0|0 → 0|0 → 0|333 → 334.1|0 → 0|33/47/50/63.5 → 50/60/62/74.2|0/100/0/0|3.226/14.615|
|20|realistic 65|158 → 45|D:92.77 F:4.15 U:12.46 → D:29.08 U:2.08|0 → 0|334.1 → 334.5|0 → 0|39/74/86/113.5 → 53/77/88/118.2|0/100/0/0|2.879/8.04|
|20|hardware 65|111 → 44|L:30.46 F:46.38 → L:30.46|33 → 0|342.6 → 343.4|0 → 0|36/62/71/82.9 → 69/98/108/121|0/12.2/87.8/0|5.206/12.657|
|20|severe 65|245 → 70|D:125.31 F:8.31 U:36 → D:40.15 U:8.31|0 → 0|336.3 → 335.6|55176 → 44054|44/89/104/119.9 → 66/106/119/130.1|0/14.9/85.1/0|2.916/8.057|
|20|hardware 900|1426 → 649|L:32.25 F:39.05 → L:32.2 F:0.25|425 → 5|4608.7 → 4612.7|0 → 0|36/62/72/95.6 → 71/99/109/133.8|0/0.9/99.1/0|5.562/27.771|

|人数|秒|loss分類の無音runs 件数/合計ms/最大ms 旧→新|
|---|---|---|
|1|65|3/405.3/189.4 → 3/416.7/160|
|5|65|9/1197.6/189.4 → 9/1354.8/210|
|10|65|21/3029.8/200 → 21/3191.4/220|
|20|65|44/6517.6/200 → 44/6907.1/220|
|20|900|645/93778.1/219.1 → 644/97582.5/229|

17条件すべてでcap破棄は旧方式以下、新方式の遅延はp99 120 ms / 最大140 ms以内だった。
実機再現の65秒は全人数で微小型0、900秒は5件（1人15分0.25件）。
実時間steadyは全人数で話中不足0。1 / 5 / 10人は終了時40 msへ下がったが、
20人の実時間steadyはホストの揺れを観測して60 msを保持した。
このため「完全に揺れなしで40 msへ下がる」の確認は別のexact model試験でも行った。
本物のdecoderとミックスへ65秒相当を通した1 / 5 / 10 / 20人の補助試験は、両方式とも話中不足0・破棄0・有限で非ゼロのPCM、
新方式は全員40 ms。実行時間はそれぞれ約1.26 / 3.05 / 5.55 / 10.15秒で、実時間の遅延表の代用にはしていない。

Node 22.23.4 の通常テストは517件中513成功・4 skip・失敗0（25.807秒）、型チェックも成功。
skipはMac向け1件、Linux向けプロセス終了2件、PowerShell 7向け1件の環境条件によるもの。
旧PCM golden、新しい連続PCMのsample一致、1時間の±200 ppm、語頭・微小残り・フェード、
RTPの実receiver fixture・wrap・fallback・分類、静かな窓をまたぐ記憶、PRE WAVの一致、Bundleの許可リスト・匿名化を確認した。
native・依存・lockfile・Nodeの指定、production schedulerに差分はない。

最終raw結果は `target/rx-stage2/matrix-bounded.json` / `long20-bounded.json` / `exact-steady.json`、
ログは同じ場所の `all-tests-final.log` / `typecheck-final.log`、集計は `tables.md` / `checks.json`。
途中案の `matrix-final-ab.json` / `long20-final-ab.json` 等は棄却した結果で、この最終表には含めない。
