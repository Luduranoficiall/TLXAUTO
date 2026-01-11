"""Smoke test rápido do TLX-ADS (sem subir servidor).

Roda a API in-process via TestClient e valida os fluxos principais:
- register/login (token)
- /auth/me
- CRUD básico de ads + schedule
- PATCH limpando scheduled_at com null
- filtros em /ads
- job protegido /jobs/run-due
- listagem de deliveries

Uso:
  TLX_ADS_DB_PATH=/tmp/tlx_ads_test.sqlite3 \
  JWT_SECRET=dev-test PWD_SALT=pepper ADMIN_KEY=adm \
  python smoke_test.py
"""

from __future__ import annotations

import os
import tempfile

# IMPORTANTE: setar DB path antes de importar a app (db.py lê env no import)
if not os.getenv("TLX_ADS_DB_PATH"):
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".sqlite3")
    os.environ["TLX_ADS_DB_PATH"] = tmp.name

os.environ.setdefault("JWT_SECRET", "dev-test")
os.environ.setdefault("PWD_SALT", "pepper")
os.environ.setdefault("ADMIN_KEY", "adm")

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402


def main() -> None:
    with TestClient(app) as c:
        r = c.get("/health")
        assert r.status_code == 200 and r.json().get("ok") is True

        email = "user_test@tlxads.local"
        pw = "senha123"

        r = c.post("/auth/register", json={"email": email, "password": pw})
        assert r.status_code == 200, r.text
        body = r.json()
        tok = body["access_token"]
        assert int(body.get("tenant_id") or 0) > 0
        assert str(body.get("role") or "")

        r = c.get("/auth/me", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200 and r.json()["email"] == email

        r = c.post(
            "/ads",
            json={
                "title": "Meu anúncio",
                "body": "Texto",
                "channel": "whatsapp",
                "target_url": None,
            },
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200
        ad_id = r.json()["id"]

        # templates + render
        r = c.post(
            "/templates",
            json={"name": "promo", "body": "Oi {{nome}}, confira!"},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200, r.text
        tpl_id = r.json()["id"]

        r = c.post(
            "/ads",
            json={
                "title": "Meu anúncio 2",
                "body": "placeholder",
                "channel": "whatsapp",
                "template_id": tpl_id,
                "variables": {"nome": "Ana"},
            },
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200, r.text
        assert "rendered_body" in r.json()

        r = c.post(
            f"/ads/{ad_id}/schedule",
            params={"scheduled_at": "2026-01-11T15:00:00+00:00"},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200 and r.json()["status"] == "scheduled"

        # bug importante: limpar scheduled_at com null via PATCH
        r = c.patch(
            f"/ads/{ad_id}",
            json={"status": "draft", "scheduled_at": None},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200 and r.json()["scheduled_at"] is None

        r = c.get(
            "/ads",
            params={"status": "draft", "q": "Meu", "limit": 10, "offset": 0},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200 and len(r.json()) >= 1

        r = c.post("/jobs/run-due", headers={"X-Admin-Key": "wrong"})
        assert r.status_code == 403

        r = c.post("/jobs/run-due", headers={"X-Admin-Key": os.getenv("ADMIN_KEY", "")})
        assert r.status_code == 200

        r = c.get(
            f"/ads/{ad_id}/deliveries",
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200 and isinstance(r.json(), list)

        # short link + redirect + métricas
        r = c.post(
            "/links",
            json={
                "destination_url": "https://example.com/landing",
                "ad_id": ad_id,
                "utm_source": "tlxauto",
                "utm_medium": "whatsapp",
                "utm_campaign": "teste",
            },
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200, r.text
        slug = r.json()["slug"]

        r = c.get(f"/r/{slug}", follow_redirects=False)
        assert r.status_code in (301, 302, 307, 308)
        assert "location" in {k.lower() for k in r.headers.keys()}

        r = c.post("/events/conversion", params={"slug": slug})
        assert r.status_code == 200 and r.json().get("ok") is True

        r = c.get("/dashboard", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200
        d = r.json()
        assert int(d.get("clicks") or 0) >= 1
        assert int(d.get("conversions") or 0) >= 1

    print("smoke_ok")


if __name__ == "__main__":
    main()
