#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git config --unset core.hooksPath || true

echo "Auto-push desativado (core.hooksPath removido)."
