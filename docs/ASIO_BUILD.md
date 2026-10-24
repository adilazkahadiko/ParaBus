# Windows ASIO Releaseビルド手順

これは配布準備の手順です。現行アプリのDLL差し替え・機器開始・配布は行いません。
固定sourceからDLLをビルドできたことと、本番で安定して使えることは別の確認です。

## 非公開Windowsテストパッケージへの組み込み（2026-10-07）

`test-packages.yml`のWindowsジョブと`windows-audio-native.yml`は、通常の`npm ci`の後に
`scripts/build-windows-asio.ps1`を実行する。Macジョブには適用しない。
PortAudio commitとSDK ZIP / LICENSEのSHA-256は下の固定値を維持する。
SDKの直接URLは`https://download.steinberg.net/sdk_downloads/ASIO-SDK_2.3.4_2025-10-15.zip`。
ASIO SDK 2.3.4（2025年版）のGPLv3側を使用する。SDK自体はGitへ追加しない。

- Release x64、ASIO / WASAPIを有効にし、MSVC runtimeはstaticでDLLを作る
- SDK検出・compile graph内のASIO source・ASIO exportを確認し、不一致なら止める
- DLLとimport libraryを`portaudio_x64`の名前で作り、naudiodon2 2.5.0をそのlibraryへ再リンクする。旧DLLのordinal互換性を仮定しない
- DLL / bindingのSHA-256と入力情報を`node_modules/naudiodon2/asio-build-info.json`に記録する
- `scripts/asio-native-check.ts`でASIO / WASAPIのhost APIと実ロードDLL・hashを確認する。パッケージ組み立て後にも再検証する
- native-sourceにSDK原本ZIP、PortAudioの固定source ZIP（.gitを除く）、生成されたpatched_asiolist.cpp、GPL本文、再ビルド手順・hashを同梱する。SDK ZIPにはメーカーの機器ドライバーを追加しない

この検査はCI用。`getHostAPIs()`はPortAudio初期化とドライバーの列挙を行うため、
実機で音声稼働中に実行しない。AudioIOは開始しない。通常の`check:audio-native`は
引き続き機器を列挙せず、ASIO必須の検査を起動時へ追加しない。

ASIO APIがCIで存在することと、利用PCで実機ドライバーが動くことは別。
メーカー公式の64bit ASIOドライバーを導入し、停止中にデバイスを明示選択してから試す。
公開binary配布のgate・DAVE等の未確認事項は解除しない。
古い非ASIO overlayを上書きするとASIO DLLが元へ戻るので、対応する新しいテストZIPを使用する。

