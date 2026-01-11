import './style.css'

import {
  api,
  clearToken,
  getToken,
  type Appointment,
  type AppointmentDurationMinutes,
  type AppointmentStatus,
  type Customer,
  type ServiceOrder,
  type Stats,
  type User,
  type UserRole,
  type Vehicle,
} from './api'

type Tab = 'dashboard' | 'clientes' | 'veiculos' | 'ordens' | 'agenda'

const appEl = document.querySelector<HTMLDivElement>('#root')
if (!appEl) throw new Error('Elemento #root não encontrado')

appEl.innerHTML = `
  <div class="shell">
    <header class="header">
      <div class="brand">
        <div class="brand__title">TLXAUTO <span class="badge badge--premium">TLX</span></div>
        <div class="brand__subtitle">MVP — Clientes • Veículos • Ordens • Agenda</div>
      </div>
      <div class="header__right">
        <div id="auth-area" class="auth-area"></div>
        <button class="btn" id="btn-reminders" type="button" style="display:none;">
          Lembretes
          <span class="badge badge--premium" id="reminders-badge" style="display:none;">0</span>
        </button>
        <button class="btn" id="btn-health" type="button">Testar API</button>
      </div>
    </header>

    <nav class="tabs" aria-label="Navegação">
      <button class="tab is-active" data-tab="dashboard" type="button">Dashboard</button>
      <button class="tab" data-tab="clientes" type="button">Clientes</button>
      <button class="tab" data-tab="veiculos" type="button">Veículos</button>
      <button class="tab" data-tab="ordens" type="button">Ordens</button>
      <button class="tab" data-tab="agenda" type="button">Agenda</button>
    </nav>

    <main class="main">
      <section class="panel" id="panel-dashboard"></section>
      <section class="panel" id="panel-clientes"></section>
      <section class="panel is-hidden" id="panel-veiculos"></section>
      <section class="panel is-hidden" id="panel-ordens"></section>
      <section class="panel is-hidden" id="panel-agenda"></section>
    </main>

    <footer class="footer">
      <small>Backend: FastAPI • Frontend: TypeScript puro (Vite)</small>
    </footer>
  </div>
`

const authAreaEl = document.querySelector<HTMLDivElement>('#auth-area')
if (!authAreaEl) throw new Error('Elemento #auth-area não encontrado')

const remindersBtnEl = document.querySelector<HTMLButtonElement>('#btn-reminders')
const remindersBadgeEl = document.querySelector<HTMLSpanElement>('#reminders-badge')

let currentUser: User | null = null

let reminderTimer: number | null = null
const reminderToastSeen = new Set<number>()

let audioArmed = false
let reminderSoundEnabled = localStorage.getItem('tlxauto_reminder_sound') !== 'off'

window.addEventListener(
  'pointerdown',
  () => {
    audioArmed = true
  },
  { once: true },
)

function playBeep() {
  if (!reminderSoundEnabled) return
  if (!audioArmed) return

  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()

    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880

    gain.gain.value = 0.0001
    osc.connect(gain)
    gain.connect(ctx.destination)

    const now = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)

    osc.start(now)
    osc.stop(now + 0.2)

    osc.onended = () => {
      void ctx.close().catch(() => undefined)
    }
  } catch {
    // Sem áudio disponível/permissão: ok.
  }
}

function setRemindersCount(count: number) {
  if (remindersBtnEl) remindersBtnEl.style.display = currentUser ? '' : 'none'
  if (!remindersBadgeEl) return
  if (!currentUser || count <= 0) {
    remindersBadgeEl.style.display = 'none'
    remindersBadgeEl.textContent = '0'
    return
  }
  remindersBadgeEl.style.display = ''
  remindersBadgeEl.textContent = String(count)
}

remindersBtnEl?.addEventListener('click', async () => {
  const ok = await ensureAuthenticated(false)
  if (!ok) {
    toast('Faça login para ver lembretes', 'error')
    return
  }
  setTab('agenda')
  document.querySelector('#agenda-reminders-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
})

function stopReminderPolling() {
  if (reminderTimer !== null) {
    window.clearInterval(reminderTimer)
    reminderTimer = null
  }
  setRemindersCount(0)
}

async function pollReminders(withinMinutes = 15) {
  if (!currentUser) return
  if (!getToken()) return

  try {
    const upcoming = await api.reminders(withinMinutes)

    setRemindersCount(upcoming.length)

    // Atualiza UI da Agenda, se estiver montada
    refreshAgendaRemindersUI(upcoming)

    // Toast apenas para itens novos
    let hadNew = false
    upcoming.forEach((a) => {
      if (reminderToastSeen.has(a.id)) return
      reminderToastSeen.add(a.id)
      hadNew = true
      toast(`Lembrete: ${a.title} (${formatDateTime(a.scheduled_at)})`)
    })

    if (hadNew) playBeep()
  } catch (err) {
    // Se o token cair (401), o client já limpa. Aqui só evitamos spam.
  }
}

function startReminderPolling() {
  stopReminderPolling()
  reminderToastSeen.clear()
  // Primeira rodada já
  void pollReminders(15)
  reminderTimer = window.setInterval(() => void pollReminders(15), 30_000)
}

const healthBtn = document.querySelector<HTMLButtonElement>('#btn-health')
healthBtn?.addEventListener('click', async () => {
  try {
    const res = await api.health()
    toast(`API OK (server_time: ${res.server_time})`)
  } catch (err) {
    toast(errToMessage(err), 'error')
  }
})

const panels = {
  dashboard: document.querySelector<HTMLElement>('#panel-dashboard'),
  clientes: document.querySelector<HTMLElement>('#panel-clientes'),
  veiculos: document.querySelector<HTMLElement>('#panel-veiculos'),
  ordens: document.querySelector<HTMLElement>('#panel-ordens'),
  agenda: document.querySelector<HTMLElement>('#panel-agenda'),
} as const

function assertPanel(el: HTMLElement | null, name: string): HTMLElement {
  if (!el) throw new Error(`Panel não encontrado: ${name}`)
  return el
}

const panelClientes = assertPanel(panels.clientes, 'clientes')
const panelVeiculos = assertPanel(panels.veiculos, 'veiculos')
const panelOrdens = assertPanel(panels.ordens, 'ordens')
const panelDashboard = assertPanel(panels.dashboard, 'dashboard')
const panelAgenda = assertPanel(panels.agenda, 'agenda')

function setTab(tab: Tab) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
    const isActive = b.dataset.tab === tab
    b.classList.toggle('is-active', isActive)
  })

  panelDashboard.classList.toggle('is-hidden', tab !== 'dashboard')
  panelClientes.classList.toggle('is-hidden', tab !== 'clientes')
  panelVeiculos.classList.toggle('is-hidden', tab !== 'veiculos')
  panelOrdens.classList.toggle('is-hidden', tab !== 'ordens')
  panelAgenda.classList.toggle('is-hidden', tab !== 'agenda')
}

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
  b.addEventListener('click', () => setTab((b.dataset.tab as Tab) || 'clientes'))
})

function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toast(message: string, type: 'info' | 'error' = 'info') {
  const el = document.createElement('div')
  el.className = `toast toast--${type}`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.classList.add('is-visible'), 10)
  setTimeout(() => {
    el.classList.remove('is-visible')
    setTimeout(() => el.remove(), 250)
  }, 2500)
}

function renderAuthArea() {
  if (!authAreaEl) return

  if (!currentUser) {
    setRemindersCount(0)
    authAreaEl.innerHTML = `<button class="btn btn--primary" id="btn-login" type="button">Entrar</button>`
    document.querySelector<HTMLButtonElement>('#btn-login')?.addEventListener('click', async () => {
      const ok = await ensureAuthenticated(true)
      renderAuthArea()
      if (ok) {
        await reloadAll()
        startReminderPolling()
      } else {
        renderLockedState()
      }
    })
    return
  }

  const roleLabel = currentUser.role === 'admin' ? 'Admin' : 'Operador'
  const adminBtn =
    currentUser.role === 'admin'
      ? `<button class="btn" id="btn-users" type="button">Usuários</button>`
      : ''

  authAreaEl.innerHTML = `
    <div class="auth-chip" title="${escapeHtml(currentUser.email)}">
      <span class="badge">${escapeHtml(roleLabel)}</span>
      <span class="auth-chip__email">${escapeHtml(currentUser.email)}</span>
    </div>
    ${adminBtn}
    <button class="btn" id="btn-logout" type="button">Sair</button>
  `

  document.querySelector<HTMLButtonElement>('#btn-logout')?.addEventListener('click', async () => {
    clearToken()
    currentUser = null
    stopReminderPolling()
    renderAuthArea()
    renderLockedState()
  })

  document.querySelector<HTMLButtonElement>('#btn-users')?.addEventListener('click', async () => {
    await openUsersModal()
  })
}

