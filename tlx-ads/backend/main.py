from datetime import datetime, timezone, timedelta
from typing import List, Optional

import sqlite3

import os
try:
    import stripe
except Exception:  # pragma: no cover
    stripe = None

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import RedirectResponse
from fastapi.responses import Response

from auth import create_token_tenant, decode_token, hash_password, verify_password
from db import get_db, init_db
from models import (
    AdCreateIn,
    AdOut,
    AdUpdateIn,
    CampaignCreateIn,
    CampaignOut,
    CampaignUpdateIn,
    DashboardOut,
    DashboardHistoryOut,
    DashboardHistoryPoint,
    DashboardChannelsOut,
    DashboardChannelPoint,
    DashboardCampaignsOut,
    DashboardCampaignPoint,
    DashboardCampaignConvOut,
    DashboardCampaignConvPoint,
    DashboardSlaOut,
    DeliveryOut,
    DeliveryQueueCreateIn,
    DeliveryQueueOut,
    AutomationSegmentSendIn,
    AutomationSegmentSendOut,
    LinkCreateIn,
    LinkOut,
    LoginIn,
    ContactCreateIn,
    ContactOut,
    ContactUpdateIn,
    MeOut,
    MemberOut,
    MemberRoleUpdateIn,
    RegisterIn,
    SegmentCreateIn,
    SegmentMemberAddIn,
    SegmentOut,
    SegmentUpdateIn,
    TenantCreateIn,
    TenantOut,
    InviteCreateIn,
    InviteOut,
    AcceptInviteIn,
    PasswordResetRequestIn,
    PasswordResetConfirmIn,
    TemplateCreateIn,
    TemplateOut,
    TemplatePreviewIn,
    TemplatePreviewOut,
    TokenOut,
    PlanCheckoutIn,
    PlanCheckoutOut,
)

from audit import write_audit
from metrics_util import ctr
from rate_limit_redis import get_rate_limiter
from rbac import ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER, require_role
from shortener import generate_slug
from templates_util import render_template
from token_utils import secure_token
from utm import add_utm

from saas import (
    check_daily_send_or_raise,
    check_monthly_resource_or_raise,
    increment_daily_send,
    increment_monthly_resource,
    plan_snapshot,
    set_plan,
    get_stripe_refs,
)

from otel import setup_otel

from jobs.worker_deliveries import process_once as process_deliveries_once

app = FastAPI(title="TLX Ads Platform", version="1.0.0")

setup_otel(app)

security = HTTPBearer(auto_error=False)

auth_limiter = get_rate_limiter(limit_per_min=int(os.getenv("RATE_LIMIT_PER_MIN", "60")), prefix="auth")

# CORS (ajuste domínios em produção)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def require_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Missing bearer token")

    payload = decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")
    return payload


def require_ctx(user: dict = Depends(require_user)) -> dict:
    # tid/role entram via token (multi-tenant). Em modo compat, init_db cria tenant default e memberships.
    try:
        tid = int(user.get("tid") or 0)
    except Exception:
        tid = 0
    role = str(user.get("role") or ROLE_VIEWER)
    if tid <= 0:
        try:
            with get_db() as db:
                row = db.execute("SELECT id FROM tenants WHERE slug = ?", ("default",)).fetchone()
                if row:
                    tid = int(row[0])
        except Exception:
            pass
    return {"user_id": int(user["sub"]), "email": str(user.get("email", "")), "tenant_id": tid, "role": role}


def _normalize_slug(value: str) -> str:
    v = (value or "").strip().lower()
    v = v.replace(" ", "-")
    ok = all(c.isalnum() or c in "-_" for c in v)
    if not v or not ok:
        raise HTTPException(status_code=400, detail="tenant_slug inválido")
    return v


def _get_tenant_id_by_slug(db, slug: str) -> Optional[int]:
    row = db.execute("SELECT id FROM tenants WHERE slug = ?", (slug,)).fetchone()
    return int(row[0]) if row else None


def _tenant_or_403(ctx: dict, tenant_id: int) -> None:
    if int(ctx.get("tenant_id") or 0) != int(tenant_id):
        raise HTTPException(status_code=403, detail="Tenant mismatch")


def _must_membership(db, tenant_id: int, user_id: int) -> sqlite3.Row:
    row = db.execute(
        "SELECT role, created_at FROM memberships WHERE tenant_id = ? AND user_id = ?",
        (tenant_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="Not a member")
    return row


def _env_truthy(name: str) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _public_web_base() -> str:
    return (os.getenv("PUBLIC_WEB_BASE") or os.getenv("PUBLIC_BASE_URL") or "http://localhost:5173").rstrip("/")


PLAN_PRICE_ENV = {
    "free": "STRIPE_PRICE_FREE",
    "pro": "STRIPE_PRICE_PRO",
    "business": "STRIPE_PRICE_BUSINESS",
}


def _stripe_enabled() -> bool:
    return bool((os.getenv("STRIPE_SECRET_KEY") or "").strip()) and stripe is not None


def _stripe_init() -> None:
    if stripe is None:
        raise HTTPException(status_code=500, detail="Stripe library not installed")
    key = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Stripe not configured")
    stripe.api_key = key


def _price_id_for_plan(plan: str) -> Optional[str]:
    env = PLAN_PRICE_ENV.get(str(plan or "").strip().lower())
    if not env:
        return None
    return (os.getenv(env) or "").strip() or None


def _plan_for_price_id(price_id: str) -> Optional[str]:
    pid = str(price_id or "").strip()
    for plan, env in PLAN_PRICE_ENV.items():
        if (os.getenv(env) or "").strip() == pid:
            return plan
    return None


def _normalize_plan_status(value: str) -> str:
    v = str(value or "active").strip().lower()
    if v in ("active", "trialing", "past_due", "canceled"):
        return v
    if v in ("incomplete", "unpaid", "incomplete_expired"):
        return "past_due"
    return "active"


def _unix_to_iso(ts: Optional[int]) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), timezone.utc).replace(microsecond=0).isoformat()


def _find_tenant_by_stripe(db, subscription_id: Optional[str], customer_id: Optional[str]) -> int:
    sub = str(subscription_id or "").strip()
    cust = str(customer_id or "").strip()
    if not sub and not cust:
        return 0
    row = db.execute(
        "SELECT tenant_id FROM tenant_plans WHERE stripe_subscription_id = ? OR stripe_customer_id = ?",
        (sub, cust),
    ).fetchone()
    return int(row[0]) if row else 0


PIXEL_GIF_BYTES = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!"
    b"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00"
    b"\x00\x02\x02D\x01\x00;"
)


def _validate_iso8601(value: str) -> None:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(status_code=400, detail="scheduled_at must be ISO 8601")


@app.on_event("startup")
def _startup():
    init_db()


@app.get("/health")
def health():
    return {"ok": True, "ts": now_iso()}


