from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field

app = FastAPI(title="TLXAUTO API", version="0.1.0")

API_PREFIX = "/api"
DB_PATH = Path(__file__).with_name("tlxauto.db")

# Carrega .env do diretório raiz do projeto (quando existir)
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:
    # Sem dotenv/sem arquivo: tudo bem em dev. Em prod use env vars.
    pass

JWT_SECRET_KEY = os.getenv("TLXAUTO_SECRET_KEY", "dev-insecure-change-me-please")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("TLXAUTO_ACCESS_TOKEN_EXPIRE_MINUTES", "720"))
BOOTSTRAP_ADMIN_EMAIL = os.getenv("TLXAUTO_ADMIN_EMAIL", "admin@tlxauto.local")
BOOTSTRAP_ADMIN_PASSWORD = os.getenv("TLXAUTO_ADMIN_PASSWORD", "admin123")

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)

# Em dev, liberamos o frontend local. Ajustaremos depois.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    server_time: datetime = Field(default_factory=datetime.utcnow)


Role = Literal["admin", "operator"]


class UserPublic(BaseModel):
    id: int
    email: str
    role: Role


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=6, max_length=200)
    role: Role


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    user: UserPublic


def _row_to_user_public(row: sqlite3.Row) -> UserPublic:
    return UserPublic(id=int(row["id"]), email=str(row["email"]), role=row["role"])


def _get_user_by_email(email: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT id, email, password_hash, role, is_active FROM users WHERE email = ?",
            (email.lower().strip(),),
        ).fetchone()


def _get_user_by_id(user_id: int) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT id, email, role, is_active FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()


def _create_access_token(user_id: int, role: str) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm="HS256")


def _require_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> UserPublic:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Não autenticado")

    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=["HS256"])
        sub = payload.get("sub")
        if sub is None:
            raise HTTPException(status_code=401, detail="Token inválido")
        user_id = int(sub)
    except (JWTError, ValueError):
        raise HTTPException(status_code=401, detail="Token inválido")

    row = _get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=401, detail="Usuário não encontrado")
    if int(row["is_active"]) != 1:
        raise HTTPException(status_code=403, detail="Usuário desativado")
    return _row_to_user_public(row)


def _require_admin(user: UserPublic = Depends(_require_user)) -> UserPublic:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Apenas admin")
    return user


@app.post(f"{API_PREFIX}/auth/login", response_model=TokenResponse)
def login_api(payload: LoginRequest) -> TokenResponse:
    row = _get_user_by_email(payload.email)
    if row is None:
        raise HTTPException(status_code=401, detail="Credenciais inválidas")
    if int(row["is_active"]) != 1:
        raise HTTPException(status_code=403, detail="Usuário desativado")
    if not pwd_context.verify(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenciais inválidas")

    user_public = UserPublic(id=int(row["id"]), email=str(row["email"]), role=row["role"])
    token = _create_access_token(user_public.id, user_public.role)
    return TokenResponse(access_token=token, user=user_public)


@app.get(f"{API_PREFIX}/auth/me", response_model=UserPublic)
def me_api(user: UserPublic = Depends(_require_user)) -> UserPublic:
    return user


@app.get(f"{API_PREFIX}/auth/users", response_model=list[UserPublic])
def list_users_api(_: UserPublic = Depends(_require_admin)) -> list[UserPublic]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, email, role FROM users WHERE is_active = 1 ORDER BY id DESC"
        ).fetchall()
    return [_row_to_user_public(r) for r in rows]