async function ensureAuthenticated(forcePrompt: boolean): Promise<boolean> {
  // Já autenticado
  if (currentUser && !forcePrompt) return true

  // Tenta validar token salvo
  const token = getToken()
  if (token) {
    try {
      currentUser = await api.me()
      return true
    } catch {
      clearToken()
      currentUser = null
    }
  }

  if (!forcePrompt) return false

  // Pede login
  const u = await openLoginModal()
  if (!u) return false
  currentUser = u
  return true
}

function openLoginModal(): Promise<User | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Login">
        <div class="modal__header">
          <div>
            <div class="modal__title">Entrar</div>
            <div class="modal__subtitle">Acesse o TLXAUTO com seu e-mail e senha</div>
          </div>
          <button class="btn" id="btn-close-login" type="button">Fechar</button>
        </div>

        <form class="form" id="form-login">
          <label>
            E-mail
            <input name="email" type="email" required autocomplete="username" placeholder="admin@tlxauto.local" />
          </label>
          <label>
            Senha
            <input name="password" type="password" required autocomplete="current-password" />
          </label>

          <div class="row row--space">
            <div class="muted" style="font-size: 12px;">
              Dica dev: admin inicial vem do arquivo <code>.env</code>
            </div>
            <button class="btn btn--primary" type="submit">Entrar</button>
          </div>
        </form>
      </div>
    `

    let done = false
    const cleanup = () => overlay.remove()
    const finish = (user: User | null) => {
      if (done) return
      done = true
      cleanup()
      resolve(user)
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null)
    })

    overlay.querySelector<HTMLButtonElement>('#btn-close-login')?.addEventListener('click', () => {
      finish(null)
    })

    overlay.querySelector<HTMLFormElement>('#form-login')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const fd = new FormData(form)
      const email = String(fd.get('email') ?? '').trim()
      const password = String(fd.get('password') ?? '')
      if (!email || !password) return

      try {
        const res = await api.login({ email, password })
        toast('Login efetuado')
        finish(res.user)
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
    })

    document.body.appendChild(overlay)
    overlay.querySelector<HTMLInputElement>('input[name="email"]')?.focus()
  })
}

function renderLockedState() {
  const content = `
    <div class="grid" style="grid-template-columns: 1fr;">
      <div class="card">
        <h3>Login necessário</h3>
        <div class="muted">
          Para acessar Clientes, Veículos e Ordens, clique em <strong>Entrar</strong> no topo.
        </div>
      </div>
    </div>
  `
  panelDashboard.innerHTML = content
  panelClientes.innerHTML = content
  panelVeiculos.innerHTML = content
  panelOrdens.innerHTML = content
  panelAgenda.innerHTML = content
  setTab('dashboard')
}

async function openUsersModal(): Promise<void> {
  if (!currentUser || currentUser.role !== 'admin') {
    toast('Apenas admin', 'error')
    return
  }

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Usuários">
      <div class="modal__header">
        <div>
          <div class="modal__title">Usuários</div>
          <div class="modal__subtitle">Administração (admin/operador)</div>
        </div>
        <button class="btn" id="btn-close-users" type="button">Fechar</button>
      </div>

      <div class="grid" style="grid-template-columns: 1fr;">
        <div class="card">
          <div class="row row--space">
            <h3>Lista</h3>
            <button class="btn" id="btn-refresh-users" type="button">Atualizar</button>
          </div>
          <div id="users-list" class="list"></div>
        </div>

        <div class="card">
          <h3>Novo usuário</h3>
          <form class="form" id="form-user-create">
            <label>
              E-mail
              <input name="email" type="email" required autocomplete="off" />
            </label>
            <label>
              Senha
              <input name="password" type="password" required minlength="6" />
            </label>
            <label>
              Papel
              <select name="role" required>
                <option value="operator">Operador</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button class="btn btn--primary" type="submit">Criar</button>
          </form>
        </div>
      </div>
    </div>
  `

  const cleanup = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup()
  })
  overlay.querySelector<HTMLButtonElement>('#btn-close-users')?.addEventListener('click', cleanup)

  const listEl = overlay.querySelector<HTMLDivElement>('#users-list')

  const renderUsers = (users: User[]) => {
    if (!listEl) return
    listEl.innerHTML = users.length
      ? users
          .map((u) => {
            const roleLabel = u.role === 'admin' ? 'Admin' : 'Operador'
            return `
              <div class="list__item">
                <div class="list__title">#${u.id} — ${escapeHtml(u.email)}</div>
                <div class="list__meta">${escapeHtml(roleLabel)}</div>
              </div>
            `
          })
          .join('')
      : '<div class="muted">Nenhum usuário.</div>'
  }

  const load = async () => {
    if (listEl) listEl.textContent = 'Carregando...'
    try {
      const users = await api.listUsers()
      renderUsers(users)
    } catch (err) {
      if (listEl) listEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  overlay.querySelector<HTMLButtonElement>('#btn-refresh-users')?.addEventListener('click', load)
  overlay.querySelector<HTMLFormElement>('#form-user-create')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement
    const fd = new FormData(form)
    const email = String(fd.get('email') ?? '').trim()
    const password = String(fd.get('password') ?? '')
    const role = String(fd.get('role') ?? 'operator') as UserRole
    if (!email || !password) return
    try {
      await api.createUser({ email, password, role })
      toast('Usuário criado')
      form.reset()
      await load()
    } catch (err) {
      toast(errToMessage(err), 'error')
    }
  })

  document.body.appendChild(overlay)
  await load()
}

async function reloadAll() {
  await renderDashboard()
  await renderClientes()
  await renderVeiculos()
  await renderOrdens()
  await renderAgenda()
  setTab('dashboard')
}

