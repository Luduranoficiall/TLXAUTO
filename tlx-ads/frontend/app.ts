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
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await res.text();

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
}

type PlanId = "free" | "pro" | "business" | "enterprise";

type PlanSnapshot = {
  tenant_id: number;
  plan: PlanId;
  status: string;
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
    name: "Free",
    price: "R$ 0",
    subtitle: "Para validar a operação com limites claros.",
  },
  {
    id: "pro",
    name: "Pro",
    price: "R$ 79/mês",
    subtitle: "Para quem roda anúncios todo dia.",
    recommended: true,
  },
  {
    id: "business",
    name: "Business",
    price: "R$ 199/mês",
    subtitle: "Para time / múltiplas campanhas e escala.",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Sob consulta",
    subtitle: "Operação grande, integrações e limites sob medida.",
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
    free: { ads_created_monthly: 50, templates_created_monthly: 20, links_created_monthly: 200, invites_created_monthly: 20, sends_daily_total: 200 },
    pro: { ads_created_monthly: 300, templates_created_monthly: 200, links_created_monthly: 2000, invites_created_monthly: 200, sends_daily_total: 2000 },
    business: { ads_created_monthly: 2000, templates_created_monthly: 1000, links_created_monthly: 20000, invites_created_monthly: 2000, sends_daily_total: 20000 },
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
        <button class="btn btn-secondary" data-action="choose-plan" data-plan="${def.id}">${isCurrent ? "Plano atual" : "Quero este plano"}</button>
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
      currentBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:800;">Seu plano atual: <span class="pill premium">${escapeHtml(snap.plan.toUpperCase())}</span></div>
            <div class="muted" style="margin-top:6px;">Status: <code>${escapeHtml(String(snap.status || "active"))}</code> — Tenant: <code>${escapeHtml(
              String(snap.tenant_id)
            )}</code></div>
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
    btn.addEventListener("click", () => {
      const plan = (btn as HTMLButtonElement).dataset.plan as PlanId;
      localStorage.setItem("selected_plan", plan);

      if (!getToken()) {
        setAlert(`Plano selecionado: <strong>${escapeHtml(plan)}</strong>. Agora faça login/cadastro para continuar.`, "ok");
        window.location.assign("/");
        return;
      }

      // Ainda não existe fluxo de cobrança automático aqui.
      setAlert(
        `Plano selecionado: <strong>${escapeHtml(plan)}</strong>. Me diga o valor final de cada plano que você quer e eu ligo isso no backend (checkout/upgrade).`,
        "ok"
      );
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
    await refreshDashboard();
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
    await refreshDashboard();
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
  }
}

async function createAd() {
  const title = (qs("adTitle") as HTMLInputElement).value.trim();
  const body = (qs("adBody") as HTMLTextAreaElement).value.trim();
  const channel = (qs("adChannel") as HTMLSelectElement).value;
  const target_url = (qs("adUrl") as HTMLInputElement).value.trim() || null;

  if (!title || !body) {
    setAlert("Título e texto são obrigatórios.", "danger");
    return;
  }

  try {
    await api<Ad>("/ads", {
      method: "POST",
      body: JSON.stringify({ title, body, channel, target_url }),
    });

    (qs("adTitle") as HTMLInputElement).value = "";
    (qs("adBody") as HTMLTextAreaElement).value = "";
    (qs("adUrl") as HTMLInputElement).value = "";

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
  return `
    <div class="card">
      <div class="adHeader">
        <div style="flex: 1 1 520px; min-width: 280px;">
          <div class="adPills">
            <span class="adTitle">${escapeHtml(ad.title)}</span>
            <span class="pill">${escapeHtml(ad.status)}</span>
            <span class="pill">${escapeHtml(ad.channel)}</span>
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

async function refreshAds() {
  try {
    const ads = await api<Ad[]>("/ads");
    const list = qs("adsList");
    list.innerHTML = ads.map(renderAd).join("") || `<div class="muted">Nenhum anúncio ainda.</div>`;

    // bind actions
    list.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = (btn as HTMLButtonElement).dataset.action!;
        const id = Number((btn as HTMLButtonElement).dataset.id!);
        await handleAdAction(action, id);
      });
    });
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

(qs("btnLogout") as HTMLButtonElement).addEventListener("click", () => {
  setToken(null);
  showApp(false);
  setAlert("Você saiu.");
});

(qs("btnAcceptInvite") as HTMLButtonElement).addEventListener("click", () => void acceptInvite());
(qs("btnRequestReset") as HTMLButtonElement).addEventListener("click", () => void requestReset());
(qs("btnConfirmReset") as HTMLButtonElement).addEventListener("click", () => void confirmReset());

(function init() {
  // label API base
  try {
    (qs("apiBaseLabel") as HTMLElement).textContent = env().PUBLIC_API_BASE;
  } catch {
    // ignore
  }

  // roteamento simples
  const r = route();
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
    void refreshPlansUI();
    return;
  }

  (qs("tenantSlug") as HTMLInputElement).value = getTenantSlug() || "";
  const token = getToken();
  showApp(!!token);
  if (token) {
    void refreshAds();
    void refreshDashboard();
  }
})();
