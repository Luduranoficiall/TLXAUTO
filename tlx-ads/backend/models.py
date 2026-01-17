from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=6, max_length=128)
    tenant_name: Optional[str] = Field(default=None, max_length=120)
    tenant_slug: Optional[str] = Field(default=None, max_length=60)


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str
    tenant_slug: Optional[str] = Field(default=None, max_length=60)


class TokenOut(BaseModel):
    access_token: str
    tenant_id: Optional[int] = None
    role: Optional[str] = None


class PlanCheckoutIn(BaseModel):
    plan: str = Field(min_length=2, max_length=40)


class PlanCheckoutOut(BaseModel):
    url: str


class MeOut(BaseModel):
    id: int
    email: str
    tenant_id: Optional[int] = None
    role: Optional[str] = None


AdStatus = Literal["draft", "scheduled", "sent", "paused"]


class AdCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=4000)
    target_url: Optional[str] = Field(default=None, max_length=500)
    channel: str = Field(min_length=1, max_length=40)  # whatsapp, x, etc.
    target: Optional[str] = Field(default=None, max_length=220)  # e164/email/self
    campaign_id: Optional[int] = None
    template_id: Optional[int] = None
    variables: Optional[dict[str, str]] = None


class AdUpdateIn(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    body: Optional[str] = Field(default=None, min_length=1, max_length=4000)
    target_url: Optional[str] = Field(default=None, max_length=500)
    channel: Optional[str] = Field(default=None, min_length=1, max_length=40)
    target: Optional[str] = Field(default=None, max_length=220)
    campaign_id: Optional[int] = None
    status: Optional[AdStatus] = None
    scheduled_at: Optional[str] = None  # ISO 8601 string
    template_id: Optional[int] = None
    variables: Optional[dict[str, str]] = None


class AdOut(BaseModel):
    id: int
    tenant_id: int
    title: str
    body: str
    rendered_body: Optional[str] = None
    target_url: Optional[str]
    channel: str
    target: Optional[str] = None
    campaign_id: Optional[int] = None
    status: AdStatus
    scheduled_at: Optional[str]
    created_at: str
    updated_at: str


DeliveryResult = Literal["ok", "fail"]


class DeliveryOut(BaseModel):
    id: int
    delivered_at: str
    result: DeliveryResult
    details: Optional[str]


class TemplateCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=8000)


class TemplateOut(BaseModel):
    id: int
    name: str
    body: str
    updated_at: str


class TemplatePreviewIn(BaseModel):
    body: str = Field(min_length=1, max_length=8000)
    variables: Optional[dict[str, str]] = None


class TemplatePreviewOut(BaseModel):
    rendered: str


class LinkCreateIn(BaseModel):
    destination_url: str = Field(min_length=3, max_length=4000)
    ad_id: Optional[int] = None
    utm_source: Optional[str] = Field(default=None, max_length=80)
    utm_medium: Optional[str] = Field(default=None, max_length=80)
    utm_campaign: Optional[str] = Field(default=None, max_length=120)
    utm_content: Optional[str] = Field(default=None, max_length=120)


class LinkOut(BaseModel):
    slug: str
    destination_url: str


class DashboardOut(BaseModel):
    clicks: int
    conversions: int
    impressions_proxy: int
    ctr_proxy: float
    ts: str


class DashboardHistoryPoint(BaseModel):
    day: str
    clicks: int
    conversions: int
    impressions_proxy: int
    ctr_proxy: float


class DashboardHistoryOut(BaseModel):
    days: int
    points: list[DashboardHistoryPoint]


class DashboardChannelPoint(BaseModel):
    channel: str
    clicks: int
    conversions: int
    impressions_proxy: int
    ctr_proxy: float


class DashboardChannelsOut(BaseModel):
    days: int
    points: list[DashboardChannelPoint]


class DashboardCampaignPoint(BaseModel):
    campaign_id: Optional[int] = None
    campaign_name: str
    total: int
    sent: int
    failed: int
    retrying: int
    queued: int
    sending: int


class DashboardCampaignsOut(BaseModel):
    days: int
    points: list[DashboardCampaignPoint]


