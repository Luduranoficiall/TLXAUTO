export {};

type Env = { PUBLIC_API_BASE: string; PUBLIC_WEB_BASE: string };

declare global {
  interface Window {
    __ENV__?: Env;
  }
}

function env(): Env {
  return window.__ENV__ || { PUBLIC_API_BASE: "http://localhost:8000", PUBLIC_WEB_BASE: "http://localhost:5173" };
}

const API_BASE = env().PUBLIC_API_BASE;

type AdStatus = "draft" | "scheduled" | "sent" | "paused";

type Ad = {
  id: number;
  title: string;
  body: string;
  target_url?: string | null;
  channel: string;
  campaign_id?: number | null;
  status: AdStatus;
  scheduled_at?: string | null;
  created_at: string;
  updated_at: string;
};

type DashboardOut = {
  clicks: number;
  conversions: number;
  impressions_proxy: number;
  ctr_proxy: number;
  ts: string;
};

type DashboardHistoryPoint = {
  day: string;
  clicks: number;
  conversions: number;
  impressions_proxy: number;
  ctr_proxy: number;
};

type DashboardHistoryOut = {
  days: number;
  points: DashboardHistoryPoint[];
};

type Contact = {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  consent_at?: string | null;
  meta_json?: string | null;
};

type Segment = {
  id: number;
  name: string;
};

type SegmentMember = {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

type DeliveryQueue = {
  id: number;
  channel: string;
  to_addr: string;
  status: string;
  attempts: number;
  next_attempt_at?: string | null;
};

type ChannelStatsPoint = {
  channel: string;
  clicks: number;
  conversions: number;
  impressions_proxy: number;
  ctr_proxy: number;
};

type CampaignStatsPoint = {
  campaign_id?: number | null;
  campaign_name: string;
  total: number;
  sent: number;
  failed: number;
  retrying: number;
  queued: number;
  sending: number;
};

type CampaignConvPoint = {
  campaign_id?: number | null;
  campaign_name: string;
  clicks: number;
  conversions: number;
};

type Campaign = {
  id: number;
  name: string;
  objective?: string | null;
  status: string;
  start_at?: string | null;
  end_at?: string | null;
};

type Template = {
  id: number;
  name: string;
  body: string;
  updated_at: string;
};

let templatesCache: Template[] = [];
let campaignsCache: Campaign[] = [];
let contactsCache: Contact[] = [];

function extractVariables(body: string): string[] {
  const vars = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    vars.add(m[1]);
  }
  return Array.from(vars.values());
}

function buildVariablesFromInputs(containerId: string): Record<string, string> {
  const box = qso(containerId);
  if (!box) return {};
  const inputs = Array.from(box.querySelectorAll("input[data-var]")) as HTMLInputElement[];
  const out: Record<string, string> = {};
  inputs.forEach((inp) => {
    const key = inp.dataset.var || "";
    if (key) out[key] = inp.value.trim();
  });
  return out;
}

function renderVariablesForm(containerId: string, vars: string[]) {
  const box = qso(containerId);
  if (!box) return;
  if (!vars.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = vars
    .map(
      (v) => `
        <div>
          <label>${escapeHtml(v)}</label>
          <input data-var="${escapeHtml(v)}" placeholder="${escapeHtml(v)}" />
        </div>
      `
    )
    .join("");
}

function syncVariablesJson(containerId: string, inputId: string) {
  const input = qso(inputId) as HTMLInputElement | null;
  if (!input) return;
  const vars = buildVariablesFromInputs(containerId);
  const hasAny = Object.values(vars).some((v) => v.length > 0);
  input.value = hasAny ? JSON.stringify(vars) : "";
}

function parseVariablesJson(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
    throw new Error("Invalid JSON");
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [String(k), String(v)]));
}

function bindVariablesForm(containerId: string, inputId: string) {
  const box = qso(containerId);
  if (!box) return;
  box.querySelectorAll("input[data-var]").forEach((el) => {
    el.addEventListener("input", () => syncVariablesJson(containerId, inputId));
  });
}

function applyTemplateToAd(tpl: Template) {
  const bodyEl = qso("adBody") as HTMLTextAreaElement | null;
  const titleEl = qso("adTitle") as HTMLInputElement | null;
  const select = qso("adTemplate") as HTMLSelectElement | null;
  const varsInput = qso("adVariables") as HTMLInputElement | null;
  if (bodyEl) bodyEl.value = tpl.body;
  if (titleEl && !titleEl.value.trim()) titleEl.value = tpl.name;
  if (select) select.value = String(tpl.id);
  if (varsInput) varsInput.value = "";
  const vars = extractVariables(tpl.body);
  renderVariablesForm("adVariablesForm", vars);
  bindVariablesForm("adVariablesForm", "adVariables");
}

function qs(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

function qso(id: string): HTMLElement | null {
  return document.getElementById(id);
}

type Section = "home" | "accept-invite" | "reset-password" | "plans";

function showOnly(section: Section) {
  // home = fluxo atual (auth+app)
  const isHome = section === "home";
  qs("authSection").classList.toggle("hidden", !isHome || !!getToken());
  qs("appSection").classList.toggle("hidden", !isHome || !getToken());
  qs("btnLogout").classList.toggle("hidden", !getToken() || !isHome);

  qs("acceptInviteSection").classList.toggle("hidden", section !== "accept-invite");
  qs("resetPasswordSection").classList.toggle("hidden", section !== "reset-password");

  const plans = qso("plansSection");
  if (plans) plans.classList.toggle("hidden", section !== "plans");

  syncUserInfo();
  updateNav();
}

function route(): Section {
  const path = window.location.pathname;
  if (path === "/accept-invite") return "accept-invite";
  if (path === "/reset-password") return "reset-password";
  if (path === "/planos" || path === "/choose-plan") return "plans";
  return "home";
}

function getQueryParam(name: string): string | null {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function setAlert(message: string, kind: "ok" | "danger" = "ok") {
  const box = qs("alerts");
  box.innerHTML = `<div class="card ${kind === "danger" ? "danger" : "ok"}">${message}</div>`;
  setTimeout(() => (box.innerHTML = ""), 4500);
}

function getToken(): string | null {
  return localStorage.getItem("token");
}

function setToken(t: string | null) {
  if (t) localStorage.setItem("token", t);
  else localStorage.removeItem("token");
}

function getTenantSlug(): string {
  return localStorage.getItem("tenant_slug") || "";
}

function setTenantSlug(v: string) {
  localStorage.setItem("tenant_slug", v);
}

function decodeJwtPayload(token: string): any | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function syncUserInfo() {
  const el = qs("userInfo");
  const token = getToken();
  if (!token) {
    el.textContent = "";
    return;
  }
  const payload = decodeJwtPayload(token);
  const email = payload?.email ? String(payload.email) : "";
  const tid = payload?.tid !== undefined ? String(payload.tid) : "";
  const role = payload?.role ? String(payload.role) : "";
  const extra = tid || role ? ` — tenant: ${tid || "?"}${role ? ` (${role})` : ""}` : "";
  el.textContent = email ? `Logado: ${email}${extra}` : "";
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as any),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const base = env().PUBLIC_API_BASE;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  let res: Response;
  let text = "";
  try {
    res = await fetch(`${base}${path}`, { ...opts, headers, signal: controller.signal });
    text = await res.text();
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Tempo limite. Tente novamente.");
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }

  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = data && data.detail ? data.detail : `HTTP ${res.status}`;
    // Se a sessão expirou/inválida, volta para login automaticamente
    if (res.status === 401 && getToken()) {
      setToken(null);
      showApp(false);
      syncUserInfo();
    }
    throw new Error(msg);
  }
  return data as T;
}

function showApp(isAuthed: boolean) {
  qs("authSection").classList.toggle("hidden", isAuthed);
  qs("appSection").classList.toggle("hidden", !isAuthed);
  qs("btnLogout").classList.toggle("hidden", !isAuthed);
  syncUserInfo();
  updateNav();
}

type PlanId = "free" | "pro" | "business" | "enterprise";

type PlanSnapshot = {
  tenant_id: number;
  plan: PlanId;
  status: string;
  trial_ends_at?: string | null;
  current_period_end?: string | null;
  limits: {
    ads_created_monthly: number | null;
    templates_created_monthly: number | null;
    links_created_monthly: number | null;
    invites_created_monthly: number | null;
    sends_daily_total: number | null;
  };
  usage: {
    month: string;
    ads_created: number;
    templates_created: number;
    links_created: number;
    invites_created: number;
    day: string;
    sends_total: number;
    sends_whatsapp: number;
    sends_x: number;
    sends_email: number;
  };
};

type PlanDef = {
  id: PlanId;
  name: string;
  price: string;
  subtitle: string;
  recommended?: boolean;
};