async function renderDashboard() {
  panelDashboard.innerHTML = `
    <h2>Dashboard</h2>
    <div class="grid">
      <div class="card" id="stats-card">
        <div class="row row--space">
          <h3>Visão geral</h3>
          <button class="btn" id="btn-refresh-stats" type="button">Atualizar</button>
        </div>
        <div id="stats-grid" class="kpi-grid"></div>
      </div>

      <div class="card" id="recent-card">
        <div class="row row--space">
          <h3>Últimas OS</h3>
          <div class="muted" style="font-size: 12px;">Rápido pra conferir o fluxo</div>
        </div>
        <div id="recent-os" class="list"></div>
      </div>
    </div>
  `

  const statsGridEl = document.querySelector<HTMLDivElement>('#stats-grid')
  const recentEl = document.querySelector<HTMLDivElement>('#recent-os')

  const renderStats = (s: Stats) => {
    if (!statsGridEl) return
    statsGridEl.innerHTML = `
      <div class="kpi">
        <div class="kpi__label">Clientes</div>
        <div class="kpi__value">${s.customers}</div>
      </div>
      <div class="kpi">
        <div class="kpi__label">Veículos</div>
        <div class="kpi__value">${s.vehicles}</div>
      </div>
      <div class="kpi">
        <div class="kpi__label">OS (total)</div>
        <div class="kpi__value">${s.service_orders_total}</div>
      </div>
      <div class="kpi">
        <div class="kpi__label">Abertas</div>
        <div class="kpi__value">${s.service_orders_open}</div>
      </div>
      <div class="kpi">
        <div class="kpi__label">Em andamento</div>
        <div class="kpi__value">${s.service_orders_in_progress}</div>
      </div>
      <div class="kpi">
        <div class="kpi__label">Concluídas</div>
        <div class="kpi__value">${s.service_orders_done}</div>
      </div>
      <div class="kpi kpi--premium">
        <div class="kpi__label">Receita (done)</div>
        <div class="kpi__value">${moneyFromCents(s.revenue_done_cents)}</div>
      </div>
    `
  }

  const load = async () => {
    if (statsGridEl) statsGridEl.textContent = 'Carregando...'
    if (recentEl) recentEl.textContent = 'Carregando...'

    try {
      const [stats, customers, vehicles, orders] = await Promise.all([
        api.stats(),
        api.listCustomers(),
        api.listVehicles(),
        api.listServiceOrders(),
      ])
      renderStats(stats)

      const custMap = new Map<number, Customer>(customers.map((c) => [c.id, c]))
      const vehMap = new Map<number, Vehicle>(vehicles.map((v) => [v.id, v]))
      const recent = orders.slice(0, 6)
      if (recentEl) {
        recentEl.innerHTML = recent.length
          ? recent
              .map((o) => {
                const c = custMap.get(o.customer_id)
                const v = vehMap.get(o.vehicle_id)
                const cText = c ? c.name : `Cliente #${o.customer_id}`
                const vText = v ? `${v.plate} — ${v.model}` : `Veículo #${o.vehicle_id}`
                return `
                  <div class="list__item">
                    <div class="row row--space row--wrap">
                      <div>
                        <div class="list__title">OS #${o.id} — ${escapeHtml(cText)}</div>
                        <div class="list__meta">${escapeHtml(vText)} • ${escapeHtml(o.status)} • ${moneyFromCents(o.total_cents)}</div>
                      </div>
                      <div class="badge">${escapeHtml(o.status)}</div>
                    </div>
                    <div class="list__desc">${escapeHtml(o.description)}</div>
                  </div>
                `
              })
              .join('')
          : '<div class="muted">Nenhuma OS ainda.</div>'
      }
    } catch (err) {
      if (statsGridEl) statsGridEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
      if (recentEl) recentEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  document.querySelector<HTMLButtonElement>('#btn-refresh-stats')?.addEventListener('click', load)
  await load()
}

function moneyFromCents(totalCents: number): string {
  const value = totalCents / 100
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('pt-BR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function datetimeLocalFromIso(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const yyyy = d.getFullYear()
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`
}

function isoFromDatetimeLocal(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toISOString()
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + days)
  return x
}

function startOfWeek(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  // JS: 0=Dom ... 6=Sáb. Queremos segunda como início.
  const day = x.getDay()
  const diff = (day === 0 ? -6 : 1) - day
  x.setDate(x.getDate() + diff)
  return x
}

function weekLabel(weekStart: Date): string {
  const weekEnd = addDays(weekStart, 6)
  const fmt = (dt: Date) =>
    dt.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  return `${fmt(weekStart)} — ${fmt(weekEnd)}`
}

function nearestSlotKeyFromIso(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const m = d.getMinutes()
  const rounded = m < 15 ? 0 : m < 45 ? 30 : 0
  if (m >= 45) d.setHours(d.getHours() + 1)
  d.setMinutes(rounded, 0, 0)
  const yyyy = d.getFullYear()
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`
}

function refreshAgendaRemindersUI(upcoming: Appointment[]) {
  const listEl = document.querySelector<HTMLDivElement>('#agenda-reminders-list')
  if (!listEl) return

  listEl.innerHTML = upcoming.length
    ? upcoming
        .map(
          (a) => `
            <div class="list__item">
              <div class="row row--space row--wrap">
                <div>
                  <div class="list__title">${escapeHtml(a.title)}</div>
                  <div class="list__meta">${escapeHtml(formatDateTime(a.scheduled_at))}</div>
                </div>
                <div class="row">
                  <button class="btn btn--premium" data-action="mark-reminded" data-id="${a.id}" type="button">Marcar avisado</button>
                </div>
              </div>
            </div>
          `,
        )
        .join('')
    : '<div class="muted">Nada nos próximos minutos.</div>'
}

async function renderAgenda() {
  panelAgenda.innerHTML = `
    <h2>Agenda</h2>
    <div class="grid">
      <div class="card">
        <h3>Novo agendamento</h3>
        <form id="form-appointment" class="form">
          <label>
            Cliente
            <select name="customer_id" id="appt-customer" required></select>
          </label>
          <label>
            Veículo (opcional)
            <select name="vehicle_id" id="appt-vehicle"></select>
          </label>
          <label>
            OS vinculada (opcional)
            <input name="service_order_id" inputmode="numeric" placeholder="#123" />
          </label>
          <label>
            Título
            <input name="title" required minlength="1" maxlength="120" placeholder="Ex.: Retorno / Revisão / Orçamento" />
          </label>
          <label>
            Duração
            <select name="duration_minutes" required>
              <option value="30" selected>30 min</option>
              <option value="60">60 min</option>
              <option value="90">90 min</option>
            </select>
          </label>
          <label>
            Quando
            <input name="scheduled_at" type="datetime-local" required />
          </label>
          <label>
            Observações (opcional)
            <textarea name="notes" maxlength="1000" rows="3" placeholder="Detalhes, itens, combinar..." ></textarea>
          </label>
          <button class="btn btn--primary" type="submit">Salvar</button>
        </form>
      </div>

      <div style="display: grid; gap: 14px;">
        <div class="card">
          <div class="row row--space">
            <h3>Lembretes (próx. 15 min)</h3>
            <button class="btn" id="btn-refresh-reminders" type="button">Atualizar</button>
          </div>
          <div id="agenda-reminders-list" class="list"></div>
        </div>

        <div class="card">
          <div class="row row--space row--wrap">
            <h3>Agendamentos</h3>
            <div class="row row--wrap">
              <button class="btn" id="btn-agenda-view-list" type="button">Lista</button>
              <button class="btn" id="btn-agenda-view-week" type="button">Semana</button>
              <button class="btn" id="btn-refresh-appointments" type="button">Atualizar</button>
            </div>
          </div>
          <div class="row row--wrap" id="agenda-list-filters" style="margin: 10px 0 12px;">
            <input id="appt-from" type="datetime-local" placeholder="De" />
            <input id="appt-to" type="datetime-local" placeholder="Até" />
            <select id="appt-status">
              <option value="">Status (todos)</option>
              <option value="scheduled">scheduled</option>
              <option value="done">done</option>
              <option value="canceled">canceled</option>
            </select>
            <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
              <input id="appt-only-unreminded" type="checkbox" />
              só não avisados
            </label>
          </div>
          <div class="row row--space row--wrap" id="agenda-week-controls" style="display:none; margin: 10px 0 12px;">
            <div class="row">
              <button class="btn" id="btn-week-prev" type="button">◀</button>
              <button class="btn" id="btn-week-today" type="button">Hoje</button>
              <button class="btn" id="btn-week-next" type="button">▶</button>
            </div>
            <div class="row row--wrap">
              <select id="week-customer" title="Filtrar por cliente">
                <option value="">Cliente (todos)</option>
              </select>
              <div class="muted" id="week-label" style="font-size: 12px;"></div>
            </div>
          </div>
          <div id="agenda-week" class="week is-hidden"></div>
          <div id="appointments-list" class="list"></div>
        </div>
      </div>
    </div>
  `

  const form = document.querySelector<HTMLFormElement>('#form-appointment')
  const selectCustomer = document.querySelector<HTMLSelectElement>('#appt-customer')
  const selectVehicle = document.querySelector<HTMLSelectElement>('#appt-vehicle')

  const listEl = document.querySelector<HTMLDivElement>('#appointments-list')
  const weekEl = document.querySelector<HTMLDivElement>('#agenda-week')
  const weekLabelEl = document.querySelector<HTMLDivElement>('#week-label')
  const listFiltersEl = document.querySelector<HTMLDivElement>('#agenda-list-filters')
  const weekControlsEl = document.querySelector<HTMLDivElement>('#agenda-week-controls')

  const btnViewList = document.querySelector<HTMLButtonElement>('#btn-agenda-view-list')
  const btnViewWeek = document.querySelector<HTMLButtonElement>('#btn-agenda-view-week')
  const btnWeekPrev = document.querySelector<HTMLButtonElement>('#btn-week-prev')
  const btnWeekToday = document.querySelector<HTMLButtonElement>('#btn-week-today')
  const btnWeekNext = document.querySelector<HTMLButtonElement>('#btn-week-next')
  const refreshBtn = document.querySelector<HTMLButtonElement>('#btn-refresh-appointments')
  const remindersBtn = document.querySelector<HTMLButtonElement>('#btn-refresh-reminders')

  const fromEl = document.querySelector<HTMLInputElement>('#appt-from')
  const toEl = document.querySelector<HTMLInputElement>('#appt-to')
  const statusEl = document.querySelector<HTMLSelectElement>('#appt-status')
  const onlyUnremindedEl = document.querySelector<HTMLInputElement>('#appt-only-unreminded')

  let customers: Customer[] = []
  let vehiclesAll: Vehicle[] = []
  let appointments: Appointment[] = []

  let agendaView: 'list' | 'week' = 'list'
  let weekStart = startOfWeek(new Date())
  let weekCustomerId: number | null = null

  const weekCustomerEl = document.querySelector<HTMLSelectElement>('#week-customer')

  const vehiclesForCustomer = (customerId: number) => vehiclesAll.filter((v) => v.customer_id === customerId)

  const loadCustomers = async () => {
    customers = await api.listCustomers()
    if (selectCustomer) {
      selectCustomer.innerHTML = customers.length
        ? customers.map((c) => `<option value="${c.id}">#${c.id} — ${escapeHtml(c.name)}</option>`).join('')
        : '<option value="" disabled selected>Cadastre um cliente primeiro</option>'
      selectCustomer.disabled = customers.length === 0
    }

    if (weekCustomerEl) {
      weekCustomerEl.innerHTML = `<option value="">Cliente (todos)</option>${customers
        .map((c) => `<option value="${c.id}">#${c.id} — ${escapeHtml(c.name)}</option>`)
        .join('')}`
    }
  }

  const loadVehicles = async () => {
    vehiclesAll = await api.listVehicles()
    if (!selectVehicle) return

    const customerId = selectCustomer && !selectCustomer.disabled ? Number(selectCustomer.value) : 0
    const subset = customerId ? vehiclesForCustomer(customerId) : []
    selectVehicle.innerHTML = `
      <option value="">(sem veículo)</option>
      ${subset
        .map((v) => `<option value="${v.id}">#${v.id} — ${escapeHtml(v.plate)} — ${escapeHtml(v.model)}</option>`)
        .join('')}
    `
  }

  const renderList = () => {
    if (!listEl) return

    const custMap = new Map<number, Customer>(customers.map((c) => [c.id, c]))
    const vehMap = new Map<number, Vehicle>(vehiclesAll.map((v) => [v.id, v]))

    listEl.innerHTML = appointments.length
      ? appointments
          .map((a) => {
            const c = custMap.get(a.customer_id)
            const v = a.vehicle_id ? vehMap.get(a.vehicle_id) : null
            const cText = c ? c.name : `Cliente #${a.customer_id}`
            const vText = v ? `${v.plate} — ${v.model}` : 'sem veículo'
            const badge = a.status === 'scheduled' ? 'badge badge--premium' : 'badge'
            const remindedText = a.reminded_at ? ` • avisado em ${formatDateTime(a.reminded_at)}` : ''
            const markBtn = !a.reminded_at && a.status === 'scheduled'
              ? `<button class="btn btn--premium" data-action="mark-reminded" data-id="${a.id}" type="button">Marcar avisado</button>`
              : ''
            return `
              <div class="list__item">
                <div class="row row--space row--wrap">
                  <div>
                    <div class="list__title">#${a.id} — ${escapeHtml(a.title)}</div>
                    <div class="list__meta">${escapeHtml(cText)} • ${escapeHtml(vText)} • ${escapeHtml(formatDateTime(a.scheduled_at))}${remindedText}</div>
                  </div>
                  <div class="row">
                    <span class="${badge}">${escapeHtml(a.status)}</span>
                    <button class="btn" data-action="edit" data-id="${a.id}" type="button">Editar</button>
                    ${markBtn}
                    <button class="btn btn--danger" data-action="delete" data-id="${a.id}" type="button">Excluir</button>
                  </div>
                </div>
                ${a.notes ? `<div class="list__desc">${escapeHtml(a.notes)}</div>` : ''}
              </div>
            `
          })
          .join('')
      : '<div class="muted">Nenhum agendamento.</div>'
  }

  const loadAppointments = async () => {
    if (!listEl) return
    listEl.textContent = 'Carregando...'

    try {
      const filters = {
        from: fromEl?.value ? isoFromDatetimeLocal(fromEl.value) : undefined,
        to: toEl?.value ? isoFromDatetimeLocal(toEl.value) : undefined,
        status: (statusEl?.value || undefined) as AppointmentStatus | undefined,
        only_unreminded: Boolean(onlyUnremindedEl?.checked),
      }
      appointments = await api.listAppointments(filters)
      renderList()
    } catch (err) {
      if (listEl) listEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  const renderWeekGrid = (items: Appointment[]) => {
    if (!weekEl) return

    const filtered = weekCustomerId ? items.filter((a) => a.customer_id === weekCustomerId) : items

    const hoursStart = 7
    const hoursEnd = 19
    const stepMinutes = 30

    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
    const dayNames = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']

    weekEl.innerHTML = `
      <div class="week__header">
        ${days
          .map((d, idx) => {
            const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
            return `<div class="week__dayhead"><div class="week__dow">${dayNames[idx]}</div><div class="week__date">${label}</div></div>`
          })
          .join('')}
      </div>
      <div class="week__grid">
        ${days
          .map((d) => {
            const yyyy = d.getFullYear()
            const mm = pad2(d.getMonth() + 1)
            const dd = pad2(d.getDate())
            const dayKey = `${yyyy}-${mm}-${dd}`

            const slots: string[] = []
            for (let h = hoursStart; h <= hoursEnd; h++) {
              for (let m = 0; m < 60; m += stepMinutes) {
                const hh = pad2(h)
                const mi = pad2(m)
                const dtLocal = `${dayKey}T${hh}:${mi}`
                slots.push(
                  `<div class="week__slot" data-dtlocal="${dtLocal}">
                     <div class="week__slotlabel">${hh}:${mi}</div>
                     <div class="week__slotbody"></div>
                   </div>`,
                )
              }
            }
            return `<div class="week__col" data-day="${dayKey}">${slots.join('')}</div>`
          })
          .join('')}
      </div>
    `

    // Inserir agendamentos nos slots mais próximos
    const slotBodyByKey = new Map<string, HTMLDivElement>()
    weekEl.querySelectorAll<HTMLDivElement>('.week__slot').forEach((slot) => {
      const k = String(slot.dataset.dtlocal || '')
      const body = slot.querySelector<HTMLDivElement>('.week__slotbody')
      if (k && body) slotBodyByKey.set(k, body)
    })

    filtered.forEach((a) => {
      const key = nearestSlotKeyFromIso(a.scheduled_at)
      const body = slotBodyByKey.get(key)
      if (!body) return

      const el = document.createElement('div')
      const status = a.status as AppointmentStatus
      el.className = `appt-chip appt-chip--${status}`
      el.draggable = a.status === 'scheduled'
      el.dataset.id = String(a.id)
      el.title = `${a.title} • ${a.duration_minutes} min${a.notes ? `\n${a.notes}` : ''}`
      el.textContent = `#${a.id} ${a.title} (${a.duration_minutes}m)`
      body.appendChild(el)
    })
  }

  const loadWeek = async () => {
    if (!weekEl) return
    weekEl.textContent = 'Carregando semana...'
    try {
      const fromIso = new Date(weekStart).toISOString()
      const toIso = addDays(weekStart, 7).toISOString()
      const items = await api.listAppointments({ from: fromIso, to: toIso })
      if (weekLabelEl) weekLabelEl.textContent = weekLabel(weekStart)
      renderWeekGrid(items)
    } catch (err) {
      weekEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  const setAgendaView = async (view: 'list' | 'week') => {
    agendaView = view
    const isWeek = agendaView === 'week'
    if (weekEl) weekEl.classList.toggle('is-hidden', !isWeek)
    if (listFiltersEl) listFiltersEl.style.display = isWeek ? 'none' : ''
    if (weekControlsEl) weekControlsEl.style.display = isWeek ? '' : 'none'
    if (listEl) listEl.style.display = isWeek ? 'none' : ''

    btnViewList?.classList.toggle('btn--primary', !isWeek)
    btnViewWeek?.classList.toggle('btn--primary', isWeek)

    if (isWeek) {
      await loadWeek()
    } else {
      await loadAppointments()
    }
  }

  const loadReminders = async () => {
    const list = document.querySelector<HTMLDivElement>('#agenda-reminders-list')
    if (list) list.textContent = 'Carregando...'
    try {
      const upcoming = await api.reminders(15)
      refreshAgendaRemindersUI(upcoming)
    } catch (err) {
      if (list) list.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  selectCustomer?.addEventListener('change', async () => {
    await loadVehicles()
  })

  remindersBtn?.addEventListener('click', loadReminders)
  refreshBtn?.addEventListener('click', loadAppointments)
  fromEl?.addEventListener('change', loadAppointments)
  toEl?.addEventListener('change', loadAppointments)
  statusEl?.addEventListener('change', loadAppointments)
  onlyUnremindedEl?.addEventListener('change', loadAppointments)

  document.querySelector<HTMLDivElement>('#agenda-reminders-list')?.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const btn = t.closest<HTMLButtonElement>('button[data-action="mark-reminded"]')
    if (!btn) return
    const id = Number(btn.dataset.id)
    if (!id) return
    try {
      await api.markAppointmentReminded(id)
      toast('Marcado como avisado')
      await loadReminders()
      await loadAppointments()
    } catch (err) {
      toast(errToMessage(err), 'error')
    }
  })

  listEl?.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const btn = t.closest<HTMLButtonElement>('button[data-action]')
    if (!btn) return
    const id = Number(btn.dataset.id)
    if (!id) return
    const action = String(btn.dataset.action)

    if (action === 'delete') {
      if (!confirm(`Excluir o agendamento #${id}?`)) return
      try {
        await api.deleteAppointment(id)
        toast('Agendamento excluído')
        await loadReminders()
        await loadAppointments()
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
      return
    }

    if (action === 'mark-reminded') {
      try {
        await api.markAppointmentReminded(id)
        toast('Marcado como avisado')
        await loadReminders()
        await loadAppointments()
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
      return
    }

    if (action === 'edit') {
      const appt = appointments.find((x) => x.id === id)
      if (!appt) return
      const ok = await openAppointmentEditModal(appt, customers, vehiclesAll)
      if (ok) {
        toast('Agendamento atualizado')
        await loadReminders()
        await loadAppointments()
      }
    }
  })

  // Week view controls
  btnViewList?.addEventListener('click', async () => setAgendaView('list'))
  btnViewWeek?.addEventListener('click', async () => setAgendaView('week'))
  btnWeekPrev?.addEventListener('click', async () => {
    weekStart = addDays(weekStart, -7)
    await loadWeek()
  })
  btnWeekNext?.addEventListener('click', async () => {
    weekStart = addDays(weekStart, 7)
    await loadWeek()
  })
  btnWeekToday?.addEventListener('click', async () => {
    weekStart = startOfWeek(new Date())
    await loadWeek()
  })

  weekCustomerEl?.addEventListener('change', async () => {
    const raw = String(weekCustomerEl.value || '').trim()
    weekCustomerId = raw ? Number(raw) : null
    await loadWeek()
  })

  // Drag & drop reschedule
  weekEl?.addEventListener('dragstart', (e) => {
    const t = e.target as HTMLElement
    const chip = t.closest<HTMLElement>('.appt-chip')
    if (!chip) return
    const id = chip.dataset.id
    if (!id) return
    e.dataTransfer?.setData('text/plain', id)
    e.dataTransfer?.setData('application/x-tlxauto-appt', id)
    e.dataTransfer?.setDragImage(chip, 10, 10)
  })

  weekEl?.addEventListener('dragover', (e) => {
    const t = e.target as HTMLElement
    const slot = t.closest<HTMLElement>('.week__slot')
    if (!slot) return
    e.preventDefault()
    slot.classList.add('is-drop')
  })

  weekEl?.addEventListener('dragleave', (e) => {
    const t = e.target as HTMLElement
    const slot = t.closest<HTMLElement>('.week__slot')
    if (!slot) return
    slot.classList.remove('is-drop')
  })

  weekEl?.addEventListener('drop', async (e) => {
    const t = e.target as HTMLElement
    const slot = t.closest<HTMLElement>('.week__slot')
    if (!slot) return
    e.preventDefault()
    slot.classList.remove('is-drop')

    const idStr = e.dataTransfer?.getData('application/x-tlxauto-appt') || e.dataTransfer?.getData('text/plain')
    const id = Number(idStr)
    const dtLocal = String(slot.dataset.dtlocal || '')
    if (!id || !dtLocal) return

    try {
      await api.updateAppointment(id, { scheduled_at: isoFromDatetimeLocal(dtLocal) })
      toast('Agendamento reagendado')
      await loadWeek()
      await loadAppointments()
      await loadReminders()
    } catch (err) {
      toast(errToMessage(err), 'error')
    }
  })

  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!selectCustomer || selectCustomer.disabled) {
      toast('Cadastre um cliente primeiro', 'error')
      return
    }
    const fd = new FormData(form)
    const customerId = Number(fd.get('customer_id'))
    const vehicleIdRaw = String(fd.get('vehicle_id') ?? '').trim()
    const soRaw = String(fd.get('service_order_id') ?? '').trim().replace('#', '')
    const title = String(fd.get('title') ?? '').trim()
    const durationRaw = String(fd.get('duration_minutes') ?? '30').trim()
    const scheduledLocal = String(fd.get('scheduled_at') ?? '').trim()
    const notesRaw = String(fd.get('notes') ?? '').trim()

    const vehicleId = vehicleIdRaw ? Number(vehicleIdRaw) : null
    const soId = soRaw ? Number(soRaw) : null
    const scheduledAt = isoFromDatetimeLocal(scheduledLocal)
    const durationMinutes = Number(durationRaw) as AppointmentDurationMinutes

    if (!customerId || !title || !scheduledLocal) return

    try {
      await api.createAppointment({
        customer_id: customerId,
        vehicle_id: Number.isFinite(vehicleId as number) ? (vehicleId as number) : null,
        service_order_id: Number.isFinite(soId as number) ? (soId as number) : null,
        title,
        notes: notesRaw ? notesRaw : null,
        scheduled_at: scheduledAt,
        duration_minutes: durationMinutes,
      })
      form.reset()
      await loadVehicles()
      toast('Agendamento criado')
      await loadReminders()
      await loadAppointments()
    } catch (err) {
      toast(errToMessage(err), 'error')
    }
  })

  await loadCustomers()
  await loadVehicles()
  await loadReminders()
  await loadAppointments()

  await setAgendaView('list')
}

function openAppointmentEditModal(
  appointment: Appointment,
  customers: Customer[],
  vehiclesAll: Vehicle[],
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'

    const customerOptions = customers
      .map(
        (c) =>
          `<option value="${c.id}" ${c.id === appointment.customer_id ? 'selected' : ''}>#${c.id} — ${escapeHtml(c.name)}</option>`,
      )
      .join('')

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Editar agendamento">
        <div class="modal__header">
          <div>
            <div class="modal__title">Editar agendamento</div>
            <div class="modal__subtitle">#${appointment.id}</div>
          </div>
          <button class="btn" id="btn-close" type="button">Fechar</button>
        </div>
        <form class="form" id="form-edit">
          <label>
            Cliente
            <select name="customer_id" id="edit-appt-customer" required>${customerOptions}</select>
          </label>
          <label>
            Veículo (opcional)
            <select name="vehicle_id" id="edit-appt-vehicle"></select>
          </label>
          <label>
            OS vinculada (opcional)
            <input name="service_order_id" inputmode="numeric" value="${escapeHtml(String(appointment.service_order_id ?? ''))}" />
          </label>
          <label>
            Título
            <input name="title" required minlength="1" maxlength="120" value="${escapeHtml(appointment.title)}" />
          </label>
          <label>
            Duração
            <select name="duration_minutes" required>
              <option value="30" ${appointment.duration_minutes === 30 ? 'selected' : ''}>30 min</option>
              <option value="60" ${appointment.duration_minutes === 60 ? 'selected' : ''}>60 min</option>
              <option value="90" ${appointment.duration_minutes === 90 ? 'selected' : ''}>90 min</option>
            </select>
          </label>
          <label>
            Quando
            <input name="scheduled_at" type="datetime-local" required value="${escapeHtml(datetimeLocalFromIso(appointment.scheduled_at))}" />
          </label>
          <label>
            Status
            <select name="status" required>
              <option value="scheduled" ${appointment.status === 'scheduled' ? 'selected' : ''}>scheduled</option>
              <option value="done" ${appointment.status === 'done' ? 'selected' : ''}>done</option>
              <option value="canceled" ${appointment.status === 'canceled' ? 'selected' : ''}>canceled</option>
            </select>
          </label>
          <label>
            Observações (opcional)
            <textarea name="notes" maxlength="1000" rows="3">${escapeHtml(appointment.notes ?? '')}</textarea>
          </label>
          <div class="row row--space">
            <div class="muted" style="font-size: 12px;">Atualiza, salva e segue o jogo</div>
            <button class="btn btn--primary" type="submit">Salvar</button>
          </div>
        </form>
      </div>
    `

    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      overlay.remove()
      resolve(ok)
    }

    const selectCustomer = overlay.querySelector<HTMLSelectElement>('#edit-appt-customer')
    const selectVehicle = overlay.querySelector<HTMLSelectElement>('#edit-appt-vehicle')

    const renderVehicles = () => {
      if (!selectCustomer || !selectVehicle) return
      const customerId = Number(selectCustomer.value)
      const subset = vehiclesAll.filter((v) => v.customer_id === customerId)
      selectVehicle.innerHTML = `
        <option value="">(sem veículo)</option>
        ${subset
          .map(
            (v) =>
              `<option value="${v.id}" ${appointment.vehicle_id === v.id ? 'selected' : ''}>#${v.id} — ${escapeHtml(v.plate)} — ${escapeHtml(v.model)}</option>`,
          )
          .join('')}
      `
    }

    renderVehicles()
    selectCustomer?.addEventListener('change', renderVehicles)

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false)
    })
    overlay.querySelector<HTMLButtonElement>('#btn-close')?.addEventListener('click', () => finish(false))

    overlay.querySelector<HTMLFormElement>('#form-edit')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const fd = new FormData(form)
      const customerId = Number(fd.get('customer_id'))
      const vehicleRaw = String(fd.get('vehicle_id') ?? '').trim()
      const soRaw = String(fd.get('service_order_id') ?? '').trim().replace('#', '')
      const title = String(fd.get('title') ?? '').trim()
      const durationRaw = String(fd.get('duration_minutes') ?? String(appointment.duration_minutes)).trim()
      const scheduledLocal = String(fd.get('scheduled_at') ?? '').trim()
      const status = String(fd.get('status') ?? 'scheduled') as AppointmentStatus
      const notesRaw = String(fd.get('notes') ?? '').trim()

      const vehicleId = vehicleRaw ? Number(vehicleRaw) : null
      const soId = soRaw ? Number(soRaw) : null
      const durationMinutes = Number(durationRaw) as AppointmentDurationMinutes

      try {
        await api.updateAppointment(appointment.id, {
          customer_id: customerId,
          vehicle_id: Number.isFinite(vehicleId as number) ? (vehicleId as number) : null,
          service_order_id: Number.isFinite(soId as number) ? (soId as number) : null,
          title,
          notes: notesRaw ? notesRaw : null,
          status,
          scheduled_at: isoFromDatetimeLocal(scheduledLocal),
          duration_minutes: durationMinutes,
        })
        finish(true)
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
    })

    document.body.appendChild(overlay)
    overlay.querySelector<HTMLInputElement>('input[name="title"]')?.focus()
  })
}

async function renderClientes() {
  panelClientes.innerHTML = `
    <h2>Clientes</h2>
    <div class="grid">
      <div class="card">
        <h3>Novo cliente</h3>
        <form id="form-customer" class="form">
          <label>
            Nome
            <input name="name" required minlength="1" maxlength="120" />
          </label>
          <label>
            Telefone (opcional)
            <input name="phone" maxlength="40" />
          </label>
          <button class="btn btn--primary" type="submit">Salvar</button>
        </form>
      </div>

      <div class="card">
        <div class="row row--space">
          <h3>Lista</h3>
          <div class="row">
            <input id="customers-search" placeholder="Buscar nome/telefone..." />
            <button class="btn" id="btn-refresh-customers" type="button">Atualizar</button>
          </div>
        </div>
        <div id="customers-list" class="list"></div>
      </div>
    </div>
  `

  const listEl = document.querySelector<HTMLDivElement>('#customers-list')
  const refreshBtn = document.querySelector<HTMLButtonElement>('#btn-refresh-customers')
  const form = document.querySelector<HTMLFormElement>('#form-customer')
  const searchEl = document.querySelector<HTMLInputElement>('#customers-search')

  let customers: Customer[] = []

  const renderList = () => {
    if (!listEl) return
    const q = (searchEl?.value ?? '').trim().toLowerCase()
    const filtered = q
      ? customers.filter((c) =>
          `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(q),
        )
      : customers

    listEl.innerHTML = filtered.length
      ? filtered
          .map(
            (c) => `
              <div class="list__item">
                <div class="row row--space row--wrap">
                  <div>
                    <div class="list__title">#${c.id} — ${escapeHtml(c.name)}</div>
                    <div class="list__meta">${c.phone ? escapeHtml(c.phone) : 'sem telefone'}</div>
                  </div>
                  <div class="row">
                    <button class="btn btn--premium" data-action="edit-customer" data-id="${c.id}" type="button">Editar</button>
                    <button class="btn btn--danger" data-action="delete-customer" data-id="${c.id}" type="button">Excluir</button>
                  </div>
                </div>
              </div>
            `,
          )
          .join('')
      : '<div class="muted">Nenhum cliente.</div>'
  }

  const load = async () => {
    if (!listEl) return
    listEl.textContent = 'Carregando...'
    try {
      customers = await api.listCustomers()
      renderList()
    } catch (err) {
      if (listEl) listEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  searchEl?.addEventListener('input', renderList)

  listEl?.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const btn = t.closest<HTMLButtonElement>('button[data-action]')
    if (!btn) return
    const id = Number(btn.dataset.id)
    if (!id) return

    if (btn.dataset.action === 'edit-customer') {
      const c = customers.find((x) => x.id === id)
      if (!c) return
      const updated = await openCustomerEditModal(c)
      if (updated) {
        toast('Cliente atualizado')
        await load()
      }
      return
    }

    if (btn.dataset.action === 'delete-customer') {
      if (!confirm('Excluir este cliente? Isso também remove veículos e OS vinculadas.')) return
      try {
        await api.deleteCustomer(id)
        toast('Cliente excluído')
        await load()
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
    }
  })

  refreshBtn?.addEventListener('click', load)
  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(form)
    const name = String(fd.get('name') ?? '').trim()
    const phone = String(fd.get('phone') ?? '').trim()
    if (!name) return
    try {
      await api.createCustomer({ name, phone: phone || undefined })
      form.reset()
      toast('Cliente cadastrado')
      await load()
    } catch (err) {
      toast(errToMessage(err), 'error')
    }
  })

  await load()
}

