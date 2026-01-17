import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


DB_PATH = Path(os.getenv("TLX_ADS_DB_PATH", str(Path(__file__).resolve().parent / "data.sqlite3")))


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _connect() -> sqlite3.Connection:
    # check_same_thread=False para permitir uso em apps web (FastAPI/uvicorn) com múltiplas threads.
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row

    # Pragmas básicos
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")

    # Melhorias de concorrência/performance em SQLite (seguras para dev/prod pequeno)
    try:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
    except Exception:
        # Alguns ambientes podem não suportar WAL (ex.: FS restrito). Segue no padrão.
        pass

    return conn


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    ts = now_iso()
    with get_db() as db:
        def _ensure_column(table: str, column: str, ddl: str) -> None:
            try:
                cols = [r["name"] for r in db.execute(f"PRAGMA table_info({table})").fetchall()]
                if column not in cols:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            except Exception:
                # se algo der errado, não quebra o startup (MVP)
                pass

        # Núcleo multi-tenant
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS tenants (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              slug TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS memberships (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              role TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(tenant_id, user_id),
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )

        # Conteúdo
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS templates (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              body TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS ads (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              owner_user_id INTEGER NOT NULL,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              rendered_body TEXT,
              target_url TEXT,
              channel TEXT NOT NULL,
              target TEXT,
              campaign_id INTEGER,
              template_id INTEGER,
              variables_json TEXT,
              status TEXT NOT NULL DEFAULT 'draft',
              scheduled_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
              FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
              FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
              FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS short_links (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              ad_id INTEGER,
              slug TEXT NOT NULL,
              destination_url TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(tenant_id, slug),
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
              FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE SET NULL
            );
            """
        )

        # Métricas + auditoria
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS metric_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              ad_id INTEGER,
              link_id INTEGER,
              event_type TEXT NOT NULL, -- impression|click|conversion
              value INTEGER NOT NULL DEFAULT 1,
              meta_json TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
              FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE SET NULL,
              FOREIGN KEY (link_id) REFERENCES short_links(id) ON DELETE SET NULL
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              actor_user_id INTEGER,
              action TEXT NOT NULL,
              entity TEXT NOT NULL,
              entity_id TEXT,
              meta_json TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        # Convites e reset de senha (tokens)
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS invite_tokens (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              email TEXT NOT NULL,
              role TEXT NOT NULL,
              token TEXT NOT NULL UNIQUE,
              expires_at TEXT NOT NULL,
              used_at TEXT,
              meta_json TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              token TEXT NOT NULL UNIQUE,
              expires_at TEXT NOT NULL,
              used_at TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )

        # Entregas (simuladas) de anúncios
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS ad_deliveries (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ad_id INTEGER NOT NULL,
              delivered_at TEXT NOT NULL,
              result TEXT NOT NULL, -- "ok" | "fail"
              details TEXT,
              FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
            );
            """
        )

        # SaaS (núcleo vendável): planos + uso/quotas
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS tenant_plans (
              tenant_id INTEGER PRIMARY KEY,
              plan TEXT NOT NULL,              -- free|pro|business|enterprise
              status TEXT NOT NULL,            -- active|trialing|past_due|canceled
              trial_ends_at TEXT,
              current_period_end TEXT,
              stripe_customer_id TEXT,
              stripe_subscription_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS stripe_events (
              id TEXT PRIMARY KEY,
              type TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            """
        )
        _ensure_column("tenant_plans", "stripe_customer_id", "TEXT")
        _ensure_column("tenant_plans", "stripe_subscription_id", "TEXT")

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS tenant_usage_daily (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              day TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
              sends_total INTEGER NOT NULL DEFAULT 0,
              sends_whatsapp INTEGER NOT NULL DEFAULT 0,
              sends_x INTEGER NOT NULL DEFAULT 0,
              sends_email INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(tenant_id, day),
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS tenant_usage_monthly (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              month TEXT NOT NULL,             -- YYYY-MM (UTC)
              ads_created INTEGER NOT NULL DEFAULT 0,
              templates_created INTEGER NOT NULL DEFAULT 0,
              links_created INTEGER NOT NULL DEFAULT 0,
              invites_created INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(tenant_id, month),
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        # Migração leve: adiciona coluna em DBs antigos
        _ensure_column("tenant_usage_monthly", "invites_created", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column("ads", "campaign_id", "INTEGER")

        # Campanhas/CRM básico
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS campaigns (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              objective TEXT,
              status TEXT NOT NULL DEFAULT 'active',
              start_at TEXT,
              end_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS contacts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              name TEXT,
              email TEXT,
              phone TEXT,
              consent_at TEXT,
              meta_json TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(tenant_id, email),
              UNIQUE(tenant_id, phone),
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS segments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(tenant_id, name),
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            """
        )

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS segment_members (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              segment_id INTEGER NOT NULL,
              contact_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(segment_id, contact_id),
              FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE CASCADE,
              FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            );
            """
        )

        # Fila de envios com retries e DLQ (status=failed)
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS deliveries (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              tenant_id INTEGER NOT NULL,
              campaign_id INTEGER,
              channel TEXT NOT NULL,
              to_addr TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              status TEXT NOT NULL,            -- queued|sending|sent|retrying|failed
              attempts INTEGER NOT NULL DEFAULT 0,
              max_attempts INTEGER NOT NULL DEFAULT 5,
              next_attempt_at TEXT,
              last_error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(tenant_id, idempotency_key),
              FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
              FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
            );
            """
        )

        # Default tenant (necessário para login/register sem tenant_slug)
        db.execute(
            "INSERT OR IGNORE INTO tenants (name, slug, created_at) VALUES (?, ?, ?)",
            ("Default", "default", ts),
        )

        # Índices
        db.execute("CREATE INDEX IF NOT EXISTS idx_ads_owner ON ads(owner_user_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_ads_tenant ON ads(tenant_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_ads_owner_status ON ads(owner_user_id, status);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_ads_tenant_status ON ads(tenant_id, status);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_ads_campaign ON ads(tenant_id, campaign_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_deliveries_ad ON ad_deliveries(ad_id);")

        db.execute("CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant_id, id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_links_tenant_slug ON short_links(tenant_id, slug);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_metric_tenant_type ON metric_events(tenant_id, event_type);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_metric_tenant_day ON metric_events(tenant_id, created_at);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);")

        db.execute("CREATE INDEX IF NOT EXISTS idx_tplan_tenant ON tenant_plans(tenant_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_usage_day ON tenant_usage_daily(tenant_id, day);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_usage_month ON tenant_usage_monthly(tenant_id, month);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id, id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_segments_tenant ON segments(tenant_id, id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_segment_members ON segment_members(segment_id, contact_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_deliveries_queue ON deliveries(tenant_id, status, next_attempt_at, id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_deliveries_tenant_created ON deliveries(tenant_id, created_at);")

        db.execute("CREATE INDEX IF NOT EXISTS idx_invite_tenant_email ON invite_tokens(tenant_id, email);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_invite_token ON invite_tokens(token);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_reset_token ON password_reset_tokens(token);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens(user_id);")