const PLAN_DEFS: PlanDef[] = [
  {
    id: "free",
    name: "Essencial",
    price: "US$ 49/mo",
    subtitle: "Para começar a rodar campanhas com foco em ROI.",
  },
  {
    id: "pro",
    name: "Profissional",
    price: "US$ 129/mo",
    subtitle: "Para quem opera anuncios com consistencia semanal.",
    recommended: true,
  },
  {
    id: "business",
    name: "Agencia",
    price: "US$ 249/mo",
    subtitle: "Para multiplos clientes e performance em escala.",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Sob consulta",
    subtitle: "Operacao grande, integrações e limites sob medida.",
  },
];

function fmtLimit(v: number | null): string {
  if (v === null) return "Ilimitado";
  return String(v);
}

function fmtPct(current: number, limit: number | null): string {
  if (limit === null) return "—";
  const pct = limit <= 0 ? 0 : Math.min(1, current / limit);
  return `${Math.round(pct * 100)}%`;
}

function renderPlanCard(def: PlanDef, snap?: PlanSnapshot | null): string {
  const limits = snap?.limits;
  const usage = snap?.usage;

  // Se não tiver snapshot (não logado), usamos os limites do backend como referência “padrão”
  // sem chamar API: valores batem com `tlx-ads/backend/saas.py`.
  const DEFAULT_LIMITS: Record<PlanId, PlanSnapshot["limits"]> = {
    free: { ads_created_monthly: 120, templates_created_monthly: 60, links_created_monthly: 800, invites_created_monthly: 40, sends_daily_total: 600 },
    pro: { ads_created_monthly: 600, templates_created_monthly: 240, links_created_monthly: 4000, invites_created_monthly: 200, sends_daily_total: 3000 },
    business: { ads_created_monthly: 2500, templates_created_monthly: 1000, links_created_monthly: 25000, invites_created_monthly: 1000, sends_daily_total: 15000 },
    enterprise: { ads_created_monthly: null, templates_created_monthly: null, links_created_monthly: null, invites_created_monthly: null, sends_daily_total: null },
  };

  const l = DEFAULT_LIMITS[def.id];

  const isCurrent = snap?.plan === def.id;
  const css = ["planCard", def.recommended ? "recommended" : "", isCurrent ? "recommended" : ""]
    .filter(Boolean)
    .join(" ");

  const badge = isCurrent
    ? `<span class="pill premium">Seu plano atual</span>`
    : def.recommended
      ? `<span class="pill premium">Mais escolhido</span>`
      : `<span class="pill">Plano</span>`;

  const usageBlock =
    snap && usage && limits
      ? `
        <div class="planHint">
          Uso do mês (${escapeHtml(usage.month)}): anúncios ${usage.ads_created}/${fmtLimit(limits.ads_created_monthly)} (${fmtPct(
            usage.ads_created,
            limits.ads_created_monthly
          )})
        </div>
      `
      : ``;

  return `
    <div class="${css}" data-plan="${def.id}">
      <div class="planTop">
        <div>
          <div class="planName">${escapeHtml(def.name)}</div>
          <div class="planSub">${escapeHtml(def.subtitle)}</div>
        </div>
        <div>${badge}</div>
      </div>

      <div class="planPrice">${escapeHtml(def.price)}</div>

      <ul class="planFeatures">
        <li>• <strong>${fmtLimit(l.ads_created_monthly)}</strong> anúncios/mês <span class="muted">(criar drafts e campanhas)</span></li>
        <li>• <strong>${fmtLimit(l.templates_created_monthly)}</strong> templates/mês <span class="muted">(padrão de copy)</span></li>
        <li>• <strong>${fmtLimit(l.links_created_monthly)}</strong> links/mês <span class="muted">(encurtador + UTM)</span></li>
        <li>• <strong>${fmtLimit(l.invites_created_monthly)}</strong> convites/mês <span class="muted">(equipe/cliente)</span></li>
        <li>• <strong>${fmtLimit(l.sends_daily_total)}</strong> envios/dia <span class="muted">(WhatsApp/X/Email)</span></li>
      </ul>

      <div class="planCtaRow">
        <button class="btn btn-secondary" data-action="choose-plan" data-plan="${def.id}">${isCurrent ? "Plano atual" : "Assinar este plano"}</button>
        ${snap && !isCurrent && def.id !== "enterprise" ? `<button class="btn ghostBtn" data-action="change-plan" data-plan="${def.id}">Alterar para este plano</button>` : ""}
      </div>
      ${usageBlock}
    </div>
  `;
}

