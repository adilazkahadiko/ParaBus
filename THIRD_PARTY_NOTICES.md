# Third-party licensing inventory

ParaBus本体のGPL-3.0-only表記は、第三者コードのライセンスを置き換えるものではありません。
過去の調査記録も含む一覧です。2026-10-22の個別レビュー版の構成は下記の最新節を参照してください。
依存を再配布するときは、各配布物の元の著作権表記、LICENSE / COPYING / NOTICEを保持してください。

## Node dependencies

2026-10-02時点の`package-lock.json`に固定された主要依存です。

| Component | Version | Upstream license |
| --- | --- | --- |
| discord.js | 14.27.0 | Apache-2.0 |
| @discordjs/voice | 0.19.2 | Apache-2.0 |
| @discordjs/opus | 0.10.0 | MIT |
| naudiodon2 | 2.5.0 | Apache-2.0 |
| @snazzah/davey（推移依存） | 0.1.12 | MIT |
| segfault-handler（naudiodon2の推移依存） | 1.3.0 | BSD-3-Clause |
| opusscript（試験用） | 0.1.1 | MIT |
| TypeScript（開発用） | 7.0.2 | Apache-2.0 |
| @types/node（開発用） | 26.2.0 | MIT |
| node-gyp（nativeビルド用） | 12.1.0 | MIT |

推移依存・platform別packageも含む177 entryの宣言はMIT 85、Apache-2.0 35、ISC 42、
BlueOak-1.0.0 10、BSD-3-Clause 2、BSD-2-Clause 2、0BSD 1です。正確な版と取得先はlockfileに記録されています。
この集計はpackage metadataであり、組み込まれたnative libraryすべてのlicense一覧ではありません。

