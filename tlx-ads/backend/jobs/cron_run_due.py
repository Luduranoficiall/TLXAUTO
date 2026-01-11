"""Job por cron: processa anúncios scheduled vencidos.

Este script evita depender de Redis/RQ para o MVP.
Ele replica a lógica do endpoint /jobs/run-due, mas rodando local (sem servidor).

Uso (exemplo):
  TLX_ADS_DB_PATH=/var/lib/tlxauto/data.sqlite3 \
  JWT_SECRET=... PWD_SALT=... \
  /path/to/python cron_run_due.py

Cron (a cada minuto):
  * * * * * /path/to/python /.../tlx-ads/backend/jobs/cron_run_due.py >> /var/log/tlx_run_due.log 2>&1
"""

from __future__ import annotations

from datetime import datetime, timezone

from db import get_db, init_db, now_iso
from saas import check_daily_send_or_raise, increment_daily_send


def main() -> None:
    init_db()
    now = datetime.now(timezone.utc)

    with get_db() as db:
        rows = db.execute(
            """
            SELECT id, tenant_id, channel, scheduled_at
            FROM ads
            WHERE status = 'scheduled' AND scheduled_at IS NOT NULL
            """
        ).fetchall()

        sent = 0
        for r in rows:
            ad_id = int(r["id"])
            tenant_id = int(r["tenant_id"])
            channel = str(r["channel"] or "")
            try:
                sched = datetime.fromisoformat(str(r["scheduled_at"]).replace("Z", "+00:00"))
            except Exception:
                continue

            if sched <= now:
                try:
                    check_daily_send_or_raise(db, tenant_id, 1)
                except Exception as e:
                    # registra falha e mantém status scheduled
                    db.execute(
                        """
                        INSERT INTO ad_deliveries (ad_id, delivered_at, result, details)
                        VALUES (?, ?, 'fail', ?)
                        """,
                        (ad_id, now_iso(), f"Quota exceeded: {getattr(e, 'detail', str(e))}"),
                    )
                    continue

                db.execute(
                    "UPDATE ads SET status = 'sent', updated_at = ? WHERE id = ?",
                    (now_iso(), ad_id),
                )
                db.execute(
                    """
                    INSERT INTO ad_deliveries (ad_id, delivered_at, result, details)
                    VALUES (?, ?, 'ok', ?)
                    """,
                    (ad_id, now_iso(), "Cron delivery"),
                )
                increment_daily_send(db, tenant_id, channel, 1)
                sent += 1

    print({"sent": sent, "ts": now_iso()})


if __name__ == "__main__":
    main()