async function refreshPlansUI() {
  const grid = qso("plansGrid");
  if (!grid) return;

  let snap: PlanSnapshot | null = null;
  const token = getToken();
  const portalBtn = qso("btnBillingPortal");
  const cancelBtn = qso("btnCancelPlan");
  if (portalBtn) portalBtn.classList.toggle("hidden", !token);
  if (cancelBtn) cancelBtn.classList.toggle("hidden", !token);
  if (token) {
    try {
      snap = await api<PlanSnapshot>("/saas/plan");
    } catch {
      // se falhar, continua com UI estática
      snap = null;
    }
  }

  const currentBox = qso("planCurrentBox");
  if (currentBox) {
    if (snap) {
      currentBox.classList.remove("hidden");
      const periodEnd = snap.current_period_end ? `<div class="muted" style="margin-top:6px;">Renovacao: <code>${escapeHtml(String(snap.current_period_end))}</code></div>` : "";
      const trialEnd = snap.trial_ends_at ? `<div class="muted" style="margin-top:6px;">Teste ate: <code>${escapeHtml(String(snap.trial_ends_at))}</code></div>` : "";
      currentBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:800;">Seu plano atual: <span class="pill premium">${escapeHtml(snap.plan.toUpperCase())}</span></div>
            <div class="muted" style="margin-top:6px;">Status: <code>${escapeHtml(String(snap.status || "active"))}</code> — Tenant: <code>${escapeHtml(
              String(snap.tenant_id)
            )}</code></div>
            ${trialEnd}
            ${periodEnd}
          </div>
          <div class="muted" style="margin-top:6px;">Dia (UTC): <code>${escapeHtml(snap.usage.day)}</code></div>
        </div>
      `;
    } else {
      currentBox.classList.add("hidden");
      currentBox.innerHTML = "";
    }
  }

  grid.innerHTML = PLAN_DEFS.map((d) => renderPlanCard(d, snap)).join("");

  // bind CTA
  grid.querySelectorAll("button[data-action=choose-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const plan = (btn as HTMLButtonElement).dataset.plan as PlanId;
      localStorage.setItem("selected_plan", plan);

      if (!getToken()) {
        setAlert(`Plano selecionado: <strong>${escapeHtml(plan)}</strong>. Agora faca login/cadastro para continuar.`, "ok");
        window.location.assign("/");
        return;
      }

      if (plan === "enterprise") {
        setAlert("Plano Enterprise: fale com o comercial para um pacote sob medida.", "ok");
        return;
      }

      try {
        const out = await api<{ url: string }>("/billing/checkout-session", {
          method: "POST",
          body: JSON.stringify({ plan }),
        });
        if (out?.url) window.location.assign(out.url);
        else setAlert("Nao foi possivel iniciar o checkout.", "danger");
      } catch (e: any) {
        setAlert(e.message || "Falha ao iniciar checkout.", "danger");
      }
    });
  });

  grid.querySelectorAll("button[data-action=change-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const plan = (btn as HTMLButtonElement).dataset.plan as PlanId;
      if (!getToken()) {
        setAlert("Faca login para alterar o plano.", "danger");
        return;
      }
      if (plan === "enterprise") {
        setAlert("Plano Enterprise: fale com o comercial.", "ok");
        return;
      }
      try {
        const out = await api<{ url: string }>("/billing/change-plan", {
          method: "POST",
          body: JSON.stringify({ plan }),
        });
        if (out?.url) window.location.assign(out.url);
        else setAlert("Plano alterado.", "ok");
      } catch (e: any) {
        setAlert(e.message || "Falha ao alterar plano.", "danger");
      }
    });
  });
}

async function acceptInvite() {
  const token = (qs("inviteToken") as HTMLInputElement).value.trim();
  const password = (qs("invitePassword") as HTMLInputElement).value;
  if (!token || !password) {
    setAlert("Informe token e senha.", "danger");
    return;
  }

  try {
    const r = await api<{ access_token: string; tenant_id: number; role: string }>("/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    setToken(r.access_token);
    showOnly("home");
    showApp(true);
    setAlert(`Convite aceito. Tenant: ${r.tenant_id} | Role: ${r.role}`);
    await refreshAds();
    refreshReports();
    await refreshTemplates();
    await refreshCrm();
    await refreshCampaigns();
    await refreshQueue();
  } catch (e: any) {
    setAlert(e.message || "Falha ao aceitar convite.", "danger");
  }
}

async function requestReset() {
  const email = (qs("resetEmail") as HTMLInputElement).value.trim();
  if (!email) {
    setAlert("Informe o email.", "danger");
    return;
  }
  try {
    await api<{ ok: boolean }>("/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    setAlert("Se o email existir, você receberá o link/token. (Em dev, a API pode retornar o token.)");
  } catch (e: any) {
    setAlert(e.message || "Falha ao solicitar reset.", "danger");
  }
}

async function confirmReset() {
  const token = (qs("resetToken") as HTMLInputElement).value.trim();
  const new_password = (qs("resetNewPassword") as HTMLInputElement).value;

  if (!token || !new_password) {
    setAlert("Informe token e nova senha.", "danger");
    return;
  }
  try {
    await api<{ ok: boolean }>("/auth/confirm-password-reset", {
      method: "POST",
      body: JSON.stringify({ token, new_password }),
    });
    setAlert("Senha redefinida com sucesso.");
  } catch (e: any) {
    setAlert(e.message || "Falha ao confirmar reset.", "danger");
  }
}

async function doLogin(isRegister: boolean) {
  const email = (qs("email") as HTMLInputElement).value.trim();
  const password = (qs("password") as HTMLInputElement).value;
  const tenant_slug = ((qs("tenantSlug") as HTMLInputElement).value || "").trim();

  if (!email || !password) {
    setAlert("Informe email e senha.", "danger");
    return;
  }

  try {
    setTenantSlug(tenant_slug);
    const data = await api<{ access_token: string }>(isRegister ? "/auth/register" : "/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, tenant_slug: tenant_slug || undefined }),
    });
    setToken(data.access_token);
    showApp(true);
    setAlert(isRegister ? "Cadastro ok." : "Login ok.");
    await refreshAds();
    refreshReports();
    await refreshTemplates();
    await refreshCrm();
    await refreshCampaigns();
    await refreshQueue();
  } catch (e: any) {
    setAlert(e.message || "Falha no login.", "danger");
  }
}

async function refreshDashboard() {
  const sec = qso("kpiSection");
  if (!sec) return;

  const token = getToken();
  sec.classList.toggle("hidden", !token);
  if (!token) return;

  try {
    const d = await api<DashboardOut>("/dashboard");
    const clicksEl = qso("kpiClicks");
    const convEl = qso("kpiConversions");
    const ctrEl = qso("kpiCtr");
    const tsEl = qso("kpiTs");
    const statusEl = qso("tlxStatus");

    if (clicksEl) clicksEl.textContent = String(d.clicks ?? 0);
    if (convEl) convEl.textContent = String(d.conversions ?? 0);
    if (ctrEl) ctrEl.textContent = `${((d.ctr_proxy ?? 0) * 100).toFixed(2)}%`;
    if (tsEl) tsEl.textContent = d.ts ? String(d.ts) : "—";

    const impressionsEl = qso("kpiImpressions");
    const ctrPctEl = qso("kpiCtrPct");
    const cvrEl = qso("kpiCvr");
    const convPerClickEl = qso("kpiConvPerClick");
    const clicks = Number(d.clicks ?? 0);
    const convCount = Number(d.conversions ?? 0);
    const impressions = Number(d.impressions_proxy ?? 0);
    const ctrPct = Number(d.ctr_proxy ?? 0) * 100;
    const cvr = clicks > 0 ? (convCount / clicks) * 100 : 0;
    const convPerClick = clicks > 0 ? (convCount / clicks) * 100 : 0;
    if (impressionsEl) impressionsEl.textContent = String(impressions);
    if (ctrPctEl) ctrPctEl.textContent = `${ctrPct.toFixed(2)}%`;
    if (cvrEl) cvrEl.textContent = `${cvr.toFixed(2)}%`;
    if (convPerClickEl) convPerClickEl.textContent = `${convPerClick.toFixed(2)}`;

    // Status TLX (dourado só se está performando / gerando dinheiro)
    const ctr = Number(d.ctr_proxy ?? 0);
    const conv = Number(d.conversions ?? 0);
    const CTR_TLX_THRESHOLD = 0.05; // 5% (mude depois se quiser)
    const isPremium = conv > 0 || ctr >= CTR_TLX_THRESHOLD;
    if (statusEl) statusEl.classList.toggle("hidden", !isPremium);
  } catch (e: any) {
    // Não quebra a tela por KPI
    const tsEl = qso("kpiTs");
    if (tsEl) tsEl.textContent = "—";
    const statusEl = qso("tlxStatus");
    if (statusEl) statusEl.classList.add("hidden");
    const impressionsEl = qso("kpiImpressions");
    const ctrPctEl = qso("kpiCtrPct");
    const cvrEl = qso("kpiCvr");
    const convPerClickEl = qso("kpiConvPerClick");
    if (impressionsEl) impressionsEl.textContent = "—";
    if (ctrPctEl) ctrPctEl.textContent = "—";
    if (cvrEl) cvrEl.textContent = "—";
    if (convPerClickEl) convPerClickEl.textContent = "—";
  }
}

async function refreshHistory(days = 14) {
  const chart = qso("historyChart");
  const labels = qso("historyLabels");
  const title = qso("historyTitle");
  if (!chart || !labels) return;
  const token = getToken();
  if (!token) {
    chart.innerHTML = "";
    labels.innerHTML = "";
    if (title) title.textContent = `Historico ${days} dias (cliques)`;
    return;
  }
  try {
    const out = await api<DashboardHistoryOut>(`/dashboard/history?days=${days}`);
    const maxClicks = Math.max(1, ...out.points.map((p) => p.clicks));
    chart.innerHTML = out.points
      .map((p) => {
        const pct = Math.max(6, Math.round((p.clicks / maxClicks) * 100));
        const cls = p.clicks === 0 ? "historyBar low" : "historyBar";
        const convPct = p.clicks > 0 ? Math.max(4, Math.round((p.conversions / p.clicks) * 100)) : 0;
        const inner = convPct ? `<div class="historyBarInner" style="height:${convPct}%;"></div>` : "";
        const title = `Cliques ${p.clicks} | Conv ${p.conversions} | CTR ${(p.ctr_proxy * 100).toFixed(2)}%`;
        return `<div class="${cls}" style="height:${pct}%;" title="${escapeHtml(title)}">${inner}</div>`;
      })
      .join("");
    labels.innerHTML = out.points
      .map((p) => `<div>${escapeHtml(p.day.slice(5))}</div>`)
      .join("");
    if (title) title.textContent = `Historico ${days} dias (cliques)`;
  } catch {
    chart.innerHTML = "";
    labels.innerHTML = "";
    if (title) title.textContent = `Historico ${days} dias (cliques)`;
  }
}

async function refreshChannelStats(days = 14) {
  const table = qso("channelsTable");
  const chart = qso("channelsChart");
  if (!table) return;
  if (!getToken()) {
    table.innerHTML = "";
    if (chart) chart.innerHTML = "";
    return;
  }
  try {
    const out = await api<{ points: ChannelStatsPoint[] }>(`/dashboard/channels?days=${days}`);
    table.innerHTML =
      out.points
        .map((p) => {
          return `
            <tr>
              <td>${escapeHtml(p.channel || "—")}</td>
              <td>${p.clicks}</td>
              <td>${p.conversions}</td>
              <td>${(p.ctr_proxy * 100).toFixed(2)}%</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="4" class="muted">Sem dados.</td></tr>`;
    if (chart) {
      const maxConv = Math.max(1, ...out.points.map((p) => p.conversions));
      chart.innerHTML = out.points
        .map((p) => {
          const pct = Math.max(8, Math.round((p.conversions / maxConv) * 100));
          const title = `${p.channel}: ${p.conversions} conv`;
          return `<div class="historyBar" style="height:${pct}%;" title="${escapeHtml(title)}"></div>`;
        })
        .join("");
    }
  } catch {
    table.innerHTML = `<tr><td colspan="4" class="muted">Falha ao carregar.</td></tr>`;
    if (chart) chart.innerHTML = "";
  }
}

async function refreshCampaignStats(days = 30) {
  const table = qso("campaignsTable");
  if (!table) return;
  if (!getToken()) {
    table.innerHTML = "";
    return;
  }
  try {
    const out = await api<{ points: CampaignStatsPoint[] }>(`/dashboard/campaigns?days=${days}`);
    table.innerHTML =
      out.points
        .map((p) => {
          const name = escapeHtml(p.campaign_name || "Sem campanha");
          return `
            <tr>
              <td>${name}</td>
              <td>${p.total}</td>
              <td>${p.sent}</td>
              <td>${p.failed}</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="4" class="muted">Sem dados.</td></tr>`;
  } catch {
    table.innerHTML = `<tr><td colspan="4" class="muted">Falha ao carregar.</td></tr>`;
  }
}

async function refreshCampaignConversions(days = 30) {
  const chart = qso("campaignsChart");
  if (!chart) return;
  if (!getToken()) {
    chart.innerHTML = "";
    return;
  }
  try {
    const out = await api<{ points: CampaignConvPoint[] }>(`/dashboard/campaign-conversions?days=${days}`);
    if (!out.points.length) {
      return;
    }
    const maxConv = Math.max(1, ...out.points.map((p) => p.conversions));
    chart.innerHTML = out.points
      .map((p) => {
        const pct = Math.max(8, Math.round((p.conversions / maxConv) * 100));
        const title = `${p.campaign_name}: ${p.conversions} conv`;
        return `<div class="historyBar low" style="height:${pct}%;" title="${escapeHtml(title)}"></div>`;
      })
      .join("");
  } catch {
    chart.innerHTML = "";
  }
}

async function refreshSla(days = 30) {
  const totalEl = qso("slaTotal");
  const failEl = qso("slaFailRate");
  const attemptsEl = qso("slaAttempts");
  const timeEl = qso("slaAvgTime");
  const statusEl = qso("slaStatus");
  const failCard = qso("slaFailCard");
  if (!totalEl || !failEl || !attemptsEl || !timeEl) return;
  if (!getToken()) {
    totalEl.textContent = "—";
    failEl.textContent = "—";
    attemptsEl.textContent = "—";
    timeEl.textContent = "—";
    failCard?.classList.remove("danger");
    if (statusEl) statusEl.textContent = "";
    return;
  }
  try {
    const out = await api<{
      total: number;
      failed: number;
      retrying: number;
      queued: number;
      sending: number;
      sent: number;
      avg_attempts: number;
      avg_time_sec: number;
      failure_rate: number;
    }>(`/dashboard/sla?days=${days}`);
    totalEl.textContent = String(out.total);
    failEl.textContent = `${(out.failure_rate * 100).toFixed(2)}%`;
    attemptsEl.textContent = out.avg_attempts.toFixed(2);
    timeEl.textContent = out.avg_time_sec.toFixed(1);
    if (failCard) {
      const threshold = 0.1;
      failCard.classList.toggle("danger", out.failure_rate >= threshold);
      failCard.classList.toggle("premium", out.failure_rate < threshold);
    }
    if (statusEl) {
      statusEl.textContent = `Sent ${out.sent} | Failed ${out.failed} | Retry ${out.retrying} | Queue ${out.queued}`;
    }
  } catch {
    totalEl.textContent = "—";
    failEl.textContent = "—";
    attemptsEl.textContent = "—";
    timeEl.textContent = "—";
    failCard?.classList.remove("danger");
    if (statusEl) statusEl.textContent = "";
  }
}

function refreshReports() {
  void refreshDashboard();
  const days = getReportsDays();
  void refreshHistory(days);
  void refreshChannelStats(days);
  const campaignDays = Math.max(30, days);
  void refreshCampaignStats(campaignDays);
  void refreshCampaignConversions(campaignDays);
  void refreshSla(campaignDays);
}

function getReportsDays(): number {
  const sel = qso("reportsDays") as HTMLSelectElement | null;
  const v = sel?.value ? Number(sel.value) : 14;
  return Number.isNaN(v) || v <= 0 ? 14 : v;
}

function renderTemplate(tpl: Template): string {
  return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; flex-wrap:wrap;">
        <div>
          <div style="font-weight:700;">${escapeHtml(tpl.name)}</div>
          <div class="muted" style="margin-top:6px;">Atualizado: ${escapeHtml(tpl.updated_at)}</div>
        </div>
        <div class="row">
          <button class="btn btn-secondary" data-action="tpl-apply" data-id="${tpl.id}">Usar</button>
          <button class="btn btn-danger" data-action="tpl-delete" data-id="${tpl.id}">Excluir</button>
        </div>
      </div>
      <div class="adBody">${escapeHtml(tpl.body)}</div>
    </div>
  `;
}

function updateTemplateSelects() {
  const selectIds = ["adTemplate", "autoTemplate"];
  selectIds.forEach((id) => {
    const select = qso(id) as HTMLSelectElement | null;
    if (!select) return;
    const current = select.value;
    select.innerHTML =
      `<option value="">Sem template</option>` +
      templatesCache.map((tpl) => `<option value="${tpl.id}">${escapeHtml(tpl.name)}</option>`).join("");
    if (current) select.value = current;
  });
}

function updateCampaignSelects() {
  const selectIds = ["adCampaignId", "autoCampaignId", "adsCampaign"];
  selectIds.forEach((id) => {
    const select = qso(id) as HTMLSelectElement | null;
    if (!select) return;
    const current = select.value;
    const emptyLabel = id === "adsCampaign" ? "Todas" : "Sem campanha";
    select.innerHTML =
      `<option value="">${emptyLabel}</option>` +
      campaignsCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    if (current) select.value = current;
  });
}

async function refreshTemplates() {
  const list = qso("templatesList");
  if (!list) return;
  const token = getToken();
  if (!token) {
    list.innerHTML = `<div class="muted">Faça login para ver seus templates.</div>`;
    templatesCache = [];
    updateTemplateSelects();
    renderVariablesForm("adVariablesForm", []);
    return;
  }
  try {
    const templates = await api<Template[]>("/templates");
    templatesCache = templates;
    list.innerHTML = templates.map(renderTemplate).join("") || `<div class="muted">Nenhum template salvo ainda.</div>`;
    updateTemplateSelects();

    list.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = (btn as HTMLButtonElement).dataset.action!;
        const id = Number((btn as HTMLButtonElement).dataset.id!);
        if (action === "tpl-apply") {
          const tpl = templates.find((t) => t.id === id);
          if (!tpl) return;
          applyTemplateToAd(tpl);
          const bodyEl = qso("adBody") as HTMLTextAreaElement | null;
          bodyEl?.focus();
          setAlert(`Template aplicado: ${escapeHtml(tpl.name)}`);
        }
        if (action === "tpl-delete") {
          if (!confirm("Excluir este template?")) return;
          await api(`/templates/${id}`, { method: "DELETE" });
          setAlert("Template excluido.");
          await refreshTemplates();
        }
      });
    });
  } catch (e: any) {
    setAlert(e.message || "Falha ao carregar templates.", "danger");
  }
}