class DashboardCampaignConvPoint(BaseModel):
    campaign_id: Optional[int] = None
    campaign_name: str
    clicks: int
    conversions: int


class DashboardCampaignConvOut(BaseModel):
    days: int
    points: list[DashboardCampaignConvPoint]


class DashboardSlaOut(BaseModel):
    days: int
    total: int
    sent: int
    failed: int
    retrying: int
    queued: int
    sending: int
    avg_attempts: float
    avg_time_sec: float
    failure_rate: float


class TenantCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(min_length=1, max_length=60)


class TenantOut(BaseModel):
    id: int
    name: str
    slug: str
    created_at: str


class MemberOut(BaseModel):
    user_id: int
    email: str
    role: str
    created_at: str


class MemberRoleUpdateIn(BaseModel):
    role: str = Field(min_length=3, max_length=20)


class InviteCreateIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    role: str = Field(default="viewer", max_length=20)
    invite_base_url: Optional[str] = Field(default=None, max_length=4000)


class InviteOut(BaseModel):
    ok: bool
    invite_link: str
    expires_at: str
    # Em dev podemos retornar o token (controlado via env)
    token: Optional[str] = None


class AcceptInviteIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=6, max_length=128)


class PasswordResetRequestIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    reset_base_url: Optional[str] = Field(default=None, max_length=4000)


class PasswordResetConfirmIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(min_length=6, max_length=128)


# --- Núcleo SaaS (MVP) ---

CampaignStatus = Literal["active", "paused", "ended"]


class CampaignCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    objective: Optional[str] = Field(default=None, max_length=200)
    status: CampaignStatus = "active"
    start_at: Optional[str] = Field(default=None, max_length=40)
    end_at: Optional[str] = Field(default=None, max_length=40)


class CampaignUpdateIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    objective: Optional[str] = Field(default=None, max_length=200)
    status: Optional[CampaignStatus] = None
    start_at: Optional[str] = Field(default=None, max_length=40)
    end_at: Optional[str] = Field(default=None, max_length=40)


class CampaignOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    objective: Optional[str] = None
    status: str
    start_at: Optional[str] = None
    end_at: Optional[str] = None
    created_at: str
    updated_at: str


class ContactCreateIn(BaseModel):
    name: Optional[str] = Field(default=None, max_length=160)
    email: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=80)
    consent_at: Optional[str] = Field(default=None, max_length=40)
    meta: Optional[dict[str, Any]] = None


class ContactUpdateIn(BaseModel):
    name: Optional[str] = Field(default=None, max_length=160)
    email: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=80)
    consent_at: Optional[str] = Field(default=None, max_length=40)
    meta: Optional[dict[str, Any]] = None


class ContactOut(BaseModel):
    id: int
    tenant_id: int
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    consent_at: Optional[str] = None
    meta_json: Optional[str] = None
    created_at: str
    updated_at: str


class SegmentCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class SegmentUpdateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class SegmentOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    created_at: str
    updated_at: str


class SegmentMemberAddIn(BaseModel):
    contact_id: int


DeliveryQueueStatus = Literal["queued", "sending", "sent", "retrying", "failed"]


class DeliveryQueueCreateIn(BaseModel):
    channel: str = Field(min_length=1, max_length=40)
    to_addr: str = Field(min_length=1, max_length=220)
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: Optional[str] = Field(default=None, max_length=200)
    campaign_id: Optional[int] = None


class DeliveryQueueOut(BaseModel):
    id: int
    tenant_id: int
    campaign_id: Optional[int] = None
    channel: str
    to_addr: str
    status: DeliveryQueueStatus
    attempts: int
    max_attempts: int
    next_attempt_at: Optional[str] = None
    last_error: Optional[str] = None
    created_at: str
    updated_at: str


class AutomationSegmentSendIn(BaseModel):
    segment_id: int
    channel: str = Field(min_length=1, max_length=40)
    body: str = Field(min_length=1, max_length=4000)
    scheduled_at: Optional[str] = None
    campaign_id: Optional[int] = None
    template_id: Optional[int] = None
    variables: Optional[dict[str, str]] = None


class AutomationSegmentSendOut(BaseModel):
    queued: int
    failed: int
    skipped: int
