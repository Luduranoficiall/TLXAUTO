#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git config core.hooksPath .githooks

echo "Auto-push ativado (core.hooksPath=.githooks)."
echo "Para desligar: git config --unset core.hooksPath"