async function createTemplate() {
  const nameEl = qso("tplName") as HTMLInputElement | null;
  const bodyEl = qso("tplBody") as HTMLTextAreaElement | null;
  if (!nameEl || !bodyEl) return;
  const name = nameEl.value.trim();
  const body = bodyEl.value.trim();
  if (!name || !body) {
    setAlert("Informe nome e texto do template.", "danger");
    return;
  }
  try {
    await api<Template>("/templates", {
      method: "POST",
      body: JSON.stringify({ name, body }),
    });
    nameEl.value = "";
    bodyEl.value = "";
    setAlert("Template salvo.");
    await refreshTemplates();
  } catch (e: any) {
    setAlert(e.message || "Falha ao salvar template.", "danger");
  }
}

async function previewAd() {
  const bodyEl = qso("adBody") as HTMLTextAreaElement | null;
  const varsEl = qso("adVariables") as HTMLInputElement | null;
  const previewBox = qso("adPreview");
  const previewBody = qso("adPreviewBody");
  if (!bodyEl || !previewBox || !previewBody) return;
  const body = bodyEl.value.trim();
  if (!body) {
    setAlert("Informe um texto para pré-visualizar.", "danger");
    return;
  }

  syncVariablesJson("adVariablesForm", "adVariables");
  let variables: Record<string, string> = {};
  const raw = varsEl?.value?.trim() || "";
  try {
    variables = parseVariablesJson(raw);
  } catch {
    setAlert("Variáveis inválidas. Use JSON válido.", "danger");
    return;
  }

  try {
    const out = await api<{ rendered: string }>("/templates/preview", {
      method: "POST",
      body: JSON.stringify({ body, variables }),
    });
    previewBox.classList.remove("hidden");
    previewBody.textContent = out.rendered || "";
  } catch (e: any) {
    setAlert(e.message || "Falha ao gerar preview.", "danger");
  }
}

async function runAutomation() {
  const segmentEl = qso("autoSegmentId") as HTMLInputElement | null;
  const campaignEl = qso("autoCampaignId") as HTMLSelectElement | null;
  const channelEl = qso("autoChannel") as HTMLSelectElement | null;
  const scheduleEl = qso("autoScheduleAt") as HTMLInputElement | null;
  const templateEl = qso("autoTemplate") as HTMLSelectElement | null;
  const varsEl = qso("autoVariables") as HTMLInputElement | null;
  const bodyEl = qso("autoBody") as HTMLTextAreaElement | null;
  const statusEl = qso("autoStatus");
  if (!segmentEl || !channelEl || !bodyEl) return;

  const segmentId = Number(segmentEl.value.trim());
  if (!segmentId || Number.isNaN(segmentId)) {
    setAlert("Informe um ID de segmento válido.", "danger");
    return;
  }

  const channel = channelEl.value;
  const scheduled_at = scheduleEl?.value.trim() || undefined;
  const campaign_id = campaignEl?.value ? Number(campaignEl.value) : undefined;
  const template_id = templateEl?.value ? Number(templateEl.value) : undefined;

  let body = bodyEl.value.trim();
  if (!body && template_id) {
    const tpl = templatesCache.find((t) => t.id === template_id);
    if (tpl) body = tpl.body;
  }
  if (!body) {
    setAlert("Informe uma mensagem para automacao.", "danger");
    return;
  }

  let variables: Record<string, string> | undefined;
  const raw = varsEl?.value?.trim() || "";
  try {
    const parsed = parseVariablesJson(raw);
    if (Object.keys(parsed).length > 0) variables = parsed;
  } catch {
    setAlert("Variáveis inválidas. Use JSON válido.", "danger");
    return;
  }

  try {
    const out = await api<{ queued: number; failed: number; skipped: number }>("/automation/segment-send", {
      method: "POST",
      body: JSON.stringify({
        segment_id: segmentId,
        campaign_id,
        channel,
        scheduled_at,
        template_id,
        variables,
        body,
      }),
    });
    if (statusEl) {
      statusEl.textContent = `Enfileirados: ${out.queued} | Falharam: ${out.failed} | Ignorados: ${out.skipped}`;
    }
    setAlert("Automacao disparada.");
  } catch (e: any) {
    setAlert(e.message || "Falha ao disparar automacao.", "danger");
  }
}