@app.post(f"{API_PREFIX}/auth/users", response_model=UserPublic)
def create_user_api(payload: UserCreate, _: UserPublic = Depends(_require_admin)) -> UserPublic:
    try:
        user_id = _create_user(payload.email, payload.password, payload.role)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="E-mail já existe")

    row = _get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao criar usuário")
    return _row_to_user_public(row)

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Importante para manter integridade referencial quando usarmos FOREIGN KEY
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS customers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              phone TEXT,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS vehicles (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER NOT NULL,
              plate TEXT NOT NULL,
              model TEXT NOT NULL,
              year INTEGER,
              notes TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS service_orders (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER NOT NULL,
              vehicle_id INTEGER NOT NULL,
              description TEXT NOT NULL,
              status TEXT NOT NULL,
              total_cents INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
              FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS appointments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER NOT NULL,
              vehicle_id INTEGER,
              service_order_id INTEGER,
              title TEXT NOT NULL,
              notes TEXT,
              status TEXT NOT NULL,
              scheduled_at TEXT NOT NULL,
              duration_minutes INTEGER NOT NULL DEFAULT 30,
              reminded_at TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
              FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
              FOREIGN KEY(service_order_id) REFERENCES service_orders(id)
                ON DELETE SET NULL
            )
            """
        )

        # Migração leve (SQLite): adiciona coluna se o DB já existir sem ela.
        cols = {
            str(r["name"])
            for r in conn.execute("PRAGMA table_info(appointments)").fetchall()
        }
        if "duration_minutes" not in cols:
            conn.execute(
                "ALTER TABLE appointments ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 30"
            )


def _get_user_count() -> int:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()
    return int(row["c"]) if row is not None else 0


def _create_user(email: str, password: str, role: str) -> int:
    created_at = datetime.now(timezone.utc).isoformat()
    password_hash = pwd_context.hash(password)
    with _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO users (email, password_hash, role, is_active, created_at)
            VALUES (?, ?, ?, 1, ?)
            """,
            (email.lower().strip(), password_hash, role, created_at),
        )
        return int(cur.lastrowid)


def _bootstrap_admin_if_needed() -> None:
    # Cria o primeiro admin automaticamente se a tabela estiver vazia.
    if _get_user_count() > 0:
        return
    try:
        _create_user(BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD, "admin")
    except sqlite3.IntegrityError:
        return


@app.on_event("startup")
def _on_startup() -> None:
    _init_db()
    _bootstrap_admin_if_needed()


@app.get(f"{API_PREFIX}/health", response_model=HealthResponse)
def health_api() -> HealthResponse:
    return HealthResponse()


# Compat: endpoints antigos (sem /api)
@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return health_api()


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=40)


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=40)


class Customer(BaseModel):
    id: int
    name: str
    phone: str | None = None


def _row_to_customer(row: sqlite3.Row) -> Customer:
    return Customer(id=int(row["id"]), name=str(row["name"]), phone=row["phone"])


@app.get(f"{API_PREFIX}/customers", response_model=list[Customer])
def list_customers_api(_: UserPublic = Depends(_require_user)) -> list[Customer]:
    with _connect() as conn:
        rows = conn.execute("SELECT id, name, phone FROM customers ORDER BY id DESC").fetchall()
    return [_row_to_customer(r) for r in rows]


