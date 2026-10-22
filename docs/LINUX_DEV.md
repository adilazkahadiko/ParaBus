# Linux開発環境

Ubuntu 24.04などGCC 13を使う環境では、`naudiodon2`のビルド時に標準C++ヘッダーを明示する必要があります。

リポジトリのルートで次を実行してください。

```bash
bash scripts/setup-linux-dev.sh
npm run typecheck
npm test
```

セットアップスクリプトは、Linux上のネイティブビルドにだけ `-include string` を追加してから `npm ci` を実行します。Windowsの起動方法やアプリ本体の挙動には影響しません。