function renderContactsTable(contacts: Contact[]): string {
  return contacts
    .map((c) => {
      const name = c.name ? escapeHtml(String(c.name)) : "—";
      const email = c.email ? escapeHtml(String(c.email)) : "—";
      const phone = c.phone ? escapeHtml(String(c.phone)) : "—";
      let tags = "—";
      if (c.meta_json) {
        try {
          const parsed = JSON.parse(String(c.meta_json));
          const list = Array.isArray(parsed?.tags) ? parsed.tags : [];
          if (list.length) tags = escapeHtml(list.join(", "));
        } catch {
          // ignore invalid meta
        }
      }
      return `
        <tr>
          <td>${name}</td>
          <td>${email}</td>
          <td>${phone}</td>
          <td>${tags}</td>
          <td>
            <button class="btn btn-secondary" data-action="contact-edit" data-id="${c.id}">Editar</button>
            <button class="btn btn-danger" data-action="contact-delete" data-id="${c.id}">Excluir</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderSegmentsOptions(segments: Segment[]): string {
  return segments.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

async function refreshCrm() {
  const contactsList = qso("contactsList");
  const segmentsSelect = qso("segmentSelect") as HTMLSelectElement | null;
  const segmentContactSelect = qso("segmentContactSelect") as HTMLSelectElement | null;
  const segmentsList = qso("segmentsList");
  const contactsCount = qso("contactsCount");
  const segmentsCount = qso("segmentsCount");
  if (!contactsList || !segmentsSelect || !segmentContactSelect || !segmentsList) return;
  if (!getToken()) {
    contactsList.innerHTML = "";
    segmentsSelect.innerHTML = "";
    segmentContactSelect.innerHTML = "";
    if (contactsCount) contactsCount.textContent = "0";
    if (segmentsCount) segmentsCount.textContent = "0";
    contactsCache = [];
    return;
  }
  try {
    const q = (qso("contactsSearch") as HTMLInputElement | null)?.value?.trim() || "";
    const params = q ? `?q=${encodeURIComponent(q)}` : "";
    const [contacts, segments] = await Promise.all([api<Contact[]>(`/contacts${params}`), api<Segment[]>("/segments")]);
    contactsCache = contacts;
    contactsList.innerHTML = renderContactsTable(contacts) || `<tr><td colspan="4" class="muted">Sem contatos.</td></tr>`;
    if (contactsCount) contactsCount.textContent = String(contacts.length);
    if (segmentsCount) segmentsCount.textContent = String(segments.length);

    const segOptions = `<option value="">Selecione</option>` + renderSegmentsOptions(segments);
    segmentsSelect.innerHTML = segOptions;

    const contactOptions =
      `<option value="">Selecione</option>` +
      contacts.map((c) => `<option value="${c.id}">${escapeHtml(String(c.name || c.email || c.phone || c.id))}</option>`).join("");
    segmentContactSelect.innerHTML = contactOptions;

    segmentsList.innerHTML =
      segments
        .map((s) => {
          return `
            <tr>
              <td>${escapeHtml(s.name)}</td>
              <td>
                <button class="btn btn-secondary" data-action="segment-edit" data-id="${s.id}">Editar</button>
                <button class="btn btn-danger" data-action="segment-delete" data-id="${s.id}">Excluir</button>
              </td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="2" class="muted">Sem segmentos.</td></tr>`;

    void refreshSegmentMembers();

    contactsList.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = (btn as HTMLButtonElement).dataset.action!;
        const id = Number((btn as HTMLButtonElement).dataset.id || "0");
        if (!id) return;
        if (action === "contact-delete") {
          if (!confirm("Excluir este contato?")) return;
          await api(`/contacts/${id}`, { method: "DELETE" });
          setAlert("Contato excluido.");
          await refreshCrm();
        }
        if (action === "contact-edit") {
          const contact = contacts.find((c) => c.id === id);
          if (!contact) return;
          const name = prompt("Nome", contact.name || "") ?? "";
          const email = prompt("Email", contact.email || "") ?? "";
          const phone = prompt("Telefone", contact.phone || "") ?? "";
          const consent_at = prompt("Consentimento (ISO 8601)", contact.consent_at || "") ?? "";
          let tags = "";
          if (contact.meta_json) {
            try {
              const parsed = JSON.parse(String(contact.meta_json));
              if (Array.isArray(parsed?.tags)) tags = parsed.tags.join(", ");
            } catch {
              // ignore
            }
          }
          const tagsRaw = prompt("Tags (separadas por virgula)", tags) ?? "";
          const tagsList = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
          await api(`/contacts/${id}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: name || undefined,
              email: email || undefined,
              phone: phone || undefined,
              consent_at: consent_at || undefined,
              meta: tagsList.length ? { tags: tagsList } : undefined,
            }),
          });
          setAlert("Contato atualizado.");
          await refreshCrm();
        }
      });
    });

    segmentsList.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number((btn as HTMLButtonElement).dataset.id || "0");
        if (!id) return;
        const action = (btn as HTMLButtonElement).dataset.action;
        if (action === "segment-delete") {
          if (!confirm("Excluir este segmento?")) return;
          await api(`/segments/${id}`, { method: "DELETE" });
          setAlert("Segmento excluido.");
          await refreshCrm();
        }
        if (action === "segment-edit") {
          const segment = segments.find((s) => s.id === id);
          if (!segment) return;
          const name = prompt("Nome do segmento", segment.name) ?? "";
          if (!name.trim()) return;
          await api(`/segments/${id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
          setAlert("Segmento atualizado.");
          await refreshCrm();
        }
      });
    });
  } catch (e: any) {
    setAlert(e.message || "Falha ao carregar contatos/segmentos.", "danger");
  }
}

async function refreshSegmentMembers() {
  const segmentSelect = qso("segmentSelect") as HTMLSelectElement | null;
  const membersBox = qso("segmentMembers");
  if (!segmentSelect || !membersBox) return;
  const segmentId = Number(segmentSelect.value || "0");
  if (!segmentId) {
    membersBox.innerHTML = `<div class="muted">Selecione um segmento.</div>`;
    return;
  }
  try {
    const members = await api<SegmentMember[]>(`/segments/${segmentId}/members`);
    membersBox.innerHTML =
      members
        .map((m) => {
          const label = escapeHtml(String(m.name || m.email || m.phone || m.id));
          return `
            <div class="card" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
              <div>${label}</div>
              <button class="btn btn-danger" data-action="segment-remove" data-id="${m.id}">Remover</button>
            </div>
          `;
        })
        .join("") || `<div class="muted">Sem membros neste segmento.</div>`;

    membersBox.querySelectorAll("button[data-action=segment-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const contactId = Number((btn as HTMLButtonElement).dataset.id || "0");
        if (!contactId) return;
        await api(`/segments/${segmentId}/members/${contactId}`, { method: "DELETE" });
        setAlert("Membro removido.");
        await refreshSegmentMembers();
      });
    });
  } catch (e: any) {
    setAlert(e.message || "Falha ao carregar membros.", "danger");
  }
}

function renderCampaignsTable(campaigns: Campaign[]): string {
  return campaigns
    .map((c) => {
      return `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.status || "active")}</td>
          <td>
            <button class="btn btn-secondary" data-action="campaign-edit" data-id="${c.id}">Editar</button>
            <button class="btn btn-danger" data-action="campaign-delete" data-id="${c.id}">Excluir</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function refreshCampaigns() {
  const list = qso("campaignsList");
  const count = qso("campaignsCount");
  if (!list || !count) return;
  if (!getToken()) {
    campaignsCache = [];
    list.innerHTML = `<tr><td colspan="3" class="muted">Sem campanhas.</td></tr>`;
    count.textContent = "0";
    updateCampaignSelects();
    return;
  }
  try {
    const q = (qso("campaignsSearch") as HTMLInputElement | null)?.value?.trim() || "";
    const params = q ? `?q=${encodeURIComponent(q)}` : "";
    const campaigns = await api<Campaign[]>(`/campaigns${params}`);
    campaignsCache = campaigns;
    list.innerHTML = renderCampaignsTable(campaigns) || `<tr><td colspan="3" class="muted">Sem campanhas.</td></tr>`;
    count.textContent = String(campaigns.length);
    updateCampaignSelects();
    if (adsCache.length) {
      void refreshAds();
    }

    list.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = (btn as HTMLButtonElement).dataset.action || "";
        const id = Number((btn as HTMLButtonElement).dataset.id || "0");
        if (!id) return;
        if (action === "campaign-delete") {
          if (!confirm("Excluir esta campanha?")) return;
          await api(`/campaigns/${id}`, { method: "DELETE" });
          setAlert("Campanha excluida.");
          await refreshCampaigns();
        }
        if (action === "campaign-edit") {
          const campaign = campaigns.find((c) => c.id === id);
          if (!campaign) return;
          const name = prompt("Nome da campanha", campaign.name) ?? "";
          if (!name.trim()) return;
          const objective = prompt("Objetivo", campaign.objective || "") ?? "";
          const status = prompt("Status (active/paused/draft)", campaign.status || "active") ?? "";
          const start_at = prompt("Inicio (ISO 8601)", campaign.start_at || "") ?? "";
          const end_at = prompt("Fim (ISO 8601)", campaign.end_at || "") ?? "";
          await api(`/campaigns/${id}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: name.trim(),
              objective: objective || undefined,
              status: status || undefined,
              start_at: start_at || undefined,
              end_at: end_at || undefined,
            }),
          });
          setAlert("Campanha atualizada.");
          await refreshCampaigns();
        }
      });
    });
  } catch (e: any) {
    setAlert(e.message || "Falha ao carregar campanhas.", "danger");
  }
}

async function createCampaign() {
  const nameEl = qso("campaignName") as HTMLInputElement | null;
  const objectiveEl = qso("campaignObjective") as HTMLInputElement | null;
  const statusEl = qso("campaignStatus") as HTMLSelectElement | null;
  const startEl = qso("campaignStart") as HTMLInputElement | null;
  const endEl = qso("campaignEnd") as HTMLInputElement | null;
  if (!nameEl || !statusEl) return;
  const name = nameEl.value.trim();
  if (!name) {
    setAlert("Informe um nome para a campanha.", "danger");
    return;
  }
  try {
    await api<Campaign>("/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name,
        objective: objectiveEl?.value.trim() || undefined,
        status: statusEl.value,
        start_at: startEl?.value.trim() || undefined,
        end_at: endEl?.value.trim() || undefined,
      }),
    });
    setAlert("Campanha criada.");
    nameEl.value = "";
    if (objectiveEl) objectiveEl.value = "";
    if (startEl) startEl.value = "";
    if (endEl) endEl.value = "";
    await refreshCampaigns();
  } catch (e: any) {
    setAlert(e.message || "Falha ao criar campanha.", "danger");
  }
}

async function createContact() {
  const name = (qso("contactName") as HTMLInputElement | null)?.value.trim() || "";
  const email = (qso("contactEmail") as HTMLInputElement | null)?.value.trim() || "";
  const phone = (qso("contactPhone") as HTMLInputElement | null)?.value.trim() || "";
  const consent_at = (qso("contactConsent") as HTMLInputElement | null)?.value.trim() || undefined;
  const tagsRaw = (qso("contactTags") as HTMLInputElement | null)?.value.trim() || "";
  if (!email && !phone) {
    setAlert("Informe email ou telefone.", "danger");
    return;
  }
  const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
  try {
    await api<Contact>("/contacts", {
      method: "POST",
      body: JSON.stringify({
        name,
        email: email || undefined,
        phone: phone || undefined,
        consent_at,
        meta: tags.length ? { tags } : undefined,
      }),
    });
    setAlert("Contato criado.");
    const fields = ["contactName", "contactEmail", "contactPhone", "contactConsent", "contactTags"];
    fields.forEach((id) => {
      const el = qso(id) as HTMLInputElement | null;
      if (el) el.value = "";
    });
    await refreshCrm();
  } catch (e: any) {
    setAlert(e.message || "Falha ao criar contato.", "danger");
  }
}

async function createSegment() {
  const name = (qso("segmentName") as HTMLInputElement | null)?.value.trim() || "";
  if (!name) {
    setAlert("Informe um nome de segmento.", "danger");
    return;
  }
  try {
    await api<Segment>("/segments", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setAlert("Segmento criado.");
    const el = qso("segmentName") as HTMLInputElement | null;
    if (el) el.value = "";
    await refreshCrm();
  } catch (e: any) {
    setAlert(e.message || "Falha ao criar segmento.", "danger");
  }
}

async function addSegmentMember() {
  const segmentSelect = qso("segmentSelect") as HTMLSelectElement | null;
  const contactSelect = qso("segmentContactSelect") as HTMLSelectElement | null;
  if (!segmentSelect || !contactSelect) return;
  const segmentId = Number(segmentSelect.value || "0");
  const contactId = Number(contactSelect.value || "0");
  if (!segmentId || !contactId) {
    setAlert("Selecione segmento e contato.", "danger");
    return;
  }
  try {
    await api(`/segments/${segmentId}/members`, {
      method: "POST",
      body: JSON.stringify({ contact_id: contactId }),
    });
    setAlert("Contato adicionado ao segmento.");
    await refreshSegmentMembers();
  } catch (e: any) {
    setAlert(e.message || "Falha ao adicionar membro.", "danger");
  }
}

let queueTimer: number | null = null;
let reportsTimer: number | null = null;

function toggleReportsAuto(enable: boolean) {
  if (reportsTimer) {
    window.clearInterval(reportsTimer);
    reportsTimer = null;
  }
  if (enable) {
    reportsTimer = window.setInterval(() => {
      refreshReports();
    }, 8000);
  }
}

function toggleQueueAuto(enable: boolean) {
  if (queueTimer) {
    window.clearInterval(queueTimer);
    queueTimer = null;
  }
  if (enable) {
    queueTimer = window.setInterval(() => {
      void refreshQueue();
    }, 8000);
  }
}
async function refreshQueue() {
  const list = qso("queueList");
  if (!list) return;
  if (!getToken()) {
    list.innerHTML = "";
    return;
  }
  try {
    const items = await api<DeliveryQueue[]>("/deliveries?limit=20");
    list.innerHTML =
      items
        .map((d) => {
          return `
            <tr>
              <td>${d.id}</td>
              <td>${escapeHtml(d.channel)}</td>
              <td>${escapeHtml(d.to_addr)}</td>
              <td>${escapeHtml(d.status)}</td>
              <td>${d.attempts}</td>
              <td>${d.next_attempt_at ? escapeHtml(String(d.next_attempt_at)) : "—"}</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="6" class="muted">Sem envios na fila.</td></tr>`;
  } catch {
    list.innerHTML = `<tr><td colspan="6" class="muted">Falha ao carregar fila.</td></tr>`;
  }
}

function exportContactsCsv() {
  if (!contactsCache.length) {
    setAlert("Sem contatos para exportar.", "danger");
    return;
  }
  const rows = [
    ["id", "name", "email", "phone", "consent_at", "tags"].join(","),
    ...contactsCache.map((c) => {
      let tags = "";
      if (c.meta_json) {
        try {
          const parsed = JSON.parse(String(c.meta_json));
          if (Array.isArray(parsed?.tags)) tags = parsed.tags.join("|");
        } catch {
          // ignore
        }
      }
      return [
        c.id,
        `"${String(c.name || "").replace(/\"/g, '""')}"`,
        `"${String(c.email || "").replace(/\"/g, '""')}"`,
        `"${String(c.phone || "").replace(/\"/g, '""')}"`,
        `"${String(c.consent_at || "").replace(/\"/g, '""')}"`,
        `"${String(tags).replace(/\"/g, '""')}"`,
      ].join(",");
    }),
  ];
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "contacts.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function createAd() {
  const title = (qs("adTitle") as HTMLInputElement).value.trim();
  const body = (qs("adBody") as HTMLTextAreaElement).value.trim();
  const channel = (qs("adChannel") as HTMLSelectElement).value;
  const target_url = (qs("adUrl") as HTMLInputElement).value.trim() || null;
  const templateSelect = qso("adTemplate") as HTMLSelectElement | null;
  const variablesInput = qso("adVariables") as HTMLInputElement | null;
  const campaignInput = qso("adCampaignId") as HTMLSelectElement | null;
  const template_id = templateSelect?.value ? Number(templateSelect.value) : undefined;
  syncVariablesJson("adVariablesForm", "adVariables");
  const variablesRaw = variablesInput?.value?.trim() || "";
  let campaign_id = campaignInput?.value ? Number(campaignInput.value) : undefined;
  if (campaign_id !== undefined && Number.isNaN(campaign_id)) {
    setAlert("Campanha inválida. Use um ID numérico.", "danger");
    return;
  }

  if (!title || !body) {
    setAlert("Título e texto são obrigatórios.", "danger");
    return;
  }

  let variables: Record<string, string> | undefined;
  try {
    const parsed = parseVariablesJson(variablesRaw);
    if (Object.keys(parsed).length > 0) variables = parsed;
  } catch {
    setAlert("Variáveis inválidas. Use JSON válido.", "danger");
    return;
  }

  try {
    await api<Ad>("/ads", {
      method: "POST",
      body: JSON.stringify({ title, body, channel, target_url, template_id, variables, campaign_id }),
    });

    (qs("adTitle") as HTMLInputElement).value = "";
    (qs("adBody") as HTMLTextAreaElement).value = "";
    (qs("adUrl") as HTMLInputElement).value = "";
    if (campaignInput) campaignInput.value = "";

    setAlert("Anúncio criado como draft.");
    await refreshAds();
  } catch (e: any) {
    setAlert(e.message || "Falha ao criar anúncio.", "danger");
  }
}

function renderAd(ad: Ad): string {
  const sched = ad.scheduled_at ? `<span class="pill">Agendado</span><span class="muted">${escapeHtml(ad.scheduled_at)}</span>` : "";
  const url = ad.target_url
    ? `<span class="pill">URL</span><a class="muted" href="${ad.target_url}" target="_blank" rel="noopener noreferrer">${escapeHtml(ad.target_url)}</a>`
    : "";
  const campaignName = ad.campaign_id
    ? campaignsCache.find((c) => c.id === ad.campaign_id)?.name || `#${ad.campaign_id}`
    : "";
  const campaign = campaignName ? `<span class="pill">Campanha ${escapeHtml(campaignName)}</span>` : "";
  const statusBadge = ad.status === "sent" ? "premium" : "";
  return `
    <div class="card">
      <div class="adHeader">
        <div style="flex: 1 1 520px; min-width: 280px;">
          <div class="adPills">
            <span class="adTitle">${escapeHtml(ad.title)}</span>
            <span class="pill ${statusBadge}">${escapeHtml(ad.status)}</span>
            <span class="pill">${escapeHtml(ad.channel)}</span>
            ${campaign}
          </div>

          <div class="adBody">${escapeHtml(ad.body)}</div>

          <div class="adMeta">
            ${url ? `<div>${url}</div>` : ""}
            ${sched ? `<div>${sched}</div>` : ""}
          </div>

          <div class="muted" style="margin-top:10px;">Atualizado: ${escapeHtml(ad.updated_at)}</div>
        </div>

        <div class="adActions">
          <button class="btn btn-secondary" data-action="pause" data-id="${ad.id}">Pausar</button>
          <button class="btn btn-secondary" data-action="draft" data-id="${ad.id}">Voltar para Draft</button>
          <button class="btn btn-secondary" data-action="schedule" data-id="${ad.id}">Agendar</button>
          <button class="btn btn-danger" data-action="delete" data-id="${ad.id}">Excluir</button>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

type AdsFilters = {
  q: string;
  status: string;
  channel: string;
  campaign_id: string;
  limit: number;
  offset: number;
};

const ADS_PAGE_SIZE = 20;
let adsOffset = 0;
let adsHasMore = true;
let adsCache: Ad[] = [];

function getAdsFilters(): AdsFilters {
  const q = (qso("adsSearch") as HTMLInputElement | null)?.value?.trim() || "";
  const status = (qso("adsStatus") as HTMLSelectElement | null)?.value || "";
  const channel = (qso("adsChannel") as HTMLSelectElement | null)?.value || "";
  const campaign_id = (qso("adsCampaign") as HTMLSelectElement | null)?.value || "";
  return { q, status, channel, campaign_id, limit: ADS_PAGE_SIZE, offset: adsOffset };
}

function updateAdsSummary(ads: Ad[]) {
  const totalEl = qso("adsCount");
  if (totalEl) {
    totalEl.textContent = `${ads.length} anúncio(s) carregados`;
  }
  const summaryEl = qso("adsStatusSummary");
  if (summaryEl) {
    const counts = ads.reduce(
      (acc, ad) => {
        acc[ad.status] = (acc[ad.status] || 0) + 1;
        return acc;
      },
      {} as Record<AdStatus, number>
    );
    summaryEl.innerHTML = `
      <span class="pill">Draft ${counts.draft || 0}</span>
      <span class="pill">Agendado ${counts.scheduled || 0}</span>
      <span class="pill premium">Enviado ${counts.sent || 0}</span>
      <span class="pill">Pausado ${counts.paused || 0}</span>
    `;
  }
}

function toggleLoadMore(isVisible: boolean) {
  const btn = qso("adsLoadMore") as HTMLButtonElement | null;
  if (btn) btn.classList.toggle("hidden", !isVisible);
}

async function refreshAds(opts?: { append?: boolean }) {
  const append = opts?.append || false;
  if (!append) {
    adsOffset = 0;
    adsHasMore = true;
    adsCache = [];
  }

  try {
    const filters = getAdsFilters();
    const params = new URLSearchParams();
    params.set("limit", String(filters.limit));
    params.set("offset", String(filters.offset));
    if (filters.q) params.set("q", filters.q);
    if (filters.status) params.set("status", filters.status);
    if (filters.channel) params.set("channel", filters.channel);
    if (filters.campaign_id) params.set("campaign_id", filters.campaign_id);

    const ads = await api<Ad[]>(`/ads?${params.toString()}`);
    const list = qs("adsList");
    adsCache = append ? adsCache.concat(ads) : ads;
    list.innerHTML = adsCache.map(renderAd).join("");

    // bind actions
    list.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = (btn as HTMLButtonElement).dataset.action!;
        const id = Number((btn as HTMLButtonElement).dataset.id!);
        await handleAdAction(action, id);
      });
    });

    const emptyEl = qso("adsEmpty");
    const totalAds = adsCache.length;
    if (emptyEl) {
      emptyEl.textContent = totalAds === 0 ? "Nenhum anúncio encontrado com os filtros atuais." : "";
    }

    adsOffset = adsCache.length;
    adsHasMore = ads.length === ADS_PAGE_SIZE;
    toggleLoadMore(adsHasMore);
    updateAdsSummary(adsCache);
  } catch (e: any) {
    setAlert(e.message || "Falha ao carregar anúncios.", "danger");
  }
}

async function handleAdAction(action: string, id: number) {
  try {
    if (action === "delete") {
      await api<{ deleted: boolean }>(`/ads/${id}`, { method: "DELETE" });
      setAlert("Anúncio excluído.");
      await refreshAds();
      return;
    }

    if (action === "schedule") {
      const when = prompt("Informe o scheduled_at (ISO 8601 UTC). Ex: 2026-01-11T15:00:00+00:00");
      if (!when) return;
      await api<Ad>(`/ads/${id}/schedule?scheduled_at=${encodeURIComponent(when)}`, { method: "POST" });
      setAlert("Anúncio agendado.");
      await refreshAds();
      return;
    }

    if (action === "pause") {
      await api<Ad>(`/ads/${id}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) });
      setAlert("Anúncio pausado.");
      await refreshAds();
      return;
    }

    if (action === "draft") {
      await api<Ad>(`/ads/${id}`, { method: "PATCH", body: JSON.stringify({ status: "draft", scheduled_at: null }) });
      setAlert("Anúncio voltou para draft.");
      await refreshAds();
      return;
    }
  } catch (e: any) {
    setAlert(e.message || "Falha na ação.", "danger");
  }
}

