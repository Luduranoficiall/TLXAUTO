# TLXAUTO

Projeto iniciado em 10/01/2026.

## Objetivo

O **TLXAUTO** é uma **plataforma de divulgações de anúncios** (MVP + upgrades profissionais), com:

- autenticação (JWT)
- anúncios (draft/scheduled/sent/paused)
- templates com variáveis (ex.: `Oi {{nome}}`)
- short links + UTM
- métricas (cliques + conversões) e dashboard
- base pronta para multi-tenant + RBAC (admin/editor/viewer)

Stack escolhida:

- **Backend:** Python (FastAPI) + SQLite (por enquanto)
- **Frontend:** TypeScript puro (sem framework)

## Como vamos trabalhar

- Primeiro: definir escopo (MVP)
- Depois: escolher stack e inicializar o projeto
- Em seguida: rodar localmente e iterar por features

## Rodar local (dev) — TLXAUTO (anúncios)

O código do produto atual está em `tlx-ads/`.

> Observação: existe código antigo no repositório (de outro domínio). Não é o foco do TLXAUTO hoje — estamos evoluindo **um único produto** (plataforma de anúncios) sem duplicar aplicações.

### Rodar o backend

1. Abra um terminal em `tlx-ads/backend/`

1. Crie e ative um venv

1. Instale as dependências do `requirements.txt`

1. Exporte as variáveis (ou use as do `.env`):

- `JWT_SECRET`
- `PWD_SALT`
- `ADMIN_KEY`

1. Suba o servidor:

- `uvicorn main:app --reload --host 0.0.0.0 --port 8000`

Se você estiver rodando o backend antigo do TLXAUTO ao mesmo tempo, use outra porta aqui (ex.: `8001`) e ajuste o `API_BASE` no frontend.

### Rodar o frontend (tlx-ads)

Em `tlx-ads/frontend/`:

1. Instalar deps e compilar TypeScript (gera `dist/app.js`):

- `npm install`
- `npx tsc`

1. Servir como SPA (suporta deep links tipo `/accept-invite`):

- `npx serve -s . -l 5173`

> Nota: existe um `.npmrc` local neste frontend para evitar que configs globais (ex.: `~/.npmrc` com `workspaces=true`) quebrem o `npm install` aqui.

Acesso:

- Frontend: `http://localhost:5173`
- Backend (Swagger): `http://localhost:8000/docs`

## Rodar tudo com Docker (pronto pra rodar)

Na raiz do repositório:

1) Ajuste os valores do `.env` (principalmente `JWT_SECRET`, `PWD_SALT`, `ADMIN_KEY`, `PUBLIC_WEB_BASE`, `PUBLIC_API_BASE`).

2) Suba os serviços:

- `docker-compose up --build`

Serviços expostos:

- Web (frontend): `http://localhost:5173`
- API (Swagger): `http://localhost:8000/docs`
- Redis: `localhost:6379`
- OTel Collector (OTLP HTTP): `http://localhost:4318/v1/traces`

> Postgres também sobe (`localhost:5432`) para o caminho de migração/RLS, mas o backend atual ainda usa SQLite. O volume do SQLite fica persistido em `tlxadsdata`.

### Multi-tenant (opcional)

Nos endpoints de auth, você pode enviar `tenant_slug`:

- `POST /auth/register`: se `tenant_slug` for novo, cria um tenant e coloca o usuário como `admin`
- `POST /auth/login`: autentica no tenant informado (se vazio, usa `default`)

O token JWT inclui `tid` (tenant id) e `role`.

### Endpoints PRO (MVP)

- Templates: `GET /templates`, `POST /templates`
- Short link: `POST /links` (gera slug)
- Redirect público: `GET /r/{slug}` (registra click)
- Conversão pública: `POST /events/conversion?slug=...`
- Dashboard: `GET /dashboard`

### Convites de equipe (token) + reset de senha

- Criar convite (admin do tenant):
  - `POST /tenants/{tenant_id}/members/invite-token`
- Aceitar convite (público):
  - `POST /auth/accept-invite`
- Solicitar reset (público, não vaza existência do email):
  - `POST /auth/request-password-reset`
- Confirmar reset (público):
  - `POST /auth/confirm-password-reset`

> Em DEV, se `DEV_RETURN_TOKEN_LINKS=1`, a API devolve o `token`/`link` na resposta para facilitar testes.

### Impressões reais via pixel (público)

- Pixel 1x1 GIF:
  - `GET /px/impression.gif?tenant_id=1&ad_id=123`
  - opcional: `link_slug=...`

`PIXEL_ALLOWED_ORIGINS` controla quando o header `Origin` pode habilitar CORS (não bloqueia o pixel, só controla registro quando `Origin` não está allowlisted).

### Scheduler (cron) para agendamentos

Além do endpoint `/jobs/run-due`, existe o script:

- `tlx-ads/backend/jobs/cron_run_due.py`

Ele pode ser rodado por cron para processar anúncios `scheduled` vencidos.

### Rate limit Redis (multi-instância) + fallback

Se `REDIS_URL` estiver definido, o rate limit do auth usa Redis. Se ficar vazio, usa memória (dev).

### Observabilidade (OpenTelemetry OTLP)

Se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver definido, o backend instrumenta FastAPI/requests e exporta traces via OTLP/HTTP.

### Postgres RLS (upgrade futuro)

SQL de referência em `docs/postgres_rls.sql`.

### Smoke test (sem subir servidor)

Em `tlx-ads/backend/` você pode rodar `smoke_test.py` para validar o fluxo principal (auth + ads + templates + links + métricas).

## Repositório GitHub

Este projeto está versionado em:

- <https://github.com/Luduranoficiall/TLXAUTO>

### Auto-push (envia sozinho para o GitHub)

Este repositório vem com um hook versionado em `.githooks/post-commit`.

- Se `core.hooksPath` estiver apontando para `.githooks`, **todo `git commit` vai fazer `git push` automaticamente**.
- Para desativar temporariamente: `export TLXAUTO_AUTOPUSH=0`
- Para desativar de vez: `git config --unset core.hooksPath`

Para reativar em qualquer máquina:

- `./scripts/setup-autopush.sh`
