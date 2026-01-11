import json
from typing import Any, Optional

from db import get_db


def write_audit(
    tenant_id: int,
    actor_user_id: Optional[int],
    action: str,
    entity: str,
    entity_id: Optional[str],
    meta: dict[str, Any],
) -> None:
    with get_db() as db:
        db.execute(
            """
            INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity, entity_id, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant_id,
                actor_user_id,
                action,
                entity,
                entity_id,
                json.dumps(meta, ensure_ascii=False),
                __import__("datetime").datetime.utcnow().isoformat() + "Z",
            ),
        )