// Wire UI
(qs("btnLogin") as HTMLButtonElement).addEventListener("click", () => void doLogin(false));
(qs("btnRegister") as HTMLButtonElement).addEventListener("click", () => void doLogin(true));
(qs("btnCreateAd") as HTMLButtonElement).addEventListener("click", () => void createAd());
(qs("btnRefresh") as HTMLButtonElement).addEventListener("click", () => void refreshAds());
(qso("btnRefreshReports") as HTMLButtonElement | null)?.addEventListener("click", () => refreshReports());
(qso("btnCreateTemplate") as HTMLButtonElement | null)?.addEventListener("click", () => void createTemplate());
(qso("btnRefreshTemplates") as HTMLButtonElement | null)?.addEventListener("click", () => void refreshTemplates());
(qso("btnPreviewAd") as HTMLButtonElement | null)?.addEventListener("click", () => void previewAd());
(qso("btnRunAutomation") as HTMLButtonElement | null)?.addEventListener("click", () => void runAutomation());
(qso("btnRefreshCrm") as HTMLButtonElement | null)?.addEventListener("click", () => {
  void refreshCrm();
  void refreshCampaigns();
});
(qso("btnCreateContact") as HTMLButtonElement | null)?.addEventListener("click", () => void createContact());
(qso("btnCreateSegment") as HTMLButtonElement | null)?.addEventListener("click", () => void createSegment());
(qso("btnAddSegmentMember") as HTMLButtonElement | null)?.addEventListener("click", () => void addSegmentMember());
(qso("btnRefreshQueue") as HTMLButtonElement | null)?.addEventListener("click", () => void refreshQueue());
(qso("btnCreateCampaign") as HTMLButtonElement | null)?.addEventListener("click", () => void createCampaign());
(qso("reportsDays") as HTMLSelectElement | null)?.addEventListener("change", () => refreshReports());
(qso("btnExportContacts") as HTMLButtonElement | null)?.addEventListener("click", () => exportContactsCsv());
(qso("reportsAutoRefresh") as HTMLInputElement | null)?.addEventListener("change", (ev) => {
  const checked = (ev.target as HTMLInputElement).checked;
  toggleReportsAuto(checked);
  if (checked) refreshReports();
});
(qso("queueAutoRefresh") as HTMLInputElement | null)?.addEventListener("change", (ev) => {
  const checked = (ev.target as HTMLInputElement).checked;
  toggleQueueAuto(checked);
  if (checked) void refreshQueue();
});
(qso("btnUseAdAsTemplate") as HTMLButtonElement | null)?.addEventListener("click", () => {
  const bodyEl = qso("adBody") as HTMLTextAreaElement | null;
  const titleEl = qso("adTitle") as HTMLInputElement | null;
  const tplBody = qso("tplBody") as HTMLTextAreaElement | null;
  const tplName = qso("tplName") as HTMLInputElement | null;
  if (tplBody && bodyEl) tplBody.value = bodyEl.value;
  if (tplName && titleEl) tplName.value = titleEl.value;
});
(qso("adTemplate") as HTMLSelectElement | null)?.addEventListener("change", () => {
  const select = qso("adTemplate") as HTMLSelectElement | null;
  const id = select?.value ? Number(select.value) : 0;
  if (!id) {
    renderVariablesForm("adVariablesForm", []);
    return;
  }
  const tpl = templatesCache.find((t) => t.id === id);
  const bodyEl = qso("adBody") as HTMLTextAreaElement | null;
  const titleEl = qso("adTitle") as HTMLInputElement | null;
  if (tpl && bodyEl) bodyEl.value = tpl.body;
  if (tpl && titleEl && !titleEl.value.trim()) titleEl.value = tpl.name;
  if (tpl) {
    renderVariablesForm("adVariablesForm", extractVariables(tpl.body));
    bindVariablesForm("adVariablesForm", "adVariables");
  }
});
(qso("segmentSelect") as HTMLSelectElement | null)?.addEventListener("change", () => {
  void refreshSegmentMembers();
  const autoEl = qso("autoSegmentId") as HTMLInputElement | null;
  const segEl = qso("segmentSelect") as HTMLSelectElement | null;
  if (autoEl && segEl?.value) autoEl.value = segEl.value;
});
(qso("autoTemplate") as HTMLSelectElement | null)?.addEventListener("change", () => {
  const select = qso("autoTemplate") as HTMLSelectElement | null;
  const id = select?.value ? Number(select.value) : 0;
  const bodyEl = qso("autoBody") as HTMLTextAreaElement | null;
  if (!id || !bodyEl) return;
  const tpl = templatesCache.find((t) => t.id === id);
  if (tpl && !bodyEl.value.trim()) bodyEl.value = tpl.body;
});

