#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# naudiodon2 2.5.0 relies on an indirect <string> include that GCC 13 no
# longer provides. Force that standard header during the Linux native build.
export CXXFLAGS="${CXXFLAGS:+$CXXFLAGS }-include string"

npm ci --legacy-peer-deps --foreground-scripts
