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

function showOnly(section: "home" | "accept-invite" | "reset-password") {
  // home = fluxo atual (auth+app)
  qs("authSection").classList.toggle("hidden", section !== "home" || !!getToken());
  qs("appSection").classList.toggle("hidden", section !== "home" || !getToken());
  qs("btnLogout").classList.toggle("hidden", !getToken() || section !== "home");

  qs("acceptInviteSection").classList.toggle("hidden", section !== "accept-invite");
  qs("resetPasswordSection").classList.toggle("hidden", section !== "reset-password");

  syncUserInfo();
}

function route(): "home" | "accept-invite" | "reset-password" {
  const path = window.location.pathname;
  if (path === "/accept-invite") return "accept-invite";
  if (path === "/reset-password") return "reset-password";
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

  (qs("tenantSlug") as HTMLInputElement).value = getTenantSlug() || "";
  const token = getToken();
  showApp(!!token);
  if (token) {
    void refreshAds();
    void refreshDashboard();
  }
})();