@app.post("/auth/register", response_model=TokenOut)
def register(data: RegisterIn, request: Request):
    auth_limiter.hit(f"register:{request.client.host if request.client else 'unknown'}")
    created_at = now_iso()
    pwd_hash = hash_password(data.password)

    with get_db() as db:
        try:
            db.execute(
                "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
                (data.email.lower(), pwd_hash, created_at),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Email already registered")

        row = db.execute(
            "SELECT id, email FROM users WHERE email = ?",
            (data.email.lower(),),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=500, detail="Could not create user")

        # tenant: se passar slug e não existir, cria. Caso contrário usa default.
        tenant_slug = _normalize_slug(data.tenant_slug) if data.tenant_slug else "default"
        tenant_id = _get_tenant_id_by_slug(db, tenant_slug)
        if tenant_id is None and data.tenant_slug:
            tenant_name = (data.tenant_name or tenant_slug).strip()[:120]
            db.execute(
                "INSERT INTO tenants (name, slug, created_at) VALUES (?, ?, ?)",
                (tenant_name or tenant_slug, tenant_slug, created_at),
            )
            tenant_id = _get_tenant_id_by_slug(db, tenant_slug)
        if tenant_id is None:
            tenant_id = _get_tenant_id_by_slug(db, "default")
        if tenant_id is None:
            raise HTTPException(status_code=500, detail="Tenant default ausente")

        user_id = int(row["id"])
        # vira admin do tenant criado/default (por enquanto, sem convites)
        db.execute(
            "INSERT OR IGNORE INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
            (tenant_id, user_id, ROLE_ADMIN, created_at),
        )

    token = create_token_tenant(user_id, int(tenant_id), row["email"], ROLE_ADMIN)
    write_audit(int(tenant_id), user_id, "auth.register", "user", str(user_id), {"email": row["email"]})
    return {"access_token": token, "tenant_id": int(tenant_id), "role": ROLE_ADMIN}


@app.post("/auth/login", response_model=TokenOut)
def login(data: LoginIn, request: Request):
    auth_limiter.hit(f"login:{request.client.host if request.client else 'unknown'}")
    with get_db() as db:
        row = db.execute(
            "SELECT id, email, password_hash FROM users WHERE email = ?",
            (data.email.lower(),),
        ).fetchone()

        if not row or not verify_password(data.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid credentials")

        tenant_slug = _normalize_slug(data.tenant_slug) if data.tenant_slug else "default"
        tenant_id = _get_tenant_id_by_slug(db, tenant_slug)
        if tenant_id is None:
            raise HTTPException(status_code=404, detail="Tenant not found")

        membership = db.execute(
            "SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?",
            (tenant_id, int(row["id"])),
        ).fetchone()
        if not membership:
            raise HTTPException(status_code=403, detail="User is not a member of this tenant")

        role = str(membership[0])

    token = create_token_tenant(int(row["id"]), int(tenant_id), row["email"], role)
    write_audit(int(tenant_id), int(row["id"]), "auth.login", "user", str(int(row["id"])), {"email": row["email"]})
    return {"access_token": token, "tenant_id": int(tenant_id), "role": role}


@app.post("/tenants", response_model=TenantOut)
def create_tenant(data: TenantCreateIn, ctx: dict = Depends(require_ctx)):
    user_id = int(ctx["user_id"])
    ts = now_iso()
    slug = _normalize_slug(data.slug)

    with get_db() as db:
        try:
            db.execute(
                "INSERT INTO tenants (name, slug, created_at) VALUES (?, ?, ?)",
                (data.name.strip()[:120], slug, ts),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Tenant slug already exists")

        tenant_id = _get_tenant_id_by_slug(db, slug)
        if not tenant_id:
            raise HTTPException(status_code=500, detail="Could not create tenant")

        db.execute(
            "INSERT OR IGNORE INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
            (int(tenant_id), user_id, ROLE_ADMIN, ts),
        )

        row = db.execute(
            "SELECT id, name, slug, created_at FROM tenants WHERE id = ?",
            (int(tenant_id),),
        ).fetchone()

    write_audit(int(tenant_id), user_id, "tenants.create", "tenant", str(int(tenant_id)), {"slug": slug})
    return dict(row)


@app.get("/tenants/{tenant_id}/members", response_model=List[MemberOut])
def list_members(tenant_id: int, ctx: dict = Depends(require_ctx)):
    _tenant_or_403(ctx, tenant_id)
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        rows = db.execute(
            """
            SELECT m.user_id as user_id, u.email as email, m.role as role, m.created_at as created_at
            FROM memberships m
            JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = ?
            ORDER BY m.id ASC
            """,
            (tenant_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.patch("/tenants/{tenant_id}/members/{user_id}", response_model=MemberOut)
def update_member_role(tenant_id: int, user_id: int, data: MemberRoleUpdateIn, ctx: dict = Depends(require_ctx)):
    _tenant_or_403(ctx, tenant_id)
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_ADMIN)

    new_role = str(data.role).strip().lower()
    if new_role not in (ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER):
        raise HTTPException(status_code=400, detail="Invalid role")

    with get_db() as db:
        _must_membership(db, tenant_id, int(ctx["user_id"]))
        cur = db.execute(
            "UPDATE memberships SET role = ? WHERE tenant_id = ? AND user_id = ?",
            (new_role, tenant_id, user_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Member not found")

        row = db.execute(
            """
            SELECT m.user_id as user_id, u.email as email, m.role as role, m.created_at as created_at
            FROM memberships m
            JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = ? AND m.user_id = ?
            """,
            (tenant_id, user_id),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "members.update_role", "membership", f"{tenant_id}:{user_id}", {"role": new_role})
    return dict(row)


@app.get("/saas/plan")
def saas_plan(ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        return plan_snapshot(db, tenant_id)


@app.post("/billing/checkout-session", response_model=PlanCheckoutOut)
def billing_checkout_session(data: PlanCheckoutIn, ctx: dict = Depends(require_ctx)):
    plan = str(data.plan or "").strip().lower()
    if plan not in ("free", "pro", "business"):
        raise HTTPException(status_code=400, detail="Plano invalido")

    _stripe_init()
    price_id = _price_id_for_plan(plan)
    if not price_id:
        raise HTTPException(status_code=400, detail="Stripe price id nao configurado")

    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    with get_db() as db:
        stripe_customer_id, _ = get_stripe_refs(db, tenant_id)

    success_url = (os.getenv("STRIPE_SUCCESS_URL") or f"{_public_web_base()}/planos?success=1").strip()
    cancel_url = (os.getenv("STRIPE_CANCEL_URL") or f"{_public_web_base()}/planos?canceled=1").strip()

    session_params: dict = {
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "client_reference_id": f"tenant:{tenant_id}",
        "metadata": {"tenant_id": str(tenant_id), "user_id": str(ctx.get("user_id")), "plan": plan},
        "subscription_data": {"metadata": {"tenant_id": str(tenant_id), "user_id": str(ctx.get("user_id")), "plan": plan}},
        "allow_promotion_codes": True,
    }
    if stripe_customer_id:
        session_params["customer"] = stripe_customer_id
    else:
        session_params["customer_email"] = str(ctx.get("email") or "")

    session = stripe.checkout.Session.create(**session_params)
    if not session or not session.url:
        raise HTTPException(status_code=500, detail="Stripe checkout nao disponivel")
    return {"url": session.url}


@app.post("/billing/portal", response_model=PlanCheckoutOut)
def billing_portal(ctx: dict = Depends(require_ctx)):
    _stripe_init()
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    with get_db() as db:
        stripe_customer_id, _ = get_stripe_refs(db, tenant_id)
    if not stripe_customer_id:
        raise HTTPException(status_code=400, detail="Cliente Stripe nao encontrado")

    return_url = (os.getenv("STRIPE_BILLING_PORTAL_RETURN_URL") or f"{_public_web_base()}/planos").strip()
    session = stripe.billing_portal.Session.create(customer=stripe_customer_id, return_url=return_url)
    if not session or not session.url:
        raise HTTPException(status_code=500, detail="Portal Stripe indisponivel")
    return {"url": session.url}


@app.post("/billing/change-plan", response_model=PlanCheckoutOut)
def billing_change_plan(data: PlanCheckoutIn, ctx: dict = Depends(require_ctx)):
    plan = str(data.plan or "").strip().lower()
    if plan not in ("free", "pro", "business"):
        raise HTTPException(status_code=400, detail="Plano invalido")

    _stripe_init()
    price_id = _price_id_for_plan(plan)
    if not price_id:
        raise HTTPException(status_code=400, detail="Stripe price id nao configurado")

    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    with get_db() as db:
        stripe_customer_id, stripe_subscription_id = get_stripe_refs(db, tenant_id)

    if not stripe_subscription_id:
        # sem assinatura, cria checkout
        return billing_checkout_session(data, ctx)

    sub = stripe.Subscription.retrieve(stripe_subscription_id)
    items = sub.get("items", {}).get("data", [])
    if not items:
        raise HTTPException(status_code=400, detail="Assinatura sem itens")
    item_id = items[0].get("id")

    stripe.Subscription.modify(
        stripe_subscription_id,
        cancel_at_period_end=False,
        proration_behavior="create_prorations",
        items=[{"id": item_id, "price": price_id}],
    )

    with get_db() as db:
        set_plan(db, tenant_id, plan, "active", current_period_end=_unix_to_iso(sub.get("current_period_end")), stripe_customer_id=stripe_customer_id, stripe_subscription_id=stripe_subscription_id)

    return {"url": f"{_public_web_base()}/planos?success=1"}


@app.post("/billing/cancel", response_model=PlanCheckoutOut)
def billing_cancel(ctx: dict = Depends(require_ctx)):
    _stripe_init()
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    with get_db() as db:
        stripe_customer_id, stripe_subscription_id = get_stripe_refs(db, tenant_id)
    if not stripe_subscription_id:
        raise HTTPException(status_code=400, detail="Assinatura nao encontrada")

    sub = stripe.Subscription.modify(stripe_subscription_id, cancel_at_period_end=True)
    items = sub.get("items", {}).get("data", [])
    price_id = items[0].get("price", {}).get("id") if items else ""
    plan = _plan_for_price_id(price_id) or "free"
    with get_db() as db:
        set_plan(
            db,
            tenant_id,
            plan,
            "canceled",
            current_period_end=_unix_to_iso(sub.get("current_period_end")),
            stripe_customer_id=stripe_customer_id,
            stripe_subscription_id=stripe_subscription_id,
        )

    return {"url": f"{_public_web_base()}/planos?canceled=1"}


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    if not _stripe_enabled():
        raise HTTPException(status_code=400, detail="Stripe webhook not configured")

    secret = (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=400, detail="Stripe webhook secret missing")

    payload = await request.body()
    sig = request.headers.get("stripe-signature")
    if not sig:
        raise HTTPException(status_code=400, detail="Missing stripe-signature")

    _stripe_init()
    try:
        event = stripe.Webhook.construct_event(payload=payload, sig_header=sig, secret=secret)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Stripe signature")

    if hasattr(event, "to_dict"):
        event = event.to_dict()  # type: ignore

    event_type = str(event.get("type") or "")
    event_id = str(event.get("id") or "")

    with get_db() as db:
        if event_id:
            row = db.execute("SELECT id FROM stripe_events WHERE id = ?", (event_id,)).fetchone()
            if row:
                return {"ok": True}
            db.execute("INSERT INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)", (event_id, event_type, now_iso()))

        if event_type in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
            sub = event.get("data", {}).get("object", {})
            items = sub.get("items", {}).get("data", [])
            price_id = items[0].get("price", {}).get("id") if items else ""
            plan = _plan_for_price_id(price_id) or str(sub.get("metadata", {}).get("plan") or "free")
            tenant_id = int(sub.get("metadata", {}).get("tenant_id") or 0)
            customer_id = sub.get("customer")
            subscription_id = sub.get("id")

            if tenant_id <= 0:
                tenant_id = _find_tenant_by_stripe(db, subscription_id, customer_id)
            if tenant_id > 0:
                status = _normalize_plan_status(sub.get("status") or "active")
                current_period_end = _unix_to_iso(sub.get("current_period_end"))
                set_plan(
                    db,
                    tenant_id,
                    plan,
                    status,
                    current_period_end=current_period_end,
                    stripe_customer_id=customer_id,
                    stripe_subscription_id=subscription_id,
                )

        if event_type in ("invoice.payment_succeeded", "invoice.payment_failed"):
            inv = event.get("data", {}).get("object", {})
            lines = inv.get("lines", {}).get("data", [])
            price_id = lines[0].get("price", {}).get("id") if lines else ""
            plan = _plan_for_price_id(price_id) or str(inv.get("metadata", {}).get("plan") or "free")
            tenant_id = int(inv.get("metadata", {}).get("tenant_id") or 0)
            customer_id = inv.get("customer")
            subscription_id = inv.get("subscription")
            period_end = None
            if lines:
                period_end = lines[0].get("period", {}).get("end")
            status = "active" if event_type == "invoice.payment_succeeded" else "past_due"
            if tenant_id <= 0:
                tenant_id = _find_tenant_by_stripe(db, subscription_id, customer_id)
            if tenant_id > 0:
                set_plan(
                    db,
                    tenant_id,
                    plan,
                    status,
                    current_period_end=_unix_to_iso(period_end),
                    stripe_customer_id=customer_id,
                    stripe_subscription_id=subscription_id,
                )

        if event_type == "checkout.session.completed":
            session = event.get("data", {}).get("object", {})
            if session.get("mode") == "subscription":
                tenant_id = int(session.get("metadata", {}).get("tenant_id") or 0)
                if tenant_id > 0:
                    plan = str(session.get("metadata", {}).get("plan") or "free")
                    set_plan(
                        db,
                        tenant_id,
                        plan,
                        "active",
                        current_period_end=None,
                        stripe_customer_id=session.get("customer"),
                        stripe_subscription_id=session.get("subscription"),
                    )

    return {"ok": True}


@app.get("/campaigns", response_model=List[CampaignOut])
def list_campaigns(
    ctx: dict = Depends(require_ctx),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        rows = db.execute(
            """
            SELECT id, tenant_id, name, objective, status, start_at, end_at, created_at, updated_at
            FROM campaigns
            WHERE tenant_id = ?
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            (tenant_id, int(limit), int(offset)),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/campaigns", response_model=CampaignOut)
def create_campaign(data: CampaignCreateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)
    ts = now_iso()

    with get_db() as db:
        cur = db.execute(
            """
            INSERT INTO campaigns (tenant_id, name, objective, status, start_at, end_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (tenant_id, data.name.strip(), data.objective, data.status, data.start_at, data.end_at, ts, ts),
        )
        cid = int(cur.lastrowid)
        row = db.execute(
            """
            SELECT id, tenant_id, name, objective, status, start_at, end_at, created_at, updated_at
            FROM campaigns WHERE id = ? AND tenant_id = ?
            """,
            (cid, tenant_id),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "campaigns.create", "campaign", str(cid), {"name": data.name})
    return dict(row)


@app.patch("/campaigns/{campaign_id}", response_model=CampaignOut)
def update_campaign(campaign_id: int, data: CampaignUpdateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    fields: dict[str, object] = {}
    if data.name is not None:
        fields["name"] = data.name.strip()
    if "objective" in data.model_fields_set:
        fields["objective"] = data.objective
    if data.status is not None:
        fields["status"] = data.status
    if "start_at" in data.model_fields_set:
        fields["start_at"] = data.start_at
    if "end_at" in data.model_fields_set:
        fields["end_at"] = data.end_at
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    fields["updated_at"] = now_iso()

    set_clause = ", ".join([f"{k} = ?" for k in fields.keys()])
    params = list(fields.values()) + [int(campaign_id), int(tenant_id)]

    with get_db() as db:
        cur = db.execute(
            f"UPDATE campaigns SET {set_clause} WHERE id = ? AND tenant_id = ?",
            tuple(params),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Campaign not found")
        row = db.execute(
            """
            SELECT id, tenant_id, name, objective, status, start_at, end_at, created_at, updated_at
            FROM campaigns WHERE id = ? AND tenant_id = ?
            """,
            (int(campaign_id), int(tenant_id)),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "campaigns.update", "campaign", str(int(campaign_id)), {"fields": sorted(list(fields.keys()))})
    return dict(row)


@app.delete("/campaigns/{campaign_id}")
def delete_campaign(campaign_id: int, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    with get_db() as db:
        cur = db.execute("DELETE FROM campaigns WHERE id = ? AND tenant_id = ?", (int(campaign_id), int(tenant_id)))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Campaign not found")

    write_audit(tenant_id, int(ctx["user_id"]), "campaigns.delete", "campaign", str(int(campaign_id)), {})
    return {"deleted": True}


@app.get("/contacts", response_model=List[ContactOut])
def list_contacts(
    ctx: dict = Depends(require_ctx),
    q: Optional[str] = Query(default=None, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    where = ["tenant_id = ?"]
    params: list[object] = [tenant_id]
    if q:
        where.append("(name LIKE ? OR email LIKE ? OR phone LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like, like])
    where_sql = " AND ".join(where)

    with get_db() as db:
        rows = db.execute(
            f"""
            SELECT id, tenant_id, name, email, phone, consent_at, meta_json, created_at, updated_at
            FROM contacts
            WHERE {where_sql}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            tuple(params + [int(limit), int(offset)]),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/contacts", response_model=ContactOut)
def create_contact(data: ContactCreateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)
    ts = now_iso()

    email = (data.email or "").strip().lower() or None
    phone = (data.phone or "").strip() or None
    if not email and not phone:
        raise HTTPException(status_code=400, detail="email or phone is required")

    import json

    meta_json = json.dumps(data.meta, ensure_ascii=False) if data.meta is not None else None

    with get_db() as db:
        try:
            cur = db.execute(
                """
                INSERT INTO contacts (tenant_id, name, email, phone, consent_at, meta_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (tenant_id, data.name, email, phone, data.consent_at, meta_json, ts, ts),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Contact already exists (email/phone)")

        cid = int(cur.lastrowid)
        row = db.execute(
            """
            SELECT id, tenant_id, name, email, phone, consent_at, meta_json, created_at, updated_at
            FROM contacts WHERE id = ? AND tenant_id = ?
            """,
            (cid, tenant_id),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "contacts.create", "contact", str(cid), {"email": email, "phone": phone})
    return dict(row)


@app.patch("/contacts/{contact_id}", response_model=ContactOut)
def update_contact(contact_id: int, data: ContactUpdateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    import json

    fields: dict[str, object] = {}
    if "name" in data.model_fields_set:
        fields["name"] = data.name
    if "email" in data.model_fields_set:
        fields["email"] = (data.email or "").strip().lower() or None
    if "phone" in data.model_fields_set:
        fields["phone"] = (data.phone or "").strip() or None
    if "consent_at" in data.model_fields_set:
        fields["consent_at"] = data.consent_at
    if "meta" in data.model_fields_set:
        fields["meta_json"] = json.dumps(data.meta, ensure_ascii=False) if data.meta is not None else None

    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    fields["updated_at"] = now_iso()

    set_clause = ", ".join([f"{k} = ?" for k in fields.keys()])
    params = list(fields.values()) + [int(contact_id), int(tenant_id)]

    with get_db() as db:
        try:
            cur = db.execute(
                f"UPDATE contacts SET {set_clause} WHERE id = ? AND tenant_id = ?",
                tuple(params),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Contact already exists (email/phone)")

        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Contact not found")

        row = db.execute(
            """
            SELECT id, tenant_id, name, email, phone, consent_at, meta_json, created_at, updated_at
            FROM contacts WHERE id = ? AND tenant_id = ?
            """,
            (int(contact_id), int(tenant_id)),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "contacts.update", "contact", str(int(contact_id)), {"fields": sorted(list(fields.keys()))})
    return dict(row)


@app.delete("/contacts/{contact_id}")
def delete_contact(contact_id: int, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    with get_db() as db:
        cur = db.execute("DELETE FROM contacts WHERE id = ? AND tenant_id = ?", (int(contact_id), int(tenant_id)))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Contact not found")

    write_audit(tenant_id, int(ctx["user_id"]), "contacts.delete", "contact", str(int(contact_id)), {})
    return {"deleted": True}


@app.get("/segments", response_model=List[SegmentOut])
def list_segments(ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        rows = db.execute(
            "SELECT id, tenant_id, name, created_at, updated_at FROM segments WHERE tenant_id = ? ORDER BY id DESC",
            (tenant_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/segments", response_model=SegmentOut)
def create_segment(data: SegmentCreateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)
    ts = now_iso()

    with get_db() as db:
        try:
            cur = db.execute(
                "INSERT INTO segments (tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (tenant_id, data.name.strip(), ts, ts),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Segment already exists")

        sid = int(cur.lastrowid)
        row = db.execute(
            "SELECT id, tenant_id, name, created_at, updated_at FROM segments WHERE id = ? AND tenant_id = ?",
            (sid, tenant_id),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "segments.create", "segment", str(sid), {"name": data.name})
    return dict(row)


@app.patch("/segments/{segment_id}", response_model=SegmentOut)
def update_segment(segment_id: int, data: SegmentUpdateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    name = str(data.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Invalid name")
    ts = now_iso()

    with get_db() as db:
        cur = db.execute(
            "UPDATE segments SET name = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
            (name, ts, int(segment_id), int(tenant_id)),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Segment not found")
        row = db.execute(
            "SELECT id, tenant_id, name, created_at, updated_at FROM segments WHERE id = ? AND tenant_id = ?",
            (int(segment_id), int(tenant_id)),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "segments.update", "segment", str(int(segment_id)), {"name": name})
    return dict(row)


@app.delete("/segments/{segment_id}")
def delete_segment(segment_id: int, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    with get_db() as db:
        cur = db.execute("DELETE FROM segments WHERE id = ? AND tenant_id = ?", (int(segment_id), int(tenant_id)))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Segment not found")

    write_audit(tenant_id, int(ctx["user_id"]), "segments.delete", "segment", str(int(segment_id)), {})
    return {"deleted": True}


@app.get("/segments/{segment_id}/members")
def list_segment_members(segment_id: int, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        seg = db.execute("SELECT id FROM segments WHERE id = ? AND tenant_id = ?", (int(segment_id), int(tenant_id))).fetchone()
        if not seg:
            raise HTTPException(status_code=404, detail="Segment not found")
        rows = db.execute(
            """
            SELECT c.id, c.name, c.email, c.phone, c.consent_at
            FROM segment_members sm
            JOIN contacts c ON c.id = sm.contact_id
            WHERE sm.segment_id = ? AND c.tenant_id = ?
            ORDER BY sm.id DESC
            """,
            (int(segment_id), int(tenant_id)),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/segments/{segment_id}/members")
def add_segment_member(segment_id: int, data: SegmentMemberAddIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)
    ts = now_iso()

    with get_db() as db:
        seg = db.execute("SELECT id FROM segments WHERE id = ? AND tenant_id = ?", (int(segment_id), int(tenant_id))).fetchone()
        if not seg:
            raise HTTPException(status_code=404, detail="Segment not found")
        contact = db.execute("SELECT id FROM contacts WHERE id = ? AND tenant_id = ?", (int(data.contact_id), int(tenant_id))).fetchone()
        if not contact:
            raise HTTPException(status_code=404, detail="Contact not found")

        db.execute(
            "INSERT OR IGNORE INTO segment_members (segment_id, contact_id, created_at) VALUES (?, ?, ?)",
            (int(segment_id), int(data.contact_id), ts),
        )

    write_audit(tenant_id, int(ctx["user_id"]), "segments.add_member", "segment_member", f"{segment_id}:{data.contact_id}", {})
    return {"ok": True}


@app.delete("/segments/{segment_id}/members/{contact_id}")
def remove_segment_member(segment_id: int, contact_id: int, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    with get_db() as db:
        seg = db.execute("SELECT id FROM segments WHERE id = ? AND tenant_id = ?", (int(segment_id), int(tenant_id))).fetchone()
        if not seg:
            raise HTTPException(status_code=404, detail="Segment not found")
        cur = db.execute(
            "DELETE FROM segment_members WHERE segment_id = ? AND contact_id = ?",
            (int(segment_id), int(contact_id)),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Member not found")

    write_audit(tenant_id, int(ctx["user_id"]), "segments.remove_member", "segment_member", f"{segment_id}:{contact_id}", {})
    return {"deleted": True}


@app.post("/automation/segment-send", response_model=AutomationSegmentSendOut)
def automation_segment_send(data: AutomationSegmentSendIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    scheduled_at = data.scheduled_at.strip() if data.scheduled_at else None
    if scheduled_at:
        _validate_iso8601(scheduled_at)

    channel = str(data.channel or "").strip().lower()
    variables = data.variables or {}
    body = data.body

    with get_db() as db:
        seg = db.execute(
            "SELECT id FROM segments WHERE id = ? AND tenant_id = ?",
            (int(data.segment_id), int(tenant_id)),
        ).fetchone()
        if not seg:
            raise HTTPException(status_code=404, detail="Segment not found")

        if data.campaign_id is not None:
            ok = db.execute(
                "SELECT id FROM campaigns WHERE id = ? AND tenant_id = ?",
                (int(data.campaign_id), int(tenant_id)),
            ).fetchone()
            if not ok:
                raise HTTPException(status_code=404, detail="Campaign not found")

        if data.template_id is not None:
            tpl = db.execute(
                "SELECT body FROM templates WHERE id = ? AND tenant_id = ?",
                (int(data.template_id), int(tenant_id)),
            ).fetchone()
            if not tpl:
                raise HTTPException(status_code=404, detail="Template not found")
            body = render_template(str(tpl[0]), variables)
        elif variables:
            body = render_template(body, variables)

        contacts = db.execute(
            """
            SELECT c.id, c.email, c.phone
            FROM segment_members sm
            JOIN contacts c ON c.id = sm.contact_id
            WHERE sm.segment_id = ? AND c.tenant_id = ?
            """,
            (int(data.segment_id), int(tenant_id)),
        ).fetchall()

        queued = 0
        failed = 0
        skipped = 0
        ts = now_iso()

        import json

        for c in contacts:
            to_addr = ""
            if channel == "email":
                to_addr = str(c["email"] or "").strip()
            else:
                to_addr = str(c["phone"] or "").strip()
            if not to_addr:
                skipped += 1
                continue

            try:
                check_daily_send_or_raise(db, tenant_id, 1)
            except HTTPException:
                failed += 1
                break

            payload_json = json.dumps(
                {"body": body, "template_id": data.template_id, "variables": variables},
                ensure_ascii=False,
            )
            key = secure_token(16)
            db.execute(
                """
                INSERT INTO deliveries (
                  tenant_id, campaign_id, channel, to_addr, payload_json, idempotency_key,
                  status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 5, ?, NULL, ?, ?)
                """,
                (int(tenant_id), data.campaign_id, channel, to_addr, payload_json, key, scheduled_at, ts, ts),
            )
            increment_daily_send(db, tenant_id, channel, 1)
            queued += 1

    write_audit(tenant_id, int(ctx["user_id"]), "automation.segment_send", "segment", str(int(data.segment_id)), {"queued": queued})
    return {"queued": queued, "failed": failed, "skipped": skipped}


@app.post("/deliveries", response_model=DeliveryQueueOut)
def enqueue_delivery(data: DeliveryQueueCreateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    ts = now_iso()
    channel = str(data.channel).strip().lower()
    to_addr = str(data.to_addr).strip()
    key = (data.idempotency_key or secure_token(16)).strip()

    import json

    payload_json = json.dumps(data.payload or {}, ensure_ascii=False)

    with get_db() as db:
        # valida campaign_id no tenant (se vier)
        if data.campaign_id is not None:
            ok = db.execute(
                "SELECT id FROM campaigns WHERE id = ? AND tenant_id = ?",
                (int(data.campaign_id), int(tenant_id)),
            ).fetchone()
            if not ok:
                raise HTTPException(status_code=404, detail="Campaign not found")

        # Quota diária de envios (contabiliza no enqueue)
        check_daily_send_or_raise(db, tenant_id, 1)

        try:
            cur = db.execute(
                """
                INSERT INTO deliveries (
                  tenant_id, campaign_id, channel, to_addr, payload_json, idempotency_key,
                  status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 5, ?, NULL, ?, ?)
                """,
                (int(tenant_id), data.campaign_id, channel, to_addr, payload_json, key, ts, ts, ts),
            )
            did = int(cur.lastrowid)
        except sqlite3.IntegrityError:
            # idempotência: retorna o existente
            row = db.execute(
                """
                SELECT id, tenant_id, campaign_id, channel, to_addr, status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at
                FROM deliveries WHERE tenant_id = ? AND idempotency_key = ?
                """,
                (int(tenant_id), key),
            ).fetchone()
            if not row:
                raise
            return dict(row)

        increment_daily_send(db, tenant_id, channel, 1)

        row = db.execute(
            """
            SELECT id, tenant_id, campaign_id, channel, to_addr, status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at
            FROM deliveries WHERE id = ? AND tenant_id = ?
            """,
            (did, int(tenant_id)),
        ).fetchone()

    write_audit(tenant_id, int(ctx["user_id"]), "deliveries.enqueue", "delivery", str(int(row["id"])), {"channel": channel})
    return dict(row)


@app.get("/deliveries", response_model=List[DeliveryQueueOut])
def list_deliveries_queue(
    ctx: dict = Depends(require_ctx),
    status: Optional[str] = Query(default=None, max_length=20),
    campaign_id: Optional[int] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    where = ["tenant_id = ?"]
    params: list[object] = [tenant_id]
    if status:
        where.append("status = ?")
        params.append(status)
    if campaign_id is not None:
        where.append("campaign_id = ?")
        params.append(int(campaign_id))
    where_sql = " AND ".join(where)

    with get_db() as db:
        rows = db.execute(
            f"""
            SELECT id, tenant_id, campaign_id, channel, to_addr, status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at
            FROM deliveries
            WHERE {where_sql}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            tuple(params + [int(limit), int(offset)]),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/tenants/{tenant_id}/members/invite-token", response_model=InviteOut)
def invite_member_token(tenant_id: int, data: InviteCreateIn, request: Request, ctx: dict = Depends(require_ctx)):
    # rate limit por IP + tenant
    ip = request.client.host if request and request.client else "unknown"
    auth_limiter.hit(f"invite:{tenant_id}:{ip}")

    _tenant_or_403(ctx, tenant_id)
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_ADMIN)

    email = data.email.lower().strip()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    inv_role = str(data.role or ROLE_VIEWER).strip().lower()
    if inv_role not in (ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER):
        raise HTTPException(status_code=400, detail="Invalid role")

    token = secure_token(32)
    expires_at = datetime.now(timezone.utc) + __import__("datetime").timedelta(hours=48)
    ts = now_iso()

    invite_base = (data.invite_base_url or (_public_web_base() + "/accept-invite")).strip()

    with get_db() as db:
        check_monthly_resource_or_raise(db, tenant_id, "invites_created", 1)

        # evita spam: se já tem convite ativo para esse email no tenant, retorna 409
        existing = db.execute(
            """
            SELECT id FROM invite_tokens
            WHERE tenant_id = ? AND email = ? AND used_at IS NULL AND expires_at > ?
            """,
            (tenant_id, email, ts),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Invite already active")

        db.execute(
            """
            INSERT INTO invite_tokens (tenant_id, email, role, token, expires_at, used_at, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
            """,
            (tenant_id, email, inv_role, token, expires_at.replace(microsecond=0).isoformat(), ts),
        )

        increment_monthly_resource(db, tenant_id, "invites_created", 1)

    link = f"{invite_base}?token={token}"
    write_audit(tenant_id, int(ctx["user_id"]), "invite.create", "invite_token", None, {"email": email, "role": inv_role})

    out = {"ok": True, "invite_link": link, "expires_at": expires_at.replace(microsecond=0).isoformat()}
    if _env_truthy("DEV_RETURN_TOKEN_LINKS"):
        out["token"] = token
    return out


@app.post("/auth/accept-invite", response_model=TokenOut)
def accept_invite(data: AcceptInviteIn):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    ts = now_iso()

    with get_db() as db:
        inv = db.execute(
            "SELECT id, tenant_id, email, role, token, expires_at, used_at FROM invite_tokens WHERE token = ?",
            (data.token,),
        ).fetchone()
        if not inv:
            raise HTTPException(status_code=404, detail="Invalid token")
        if inv["used_at"] is not None:
            raise HTTPException(status_code=409, detail="Token already used")
        try:
            exp = datetime.fromisoformat(str(inv["expires_at"]).replace("Z", "+00:00"))
        except Exception:
            exp = now
        if exp <= now:
            raise HTTPException(status_code=410, detail="Token expired")

        email = str(inv["email"]).lower().strip()
        tenant_id = int(inv["tenant_id"])
        role = str(inv["role"]) or ROLE_VIEWER

        # cria user se não existir; se existir, redefine senha (MVP)
        u = db.execute("SELECT id, email FROM users WHERE email = ?", (email,)).fetchone()
        if not u:
            pwd_hash = hash_password(data.password)
            db.execute(
                "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
                (email, pwd_hash, ts),
            )
            u = db.execute("SELECT id, email FROM users WHERE email = ?", (email,)).fetchone()
        else:
            pwd_hash = hash_password(data.password)
            db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (pwd_hash, int(u["id"])))

        user_id = int(u["id"]) if u else 0

        existing = db.execute(
            "SELECT id FROM memberships WHERE tenant_id = ? AND user_id = ?",
            (tenant_id, user_id),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Already a member")

        db.execute(
            "INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
            (tenant_id, user_id, role, ts),
        )
        db.execute("UPDATE invite_tokens SET used_at = ? WHERE id = ?", (ts, int(inv["id"])))

    write_audit(tenant_id, user_id, "invite.accept", "membership", None, {"email": email, "role": role})
    token = create_token_tenant(user_id, tenant_id, email, role)
    return {"access_token": token, "tenant_id": tenant_id, "role": role}


@app.post("/auth/request-password-reset")
def request_password_reset(data: PasswordResetRequestIn):
    email = data.email.lower().strip()
    if not email:
        return {"ok": True}

    reset_base = (data.reset_base_url or (_public_web_base() + "/reset-password")).strip()
    token = secure_token(32)
    expires_at = datetime.now(timezone.utc) + __import__("datetime").timedelta(hours=2)
    ts = now_iso()

    with get_db() as db:
        u = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if not u:
            return {"ok": True}

        db.execute(
            "INSERT INTO password_reset_tokens (user_id, token, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)",
            (int(u[0]), token, expires_at.replace(microsecond=0).isoformat(), ts),
        )

    write_audit(0, int(u[0]), "auth.pwd_reset_request", "user", str(int(u[0])), {})
    link = f"{reset_base}?token={token}"
    out: dict = {"ok": True}
    if _env_truthy("DEV_RETURN_TOKEN_LINKS"):
        out["reset_link"] = link
        out["token"] = token
        out["expires_at"] = expires_at.replace(microsecond=0).isoformat()
    return out


@app.post("/auth/confirm-password-reset")
def confirm_password_reset(data: PasswordResetConfirmIn):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    ts = now_iso()

    with get_db() as db:
        pr = db.execute(
            "SELECT id, user_id, token, expires_at, used_at FROM password_reset_tokens WHERE token = ?",
            (data.token,),
        ).fetchone()
        if not pr:
            raise HTTPException(status_code=404, detail="Invalid token")
        if pr["used_at"] is not None:
            raise HTTPException(status_code=409, detail="Token already used")
        try:
            exp = datetime.fromisoformat(str(pr["expires_at"]).replace("Z", "+00:00"))
        except Exception:
            exp = now
        if exp <= now:
            raise HTTPException(status_code=410, detail="Token expired")

        user_id = int(pr["user_id"])
        u = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not u:
            raise HTTPException(status_code=404, detail="User not found")

        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(data.new_password), user_id))
        db.execute("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?", (ts, int(pr["id"])))

    write_audit(0, user_id, "auth.pwd_reset_confirm", "user", str(user_id), {})
    return {"ok": True}


@app.get("/auth/me", response_model=MeOut)
def me(ctx: dict = Depends(require_ctx)):
    return {
        "id": int(ctx["user_id"]),
        "email": str(ctx.get("email", "")),
        "tenant_id": int(ctx.get("tenant_id") or 0),
        "role": str(ctx.get("role") or ROLE_VIEWER),
    }


@app.get("/ads", response_model=List[AdOut])
def list_ads(
    ctx: dict = Depends(require_ctx),
    status: Optional[str] = Query(default=None, max_length=20),
    channel: Optional[str] = Query(default=None, max_length=40),
    campaign_id: Optional[int] = Query(default=None),
    q: Optional[str] = Query(default=None, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    where = ["tenant_id = ?"]
    params: list[object] = [tenant_id]

    if status:
        where.append("status = ?")
        params.append(status)
    if channel:
        where.append("channel = ?")
        params.append(channel)
    if campaign_id is not None:
        where.append("campaign_id = ?")
        params.append(int(campaign_id))
    if q:
        where.append("(title LIKE ? OR body LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like])

    where_sql = " AND ".join(where)

    with get_db() as db:
        rows = db.execute(
            f"""
            SELECT id, tenant_id, title, body, rendered_body, target_url, channel, target, campaign_id, status, scheduled_at, created_at, updated_at
            FROM ads
            WHERE {where_sql}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            tuple(params + [limit, offset]),
        ).fetchall()

    return [dict(r) for r in rows]


@app.post("/ads", response_model=AdOut)
def create_ad(data: AdCreateIn, ctx: dict = Depends(require_ctx)):
    user_id = int(ctx["user_id"])
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)
    ts = now_iso()

    import json

    variables = data.variables or {}
    rendered = None

    with get_db() as db:
        check_monthly_resource_or_raise(db, tenant_id, "ads_created", 1)

        if data.campaign_id is not None:
            ok = db.execute(
                "SELECT id FROM campaigns WHERE id = ? AND tenant_id = ?",
                (int(data.campaign_id), int(tenant_id)),
            ).fetchone()
            if not ok:
                raise HTTPException(status_code=404, detail="Campaign not found")

        if data.template_id is not None:
            tpl = db.execute(
                "SELECT body FROM templates WHERE id = ? AND tenant_id = ?",
                (int(data.template_id), tenant_id),
            ).fetchone()
            if not tpl:
                raise HTTPException(status_code=404, detail="Template not found")
            rendered = render_template(str(tpl[0]), variables)
        elif variables:
            rendered = render_template(data.body, variables)

        cur = db.execute(
            """
            INSERT INTO ads (tenant_id, owner_user_id, title, body, rendered_body, target_url, channel, target, campaign_id, template_id, variables_json, status, scheduled_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)
            """,
            (
                tenant_id,
                user_id,
                data.title,
                data.body,
                rendered,
                data.target_url,
                data.channel,
                data.target,
                data.campaign_id,
                data.template_id,
                json.dumps(variables, ensure_ascii=False) if variables else None,
                ts,
                ts,
            ),
        )
        ad_id = cur.lastrowid
        row = db.execute(
            """
            SELECT id, tenant_id, title, body, rendered_body, target_url, channel, target, campaign_id, status, scheduled_at, created_at, updated_at
            FROM ads WHERE id = ? AND tenant_id = ?
            """,
            (ad_id, tenant_id),
        ).fetchone()

        increment_monthly_resource(db, tenant_id, "ads_created", 1)

    write_audit(tenant_id, user_id, "ads.create", "ad", str(int(ad_id)), {"channel": data.channel})

    return dict(row)


@app.patch("/ads/{ad_id}", response_model=AdOut)
def update_ad(ad_id: int, data: AdUpdateIn, ctx: dict = Depends(require_ctx)):
    user_id = int(ctx["user_id"])
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    fields = {}
    if data.title is not None:
        fields["title"] = data.title
    if data.body is not None:
        fields["body"] = data.body
    # Para permitir limpar campos (enviar null), checamos model_fields_set.
    if "target_url" in data.model_fields_set:
        fields["target_url"] = data.target_url
    if "target" in data.model_fields_set:
        fields["target"] = data.target
    if data.channel is not None:
        fields["channel"] = data.channel
    if "campaign_id" in data.model_fields_set:
        fields["campaign_id"] = data.campaign_id
    if data.status is not None:
        fields["status"] = data.status
    if "scheduled_at" in data.model_fields_set:
        fields["scheduled_at"] = data.scheduled_at

    if "template_id" in data.model_fields_set:
        fields["template_id"] = data.template_id

    variables = data.variables or {}
    if "variables" in data.model_fields_set:
        # guardamos só a string JSON para manter a tabela simples (sem ORM aqui)
        import json

        fields["variables_json"] = json.dumps(variables, ensure_ascii=False)

    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    fields["updated_at"] = now_iso()

    set_clause = ", ".join([f"{k} = ?" for k in fields.keys()])
    params = list(fields.values()) + [ad_id, user_id]

    with get_db() as db:
        current = db.execute(
            "SELECT id, status, scheduled_at, body, template_id, variables_json FROM ads WHERE id = ? AND tenant_id = ?",
            (ad_id, tenant_id),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Ad not found")

        if "campaign_id" in fields and fields["campaign_id"] is not None:
            ok = db.execute(
                "SELECT id FROM campaigns WHERE id = ? AND tenant_id = ?",
                (int(fields["campaign_id"]), int(tenant_id)),
            ).fetchone()
            if not ok:
                raise HTTPException(status_code=404, detail="Campaign not found")

        next_status = fields.get("status", str(current["status"]))
        next_scheduled_at = fields.get("scheduled_at", current["scheduled_at"])

        if next_scheduled_at is not None:
            _validate_iso8601(str(next_scheduled_at))

        if next_status == "scheduled" and not next_scheduled_at:
            raise HTTPException(status_code=400, detail="scheduled_at is required when status=scheduled")

        # Renderização (quando body/template/variables mudam)
        will_rerender = any(k in fields for k in ("body", "template_id", "variables_json"))
        if will_rerender:
            import json

            body = str(fields.get("body") or current["body"])
            tpl_id = fields.get("template_id") if "template_id" in fields else current["template_id"]

            vars_json = fields.get("variables_json") if "variables_json" in fields else current["variables_json"]
            try:
                vars_obj = json.loads(vars_json) if vars_json else {}
            except Exception:
                vars_obj = {}

            rendered = None
            if tpl_id is not None:
                tpl = db.execute(
                    "SELECT body FROM templates WHERE id = ? AND tenant_id = ?",
                    (int(tpl_id), tenant_id),
                ).fetchone()
                if not tpl:
                    raise HTTPException(status_code=404, detail="Template not found")
                rendered = render_template(str(tpl[0]), vars_obj)
            elif vars_obj:
                rendered = render_template(body, vars_obj)
            fields["rendered_body"] = rendered

        db.execute(
            f"UPDATE ads SET {set_clause} WHERE id = ? AND tenant_id = ?",
            tuple(params),
        )

        row = db.execute(
            """
            SELECT id, tenant_id, title, body, rendered_body, target_url, channel, target, campaign_id, status, scheduled_at, created_at, updated_at
            FROM ads WHERE id = ? AND tenant_id = ?
            """,
            (ad_id, tenant_id),
        ).fetchone()

    write_audit(tenant_id, user_id, "ads.update", "ad", str(int(ad_id)), {"fields": sorted(list(fields.keys()))})

    return dict(row)


@app.delete("/ads/{ad_id}")
def delete_ad(ad_id: int, ctx: dict = Depends(require_ctx)):
    user_id = int(ctx["user_id"])
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    with get_db() as db:
        cur = db.execute(
            "DELETE FROM ads WHERE id = ? AND tenant_id = ?",
            (ad_id, tenant_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Ad not found")

    write_audit(tenant_id, user_id, "ads.delete", "ad", str(int(ad_id)), {})

    return {"deleted": True}


@app.post("/ads/{ad_id}/schedule", response_model=AdOut)
def schedule_ad(
    ad_id: int,
    scheduled_at: str,
    user: dict = Depends(require_user),
):
    """
    Agendar um anúncio (scheduled_at em ISO 8601 UTC, ex: 2026-01-11T15:00:00+00:00)
    """
    ctx = require_ctx(user)
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    user_id = int(ctx["user_id"])
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    _validate_iso8601(scheduled_at)

    with get_db() as db:
        cur = db.execute(
            """
            UPDATE ads
            SET status = 'scheduled', scheduled_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
            """,
            (scheduled_at, now_iso(), ad_id, tenant_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Ad not found")

        row = db.execute(
            """
            SELECT id, tenant_id, title, body, rendered_body, target_url, channel, target, campaign_id, status, scheduled_at, created_at, updated_at
            FROM ads WHERE id = ? AND tenant_id = ?
            """,
            (ad_id, tenant_id),
        ).fetchone()

    write_audit(tenant_id, user_id, "ads.schedule", "ad", str(int(ad_id)), {"scheduled_at": scheduled_at})

    return dict(row)


@app.get("/ads/{ad_id}/deliveries", response_model=List[DeliveryOut])
def list_deliveries(ad_id: int, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        exists = db.execute(
            "SELECT id FROM ads WHERE id = ? AND tenant_id = ?",
            (ad_id, tenant_id),
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Ad not found")

        rows = db.execute(
            """
            SELECT id, delivered_at, result, details
            FROM ad_deliveries
            WHERE ad_id = ?
            ORDER BY id DESC
            """,
            (ad_id,),
        ).fetchall()

    return [dict(r) for r in rows]


@app.post("/templates", response_model=TemplateOut)
def create_template(data: TemplateCreateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)
    ts = now_iso()

    with get_db() as db:
        check_monthly_resource_or_raise(db, tenant_id, "templates_created", 1)

        cur = db.execute(
            "INSERT INTO templates (tenant_id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (tenant_id, data.name, data.body, ts, ts),
        )
        tpl_id = cur.lastrowid
        row = db.execute(
            "SELECT id, name, body, updated_at FROM templates WHERE id = ? AND tenant_id = ?",
            (tpl_id, tenant_id),
        ).fetchone()

        increment_monthly_resource(db, tenant_id, "templates_created", 1)

    write_audit(tenant_id, int(ctx["user_id"]), "templates.create", "template", str(int(tpl_id)), {"name": data.name})
    return dict(row)


@app.get("/templates", response_model=List[TemplateOut])
def list_templates(ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        rows = db.execute(
            "SELECT id, name, body, updated_at FROM templates WHERE tenant_id = ? ORDER BY id DESC",
            (tenant_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/templates/preview", response_model=TemplatePreviewOut)
def preview_template(data: TemplatePreviewIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    variables = data.variables or {}
    rendered = render_template(data.body, variables)
    return {"rendered": rendered}


@app.delete("/templates/{tpl_id}")
def delete_template(tpl_id: int, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)

    with get_db() as db:
        cur = db.execute(
            "DELETE FROM templates WHERE id = ? AND tenant_id = ?",
            (int(tpl_id), tenant_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Template not found")

    write_audit(tenant_id, int(ctx["user_id"]), "templates.delete", "template", str(int(tpl_id)), {})
    return {"deleted": True}


@app.post("/links", response_model=LinkOut)
def create_link(data: LinkCreateIn, ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_EDITOR)
    ts = now_iso()

    # UTM opcional
    dest = data.destination_url
    if data.utm_source and data.utm_medium and data.utm_campaign:
        dest = add_utm(
            dest,
            source=data.utm_source,
            medium=data.utm_medium,
            campaign=data.utm_campaign,
            content=data.utm_content,
        )

    with get_db() as db:
        check_monthly_resource_or_raise(db, tenant_id, "links_created", 1)

        # valida ad_id no tenant (se vier)
        if data.ad_id is not None:
            ok = db.execute(
                "SELECT id FROM ads WHERE id = ? AND tenant_id = ?",
                (int(data.ad_id), tenant_id),
            ).fetchone()
            if not ok:
                raise HTTPException(status_code=404, detail="Ad not found")

        slug = generate_slug(7)
        for _ in range(10):
            try:
                db.execute(
                    "INSERT INTO short_links (tenant_id, ad_id, slug, destination_url, created_at) VALUES (?, ?, ?, ?, ?)",
                    (tenant_id, data.ad_id, slug, dest, ts),
                )
                break
            except sqlite3.IntegrityError:
                slug = generate_slug(8)

        increment_monthly_resource(db, tenant_id, "links_created", 1)

    write_audit(tenant_id, int(ctx["user_id"]), "links.create", "short_link", slug, {"ad_id": data.ad_id})
    return {"slug": slug, "destination_url": dest}


@app.get("/r/{slug}")
def redirect_short_link(slug: str):
    # Público (sem auth): registra click e redireciona
    with get_db() as db:
        row = db.execute(
            "SELECT id, tenant_id, destination_url, ad_id FROM short_links WHERE slug = ?",
            (slug,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")

        link_id = int(row["id"])
        tenant_id = int(row["tenant_id"])
        ad_id = int(row["ad_id"]) if row["ad_id"] is not None else None

        db.execute(
            "INSERT INTO metric_events (tenant_id, ad_id, link_id, event_type, value, meta_json, created_at) VALUES (?, ?, ?, 'click', 1, NULL, ?)",
            (tenant_id, ad_id, link_id, now_iso()),
        )

    return RedirectResponse(url=str(row["destination_url"]), status_code=307)


@app.get("/px/impression.gif")
def pixel_impression(
    tenant_id: int,
    ad_id: Optional[int] = None,
    link_slug: Optional[str] = None,
    origin: Optional[str] = Header(default=None),
):
    # Endpoint público: registra impressão e devolve 1x1 gif.
    allowed_raw = os.getenv("PIXEL_ALLOWED_ORIGINS", "")
    allowed = [o.strip() for o in allowed_raw.split(",") if o.strip()]

    # Se existir Origin e NÃO estiver allowlisted, não registra (mas devolve o pixel)
    can_record = True
    if origin and allowed and origin not in allowed:
        can_record = False

    link_id = None
    if can_record:
        with get_db() as db:
            if link_slug:
                link = db.execute(
                    "SELECT id, tenant_id, ad_id FROM short_links WHERE slug = ?",
                    (link_slug,),
                ).fetchone()
                if link:
                    link_id = int(link["id"])
                    tenant_id = int(link["tenant_id"])
                    if ad_id is None and link["ad_id"] is not None:
                        ad_id = int(link["ad_id"])

            db.execute(
                "INSERT INTO metric_events (tenant_id, ad_id, link_id, event_type, value, meta_json, created_at) VALUES (?, ?, ?, 'impression', 1, NULL, ?)",
                (int(tenant_id), int(ad_id) if ad_id is not None else None, int(link_id) if link_id else None, now_iso()),
            )

    resp = Response(content=PIXEL_GIF_BYTES, media_type="image/gif")
    if origin and origin in allowed:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


@app.post("/events/conversion")
def event_conversion(slug: str):
    # Público: registra conversão (MVP). Em produção, valide assinatura/CSRF, etc.
    with get_db() as db:
        row = db.execute("SELECT id, tenant_id, ad_id FROM short_links WHERE slug = ?", (slug,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        db.execute(
            "INSERT INTO metric_events (tenant_id, ad_id, link_id, event_type, value, meta_json, created_at) VALUES (?, ?, ?, 'conversion', 1, NULL, ?)",
            (int(row["tenant_id"]), int(row["ad_id"]) if row["ad_id"] is not None else None, int(row["id"]), now_iso()),
        )
    return {"ok": True}


@app.get("/dashboard", response_model=DashboardOut)
def dashboard(ctx: dict = Depends(require_ctx)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    with get_db() as db:
        clicks = db.execute(
            "SELECT COALESCE(SUM(value),0) FROM metric_events WHERE tenant_id = ? AND event_type = 'click'",
            (tenant_id,),
        ).fetchone()[0]
        conv = db.execute(
            "SELECT COALESCE(SUM(value),0) FROM metric_events WHERE tenant_id = ? AND event_type = 'conversion'",
            (tenant_id,),
        ).fetchone()[0]

    clicks_i = int(clicks or 0)
    conv_i = int(conv or 0)
    impressions_proxy = max(clicks_i, 0)
    return {
        "clicks": clicks_i,
        "conversions": conv_i,
        "impressions_proxy": impressions_proxy,
        "ctr_proxy": float(ctr(clicks_i, impressions_proxy)),
        "ts": now_iso(),
    }


@app.get("/dashboard/history", response_model=DashboardHistoryOut)
def dashboard_history(ctx: dict = Depends(require_ctx), days: int = Query(default=14, ge=1, le=90)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = (now - timedelta(days=days - 1)).date().isoformat()

    with get_db() as db:
        rows = db.execute(
            """
            SELECT substr(created_at, 1, 10) as day, event_type, COALESCE(SUM(value),0) as total
            FROM metric_events
            WHERE tenant_id = ? AND created_at >= ?
            GROUP BY day, event_type
            ORDER BY day ASC
            """,
            (tenant_id, start),
        ).fetchall()

    by_day: dict[str, dict[str, int]] = {}
    for r in rows:
        day = str(r["day"])
        by_day.setdefault(day, {"click": 0, "conversion": 0, "impression": 0})
        by_day[day][str(r["event_type"] or "")] = int(r["total"] or 0)

    points: list[DashboardHistoryPoint] = []
    for i in range(days):
        d = (now - timedelta(days=days - 1 - i)).date().isoformat()
        stats = by_day.get(d, {"click": 0, "conversion": 0, "impression": 0})
        clicks = int(stats.get("click") or 0)
        conv = int(stats.get("conversion") or 0)
        impressions = int(stats.get("impression") or clicks)
        ctr_proxy = float(ctr(clicks, impressions))
        points.append(
            DashboardHistoryPoint(
                day=d,
                clicks=clicks,
                conversions=conv,
                impressions_proxy=impressions,
                ctr_proxy=ctr_proxy,
            )
        )

    return {"days": int(days), "points": points}


@app.get("/dashboard/channels", response_model=DashboardChannelsOut)
def dashboard_channels(ctx: dict = Depends(require_ctx), days: int = Query(default=14, ge=1, le=90)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = (now - timedelta(days=days - 1)).date().isoformat()

    with get_db() as db:
        rows = db.execute(
            """
            SELECT a.channel as channel, me.event_type as event_type, COALESCE(SUM(me.value),0) as total
            FROM metric_events me
            JOIN ads a ON a.id = me.ad_id
            WHERE me.tenant_id = ? AND me.created_at >= ?
            GROUP BY a.channel, me.event_type
            """,
            (tenant_id, start),
        ).fetchall()

    by_channel: dict[str, dict[str, int]] = {}
    for r in rows:
        ch = str(r["channel"] or "")
        by_channel.setdefault(ch, {"click": 0, "conversion": 0, "impression": 0})
        by_channel[ch][str(r["event_type"] or "")] = int(r["total"] or 0)

    points: list[DashboardChannelPoint] = []
    for ch, stats in sorted(by_channel.items(), key=lambda x: x[0]):
        clicks = int(stats.get("click") or 0)
        conv = int(stats.get("conversion") or 0)
        impressions = int(stats.get("impression") or clicks)
        points.append(
            DashboardChannelPoint(
                channel=ch,
                clicks=clicks,
                conversions=conv,
                impressions_proxy=impressions,
                ctr_proxy=float(ctr(clicks, impressions)),
            )
        )

    return {"days": int(days), "points": points}


@app.get("/dashboard/campaigns", response_model=DashboardCampaignsOut)
def dashboard_campaigns(ctx: dict = Depends(require_ctx), days: int = Query(default=30, ge=1, le=180)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = (now - timedelta(days=days - 1)).date().isoformat()

    with get_db() as db:
        rows = db.execute(
            """
            SELECT d.campaign_id as campaign_id, c.name as campaign_name, d.status as status, COUNT(1) as total
            FROM deliveries d
            LEFT JOIN campaigns c ON c.id = d.campaign_id
            WHERE d.tenant_id = ? AND d.created_at >= ?
            GROUP BY d.campaign_id, c.name, d.status
            """,
            (tenant_id, start),
        ).fetchall()

    by_campaign: dict[str, dict[str, object]] = {}
    for r in rows:
        cid = r["campaign_id"]
        key = str(cid or 0)
        name = str(r["campaign_name"] or "Sem campanha")
        by_campaign.setdefault(
            key,
            {
                "campaign_id": int(cid) if cid is not None else None,
                "campaign_name": name,
                "sent": 0,
                "failed": 0,
                "retrying": 0,
                "queued": 0,
                "sending": 0,
            },
        )
        status = str(r["status"] or "")
        total = int(r["total"] or 0)
        if status in ("sent", "failed", "retrying", "queued", "sending"):
            by_campaign[key][status] = int(by_campaign[key][status]) + total

    points: list[DashboardCampaignPoint] = []
    for _, data in by_campaign.items():
        sent = int(data["sent"])
        failed = int(data["failed"])
        retrying = int(data["retrying"])
        queued = int(data["queued"])
        sending = int(data["sending"])
        total = sent + failed + retrying + queued + sending
        points.append(
            DashboardCampaignPoint(
                campaign_id=data["campaign_id"],
                campaign_name=str(data["campaign_name"]),
                total=total,
                sent=sent,
                failed=failed,
                retrying=retrying,
                queued=queued,
                sending=sending,
            )
        )

    points.sort(key=lambda p: (p.total, p.campaign_name), reverse=True)
    return {"days": int(days), "points": points}


@app.get("/dashboard/campaign-conversions", response_model=DashboardCampaignConvOut)
def dashboard_campaign_conversions(ctx: dict = Depends(require_ctx), days: int = Query(default=30, ge=1, le=180)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = (now - timedelta(days=days - 1)).date().isoformat()

    with get_db() as db:
        rows = db.execute(
            """
            SELECT a.campaign_id as campaign_id, c.name as campaign_name, me.event_type as event_type, COALESCE(SUM(me.value),0) as total
            FROM metric_events me
            JOIN ads a ON a.id = me.ad_id
            LEFT JOIN campaigns c ON c.id = a.campaign_id
            WHERE me.tenant_id = ? AND me.created_at >= ?
            GROUP BY a.campaign_id, c.name, me.event_type
            """,
            (tenant_id, start),
        ).fetchall()

    by_campaign: dict[str, dict[str, object]] = {}
    for r in rows:
        cid = r["campaign_id"]
        key = str(cid or 0)
        name = str(r["campaign_name"] or "Sem campanha")
        by_campaign.setdefault(
            key,
            {
                "campaign_id": int(cid) if cid is not None else None,
                "campaign_name": name,
                "click": 0,
                "conversion": 0,
            },
        )
        et = str(r["event_type"] or "")
        if et in ("click", "conversion"):
            by_campaign[key][et] = int(by_campaign[key][et]) + int(r["total"] or 0)

    points: list[DashboardCampaignConvPoint] = []
    for _, data in by_campaign.items():
        points.append(
            DashboardCampaignConvPoint(
                campaign_id=data["campaign_id"],
                campaign_name=str(data["campaign_name"]),
                clicks=int(data["click"]),
                conversions=int(data["conversion"]),
            )
        )

    points.sort(key=lambda p: (p.conversions, p.clicks, p.campaign_name), reverse=True)
    return {"days": int(days), "points": points}


@app.get("/dashboard/sla", response_model=DashboardSlaOut)
def dashboard_sla(ctx: dict = Depends(require_ctx), days: int = Query(default=30, ge=1, le=180)):
    tenant_id = int(ctx.get("tenant_id") or 0)
    if tenant_id <= 0:
        tenant_id = 1
    role = str(ctx.get("role") or ROLE_VIEWER)
    require_role(role, ROLE_VIEWER)

    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = (now - timedelta(days=days - 1)).date().isoformat()

    with get_db() as db:
        rows = db.execute(
            """
            SELECT status, attempts, created_at, updated_at
            FROM deliveries
            WHERE tenant_id = ? AND created_at >= ?
            """,
            (tenant_id, start),
        ).fetchall()

    total = len(rows)
    sent = failed = retrying = queued = sending = 0
    attempts_sum = 0
    time_sum = 0.0
    time_count = 0

    for r in rows:
        status = str(r["status"] or "")
        attempts = int(r["attempts"] or 0)
        attempts_sum += attempts
        if status == "sent":
            sent += 1
        elif status == "failed":
            failed += 1
        elif status == "retrying":
            retrying += 1
        elif status == "queued":
            queued += 1
        elif status == "sending":
            sending += 1

        if status in ("sent", "failed"):
            try:
                created = datetime.fromisoformat(str(r["created_at"]).replace("Z", "+00:00"))
                updated = datetime.fromisoformat(str(r["updated_at"]).replace("Z", "+00:00"))
                delta = max(0.0, (updated - created).total_seconds())
                time_sum += delta
                time_count += 1
            except Exception:
                pass

    avg_attempts = float(attempts_sum / total) if total else 0.0
    avg_time_sec = float(time_sum / time_count) if time_count else 0.0
    failure_rate = float(failed / total) if total else 0.0

    return {
        "days": int(days),
        "total": total,
        "sent": sent,
        "failed": failed,
        "retrying": retrying,
        "queued": queued,
        "sending": sending,
        "avg_attempts": avg_attempts,
        "avg_time_sec": avg_time_sec,
        "failure_rate": failure_rate,
    }


@app.post("/jobs/run-due")
def run_due_deliveries(admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key")):
    """
    Job simples para "disparar" anúncios vencidos.
    Em produção você rodaria isso por cron/worker.
    Para não abrir geral, protegi com X-Admin-Key (env ADMIN_KEY).
    """
    import os

    required = os.getenv("ADMIN_KEY", "CHANGE_ME_ADMIN_KEY")
    if admin_key != required:
        raise HTTPException(status_code=403, detail="Forbidden")

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
                # Quota de envio (diária)
                try:
                    check_daily_send_or_raise(db, tenant_id, 1)
                except HTTPException as e:
                    # Registra falha e mantém status scheduled (para reprocessar amanhã)
                    db.execute(
                        """
                        INSERT INTO ad_deliveries (ad_id, delivered_at, result, details)
                        VALUES (?, ?, 'fail', ?)
                        """,
                        (ad_id, now_iso(), f"Quota exceeded: {e.detail}"),
                    )
                    continue

                # "Entrega" simulada: marca sent e registra delivery ok
                db.execute(
                    "UPDATE ads SET status = 'sent', updated_at = ? WHERE id = ?",
                    (now_iso(), ad_id),
                )
                db.execute(
                    """
                    INSERT INTO ad_deliveries (ad_id, delivered_at, result, details)
                    VALUES (?, ?, 'ok', ?)
                    """,
                    (ad_id, now_iso(), "Simulated delivery"),
                )
                increment_daily_send(db, tenant_id, channel, 1)
                sent += 1

    return {"sent": sent, "ts": now_iso()}


@app.post("/jobs/process-deliveries")
def job_process_deliveries(admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key")):
    import os

    required = os.getenv("ADMIN_KEY", "CHANGE_ME_ADMIN_KEY")
    if admin_key != required:
        raise HTTPException(status_code=403, detail="Forbidden")

    return process_deliveries_once(batch=50)