@app.post(f"{API_PREFIX}/customers", response_model=Customer)
def create_customer_api(
    payload: CustomerCreate,
    _: UserPublic = Depends(_require_user),
) -> Customer:
    created_at = datetime.utcnow().isoformat()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)",
            (payload.name, payload.phone, created_at),
        )
        customer_id = int(cur.lastrowid)
        row = conn.execute(
            "SELECT id, name, phone FROM customers WHERE id = ?",
            (customer_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao criar cliente")
    return _row_to_customer(row)


@app.get(f"{API_PREFIX}/customers/{'{' }customer_id{' }'}", response_model=Customer)
def get_customer_api(customer_id: int, _: UserPublic = Depends(_require_user)) -> Customer:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, phone FROM customers WHERE id = ?",
            (customer_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    return _row_to_customer(row)


@app.patch(f"{API_PREFIX}/customers/{{customer_id}}", response_model=Customer)
def update_customer_api(
    customer_id: int,
    payload: CustomerUpdate,
    _: UserPublic = Depends(_require_user),
) -> Customer:
    if not payload.model_fields_set:
        raise HTTPException(status_code=400, detail="Nada para atualizar")

    with _connect() as conn:
        existing = conn.execute(
            "SELECT id, name, phone FROM customers WHERE id = ?",
            (customer_id,),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Cliente não encontrado")

        new_name = (
            payload.name if "name" in payload.model_fields_set else str(existing["name"])
        )
        new_phone = payload.phone if "phone" in payload.model_fields_set else existing["phone"]

        conn.execute(
            "UPDATE customers SET name = ?, phone = ? WHERE id = ?",
            (new_name, new_phone, customer_id),
        )
        row = conn.execute(
            "SELECT id, name, phone FROM customers WHERE id = ?",
            (customer_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao atualizar cliente")
    return _row_to_customer(row)


@app.delete(f"{API_PREFIX}/customers/{{customer_id}}")
def delete_customer_api(customer_id: int, _: UserPublic = Depends(_require_user)) -> dict:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM customers WHERE id = ?", (customer_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Cliente não encontrado")
    return {"ok": True}


# Compat: endpoints antigos (sem /api)
@app.get("/customers", response_model=list[Customer])
def list_customers(_: UserPublic = Depends(_require_user)) -> list[Customer]:
    return list_customers_api()


@app.post("/customers", response_model=Customer)
def create_customer(payload: CustomerCreate, _: UserPublic = Depends(_require_user)) -> Customer:
    return create_customer_api(payload)


class VehicleCreate(BaseModel):
    customer_id: int
    plate: str = Field(min_length=1, max_length=20)
    model: str = Field(min_length=1, max_length=120)
    year: int | None = Field(default=None, ge=1900, le=2100)
    notes: str | None = Field(default=None, max_length=500)


class Vehicle(BaseModel):
    id: int
    customer_id: int
    plate: str
    model: str
    year: int | None = None
    notes: str | None = None


def _row_to_vehicle(row: sqlite3.Row) -> Vehicle:
    return Vehicle(
        id=int(row["id"]),
        customer_id=int(row["customer_id"]),
        plate=str(row["plate"]),
        model=str(row["model"]),
        year=row["year"],
        notes=row["notes"],
    )


class VehicleUpdate(BaseModel):
    customer_id: int | None = None
    plate: str | None = Field(default=None, min_length=1, max_length=20)
    model: str | None = Field(default=None, min_length=1, max_length=120)
    year: int | None = Field(default=None, ge=1900, le=2100)
    notes: str | None = Field(default=None, max_length=500)


@app.get(f"{API_PREFIX}/vehicles", response_model=list[Vehicle])
def list_vehicles_api(
    customer_id: int | None = Query(default=None),
    _: UserPublic = Depends(_require_user),
) -> list[Vehicle]:
    with _connect() as conn:
        if customer_id is None:
            rows = conn.execute(
                "SELECT id, customer_id, plate, model, year, notes FROM vehicles ORDER BY id DESC"
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, customer_id, plate, model, year, notes
                FROM vehicles
                WHERE customer_id = ?
                ORDER BY id DESC
                """,
                (customer_id,),
            ).fetchall()
    return [_row_to_vehicle(r) for r in rows]


@app.post(f"{API_PREFIX}/vehicles", response_model=Vehicle)
def create_vehicle_api(payload: VehicleCreate, _: UserPublic = Depends(_require_user)) -> Vehicle:
    created_at = datetime.utcnow().isoformat()
    with _connect() as conn:
        # garante que o cliente existe
        customer = conn.execute(
            "SELECT id FROM customers WHERE id = ?",
            (payload.customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente não encontrado")

        cur = conn.execute(
            """
            INSERT INTO vehicles (customer_id, plate, model, year, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload.customer_id,
                payload.plate,
                payload.model,
                payload.year,
                payload.notes,
                created_at,
            ),
        )
        vehicle_id = int(cur.lastrowid)
        row = conn.execute(
            "SELECT id, customer_id, plate, model, year, notes FROM vehicles WHERE id = ?",
            (vehicle_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao criar veículo")
    return _row_to_vehicle(row)


@app.patch(f"{API_PREFIX}/vehicles/{{vehicle_id}}", response_model=Vehicle)
def update_vehicle_api(
    vehicle_id: int,
    payload: VehicleUpdate,
    _: UserPublic = Depends(_require_user),
) -> Vehicle:
    if not payload.model_fields_set:
        raise HTTPException(status_code=400, detail="Nada para atualizar")

    with _connect() as conn:
        existing = conn.execute(
            "SELECT id, customer_id, plate, model, year, notes FROM vehicles WHERE id = ?",
            (vehicle_id,),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Veículo não encontrado")

        new_customer_id = (
            int(payload.customer_id)
            if "customer_id" in payload.model_fields_set
            else int(existing["customer_id"])
        )
        # garante que o cliente existe quando mudar
        customer = conn.execute(
            "SELECT id FROM customers WHERE id = ?",
            (new_customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente não encontrado")

        new_plate = payload.plate if "plate" in payload.model_fields_set else str(existing["plate"])
        new_model = payload.model if "model" in payload.model_fields_set else str(existing["model"])
        new_year = payload.year if "year" in payload.model_fields_set else existing["year"]
        new_notes = payload.notes if "notes" in payload.model_fields_set else existing["notes"]

        conn.execute(
            """
            UPDATE vehicles
            SET customer_id = ?, plate = ?, model = ?, year = ?, notes = ?
            WHERE id = ?
            """,
            (new_customer_id, new_plate, new_model, new_year, new_notes, vehicle_id),
        )
        row = conn.execute(
            "SELECT id, customer_id, plate, model, year, notes FROM vehicles WHERE id = ?",
            (vehicle_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao atualizar veículo")
    return _row_to_vehicle(row)


@app.delete(f"{API_PREFIX}/vehicles/{{vehicle_id}}")
def delete_vehicle_api(vehicle_id: int, _: UserPublic = Depends(_require_user)) -> dict:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM vehicles WHERE id = ?", (vehicle_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Veículo não encontrado")
    return {"ok": True}


ServiceOrderStatus = Literal["open", "in_progress", "done", "canceled"]


class ServiceOrderCreate(BaseModel):
    customer_id: int
    vehicle_id: int
    description: str = Field(min_length=1, max_length=1000)
    status: ServiceOrderStatus = "open"
    total_cents: int = Field(default=0, ge=0)


class ServiceOrder(BaseModel):
    id: int
    customer_id: int
    vehicle_id: int
    description: str
    status: ServiceOrderStatus
    total_cents: int


class ServiceOrderUpdate(BaseModel):
    description: str | None = Field(default=None, min_length=1, max_length=1000)
    status: ServiceOrderStatus | None = None
    total_cents: int | None = Field(default=None, ge=0)


def _row_to_service_order(row: sqlite3.Row) -> ServiceOrder:
    return ServiceOrder(
        id=int(row["id"]),
        customer_id=int(row["customer_id"]),
        vehicle_id=int(row["vehicle_id"]),
        description=str(row["description"]),
        status=row["status"],
        total_cents=int(row["total_cents"]),
    )


@app.get(f"{API_PREFIX}/service-orders", response_model=list[ServiceOrder])
def list_service_orders_api(
    customer_id: int | None = Query(default=None),
    vehicle_id: int | None = Query(default=None),
    _: UserPublic = Depends(_require_user),
) -> list[ServiceOrder]:
    with _connect() as conn:
        base = (
            "SELECT id, customer_id, vehicle_id, description, status, total_cents "
            "FROM service_orders"
        )
        where: list[str] = []
        params: list[int] = []
        if customer_id is not None:
            where.append("customer_id = ?")
            params.append(customer_id)
        if vehicle_id is not None:
            where.append("vehicle_id = ?")
            params.append(vehicle_id)
        sql = base
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC"

        rows = conn.execute(sql, tuple(params)).fetchall()
    return [_row_to_service_order(r) for r in rows]


@app.post(f"{API_PREFIX}/service-orders", response_model=ServiceOrder)
def create_service_order_api(
    payload: ServiceOrderCreate,
    _: UserPublic = Depends(_require_user),
) -> ServiceOrder:
    created_at = datetime.utcnow().isoformat()
    with _connect() as conn:
        customer = conn.execute(
            "SELECT id FROM customers WHERE id = ?",
            (payload.customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente não encontrado")

        vehicle = conn.execute(
            "SELECT id, customer_id FROM vehicles WHERE id = ?",
            (payload.vehicle_id,),
        ).fetchone()
        if vehicle is None:
            raise HTTPException(status_code=404, detail="Veículo não encontrado")
        if int(vehicle["customer_id"]) != payload.customer_id:
            raise HTTPException(status_code=400, detail="Veículo não pertence ao cliente")

        cur = conn.execute(
            """
                        INSERT INTO service_orders (
                            customer_id,
                            vehicle_id,
                            description,
                            status,
                            total_cents,
                            created_at
                        )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload.customer_id,
                payload.vehicle_id,
                payload.description,
                payload.status,
                payload.total_cents,
                created_at,
            ),
        )
        so_id = int(cur.lastrowid)
        row = conn.execute(
            """
            SELECT id, customer_id, vehicle_id, description, status, total_cents
            FROM service_orders
            WHERE id = ?
            """,
            (so_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao criar ordem de serviço")
    return _row_to_service_order(row)


@app.patch(f"{API_PREFIX}/service-orders/{'{' }service_order_id{' }'}", response_model=ServiceOrder)
def update_service_order_api(
    service_order_id: int,
    payload: ServiceOrderUpdate,
    _: UserPublic = Depends(_require_user),
) -> ServiceOrder:
    if payload.description is None and payload.status is None and payload.total_cents is None:
        raise HTTPException(status_code=400, detail="Nada para atualizar")

    with _connect() as conn:
        existing = conn.execute(
            """
            SELECT id, customer_id, vehicle_id, description, status, total_cents
            FROM service_orders
            WHERE id = ?
            """,
            (service_order_id,),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Ordem de serviço não encontrada")

        new_description = (
            payload.description if payload.description is not None else existing["description"]
        )
        new_status = payload.status if payload.status is not None else existing["status"]
        new_total_cents = (
            payload.total_cents if payload.total_cents is not None else int(existing["total_cents"])
        )

        conn.execute(
            """
            UPDATE service_orders
            SET description = ?, status = ?, total_cents = ?
            WHERE id = ?
            """,
            (new_description, new_status, new_total_cents, service_order_id),
        )
        row = conn.execute(
            """
            SELECT id, customer_id, vehicle_id, description, status, total_cents
            FROM service_orders
            WHERE id = ?
            """,
            (service_order_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao atualizar ordem de serviço")
    return _row_to_service_order(row)


@app.delete(f"{API_PREFIX}/service-orders/{{service_order_id}}")
def delete_service_order_api(service_order_id: int, _: UserPublic = Depends(_require_user)) -> dict:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM service_orders WHERE id = ?", (service_order_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Ordem de serviço não encontrada")
    return {"ok": True}


class StatsResponse(BaseModel):
    customers: int
    vehicles: int
    service_orders_total: int
    service_orders_open: int
    service_orders_in_progress: int
    service_orders_done: int
    service_orders_canceled: int
    revenue_done_cents: int


@app.get(f"{API_PREFIX}/stats", response_model=StatsResponse)
def stats_api(_: UserPublic = Depends(_require_user)) -> StatsResponse:
    with _connect() as conn:
        customers = int(conn.execute("SELECT COUNT(*) AS c FROM customers").fetchone()["c"])
        vehicles = int(conn.execute("SELECT COUNT(*) AS c FROM vehicles").fetchone()["c"])

        total = int(conn.execute("SELECT COUNT(*) AS c FROM service_orders").fetchone()["c"])
        by_status_rows = conn.execute(
            "SELECT status, COUNT(*) AS c FROM service_orders GROUP BY status"
        ).fetchall()
        by_status = {str(r["status"]): int(r["c"]) for r in by_status_rows}

        revenue_row = conn.execute(
            "SELECT COALESCE(SUM(total_cents), 0) AS s FROM service_orders WHERE status = 'done'"
        ).fetchone()
        revenue_done = int(revenue_row["s"]) if revenue_row is not None else 0

    return StatsResponse(
        customers=customers,
        vehicles=vehicles,
        service_orders_total=total,
        service_orders_open=by_status.get("open", 0),
        service_orders_in_progress=by_status.get("in_progress", 0),
        service_orders_done=by_status.get("done", 0),
        service_orders_canceled=by_status.get("canceled", 0),
        revenue_done_cents=revenue_done,
    )


AppointmentStatus = Literal["scheduled", "done", "canceled"]
AppointmentDurationMinutes = Literal[30, 60, 90]


class AppointmentCreate(BaseModel):
    customer_id: int
    vehicle_id: int | None = None
    service_order_id: int | None = None
    title: str = Field(min_length=1, max_length=120)
    notes: str | None = Field(default=None, max_length=1000)
    scheduled_at: str = Field(min_length=10, max_length=40)
    duration_minutes: AppointmentDurationMinutes = 30


class AppointmentUpdate(BaseModel):
    customer_id: int | None = None
    vehicle_id: int | None = None
    service_order_id: int | None = None
    title: str | None = Field(default=None, min_length=1, max_length=120)
    notes: str | None = Field(default=None, max_length=1000)
    status: AppointmentStatus | None = None
    scheduled_at: str | None = Field(default=None, min_length=10, max_length=40)
    duration_minutes: AppointmentDurationMinutes | None = None
    reminded_at: str | None = Field(default=None, min_length=10, max_length=40)


class Appointment(BaseModel):
    id: int
    customer_id: int
    vehicle_id: int | None = None
    service_order_id: int | None = None
    title: str
    notes: str | None = None
    status: AppointmentStatus
    scheduled_at: str
    duration_minutes: AppointmentDurationMinutes
    reminded_at: str | None = None


def _row_to_appointment(row: sqlite3.Row) -> Appointment:
    return Appointment(
        id=int(row["id"]),
        customer_id=int(row["customer_id"]),
        vehicle_id=row["vehicle_id"],
        service_order_id=row["service_order_id"],
        title=str(row["title"]),
        notes=row["notes"],
        status=row["status"],
        scheduled_at=str(row["scheduled_at"]),
        duration_minutes=int(row["duration_minutes"]),
        reminded_at=row["reminded_at"],
    )


def _parse_iso_datetime(value: str) -> datetime:
    # Aceita ISO com 'Z' e com offset.
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        # Se vier sem tz, assume UTC.
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _check_appointment_conflict(
    conn: sqlite3.Connection,
    scheduled_at: str,
    duration_minutes: int,
    *,
    exclude_id: int | None = None,
) -> None:
    # Regra simples (global): não permite dois agendamentos "scheduled" com overlap.
    try:
        start = _parse_iso_datetime(scheduled_at)
    except Exception:
        raise HTTPException(status_code=400, detail="scheduled_at inválido")

    end = start + timedelta(minutes=int(duration_minutes))

    rows = conn.execute(
        """
        SELECT id, scheduled_at, duration_minutes
        FROM appointments
        WHERE status = 'scheduled'
        """
    ).fetchall()

    for r in rows:
        appt_id = int(r["id"])
        if exclude_id is not None and appt_id == exclude_id:
            continue

        try:
            other_start = _parse_iso_datetime(str(r["scheduled_at"]))
        except Exception:
            continue
        other_end = other_start + timedelta(minutes=int(r["duration_minutes"]))

        if start < other_end and other_start < end:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Conflito de horário: já existe agendamento "
                    f"#{appt_id} em {other_start.isoformat()}"
                ),
            )


@app.get(f"{API_PREFIX}/appointments", response_model=list[Appointment])
def list_appointments_api(
    from_ts: str | None = Query(default=None, alias="from"),
    to_ts: str | None = Query(default=None, alias="to"),
    status: AppointmentStatus | None = Query(default=None),
    customer_id: int | None = Query(default=None),
    vehicle_id: int | None = Query(default=None),
    only_unreminded: bool = Query(default=False),
    _: UserPublic = Depends(_require_user),
) -> list[Appointment]:
    with _connect() as conn:
        sql = (
            "SELECT id, customer_id, vehicle_id, service_order_id, title, notes, status, "
            "scheduled_at, duration_minutes, reminded_at "
            "FROM appointments"
        )
        where: list[str] = []
        params: list[object] = []

        if status is not None:
            where.append("status = ?")
            params.append(status)
        if customer_id is not None:
            where.append("customer_id = ?")
            params.append(customer_id)
        if vehicle_id is not None:
            where.append("vehicle_id = ?")
            params.append(vehicle_id)
        if from_ts is not None:
            where.append("scheduled_at >= ?")
            params.append(from_ts)
        if to_ts is not None:
            where.append("scheduled_at <= ?")
            params.append(to_ts)
        if only_unreminded:
            where.append("reminded_at IS NULL")

        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY scheduled_at ASC"

        rows = conn.execute(sql, tuple(params)).fetchall()
    return [_row_to_appointment(r) for r in rows]


@app.post(f"{API_PREFIX}/appointments", response_model=Appointment)
def create_appointment_api(
    payload: AppointmentCreate,
    _: UserPublic = Depends(_require_user),
) -> Appointment:
    created_at = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        customer = conn.execute(
            "SELECT id FROM customers WHERE id = ?",
            (payload.customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente não encontrado")

        if payload.vehicle_id is not None:
            vehicle = conn.execute(
                "SELECT id, customer_id FROM vehicles WHERE id = ?",
                (payload.vehicle_id,),
            ).fetchone()
            if vehicle is None:
                raise HTTPException(status_code=404, detail="Veículo não encontrado")
            if int(vehicle["customer_id"]) != payload.customer_id:
                raise HTTPException(status_code=400, detail="Veículo não pertence ao cliente")

        if payload.service_order_id is not None:
            so = conn.execute(
                "SELECT id FROM service_orders WHERE id = ?",
                (payload.service_order_id,),
            ).fetchone()
            if so is None:
                raise HTTPException(status_code=404, detail="Ordem de serviço não encontrada")

        _check_appointment_conflict(conn, payload.scheduled_at, int(payload.duration_minutes))

        cur = conn.execute(
            """
            INSERT INTO appointments (
              customer_id, vehicle_id, service_order_id,
              title, notes, status,
              scheduled_at, duration_minutes, reminded_at, created_at
            )
            VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, NULL, ?)
            """,
            (
                payload.customer_id,
                payload.vehicle_id,
                payload.service_order_id,
                payload.title,
                payload.notes,
                payload.scheduled_at,
                int(payload.duration_minutes),
                created_at,
            ),
        )
        appt_id = int(cur.lastrowid)
        row = conn.execute(
            """
            SELECT id, customer_id, vehicle_id, service_order_id, title, notes, status,
                   scheduled_at, duration_minutes, reminded_at
            FROM appointments
            WHERE id = ?
            """,
            (appt_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao criar agendamento")
    return _row_to_appointment(row)


@app.patch(f"{API_PREFIX}/appointments/{{appointment_id}}", response_model=Appointment)
def update_appointment_api(
    appointment_id: int,
    payload: AppointmentUpdate,
    _: UserPublic = Depends(_require_user),
) -> Appointment:
    if not payload.model_fields_set:
        raise HTTPException(status_code=400, detail="Nada para atualizar")

    with _connect() as conn:
        existing = conn.execute(
            """
            SELECT id, customer_id, vehicle_id, service_order_id, title, notes, status,
                   scheduled_at, duration_minutes, reminded_at
            FROM appointments
            WHERE id = ?
            """,
            (appointment_id,),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Agendamento não encontrado")

        new_customer_id = (
            int(payload.customer_id)
            if "customer_id" in payload.model_fields_set
            else int(existing["customer_id"])
        )

        customer = conn.execute(
            "SELECT id FROM customers WHERE id = ?",
            (new_customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente não encontrado")

        new_vehicle_id = (
            payload.vehicle_id
            if "vehicle_id" in payload.model_fields_set
            else existing["vehicle_id"]
        )
        if new_vehicle_id is not None:
            vehicle = conn.execute(
                "SELECT id, customer_id FROM vehicles WHERE id = ?",
                (int(new_vehicle_id),),
            ).fetchone()
            if vehicle is None:
                raise HTTPException(status_code=404, detail="Veículo não encontrado")
            if int(vehicle["customer_id"]) != new_customer_id:
                raise HTTPException(status_code=400, detail="Veículo não pertence ao cliente")

        new_so_id = (
            payload.service_order_id
            if "service_order_id" in payload.model_fields_set
            else existing["service_order_id"]
        )
        if new_so_id is not None:
            so = conn.execute(
                "SELECT id FROM service_orders WHERE id = ?",
                (int(new_so_id),),
            ).fetchone()
            if so is None:
                raise HTTPException(status_code=404, detail="Ordem de serviço não encontrada")

        new_title = payload.title if "title" in payload.model_fields_set else str(existing["title"])
        new_notes = payload.notes if "notes" in payload.model_fields_set else existing["notes"]
        new_status = payload.status if "status" in payload.model_fields_set else existing["status"]
        new_scheduled_at = (
            payload.scheduled_at
            if "scheduled_at" in payload.model_fields_set
            else str(existing["scheduled_at"])
        )
        new_duration = (
            int(payload.duration_minutes)
            if "duration_minutes" in payload.model_fields_set
            else int(existing["duration_minutes"])
        )
        new_reminded_at = (
            payload.reminded_at
            if "reminded_at" in payload.model_fields_set
            else existing["reminded_at"]
        )

        # Conflito só importa se continuar/virar scheduled.
        if str(new_status) == "scheduled":
            _check_appointment_conflict(
                conn,
                new_scheduled_at,
                new_duration,
                exclude_id=appointment_id,
            )

        conn.execute(
            """
            UPDATE appointments
            SET customer_id = ?, vehicle_id = ?, service_order_id = ?, title = ?, notes = ?,
                status = ?,
                scheduled_at = ?, duration_minutes = ?, reminded_at = ?
            WHERE id = ?
            """,
            (
                new_customer_id,
                new_vehicle_id,
                new_so_id,
                new_title,
                new_notes,
                new_status,
                new_scheduled_at,
                new_duration,
                new_reminded_at,
                appointment_id,
            ),
        )

        row = conn.execute(
            """
            SELECT id, customer_id, vehicle_id, service_order_id, title, notes, status,
                   scheduled_at, duration_minutes, reminded_at
            FROM appointments
            WHERE id = ?
            """,
            (appointment_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Falha ao atualizar agendamento")
    return _row_to_appointment(row)


@app.delete(f"{API_PREFIX}/appointments/{{appointment_id}}")
def delete_appointment_api(appointment_id: int, _: UserPublic = Depends(_require_user)) -> dict:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM appointments WHERE id = ?", (appointment_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Agendamento não encontrado")
    return {"ok": True}


@app.get(f"{API_PREFIX}/appointments/reminders", response_model=list[Appointment])
def reminders_api(
    within_minutes: int = Query(default=15, ge=1, le=24 * 60),
    _: UserPublic = Depends(_require_user),
) -> list[Appointment]:
    now = datetime.now(timezone.utc)
    to = (now + timedelta(minutes=within_minutes)).isoformat()
    from_ts = now.isoformat()

    with _connect() as conn:
        rows = conn.execute(
            """
                        SELECT id, customer_id, vehicle_id, service_order_id, title, notes, status,
                                     scheduled_at, duration_minutes, reminded_at
            FROM appointments
            WHERE status = 'scheduled'
              AND reminded_at IS NULL
              AND scheduled_at >= ?
              AND scheduled_at <= ?
            ORDER BY scheduled_at ASC
            """,
            (from_ts, to),
        ).fetchall()
    return [_row_to_appointment(r) for r in rows]


@app.post(f"{API_PREFIX}/appointments/{{appointment_id}}/mark-reminded")
def mark_reminded_api(appointment_id: int, _: UserPublic = Depends(_require_user)) -> dict:
    ts = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE appointments SET reminded_at = ? WHERE id = ?",
            (ts, appointment_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Agendamento não encontrado")
    return {"ok": True}
