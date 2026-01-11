from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

from db import now_iso


PLAN_FREE = "free"
PLAN_PRO = "pro"
PLAN_BUSINESS = "business"
PLAN_ENTERPRISE = "enterprise"


@dataclass(frozen=True)
class PlanLimits:
    ads_created_monthly: Optional[int]
    templates_created_monthly: Optional[int]
    links_created_monthly: Optional[int]
    invites_created_monthly: Optional[int]
    sends_daily_total: Optional[int]


LIMITS_BY_PLAN: dict[str, PlanLimits] = {
    PLAN_FREE: PlanLimits(
        ads_created_monthly=50,
        templates_created_monthly=20,
        links_created_monthly=200,
        invites_created_monthly=20,
        sends_daily_total=200,
    ),
    PLAN_PRO: PlanLimits(
        ads_created_monthly=300,
        templates_created_monthly=200,
        links_created_monthly=2000,
        invites_created_monthly=200,
        sends_daily_total=2000,
    ),
    PLAN_BUSINESS: PlanLimits(
        ads_created_monthly=2000,
        templates_created_monthly=1000,
        links_created_monthly=20000,
        invites_created_monthly=2000,
        sends_daily_total=20000,
    ),
    PLAN_ENTERPRISE: PlanLimits(
        ads_created_monthly=None,
        templates_created_monthly=None,
        links_created_monthly=None,
        invites_created_monthly=None,
        sends_daily_total=None,
    ),
}


def _utc_day_key(dt: Optional[datetime] = None) -> str:
    d = dt or datetime.now(timezone.utc)
    return d.date().isoformat()


def _utc_month_key(dt: Optional[datetime] = None) -> str:
    d = dt or datetime.now(timezone.utc)
    return f"{d.year:04d}-{d.month:02d}"


def _get_limits(plan: str) -> PlanLimits:
    return LIMITS_BY_PLAN.get(str(plan or PLAN_FREE), LIMITS_BY_PLAN[PLAN_FREE])


def ensure_plan_row(db, tenant_id: int) -> None:
    """Garante que existe um row em tenant_plans (fallback para free/active)."""
    ts = now_iso()
    db.execute(
        """
        INSERT OR IGNORE INTO tenant_plans (tenant_id, plan, status, trial_ends_at, current_period_end, created_at, updated_at)
        VALUES (?, ?, 'active', NULL, NULL, ?, ?)
        """,
        (int(tenant_id), PLAN_FREE, ts, ts),
    )


def get_plan(db, tenant_id: int) -> tuple[str, str]:
    ensure_plan_row(db, tenant_id)
    row = db.execute(
        "SELECT plan, status FROM tenant_plans WHERE tenant_id = ?",
        (int(tenant_id),),
    ).fetchone()
    if not row:
        return (PLAN_FREE, "active")
    plan = str(row["plan"] or PLAN_FREE)
    status = str(row["status"] or "active")
    return (plan, status)


def _ensure_usage_month_row(db, tenant_id: int, month: str) -> None:
    ts = now_iso()
    db.execute(
        """
        INSERT OR IGNORE INTO tenant_usage_monthly (
          tenant_id, month,
          ads_created, templates_created, links_created, invites_created,
          created_at, updated_at
        ) VALUES (?, ?, 0, 0, 0, 0, ?, ?)
        """,
        (int(tenant_id), month, ts, ts),
    )


def _ensure_usage_day_row(db, tenant_id: int, day: str) -> None:
    ts = now_iso()
    db.execute(
        """
        INSERT OR IGNORE INTO tenant_usage_daily (
          tenant_id, day,
          sends_total, sends_whatsapp, sends_x, sends_email,
          created_at, updated_at
        ) VALUES (?, ?, 0, 0, 0, 0, ?, ?)
        """,
        (int(tenant_id), day, ts, ts),
    )


def _quota_exceeded(detail: str) -> None:
    # 402: Payment Required (bom para quotas/planos)
    raise HTTPException(status_code=402, detail=detail)


