#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$ROOT_DIR/.venv/bin/python"

if [[ ! -x "$PY" ]]; then
  echo "Python venv não encontrado em: $PY"
  echo "Abra o projeto no VS Code e deixe o Python criar o venv, ou crie manualmente em $ROOT_DIR/.venv"
  exit 1
fi

echo "Iniciando backend (FastAPI) em http://127.0.0.1:8000 ..."
(
  cd "$ROOT_DIR/backend"
  "$PY" -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
) &
BACKEND_PID=$!

cleanup() {
  echo "\nParando backend (PID $BACKEND_PID)..."
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Dá um pequeno tempo para o backend subir
sleep 0.4

echo "Iniciando frontend (Vite) em http://127.0.0.1:5173 ..."
(
  cd "$ROOT_DIR/frontend"
  npm_config_workspaces=false npm run dev -- --host 127.0.0.1 --port 5173
)