(qs("btnLogout") as HTMLButtonElement).addEventListener("click", () => {
  setToken(null);
  showApp(false);
  setAlert("Você saiu.");
});

(qs("btnAcceptInvite") as HTMLButtonElement).addEventListener("click", () => void acceptInvite());
(qs("btnRequestReset") as HTMLButtonElement).addEventListener("click", () => void requestReset());
(qs("btnConfirmReset") as HTMLButtonElement).addEventListener("click", () => void confirmReset());
(qso("adsLoadMore") as HTMLButtonElement | null)?.addEventListener("click", () => void refreshAds({ append: true }));
(qso("adsClear") as HTMLButtonElement | null)?.addEventListener("click", () => {
  const s = qso("adsSearch") as HTMLInputElement | null;
  const status = qso("adsStatus") as HTMLSelectElement | null;
  const channel = qso("adsChannel") as HTMLSelectElement | null;
  const campaign = qso("adsCampaign") as HTMLSelectElement | null;
  if (s) s.value = "";
  if (status) status.value = "";
  if (channel) channel.value = "";
  if (campaign) campaign.value = "";
  void refreshAds();
});

let searchTimer: number | null = null;
qso("adsSearch")?.addEventListener("input", () => {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    void refreshAds();
  }, 300);
});
qso("adsStatus")?.addEventListener("change", () => void refreshAds());
qso("adsChannel")?.addEventListener("change", () => void refreshAds());
qso("adsCampaign")?.addEventListener("change", () => void refreshAds());