function openCustomerEditModal(customer: Customer): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Editar cliente">
        <div class="modal__header">
          <div>
            <div class="modal__title">Editar cliente</div>
            <div class="modal__subtitle">#${customer.id}</div>
          </div>
          <button class="btn" id="btn-close" type="button">Fechar</button>
        </div>
        <form class="form" id="form-edit">
          <label>
            Nome
            <input name="name" required minlength="1" maxlength="120" value="${escapeHtml(customer.name)}" />
          </label>
          <label>
            Telefone (opcional)
            <input name="phone" maxlength="40" value="${escapeHtml(customer.phone ?? '')}" />
          </label>
          <div class="row row--space">
            <div class="muted" style="font-size: 12px;">Atualiza sem frescura</div>
            <button class="btn btn--primary" type="submit">Salvar</button>
          </div>
        </form>
      </div>
    `

    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      overlay.remove()
      resolve(ok)
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false)
    })
    overlay.querySelector<HTMLButtonElement>('#btn-close')?.addEventListener('click', () => finish(false))

    overlay.querySelector<HTMLFormElement>('#form-edit')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const fd = new FormData(form)
      const name = String(fd.get('name') ?? '').trim()
      const phoneRaw = String(fd.get('phone') ?? '').trim()
      try {
        await api.updateCustomer(customer.id, { name, phone: phoneRaw ? phoneRaw : null })
        finish(true)
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
    })

    document.body.appendChild(overlay)
    overlay.querySelector<HTMLInputElement>('input[name="name"]')?.focus()
  })
}

async function renderVeiculos() {
  panelVeiculos.innerHTML = `
    <h2>Veículos</h2>
    <div class="grid">
      <div class="card">
        <h3>Novo veículo</h3>
        <form id="form-vehicle" class="form">
          <label>
            Cliente
            <select name="customer_id" id="vehicle-customer" required></select>
          </label>
          <label>
            Placa
            <input name="plate" required minlength="1" maxlength="20" placeholder="ABC1D23" />
          </label>
          <label>
            Modelo
            <input name="model" required minlength="1" maxlength="120" placeholder="Gol 1.6" />
          </label>
          <label>
            Ano (opcional)
            <input name="year" inputmode="numeric" placeholder="2015" />
          </label>
          <label>
            Observações (opcional)
            <textarea name="notes" maxlength="500" rows="3"></textarea>
          </label>
          <button class="btn btn--primary" type="submit">Salvar</button>
        </form>
      </div>

      <div class="card">
        <div class="row row--space">
          <h3>Lista</h3>
          <div class="row">
            <input id="vehicles-search" placeholder="Buscar placa/modelo/cliente..." />
            <button class="btn" id="btn-refresh-vehicles" type="button">Atualizar</button>
          </div>
        </div>
        <div id="vehicles-list" class="list"></div>
      </div>
    </div>
  `

  const listEl = document.querySelector<HTMLDivElement>('#vehicles-list')
  const refreshBtn = document.querySelector<HTMLButtonElement>('#btn-refresh-vehicles')
  const form = document.querySelector<HTMLFormElement>('#form-vehicle')
  const selectCustomer = document.querySelector<HTMLSelectElement>('#vehicle-customer')
  const searchEl = document.querySelector<HTMLInputElement>('#vehicles-search')

  let customers: Customer[] = []

  const loadCustomers = async () => {
    customers = await api.listCustomers()
    if (selectCustomer) {
      selectCustomer.innerHTML = customers.length
        ? customers.map((c) => `<option value="${c.id}">#${c.id} — ${escapeHtml(c.name)}</option>`).join('')
        : '<option value="" disabled selected>Cadastre um cliente primeiro</option>'
      selectCustomer.disabled = customers.length === 0
    }
  }

  const loadVehicles = async () => {
    if (!listEl) return
    listEl.textContent = 'Carregando...'
    try {
      const vehicles = await api.listVehicles()
      const byCustomer = new Map<number, Customer>()
      customers.forEach((c) => byCustomer.set(c.id, c))
      const q = (searchEl?.value ?? '').trim().toLowerCase()
      const filtered = q
        ? vehicles.filter((v) => {
            const owner = byCustomer.get(v.customer_id)
            const ownerText = owner ? owner.name : ''
            return `${v.plate} ${v.model} ${ownerText}`.toLowerCase().includes(q)
          })
        : vehicles

      listEl.innerHTML = filtered.length
        ? filtered
            .map((v) => {
              const owner = byCustomer.get(v.customer_id)
              const ownerText = owner ? `${owner.name}` : `Cliente #${v.customer_id}`
              const yearText = v.year ? ` • ${v.year}` : ''
              return `
                <div class="list__item">
                  <div class="row row--space row--wrap">
                    <div>
                      <div class="list__title">#${v.id} — ${escapeHtml(v.plate)} — ${escapeHtml(v.model)}${yearText}</div>
                      <div class="list__meta">${escapeHtml(ownerText)}</div>
                    </div>
                    <div class="row">
                      <button class="btn btn--premium" data-action="edit-vehicle" data-id="${v.id}" type="button">Editar</button>
                      <button class="btn btn--danger" data-action="delete-vehicle" data-id="${v.id}" type="button">Excluir</button>
                    </div>
                  </div>
                </div>
              `
            })
            .join('')
        : '<div class="muted">Nenhum veículo.</div>'
    } catch (err) {
      if (listEl) listEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  searchEl?.addEventListener('input', loadVehicles)

  listEl?.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement
    const btn = t.closest<HTMLButtonElement>('button[data-action]')
    if (!btn) return
    const id = Number(btn.dataset.id)
    if (!id) return

    if (btn.dataset.action === 'delete-vehicle') {
      if (!confirm('Excluir este veículo? Isso também remove OS vinculadas.')) return
      try {
        await api.deleteVehicle(id)
        toast('Veículo excluído')
        await loadVehicles()
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
      return
    }

    if (btn.dataset.action === 'edit-vehicle') {
      try {
        const vehicles = await api.listVehicles()
        const v = vehicles.find((x) => x.id === id)
        if (!v) return
        const ok = await openVehicleEditModal(v, customers)
        if (ok) {
          toast('Veículo atualizado')
          await loadCustomers()
          await loadVehicles()
        }
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
    }
  })

  refreshBtn?.addEventListener('click', async () => {
    await loadCustomers()
    await loadVehicles()
  })

  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!selectCustomer || selectCustomer.disabled) {
      toast('Cadastre um cliente primeiro', 'error')
      return
    }
    const fd = new FormData(form)
    const customerId = Number(fd.get('customer_id'))
    const plate = String(fd.get('plate') ?? '').trim()
    const model = String(fd.get('model') ?? '').trim()
    const yearStr = String(fd.get('year') ?? '').trim()
    const notes = String(fd.get('notes') ?? '').trim()

    const year = yearStr ? Number(yearStr) : undefined
    if (!customerId || !plate || !model) return

    try {
      await api.createVehicle({
        customer_id: customerId,
        plate,
        model,
        year: Number.isFinite(year) ? year : undefined,
        notes: notes || undefined,
      })
      form.reset()
      toast('Veículo cadastrado')
      await loadVehicles()
    } catch (err) {
      toast(errToMessage(err), 'error')
    }
  })

  await loadCustomers()
  await loadVehicles()
}

