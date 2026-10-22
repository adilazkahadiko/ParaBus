#!/bin/sh
# Compatibility launcher. ParaBus.app is the normal packaged entry point.
cd "$(dirname "$0")" || exit 1
NODE=./runtime/node
[ -x "$NODE" ] || NODE=node
mkdir -p logs
if ! "$NODE" scripts/audio-native-check.ts || ! "$NODE" scripts/opus-native-check.ts; then
  echo "音声依存を読み込めません。README-TEST.txt の macOS の項目を確認してください。"
  read -r _
  exit 1
fi
exec /bin/sh scripts/start-router-macos.sh