let crmTimer: number | null = null;
qso("contactsSearch")?.addEventListener("input", () => {
  if (crmTimer) window.clearTimeout(crmTimer);
  crmTimer = window.setTimeout(() => {
    void refreshCrm();
  }, 300);
});
qso("campaignsSearch")?.addEventListener("input", () => {
  if (crmTimer) window.clearTimeout(crmTimer);
  crmTimer = window.setTimeout(() => {
    void refreshCampaigns();
  }, 300);
});
(qso("btnBillingPortal") as HTMLButtonElement | null)?.addEventListener("click", async () => {
  if (!getToken()) {
    setAlert("Faca login para gerenciar sua assinatura.", "danger");
    return;
  }
  try {
    const out = await api<{ url: string }>("/billing/portal", { method: "POST" });
    if (out?.url) window.location.assign(out.url);
    else setAlert("Nao foi possivel abrir o portal.", "danger");
  } catch (e: any) {
    setAlert(e.message || "Falha ao abrir portal.", "danger");
  }
});
(qso("btnCancelPlan") as HTMLButtonElement | null)?.addEventListener("click", async () => {
  if (!getToken()) {
    setAlert("Faca login para cancelar sua assinatura.", "danger");
    return;
  }
  if (!confirm("Cancelar assinatura no fim do ciclo?")) return;
  try {
    const out = await api<{ url: string }>("/billing/cancel", { method: "POST" });
    if (out?.url) window.location.assign(out.url);
    else setAlert("Cancelamento solicitado.", "ok");
  } catch (e: any) {
    setAlert(e.message || "Falha ao cancelar assinatura.", "danger");
  }
});

document.addEventListener("visibilitychange", () => {
  const reportsChecked = (qso("reportsAutoRefresh") as HTMLInputElement | null)?.checked || false;
  const queueChecked = (qso("queueAutoRefresh") as HTMLInputElement | null)?.checked || false;
  if (document.hidden) {
    toggleReportsAuto(false);
    toggleQueueAuto(false);
  } else {
    toggleReportsAuto(reportsChecked);
    toggleQueueAuto(queueChecked);
  }
});

(function init() {
  // label API base
  try {
    (qs("apiBaseLabel") as HTMLElement).textContent = env().PUBLIC_API_BASE;
  } catch {
    // ignore
  }

  // roteamento simples
  const r = route();
  updateNav();
  if (r === "accept-invite") {
    showOnly("accept-invite");
    const token = getQueryParam("token");
    if (token) (qs("inviteToken") as HTMLInputElement).value = token;
    return;
  }
  if (r === "reset-password") {
    showOnly("reset-password");
    const token = getQueryParam("token");
    if (token) (qs("resetToken") as HTMLInputElement).value = token;
    return;
  }
  if (r === "plans") {
    showOnly("plans");
    const success = getQueryParam("success");
    const canceled = getQueryParam("canceled");
    if (success || canceled) {
      setAlert(success ? "Assinatura iniciada com sucesso. Aguardando confirmacao." : "Checkout cancelado.", success ? "ok" : "danger");
      const u = new URL(window.location.href);
      u.searchParams.delete("success");
      u.searchParams.delete("canceled");
      history.replaceState({}, document.title, u.pathname + u.search);
    }
    void refreshPlansUI();
    return;
  }

  (qs("tenantSlug") as HTMLInputElement).value = getTenantSlug() || "";
  const token = getToken();
  showApp(!!token);
  if (token) {
    void refreshAds();
    refreshReports();
    void refreshTemplates();
    void refreshCrm();
    void refreshCampaigns();
    void refreshQueue();
  }
})();

function updateNav() {
  const r = route();
  const mapping: Record<Section, string> = {
    home: "navHome",
    "accept-invite": "navAccept",
    "reset-password": "navReset",
    plans: "navPlans",
  };
  ["navHome", "navPlans", "navAccept", "navReset"].forEach((id) => {
    const el = qso(id);
    if (el) el.removeAttribute("aria-current");
  });
  const currentId = mapping[r];
  const current = qso(currentId);
  if (current) current.setAttribute("aria-current", "page");
}
