"""Processador de fila `deliveries` (MVP).

Regras:
- Pega envios com status queued|retrying que estão prontos (next_attempt_at <= now ou NULL)
- Tenta enviar (simulado)
- Em falha: backoff exponencial e status retrying; após max_attempts -> failed (DLQ)

Obs: Este worker não integra com provedores reais ainda.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from db import get_db, init_db, now_iso


def _should_fail(channel: str, to_addr: str, payload_json: str) -> bool:
    # Falha determinística para facilitar testes:
    # - to_addr contém "fail" ou
    # - payload_json tem {"force_fail": true}
    if "fail" in (to_addr or "").lower():
        return True
    try:
        obj = json.loads(payload_json) if payload_json else {}
        if isinstance(obj, dict) and obj.get("force_fail") is True:
            return True
    except Exception:
        pass
    if (channel or "").lower() == "fail":
        return True
    return False


def _backoff_seconds(attempt: int) -> int:
    # attempt começa em 1
    base = 15
    # 15s, 30s, 60s, 120s, 240s...
    return min(base * (2 ** max(0, attempt - 1)), 60 * 60)


def process_once(batch: int = 50) -> dict:
    init_db()
    now = datetime.now(timezone.utc)

    processed = 0
    sent = 0
    failed = 0
    retried = 0

    with get_db() as db:
        rows = db.execute(
            """
            SELECT id, tenant_id, campaign_id, channel, to_addr, payload_json, status, attempts, max_attempts
            FROM deliveries
            WHERE status IN ('queued','retrying')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY id ASC
            LIMIT ?
            """,
            (now.replace(microsecond=0).isoformat(), int(batch)),
        ).fetchall()

        for r in rows:
            delivery_id = int(r["id"])
            attempts = int(r["attempts"] or 0)
            max_attempts = int(r["max_attempts"] or 5)
            channel = str(r["channel"] or "")
            to_addr = str(r["to_addr"] or "")
            payload_json = str(r["payload_json"] or "{}")

            next_attempt = attempts + 1

            # marca como sending (melhora a leitura de status, reduz duplicidade)
            db.execute(
                """
                UPDATE deliveries
                SET status = 'sending', attempts = ?, updated_at = ?
                WHERE id = ?
                """,
                (next_attempt, now_iso(), delivery_id),
            )

            if _should_fail(channel, to_addr, payload_json):
                if next_attempt >= max_attempts:
                    db.execute(
                        """
                        UPDATE deliveries
                        SET status = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ?
                        WHERE id = ?
                        """,
                        ("Simulated failure (DLQ)", now_iso(), delivery_id),
                    )
                    failed += 1
                else:
                    wait = _backoff_seconds(next_attempt)
                    na = (now + timedelta(seconds=wait)).replace(microsecond=0).isoformat()
                    db.execute(
                        """
                        UPDATE deliveries
                        SET status = 'retrying', last_error = ?, next_attempt_at = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        ("Simulated failure", na, now_iso(), delivery_id),
                    )
                    retried += 1
            else:
                db.execute(
                    """
                    UPDATE deliveries
                    SET status = 'sent', last_error = NULL, next_attempt_at = NULL, updated_at = ?
                    WHERE id = ?
                    """,
                    (now_iso(), delivery_id),
                )
                sent += 1

            processed += 1

    return {"processed": processed, "sent": sent, "retried": retried, "failed": failed, "ts": now_iso()}


def main() -> None:
    out = process_once(batch=50)
    print(out)


if __name__ == "__main__":
    main()