function openVehicleEditModal(vehicle: Vehicle, customers: Customer[]): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const customerOptions = customers
      .map(
        (c) =>
          `<option value="${c.id}" ${c.id === vehicle.customer_id ? 'selected' : ''}>#${c.id} — ${escapeHtml(c.name)}</option>`,
      )
      .join('')

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Editar veículo">
        <div class="modal__header">
          <div>
            <div class="modal__title">Editar veículo</div>
            <div class="modal__subtitle">#${vehicle.id}</div>
          </div>
          <button class="btn" id="btn-close" type="button">Fechar</button>
        </div>
        <form class="form" id="form-edit">
          <label>
            Cliente
            <select name="customer_id" required>${customerOptions}</select>
          </label>
          <label>
            Placa
            <input name="plate" required minlength="1" maxlength="20" value="${escapeHtml(vehicle.plate)}" />
          </label>
          <label>
            Modelo
            <input name="model" required minlength="1" maxlength="120" value="${escapeHtml(vehicle.model)}" />
          </label>
          <label>
            Ano (opcional)
            <input name="year" inputmode="numeric" value="${escapeHtml(String(vehicle.year ?? ''))}" />
          </label>
          <label>
            Observações (opcional)
            <textarea name="notes" maxlength="500" rows="3">${escapeHtml(vehicle.notes ?? '')}</textarea>
          </label>
          <div class="row row--space">
            <div class="muted" style="font-size: 12px;">Sem drama: atualiza e segue</div>
            <button class="btn btn--primary" type="submit">Salvar</button>
          </div>
        </form>
      </div>
    `

    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      overlay.remove()
      resolve(ok)
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false)
    })
    overlay.querySelector<HTMLButtonElement>('#btn-close')?.addEventListener('click', () => finish(false))

    overlay.querySelector<HTMLFormElement>('#form-edit')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const fd = new FormData(form)
      const customerId = Number(fd.get('customer_id'))
      const plate = String(fd.get('plate') ?? '').trim()
      const model = String(fd.get('model') ?? '').trim()
      const yearStr = String(fd.get('year') ?? '').trim()
      const notesRaw = String(fd.get('notes') ?? '').trim()

      const year = yearStr ? Number(yearStr) : null
      try {
        await api.updateVehicle(vehicle.id, {
          customer_id: customerId,
          plate,
          model,
          year: Number.isFinite(year as number) ? (year as number) : null,
          notes: notesRaw ? notesRaw : null,
        })
        finish(true)
      } catch (err) {
        toast(errToMessage(err), 'error')
      }
    })

    document.body.appendChild(overlay)
    overlay.querySelector<HTMLInputElement>('input[name="plate"]')?.focus()
  })
}

async function renderOrdens() {
  panelOrdens.innerHTML = `
    <h2>Ordens de serviço</h2>
    <div class="grid">
      <div class="card">
        <h3>Nova OS</h3>
        <form id="form-so" class="form">
          <label>
            Cliente
            <select name="customer_id" id="so-customer" required></select>
          </label>
          <label>
            Veículo
            <select name="vehicle_id" id="so-vehicle" required></select>
          </label>
          <label>
            Descrição
            <textarea name="description" required minlength="1" maxlength="1000" rows="4" placeholder="Ex.: troca de óleo + filtro"></textarea>
          </label>
          <label>
            Total (R$)
            <input name="total" inputmode="decimal" placeholder="150,00" />
          </label>
          <button class="btn btn--primary" type="submit">Salvar</button>
        </form>
      </div>

      <div class="card">
        <div class="row row--space">
          <h3>Lista</h3>
          <button class="btn" id="btn-refresh-so" type="button">Atualizar</button>
        </div>
        <div id="so-list" class="list"></div>
      </div>
    </div>
  `

  const listEl = document.querySelector<HTMLDivElement>('#so-list')
  const refreshBtn = document.querySelector<HTMLButtonElement>('#btn-refresh-so')
  const form = document.querySelector<HTMLFormElement>('#form-so')
  const selectCustomer = document.querySelector<HTMLSelectElement>('#so-customer')
  const selectVehicle = document.querySelector<HTMLSelectElement>('#so-vehicle')

  let customers: Customer[] = []
  let vehicles: Vehicle[] = []

  const loadCustomers = async () => {
    customers = await api.listCustomers()
    if (selectCustomer) {
      selectCustomer.innerHTML = customers.length
        ? customers.map((c) => `<option value="${c.id}">#${c.id} — ${escapeHtml(c.name)}</option>`).join('')
        : '<option value="" disabled selected>Cadastre um cliente primeiro</option>'
      selectCustomer.disabled = customers.length === 0
    }
  }

  const loadVehicles = async (customerId?: number) => {
    vehicles = customerId ? await api.listVehicles(customerId) : await api.listVehicles()
    if (selectVehicle) {
      selectVehicle.innerHTML = vehicles.length
        ? vehicles
            .map((v) => `<option value="${v.id}">#${v.id} — ${escapeHtml(v.plate)} — ${escapeHtml(v.model)}</option>`)
            .join('')
        : '<option value="" disabled selected>Cadastre um veículo primeiro</option>'
      selectVehicle.disabled = vehicles.length === 0
    }
  }

  const loadOrders = async () => {
    if (!listEl) return
    listEl.textContent = 'Carregando...'
    try {
      const orders = await api.listServiceOrders()
      const custMap = new Map<number, Customer>()
      const vehMap = new Map<number, Vehicle>()
      customers.forEach((c) => custMap.set(c.id, c))
      ;(await api.listVehicles()).forEach((v) => vehMap.set(v.id, v))

      listEl.innerHTML = orders.length
        ? orders
            .map((o) => renderOrderItem(o, custMap, vehMap))
            .join('')
        : '<div class="muted">Nenhuma OS ainda.</div>'

      // binds
      listEl.querySelectorAll<HTMLSelectElement>('[data-action="status"]')?.forEach((sel) => {
        sel.addEventListener('change', async () => {
          const id = Number(sel.dataset.id)
          const status = sel.value as ServiceOrder['status']
          try {
            await api.updateServiceOrder(id, { status })
            toast('Status atualizado')
          } catch (err) {
            toast(errToMessage(err), 'error')
          }
        })
      })

      listEl.querySelectorAll<HTMLButtonElement>('[data-action="delete-so"]')?.forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.dataset.id)
          if (!id) return
          if (!confirm(`Excluir a OS #${id}?`)) return
          try {
            await api.deleteServiceOrder(id)
            toast('OS excluída')
            await loadOrders()
          } catch (err) {
            toast(errToMessage(err), 'error')
          }
        })
      })
    } catch (err) {
      if (listEl) listEl.innerHTML = `<div class="error">${escapeHtml(errToMessage(err))}</div>`
    }
  }

  selectCustomer?.addEventListener('change', async () => {
    const customerId = Number(selectCustomer.value)
    await loadVehicles(Number.isFinite(customerId) ? customerId : undefined)
  })

  refreshBtn?.addEventListener('click', async () => {
    await loadCustomers()
    await loadVehicles(selectCustomer && !selectCustomer.disabled ? Number(selectCustomer.value) : undefined)
    await loadOrders()
  })

  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!selectCustomer || selectCustomer.disabled || !selectVehicle || selectVehicle.disabled) {
      toast('Cadastre cliente e veículo primeiro', 'error')
      return
    }
    const fd = new FormData(form)
    const customerId = Number(fd.get('customer_id'))
    const vehicleId = Number(fd.get('vehicle_id'))
    const description = String(fd.get('description') ?? '').trim()
    const totalStr = String(fd.get('total') ?? '').trim()

    const totalCents = parseBrlToCents(totalStr)
    if (!customerId || !vehicleId || !description) return

    try {
      await api.createServiceOrder({
        customer_id: customerId,
        vehicle_id: vehicleId,
        description,
        total_cents: totalCents,
      })
      form.reset()
      toast('OS criada')
      await loadOrders()
    } catch (err) {
      toast(errToMessage(err), 'error')
    }
  })

  await loadCustomers()
  await loadVehicles(selectCustomer && !selectCustomer.disabled ? Number(selectCustomer.value) : undefined)
  await loadOrders()
}