Apache-2.0とGPLv3の互換性は[Apache Software Foundationの説明](https://apache.org/licenses/GPL-compatibility.html)を参照してください。
BlueOak依存（chownr / minipass / tar / yallist）は元のlicenseまたは
[Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0)へのリンクを保持します。

## Rust dependencies

この節はParaBus自身のCargo workspaceが対象です。DAVEのnative package内にある別のRust依存は、
後述の「DAVE / Windows nativeの追加確認」を参照してください。

`Cargo.lock`および`cargo metadata --locked --offline`に固定された第三者crateの宣言を確認しました。
MITを選べる依存はMITの原文と著作権表記を保持する方針です。

- itoa、proc-macro2、quote、serde、serde_core、serde_derive、serde_json、syn（2 / 3）:
  MIT OR Apache-2.0。
- windows、windows-collections、windows-core、windows-future、windows-implement、
  windows-interface、windows-link、windows-numerics、windows-result、windows-strings、windows-threading:
  MIT OR Apache-2.0。
- memchr: Unlicense OR MIT。zmij: MIT。
- unicode-ident: (MIT OR Apache-2.0) AND Unicode-3.0。MITだけでなくUnicodeの表記も必要です。

Rust binaryを配布する前に、実際に組み込んだcrateの原文・著作権表記を同梱してください。
固定crateのMIT原文とunicode-identのUnicode原文は、[第三者原文集](docs/THIRD_PARTY_LICENSES.md)へ収録しました。

## Native audio / ASIO

- @discordjs/voice 0.19.2のCJS/ESM audio schedulerをParaBus側で変更（2026-10-13）。
  音声送出の2か所だけを`Date.now()`から`performance.now()`へ変更し、時刻補正の影響を避けます。
  変更内容・再適用手順は`scripts/patch-discord-voice.ts`に保持します。元のApache-2.0 LICENSE・NOTICEは削除しません。
  依存の版や対象コードが異なる場合は適用を中止します。グローバルな時計やOS設定は変更しません。

- naudiodon2 2.5.0のJS停止wrapperはParaBus側で変更（2026-10-03）。1引数のnative停止と
  完了待ち・重複停止の抑止を行います。変更は`scripts/patch-naudiodon.ts`に保持し、
  upstreamのApache-2.0著作権・免責表記は残します。binding / DLL自体は変更していません。

- @discordjs/opusのbindingはMITですが、内部libopusは別条件です。
  原文はpackage内の`deps/opus/COPYING`（BSD形式の著作権・免責・特許license案内）を保持します。
- PortAudioはMIT形式の条件です。元の`LICENSE.txt`と各sourceの著作権表記を保持します。
  naudiodon2のApache-2.0表記だけでPortAudio / ASIOまで確認済みとしないでください。
- ローカルASIO 2.3 SDKの2025年版LICENSE原本にはGPLv3とSteinberg proprietaryの選択肢があります。
  ParaBusのOSSビルドはGPLv3側を使う方針です。SDKはGitへ同梱せず、取得元・版・hash、
  対象source内の条件とビルド手順を確定してからASIO binaryを配布します。
  [Steinberg公式発表](https://ocl-steinberg-live.steinberg.net/_storage/asset/809940/storage/master/Press%20Release%20-%202025-10-15%20-%20OBS%20Partnership-%20JA.pdf)。
- ASIO / SoundGrid等の機器ドライバーは同梱せず、各メーカーの正規配布元から利用者が取得します。
  商標・ロゴの利用条件はコードのlicenseとは別です。
- DAVE / Opus等のprebuilt native packageは、対象platformごとの組み込み依存と元NOTICEを
  配布前に確認します。Node.js自体を同梱する場合も、その配布物のLICENSEを保持します。
- DAVE 0.1.12の公式sourceのMIT原文と、segfault-handler 1.3.0のpackage BSD原文を
  [第三者原文集](docs/THIRD_PARTY_LICENSES.md)へ追加しました。DAVE内のOpenMLS / RustCrypto等、
  segfault-handler内のWindows StackWalkerの配布条件確認は未完了です。
  packageのlicense名だけでは、内部依存すべてを確認済みとはしません。

## DAVE / Windows nativeの追加確認（2026-10-13）

公式npmのDAVE本体・Windows x64 package（ともに0.1.12）とsegfault-handler 1.3.0を、
ParaBusのlockfileのSHA-512と照合しました。取得物は実行していません。
DAVEの両packageにLICENSE / NOTICE本文はなく、Windows側は`.node`・README・package.jsonのみでした。
npm metadataの`gitHead`は両方とも下記commitに一致しますが、これだけでnative buildの入力全部は証明できません。

### DAVEの依存版と原文

基準は[上流js-0.1.12のCargo.lock](https://github.com/Snazzah/davey/blob/a1e2e741bea06bc3b7167a5c3792844b8975993c/Cargo.lock)
（SHA-256 `cf9bc6884056b8e20ee6835ac0ffca237f8b869d5ca14cddf25f548fa15ceb50`）です。
全237 packageはPython・他platform・開発用も含むため、Windows binaryの組み込み一覧とは扱いません。
以下25件のcrate archiveを公式crates.ioから取得し、このlockfileのchecksumと照合しました。

| 対象 | lockfileの版 | 確認した宣言・原文 |
| --- | --- | --- |
| openmls / openmls_rust_crypto | 0.8.1 / 0.5.1 | MIT。crateに本文なし。crate内のVCS情報が指す上流commitの原文を採取 |
| openmls_basic_credential / openmls_memory_storage / openmls_traits | 各0.5.0 | MIT。同じく上流commitの原文を採取 |
| aead / aes / aes-gcm / cipher / ctr / ghash | 0.5.2 / 0.8.4 / 0.10.3 / 0.4.4 / 0.9.2 / 0.5.1 | MIT OR Apache-2.0。各crateのMIT本文を採取 |
| hmac / p256 / scrypt / sha2 | 0.12.1 / 0.13.2 / 0.11.0 / 0.10.9 | MIT OR Apache-2.0。各crateのMIT本文を採取 |
| rand | 0.8.5 / 0.9.2 / 0.10.0 | MIT OR Apache-2.0。各crateのMIT本文を採取 |
| subtle | 2.6.1 | BSD-3-Clause。crateの本文を採取 |
| napi / napi-derive / napi-build | 3.8.4 / 3.5.3 / 2.3.1 | MIT。crate内のVCS情報が指す上流原文を採取。GitHubの著作権表記も含む |
| hpke-rs / hpke-rs-crypto / hpke-rs-rust-crypto | 各0.6.1 | **MPL-2.0**。crateと上流commitにLICENSE名のファイルなし。Mozilla公式本文は原文集へ収録済み。実行物に対応するsource提供・取得案内の確定は残る |

採取したMIT / BSD原文と取得元は[第三者原文集](docs/THIRD_PARTY_LICENSES.md)に追記しました。
これは一部の確認です。残る推移依存・file単位の追加条件、Windowsで有効なfeatures（組み込み機能）、
実際のprebuiltとの一致は未確認です。

`openmls_rust_crypto`はHPKEの3 crateを通常依存に持ちます。
[固定版manifest](https://github.com/openmls/openmls/blob/47dbedecad0c1fd8eb5368d582250ebfcc1e1ce6/openmls_rust_crypto/Cargo.toml)と
[HPKE source](https://github.com/cryspen/hpke-rs/tree/f3463e7530771d7f7116635335c25e7d2d11e861)を確認してください。
MPL対象の実行形式を配布する場合は、対象sourceの提供と取得方法の案内も必要です。
GPLとの組み合わせはMPL 2.0 §3.3とSecondary License非互換指定の有無を確認し、
ParaBusのGPL表記でMPL条件を上書きしないでください（[Mozilla公式本文 §3.1–3.4](https://www.mozilla.org/en-US/MPL/2.0/)）。

上流[Windows build定義](https://github.com/Snazzah/davey/blob/a1e2e741bea06bc3b7167a5c3792844b8975993c/.github/workflows/node-ci.yml)は
`stable` toolchainと`pnpm build --target x86_64-pc-windows-msvc`を使用し、明示的な`--locked`はありません。
公開前に、実際のbuild記録・解決済み依存・toolchainを確定するか、固定入力から再ビルドして記録します。
タグのCargo.lockを配布済みbinaryの完全な部品表として断定しません。

### HPKEソースの追確認（2026-10-13）

保管済みの公式crate archiveと上記DAVE lockfileのSHA-256を再照合しました。
3件ともmanifestはMPL-2.0です。固定ソースの取得先は次のとおりです。

| ソースarchive | SHA-256 |
| --- | --- |
| [hpke-rs 0.6.1](https://static.crates.io/crates/hpke-rs/hpke-rs-0.6.1.crate) | `b6ad6a58eb3e0ee30be8bfc7a9770ae98adcfa1d9bc820a5847732ce84f70837` |
| [hpke-rs-crypto 0.6.1](https://static.crates.io/crates/hpke-rs-crypto/hpke-rs-crypto-0.6.1.crate) | `0a73a99d9008010d73289f41335a3f6e14fb8c04eaf60e9111b450463b1bbc7f` |
| [hpke-rs-rust-crypto 0.6.1](https://static.crates.io/crates/hpke-rs-rust-crypto/hpke-rs-rust-crypto-0.6.1.crate) | `14b28be6cba9081c7feda2651d51c2a900029798e78b4c1e093e792f4571a870` |

この3 archive内の`Incompatible With Secondary Licenses`の文字列検索は0件でした。
これは全履歴・全依存に非互換指定がないことの証明ではありません。
公式の[固定版manifest](https://github.com/cryspen/hpke-rs/blob/f3463e7530771d7f7116635335c25e7d2d11e861/Cargo.toml)は
`/tests`を配布対象から除外しています。crateだけを完全な再ビルド・検証用ソース一式と断定しません。

ソースを取得できることと、使用したWindows binaryの対応ソースが揃うことは別です。
実際の組み込み版・変更・featuresを確定し、対象ソースと[MPL本文](https://www.mozilla.org/en-US/MPL/2.0/)を
配布物へ揃え、受領者向けの取得案内を確定するまでは配布保留を継続します。

### segfault-handler内のStackWalker

[segfault-handler 1.3.0公式archive](https://registry.npmjs.org/segfault-handler/-/segfault-handler-1.3.0.tgz)の
`binding.gyp`はWindows時に`src/StackWalker.cpp`と`includes/StackWalker.h`を組み込みます。
CPPは[npmのgitHeadのsource](https://github.com/ddopson/node-segfault-handler/blob/8d1f2030030e7674cf2a5058d4ef53669bc81e91/src/StackWalker.cpp)とbyte単位で一致しました。
両ファイルの履歴は2005年版（CPPの最終記載はv5）ですが、著作権・許諾本文はありません。
[StackWalker公式の現在の原文](https://github.com/JochenKalmbach/StackWalker/blob/7af402408202a5c00021fd57e18e39e7e6f11062/LICENSE)は
Jochen KalmbachのBSD-2-Clauseです。古い同梱版への適用・変更履歴はまだ照合できていません。
package全体のBSD-3-Clauseや現在の原文だけでこの確認を完了扱いにしません。

追確認では、著作者の[2009年初回commit](https://github.com/JochenKalmbach/StackWalker/blob/32cb8954b9474b90b6ebd76975416c02822bcee2/Main/StackWalker/StackWalker.cpp)に
Copyright (c) 2005-2009, Jochen KalmbachとBSD-3-Clauseの本文がありました。
2005年v1〜v5の履歴を含みますが、同梱v5相当とはコード差分があります。
また、同梱CPPはsegfault-handlerの[2015年導入commit](https://github.com/ddopson/node-segfault-handler/blob/447c1c530e2a7d052b05f14a87a5e1423b629795/src/StackWalker.cpp)とbyte単位で一致します。
許諾が見つからない製品と断定する状況ではありませんが、旧版との対応を確定せず表記だけ差し込んで完了にはしません。

### 実行ZIPと全lockfileの追確認（2026-10-13）

旧CI版`6c3ef734aeec`の実行ZIPに入っているDAVE `.node`は、固定npm archiveの`.node`とSHA-256が一致しました。
SHA-256: `42928bfbee406f747e67cceb0bdb493f7a56b1f63101bf13d084527576dd84a5`。
npm registryが提供するprovenanceのpayloadも同じpackage digestと上流commitを指します。
ただし署名・透明性ログの暗号検証は未実施で、payloadの照合と署名検証を同一視しません。
参照する[上流Windows build](https://github.com/Snazzah/davey/actions/runs/27923578311/attempts/2)の原本logはHTTP 410で取得できませんでした。

DAVEの上流lockfile 237 package中、registry由来234 crateを全件取得し、checksum・manifestのlicense宣言を照合しました。
残る3件はworkspace packageです。未知のlicense宣言・checksum不一致はありませんでした。
これはplatform・開発用を含む集合で、Windowsの実組み込み部品表ではありません。
MPL-2.0は上記3件に加え`hpke-rs-libcrux 0.6.1`もlockfileにありますが、実際の組み込みを確認済みとは扱いません。
原文ファイルがarchiveにない依存、file単位の追加条件、選択featuresの確定は引き続き確認対象です。

同じZIPでNode 22.23.2のLICENSE全文は公式sourceと改行形式を除き一致しました。
PortAudio source・ASIO SDK・生成変更・DLL・bindingの5 hashも同梱build記録と一致しました。
一方、HPKEのsource取得案内とStackWalkerの権利者表記は見つからず、ParaBusのCargo workspaceも入っていません。
このZIPをそのまま外部へ渡す判定にはしません。

## Distribution gate

[ASIO Releaseビルド手順と検証記録](docs/ASIO_BUILD.md)で、固定SDKからの独立ビルドを確認しました。
ASIO SDKにはrootのデュアルライセンスだけでなく、host sourceのBSD条件もあり、
PortAudio・libopus・naudiodon2と合わせて[第三者原文集](docs/THIRD_PARTY_LICENSES.md)へ保持しています。
Nodeの推移依存やprebuilt内NOTICEの網羅・DLLのアプリ組み込み確認は未完了です。

本体のLICENSEを追加しただけで、現在のローカルDLLを公開してよい状態にはなりません。
公開前に全著作権者の許諾（会社・外部提供コードを含む）、native依存の元表記、
対応sourceと再現ビルド手順、音声・Token・案件情報を含まないことを確認します。
現在のrelease stageは実行用artifactであり、GPLv3の対応source一式を作る仕組みではありません。
実行ファイルごとの出自と個別レビュー版の作成手順は[配布手順](docs/SOURCE_RELEASE.md)に記録しています。

上記は従来候補の調査時点の保留事項です。GitHubへの公開はこの作業では行いません。

## Windows個別レビュー版（2026-10-22）

この構成では任意のsegfault-handler/StackWalker診断hookとpackageを除外しています。
naudiodon2のJS変更箇所・日付と適用scriptを保持し、音声DLLは変更していません。
旧StackWalkerに別版の許諾を適用したと推定する方法は使いません。

同梱npm packageの元archive、DAVEの固定VCS sourceとlockfile全234 registry crate、
HPKE固定VCS source、ParaBusのRust sourceとcrate、ASIO SDK/PortAudioの固定sourceと変更、
再利用EXEの元commitのsourceを対応ソースZIPへ収録します。npm integrityとcrate checksumを照合します。
原文LICENSE / COPYING / NOTICE / AUTHORSは`THIRD_PARTY_ARCHIVE_NOTICES.txt`にも集約し、
元archiveにない本文は固定VCS commitから補います。取得先・hash・依存licenseの一覧を同梱します。
Node 22.23.4の公式LICENSEとsourceを保持します。機器メーカーのドライバーは含めません。

DAVEの上流build log失効と完全再現性未確認はそのまま記録します。
全platformを含むsource集合をWindowsの実リンク一覧と同一視しません。
個別レビュー版は実行用ファイルと対応sourceを一つの外側ZIPで提供します。
[案内](docs/CORRESPONDING_SOURCE.txt)、[作成手順](docs/SOURCE_RELEASE.md)。
