// Gerado em runtime no Docker (docker-entrypoint.sh).
// Fallback para dev local (sem Docker).
window.__ENV__ = window.__ENV__ || {
  PUBLIC_API_BASE: "http://localhost:8000",
  PUBLIC_WEB_BASE: "http://localhost:5173",
};