function renderOrderItem(
  o: ServiceOrder,
  custMap: Map<number, Customer>,
  vehMap: Map<number, Vehicle>,
): string {
  const customer = custMap.get(o.customer_id)
  const vehicle = vehMap.get(o.vehicle_id)
  const custText = customer ? customer.name : `Cliente #${o.customer_id}`
  const vehText = vehicle ? `${vehicle.plate} — ${vehicle.model}` : `Veículo #${o.vehicle_id}`

  const options = ['open', 'in_progress', 'done', 'canceled'] as const
  const statusSelect = `
    <select data-action="status" data-id="${o.id}" class="select">
      ${options
        .map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`)
        .join('')}
    </select>
  `

  return `
    <div class="list__item">
      <div class="row row--space row--wrap">
        <div>
          <div class="list__title">OS #${o.id} — ${escapeHtml(custText)}</div>
          <div class="list__meta">${escapeHtml(vehText)} • ${moneyFromCents(o.total_cents)}</div>
        </div>
        <div class="row">
          ${statusSelect}
          <button class="btn btn--danger" data-action="delete-so" data-id="${o.id}" type="button">Excluir</button>
        </div>
      </div>
      <div class="list__desc">${escapeHtml(o.description)}</div>
    </div>
  `
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseBrlToCents(raw: string): number {
  const v = raw.trim()
  if (!v) return 0
  // Aceita "150,00" ou "150.00" ou "150"
  const normalized = v.replaceAll('.', '').replace(',', '.')
  const num = Number(normalized)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.round(num * 100)
}

// Primeiro render
const ok = await ensureAuthenticated(false)
renderAuthArea()
if (ok) {
  await reloadAll()
  startReminderPolling()
} else {
  renderLockedState()
}
