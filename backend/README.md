# TLXAUTO Backend (FastAPI)

## Rodar

- Recomendado: criar um venv e instalar dependências via pip usando o `pyproject.toml`.

Servidor (a partir de `backend/`):

- `uvicorn app:app --reload --host 0.0.0.0 --port 8000`

Endpoints iniciais:

- `GET /api/health`
- `GET /api/customers`
- `POST /api/customers`
- `GET /api/vehicles`
- `POST /api/vehicles`
- `GET /api/service-orders`
- `POST /api/service-orders`
