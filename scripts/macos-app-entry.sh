#!/bin/sh
# Finder may translocate an unsigned app away from its sibling runtime/scripts.
# Ask for the real extracted package instead of relying on private macOS APIs.
package_root=$(CDPATH= cd -P "$(dirname "$0")/../../.." && pwd) || exit 1
if [ ! -f "$package_root/runtime/node" ] || [ ! -f "$package_root/scripts/start-router-macos.sh" ]; then
    package_root=$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "ParaBusの展開フォルダーを選んでください（runtime・scripts・ParaBus.appが入ったフォルダー）。")') || exit 1
    package_root=$(CDPATH= cd -P "$package_root" && pwd) || exit 1
fi
if [ ! -f "$package_root/release-build-info.json" ] || [ ! -f "$package_root/runtime/node" ] || [ ! -f "$package_root/scripts/start-router-macos.sh" ] || [ ! -d "$package_root/ParaBus.app" ]; then
    /usr/bin/osascript -e 'display alert "ParaBusの展開フォルダーではありません。ZIPをフォルダーごと展開してください。"'
    exit 1
fi
exec /bin/sh "$package_root/scripts/start-router-macos.sh"
