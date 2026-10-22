#!/bin/sh
# Shared by Finder's .app and the compatibility .command launcher.
package_root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd) || exit 1
cd "$package_root" || exit 1
case "$package_root" in /|"$HOME"|"$HOME/Downloads"|"$HOME/Desktop"|/Applications) echo 'ZIPを専用フォルダーへ展開してください' >&2; exit 1;; esac
[ -f scripts/start-router.ts ] || exit 1
mkdir -p logs || exit 1

# Only our extracted package is touched. -s acts on symlinks themselves, never
# following a link to another directory. Never disable system-wide Gatekeeper.
if [ "$(uname -s)" = Darwin ] && [ -f release-build-info.json ] && [ -f runtime/node ] && [ ! -f .parabus-quarantine-cleared ]; then
    if ! /usr/bin/xattr -drs com.apple.quarantine "$package_root" >> logs/router.log 2>&1; then
        /usr/bin/osascript -e 'display alert "ParaBusの初回準備に失敗しました。書き込み可能な専用フォルダーに展開し直してください。詳細はlogs/router.logにあります。"'
        exit 1
    fi
    touch .parabus-quarantine-cleared || exit 1
fi

node_executable="$package_root/runtime/node"
if [ ! -x "$node_executable" ]; then
    # Packaged apps never silently switch to a different system Node version.
    if [ -f release-build-info.json ]; then echo '同梱runtime/nodeを実行できません。ZIPを展開し直してください' >> logs/router.log; exit 1; fi
    node_executable=$(command -v node) || exit 1
fi
launcher_pid=
stop_launcher() {
    trap '' TERM HUP INT
    if [ -n "$launcher_pid" ]; then
        kill -TERM "$launcher_pid" 2>/dev/null || true
        wait "$launcher_pid"
        exit $?
    fi
    exit 0
}
trap stop_launcher TERM HUP INT
DBR_APP_PID=$$ "$node_executable" scripts/start-router.ts >> logs/router.log 2>&1 &
launcher_pid=$!
wait "$launcher_pid"
exit $?