通常の初回導入は[ソース導入手順](SOURCE_RELEASE.md#ソースからの導入)を使います。
現在はビルド用node-gyp 12.1.0をlockfileへ固定しています。以下の旧導入失敗は修正前の検証記録です。

## 固定した入力（2026-10-02）

| 入力 | 確認値 |
| --- | --- |
| PortAudio | 19.8 / commit `17967f32de95f2179e7f7caa9632a79c5d59a2ea`、未変更 |
| PortAudio取得元 | `https://github.com/PortAudio/portaudio.git` |
| SDK取得元 | Steinberg `https://www.steinberg.net/asiosdk` |
| SDK | ASIO 2.3、2025年版LICENSEにGPLv3 / proprietaryの選択肢あり |
| SDK ZIP SHA-256 | `D5EBF0C20DD2C5F43771FD0C1418F4B361BF52434EE670097CFA6B3A335E2ECA` |
| SDK LICENSE SHA-256 | `61E56814F24B32216884B2DB0B4DCC317111A5AB354D54D19DD9FC13D71B1C7A` |
| 検証ツール | Windows x64、VS Build Tools 18.5.2、MSVC 19.50.35730.0、CMake 4.2.3-msvc3、Ninja |

SDKのURLは将来内容が変わり得ます。正規配布元から取得してもhashが違う場合は止めて、
新しいSDKの版・原文条件・ビルドを改めて確認してください。未確認ミラーや既存DLLの転載で代替しません。
同じ入力を使う手順であり、PE timestampやビルドpathまで含むbit単位の再現性は検証していません。

## ビルド

Visual Studioのx64 Developer PowerShellで、ParaBusリポジトリを作業ディレクトリにします。
Git、CMake、Ninjaが利用できることを確認し、SDK ZIPを`target/asio-sdk/asiosdk.zip`へ手動配置します。
次のコマンドは、新規の検証用source / build directoryだけを使います。既存フォルダがあれば
削除・上書きせず停止するので、別の空ディレクトリ名を選んでください。

```powershell
# 固定SDKのhashと、既存フォルダを上書きしないことを確認する
$ErrorActionPreference = 'Stop'
$asioZip = (Resolve-Path 'target/asio-sdk/asiosdk.zip').Path.Replace('\', '/')
$asioSource = 'target/asio-source'
$asioBuild = 'target/asio-release'
if (Test-Path $asioSource) { throw 'source directory already exists' }
if (Test-Path $asioBuild) { throw 'build directory already exists' }
if ((Get-FileHash -LiteralPath $asioZip).Hash -ne 'D5EBF0C20DD2C5F43771FD0C1418F4B361BF52434EE670097CFA6B3A335E2ECA') {
    throw 'SDK checksum mismatch; review the new SDK first'
}

# PortAudioを正規repositoryから取得し、確認済みcommitへ固定する
git clone https://github.com/PortAudio/portaudio.git $asioSource
if ($LASTEXITCODE -ne 0) { throw 'PortAudio clone failed' }
git -C $asioSource checkout --detach 17967f32de95f2179e7f7caa9632a79c5d59a2ea
if ($LASTEXITCODE -ne 0) { throw 'PortAudio checkout failed' }

# SDKを明示してRelease構成にする。WindowsのパスはCMake向けに / へ正規化済み
$asioConfigureLog = @(cmake -S $asioSource -B $asioBuild -G Ninja `
    -DCMAKE_BUILD_TYPE=Release -DPA_BUILD_SHARED_LIBS=ON `
    -DPA_DLL_LINK_WITH_STATIC_RUNTIME=ON -DPA_USE_ASIO=ON `
    -DPA_BUILD_EXAMPLES=OFF -DPA_BUILD_TESTS=OFF `
    "-DASIO_SDK_ZIP_PATH=$asioZip" 2>&1)
$asioConfigureExit = $LASTEXITCODE
$asioConfigureLog
if ($asioConfigureExit -ne 0 -or
    ($asioConfigureLog | Select-String 'Downloading ASIO SDK') -or
    -not ($asioConfigureLog | Select-String 'Found ASIO SDK:')) {
    throw 'Configure must use the fixed SDK without downloading'
}

# 機器を開かずDLLだけをビルドし、SDK sourceの組み込みと出力hashを確認する
cmake --build $asioBuild --target portaudio --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'PortAudio build failed' }
if (-not (Select-String -LiteralPath "$asioBuild/build.ninja" -Pattern 'ASIOSDK.*common.*asio.cpp.obj')) {
    throw 'ASIO source is missing from the build graph'
}
Get-FileHash -LiteralPath "$asioBuild/portaudio.dll"
```

**注意:** このPortAudioの`FindASIO.cmake`はSDKが見つからない場合、自動取得を試みます。
`ASIO_SDK_ZIP_PATH`の絶対pathを`/`で正規化しないと、WindowsではZIPの検出に失敗しました。
`PA_USE_ASIO=ON`とDLLの生成成功だけではASIOの組み込みを保証しません。
configureのSDK検出と、`build.ninja`内のSDK sourceを両方確認してください。

SDKの展開先は新しいbuild directoryです。PortAudioはそこに`patched_asiolist.cpp`を生成し、
`delete lpdrv`を`delete[] lpdrv`へ変更してリンクします。配布する対応sourceには、
この生成変更を含む固定版のCMake手順も必要です。元ZIPを変更して配布しないでください。

## 今回の検証結果

- 現行インストール済み`portaudio_x64.dll`は、旧`target/asio-smoke/build/portaudio.dll`とhashが一致。
  SHA-256は`E1CB79F190C3570268B158B5F85AF29FC002FEC40925FDF7A52D6ED6E0DA7D60`で、旧構成はDebugだった。
- 初回の独立configureではWindows pathの扱いでSDKを再取得し、ASIOなしのDLLが生成された。
  SDK ZIPは上記hashのまま、稼働DLLも不変。初回の生成物は採用しない。
- 正規化pathを渡した`target/asio-release-check-20261002-pinned`では、自動取得なしで固定ZIPを展開。
  SDKの3 sourceと`pa_asio.cpp`をReleaseでコンパイルし、DLLを生成した。
  SHA-256は`2F10D998F7953FDCE6DB309ED2691E0B440CD8412B16A6929F34885B208AC89A`。
- upstreamの型変換警告C4244 / C4267は残る。warning 0や実機合格とは扱わない。
- 既存bindingのPortAudio参照は19個のordinal（名前ではなく番号によるリンク）。
  旧DLLと候補DLLの61個のnamed exportについて、番号と名前の対応がすべて一致した。
  候補DLLの依存はWindows system DLLだけで、外部MSVC runtime DLLへの依存はなかった。
- Node 22.23.2 / ABI 127で既存bindingと候補DLLを隔離フォルダからloadできた。
  さらにlockfileから新規展開したnaudiodon2 2.5.0 / segfault-handlerをReleaseでビルドし、
  package全体のrequire、候補DLLの実ロードpath、Opusの無音encode / decodeを確認した。
- 通常の`npm ci`はexit 0でもnaudiodon2が未導入だった。付属node-gyp 11.5.0が
  VS 2026を認識せず、optional dependencyのnative build失敗が省略されたため。
  隔離したnode-gyp 12.1.0でビルドすると成功した。upstreamの警告は残る。
- 同じPC上の新規dependency treeでの検証であり、別PC / clean OSでの合格ではない。
  ASIO device列挙・stream開始・実音声は未実施。アプリ再起動・稼働DLLの差し替えはせず、
  稼働DLLのhashは`E1CB79F190C3570268B158B5F85AF29FC002FEC40925FDF7A52D6ED6E0DA7D60`のまま。

## Node 22 / VS 2026の隔離導入確認

これは配布installerではなく、上記Release DLLとのload確認手順です。
通常の`npm ci`成功だけでASIO対応と判定しません。naudiodon2はoptional dependencyなので、
ビルド失敗時もnpmが成功扱いになることがあります。
[node-gyp 12.1.0](https://github.com/nodejs/node-gyp/releases/tag/v12.1.0)はVS 2026対応版で、
[必要なNode版](https://github.com/nodejs/node-gyp/blob/v12.1.0/package.json)は22.9以上を含む。
今回のNode 22.23.2付属node-gypは11.5.0だった。グローバルnpmやNodeを更新せず、
ビルドツールだけを検証フォルダへ導入する。

**セキュリティ注意:** native buildとpackageのrequireは取得したコードを実行します。
レビューしたlockfile、正規npm registry / Node配布元 / Discord.jsのprebuilt配布元だけを使い、
SDKとDLLのhashも確認してください。`--ignore-scripts`での展開後、必要なnative処理だけを明示実行します。

Visual Studioのx64 Developer PowerShellで、PATH先頭の`node`が22.23.4であることを確認してから実行します。
以下は新規検証フォルダだけを作成し、稼働中の`node_modules`には触れません。
`target/asio-release/portaudio.dll`は上の固定sourceから作った候補です。

```powershell
# Node版と新規フォルダを確認し、固定lockfileの依存をスクリプト無効で展開する
$ErrorActionPreference = 'Stop'
if ((node -p 'process.versions.node') -ne '22.23.4') { throw 'Use the checked Node 22.23.4 runtime' }
$asioInstall = [IO.Path]::GetFullPath('target/asio-install-check')
$asioTools = [IO.Path]::GetFullPath('target/asio-build-tools')
$asioDll = (Resolve-Path 'target/asio-release/portaudio.dll').Path
if ((Test-Path $asioInstall) -or (Test-Path $asioTools)) { throw 'Choose new check directories' }
New-Item -ItemType Directory -Path $asioInstall | Out-Null
Copy-Item -LiteralPath package.json,package-lock.json -Destination $asioInstall
npm install --prefix $asioTools node-gyp@12.1.0 --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Build tool installation failed' }
Push-Location $asioInstall
try {
    npm ci --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0) { throw 'Dependency extraction failed' }
    # 固定版Opusのprebuilt導入だけを明示実行する
    npm rebuild @discordjs/opus --foreground-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0) { throw 'Opus installation failed' }
} finally { Pop-Location }

# 対応版node-gypで、補助moduleと音声bindingだけをReleaseビルドする
foreach ($asioPackage in @('segfault-handler', 'naudiodon2')) {
    Push-Location "$asioInstall/node_modules/$asioPackage"
    try {
        node "$asioTools/node_modules/node-gyp/bin/node-gyp.js" rebuild "--devdir=$asioTools/node-headers"
        if ($LASTEXITCODE -ne 0) { throw "Native build failed: $asioPackage" }
    } finally { Pop-Location }
}

# 隔離側だけを候補DLLへ置換する。機器列挙・AudioIO生成はしない
Copy-Item -LiteralPath $asioDll -Destination "$asioInstall/node_modules/naudiodon2/build/Release/portaudio_x64.dll"
$asioLoadCheck = @'
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');
const dir = path.resolve(process.argv[1]);
const dll = path.join(dir, 'node_modules/naudiodon2/build/Release/portaudio_x64.dll');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(hash(dll), hash(process.argv[2]));
const audio = require(path.join(dir, 'node_modules/naudiodon2'));
for (const name of ['getDevices', 'getHostAPIs', 'AudioIO']) assert.equal(typeof audio[name], 'function');
const norm = p => p.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase();
const loaded = process.report.getReport().sharedObjects.filter(p => /portaudio|naudiodon|segfault-handler/i.test(p));
assert(loaded.some(p => norm(p) === norm(dll)));
assert(loaded.every(p => norm(p).startsWith(norm(dir) + '/')));
const { OpusEncoder } = require(path.join(dir, 'node_modules/@discordjs/opus'));
const encoder = new OpusEncoder(48000, 2);
assert.equal(encoder.decode(encoder.encode(Buffer.alloc(960 * 2 * 2))).length, 960 * 2 * 2);
console.log({ node: process.versions.node, abi: process.versions.modules, loaded, opusSelfCheck: true });
'@
node -e $asioLoadCheck $asioInstall $asioDll
if ($LASTEXITCODE -ne 0) { throw 'Isolated load check failed' }
```

DLLのコピーはordinal / export対応を確認した今回のnaudiodon2 2.5.0用であり、他の版への互換を保証しない。
再buildするとnaudiodon2同梱のDLLに戻るため、候補のコピーと実ロードpath確認はbuild後に行う。
requireだけでは`Pa_Initialize`を呼ばないことをsourceで確認した。
この手順に`getDevices()` / `getHostAPIs()` / `AudioIO()`呼び出しを追加しない。

## 配布前に残る確認

### 停止呼び出しの修正（2026-10-03）

naudiodon2 2.5.0のJS `abort()`は、引数1個を要求するnative `quit()`へ2個渡し、
`AudioIO Quit expects 1 argument`で機器の解放前に失敗した。Audientで実機再現を確認。
`scripts/patch-naudiodon.ts`は停止要求を1引数に直し、実際の完了をPromiseで返す。
重複した停止要求は同じPromiseへまとめる。C++ binding / PortAudio DLLは変更しない。

通常の`npm ci`のpostinstallで適用される。`--ignore-scripts`で導入した場合や既存検証環境では、
アプリを止めてから `npm.cmd run patch:audio-native` を実行する。音声bindingの再ビルドは不要。
適用後の `check:audio-native` は未適用のbindingを拒否する。想定外の版・sourceには適用しない。
ASIOは停止完了前の再オープンを拒否し、停止失敗時は明示的な本体再起動を要求する。
無音の停止→再オープンは成功したが、USB抜去・本番PC・長時間運転の合格とは別です。

### 当時の残項目と現在の確認範囲

- 別PC / clean OSでの導入、配布物への候補DLL組み込み、ASIO device列挙と実音声。
  同一PCの隔離load成功だけで本番差し替えや配布を行わない。
- [第三者原文](THIRD_PARTY_LICENSES.md)と実際の組み込み版の一致、DAVE等prebuilt内NOTICE。
- GPLv3に従った対応source・生成変更・ビルド手順の提供。現在のrelease stageだけでは不足する。
- SoundGrid / LV1等の実機確認、全著作権者の許諾、秘密設定・音声・案件情報の除外。

上記は当初の配布保留時点の記録です。2026-10-22の個別レビュー版では、対応ソース・原文表記・
部品hashを同梱し、EVO 4 / Audient ASIOでの音声確認を行いました。
現在の配布構成は[SOURCE_RELEASE.md](SOURCE_RELEASE.md)、正確な検証範囲と未確認事項は
[BETA.txt](BETA.txt)を参照してください。Windowsベータ版は[Releases](https://github.com/adilazkahadiko/ParaBus/releases)で公開しています。
別PC / SoundGridの本番確認は未完了です。
機器ドライバーは同梱しません。
