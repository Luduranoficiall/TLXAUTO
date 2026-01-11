#!/bin/sh
set -eu

API_BASE="${PUBLIC_API_BASE:-http://localhost:8000}"
WEB_BASE="${PUBLIC_WEB_BASE:-http://localhost:5173}"

cat > /web/env.js <<EOF
window.__ENV__ = {
  PUBLIC_API_BASE: "${API_BASE}",
  PUBLIC_WEB_BASE: "${WEB_BASE}"
};
EOF

exec "$@"
