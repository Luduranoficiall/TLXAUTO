export type Customer = {
  id: number
  name: string
  phone?: string | null
}

export type Vehicle = {
  id: number
  customer_id: number
  plate: string
  model: string
  year?: number | null
  notes?: string | null
}

export type ServiceOrderStatus = 'open' | 'in_progress' | 'done' | 'canceled'

export type ServiceOrder = {
  id: number
  customer_id: number
  vehicle_id: number
  description: string
  status: ServiceOrderStatus
  total_cents: number
}

export type AppointmentStatus = 'scheduled' | 'done' | 'canceled'

export type AppointmentDurationMinutes = 30 | 60 | 90

export type Appointment = {
  id: number
  customer_id: number
  vehicle_id?: number | null
  service_order_id?: number | null
  title: string
  notes?: string | null
  status: AppointmentStatus
  scheduled_at: string
  duration_minutes: AppointmentDurationMinutes
  reminded_at?: string | null
}

export type UserRole = 'admin' | 'operator'

export type User = {
  id: number
  email: string
  role: UserRole
}

export type TokenResponse = {
  access_token: string
  token_type: 'bearer'
  user: User
}

export type Stats = {
  customers: number
  vehicles: number
  service_orders_total: number
  service_orders_open: number
  service_orders_in_progress: number
  service_orders_done: number
  service_orders_canceled: number
  revenue_done_cents: number
}

type FetchOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
}

const TOKEN_KEY = 'tlxauto_token'

let tokenCache: string | null = null

export function getToken(): string | null {
  if (tokenCache !== null) return tokenCache
  tokenCache = localStorage.getItem(TOKEN_KEY)
  return tokenCache
}

export function setToken(token: string | null) {
  tokenCache = token
  if (!token) {
    localStorage.removeItem(TOKEN_KEY)
    return
  }
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  setToken(null)
}

async function fetchJson<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  if (!res.ok) {
    if (res.status === 401) {
      // Token expirado/inválido → força novo login
      clearToken()
    }
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} em ${path}${text ? `: ${text}` : ''}`)
  }

  return (await res.json()) as T
}

export const api = {
  health: () => fetchJson<{ status: 'ok'; server_time: string }>('/api/health'),

  stats: () => fetchJson<Stats>('/api/stats'),

  login: async (payload: { email: string; password: string }) => {
    const res = await fetchJson<TokenResponse>('/api/auth/login', { method: 'POST', body: payload })
    setToken(res.access_token)
    return res
  },

  me: () => fetchJson<User>('/api/auth/me'),

  listUsers: () => fetchJson<User[]>('/api/auth/users'),
  createUser: (payload: { email: string; password: string; role: UserRole }) =>
    fetchJson<User>('/api/auth/users', { method: 'POST', body: payload }),

  listCustomers: () => fetchJson<Customer[]>('/api/customers'),
  createCustomer: (payload: { name: string; phone?: string }) =>
    fetchJson<Customer>('/api/customers', { method: 'POST', body: payload }),
  updateCustomer: (id: number, payload: { name?: string; phone?: string | null }) =>
    fetchJson<Customer>(`/api/customers/${id}`, { method: 'PATCH', body: payload }),
  deleteCustomer: (id: number) => fetchJson<{ ok: true }>(`/api/customers/${id}`, { method: 'DELETE' }),

  listVehicles: (customerId?: number) => {
    const qs = customerId ? `?customer_id=${encodeURIComponent(String(customerId))}` : ''
    return fetchJson<Vehicle[]>(`/api/vehicles${qs}`)
  },
  createVehicle: (payload: {
    customer_id: number
    plate: string
    model: string
    year?: number
    notes?: string
  }) => fetchJson<Vehicle>('/api/vehicles', { method: 'POST', body: payload }),
  updateVehicle: (
    id: number,
    payload: {
      customer_id?: number
      plate?: string
      model?: string
      year?: number | null
      notes?: string | null
    },
  ) => fetchJson<Vehicle>(`/api/vehicles/${id}`, { method: 'PATCH', body: payload }),
  deleteVehicle: (id: number) => fetchJson<{ ok: true }>(`/api/vehicles/${id}`, { method: 'DELETE' }),

  listServiceOrders: (filters?: { customerId?: number; vehicleId?: number }) => {
    const params = new URLSearchParams()
    if (filters?.customerId) params.set('customer_id', String(filters.customerId))
    if (filters?.vehicleId) params.set('vehicle_id', String(filters.vehicleId))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return fetchJson<ServiceOrder[]>(`/api/service-orders${qs}`)
  },
  createServiceOrder: (payload: {
    customer_id: number
    vehicle_id: number
    description: string
    status?: ServiceOrderStatus
    total_cents?: number
  }) => fetchJson<ServiceOrder>('/api/service-orders', { method: 'POST', body: payload }),

  updateServiceOrder: (
    id: number,
    payload: { description?: string; status?: ServiceOrderStatus; total_cents?: number },
  ) => fetchJson<ServiceOrder>(`/api/service-orders/${id}`, { method: 'PATCH', body: payload }),

  deleteServiceOrder: (id: number) =>
    fetchJson<{ ok: true }>(`/api/service-orders/${id}`, { method: 'DELETE' }),

  listAppointments: (filters?: {
    from?: string
    to?: string
    status?: AppointmentStatus
    customer_id?: number
    vehicle_id?: number
    only_unreminded?: boolean
  }) => {
    const params = new URLSearchParams()
    if (filters?.from) params.set('from', filters.from)
    if (filters?.to) params.set('to', filters.to)
    if (filters?.status) params.set('status', String(filters.status))
    if (filters?.customer_id) params.set('customer_id', String(filters.customer_id))
    if (filters?.vehicle_id) params.set('vehicle_id', String(filters.vehicle_id))
    if (filters?.only_unreminded) params.set('only_unreminded', 'true')
    const qs = params.toString() ? `?${params.toString()}` : ''
    return fetchJson<Appointment[]>(`/api/appointments${qs}`)
  },

  createAppointment: (payload: {
    customer_id: number
    vehicle_id?: number | null
    service_order_id?: number | null
    title: string
    notes?: string | null
    scheduled_at: string
    duration_minutes?: AppointmentDurationMinutes
  }) => fetchJson<Appointment>('/api/appointments', { method: 'POST', body: payload }),

  updateAppointment: (
    id: number,
    payload: {
      customer_id?: number | null
      vehicle_id?: number | null
      service_order_id?: number | null
      title?: string | null
      notes?: string | null
      status?: AppointmentStatus | null
      scheduled_at?: string | null
      duration_minutes?: AppointmentDurationMinutes | null
      reminded_at?: string | null
    },
  ) => fetchJson<Appointment>(`/api/appointments/${id}`, { method: 'PATCH', body: payload }),

  deleteAppointment: (id: number) => fetchJson<{ ok: true }>(`/api/appointments/${id}`, { method: 'DELETE' }),

  reminders: (withinMinutes = 15) =>
    fetchJson<Appointment[]>(`/api/appointments/reminders?within_minutes=${encodeURIComponent(String(withinMinutes))}`),

  markAppointmentReminded: (id: number) =>
    fetchJson<{ ok: true }>(`/api/appointments/${id}/mark-reminded`, { method: 'POST' }),
}