def check_monthly_resource_or_raise(db, tenant_id: int, field: str, amount: int = 1) -> None:
    plan, status = get_plan(db, tenant_id)
    if status in ("canceled",):
        _quota_exceeded("Plano inativo. Atualize sua assinatura para continuar.")

    limits = _get_limits(plan)
    month = _utc_month_key()
    _ensure_usage_month_row(db, tenant_id, month)

    if field == "ads_created":
        limit = limits.ads_created_monthly
    elif field == "templates_created":
        limit = limits.templates_created_monthly
    elif field == "links_created":
        limit = limits.links_created_monthly
    elif field == "invites_created":
        limit = limits.invites_created_monthly
    else:
        raise HTTPException(status_code=500, detail=f"Unknown usage field: {field}")

    if limit is None:
        return

    row = db.execute(
        f"SELECT {field} as v FROM tenant_usage_monthly WHERE tenant_id = ? AND month = ?",
        (int(tenant_id), month),
    ).fetchone()
    current = int(row["v"] or 0) if row else 0

    if current + int(amount) > int(limit):
        _quota_exceeded(f"Limite do plano atingido para {field} (mês {month}).")


def increment_monthly_resource(db, tenant_id: int, field: str, amount: int = 1) -> None:
    month = _utc_month_key()
    _ensure_usage_month_row(db, tenant_id, month)
    ts = now_iso()
    db.execute(
        f"UPDATE tenant_usage_monthly SET {field} = {field} + ?, updated_at = ? WHERE tenant_id = ? AND month = ?",
        (int(amount), ts, int(tenant_id), month),
    )


def check_daily_send_or_raise(db, tenant_id: int, amount: int = 1) -> None:
    plan, status = get_plan(db, tenant_id)
    if status in ("canceled",):
        _quota_exceeded("Plano inativo. Atualize sua assinatura para continuar.")

    limits = _get_limits(plan)
    if limits.sends_daily_total is None:
        return

    day = _utc_day_key()
    _ensure_usage_day_row(db, tenant_id, day)

    row = db.execute(
        "SELECT sends_total FROM tenant_usage_daily WHERE tenant_id = ? AND day = ?",
        (int(tenant_id), day),
    ).fetchone()
    current = int(row[0] or 0) if row else 0

    if current + int(amount) > int(limits.sends_daily_total):
        _quota_exceeded(f"Limite diário de envios atingido (dia {day}).")


def increment_daily_send(db, tenant_id: int, channel: str, amount: int = 1) -> None:
    day = _utc_day_key()
    _ensure_usage_day_row(db, tenant_id, day)
    ts = now_iso()

    channel_key = "sends_total"
    ch = str(channel or "").strip().lower()
    if ch == "whatsapp":
        channel_key = "sends_whatsapp"
    elif ch in ("x", "twitter"):
        channel_key = "sends_x"
    elif ch == "email":
        channel_key = "sends_email"

    # total + específico
    db.execute(
        """
        UPDATE tenant_usage_daily
        SET sends_total = sends_total + ?,
            {channel_key} = {channel_key} + ?,
            updated_at = ?
        WHERE tenant_id = ? AND day = ?
        """.format(channel_key=channel_key),
        (int(amount), int(amount), ts, int(tenant_id), day),
    )


def plan_snapshot(db, tenant_id: int) -> dict[str, Any]:
    plan, status = get_plan(db, tenant_id)
    limits = _get_limits(plan)

    month = _utc_month_key()
    day = _utc_day_key()
    _ensure_usage_month_row(db, tenant_id, month)
    _ensure_usage_day_row(db, tenant_id, day)

    m = db.execute(
        """
        SELECT ads_created, templates_created, links_created, invites_created
        FROM tenant_usage_monthly WHERE tenant_id = ? AND month = ?
        """,
        (int(tenant_id), month),
    ).fetchone()
    d = db.execute(
        """
        SELECT sends_total, sends_whatsapp, sends_x, sends_email
        FROM tenant_usage_daily WHERE tenant_id = ? AND day = ?
        """,
        (int(tenant_id), day),
    ).fetchone()

    return {
        "tenant_id": int(tenant_id),
        "plan": plan,
        "status": status,
        "limits": {
            "ads_created_monthly": limits.ads_created_monthly,
            "templates_created_monthly": limits.templates_created_monthly,
            "links_created_monthly": limits.links_created_monthly,
            "invites_created_monthly": limits.invites_created_monthly,
            "sends_daily_total": limits.sends_daily_total,
        },
        "usage": {
            "month": month,
            "ads_created": int(m[0] or 0) if m else 0,
            "templates_created": int(m[1] or 0) if m else 0,
            "links_created": int(m[2] or 0) if m else 0,
            "invites_created": int(m[3] or 0) if m else 0,
            "day": day,
            "sends_total": int(d[0] or 0) if d else 0,
            "sends_whatsapp": int(d[1] or 0) if d else 0,
            "sends_x": int(d[2] or 0) if d else 0,
            "sends_email": int(d[3] or 0) if d else 0,
        },
    }
