-- Postgres RLS (Row Level Security) — guia de migração futura
-- TLXAUTO (plataforma de anúncios)
--
-- Ideia:
-- 1) Habilitar RLS em tabelas com tenant_id
-- 2) Criar policy: tenant_id = current_setting('app.tenant_id', true)::int
-- 3) No começo de cada request, executar: SET LOCAL app.tenant_id = '<id>'
--
-- Obs: este repo hoje roda SQLite (sem SQLAlchemy). Este arquivo é um "upgrade path".

-- habilitar RLS
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_tokens ENABLE ROW LEVEL SECURITY;

-- opcional: força até o owner respeitar
-- ALTER TABLE ads FORCE ROW LEVEL SECURITY;

-- policies
CREATE POLICY tenant_isolation_ads
ON ads
USING (tenant_id = current_setting('app.tenant_id', true)::int);

CREATE POLICY tenant_isolation_templates
ON templates
USING (tenant_id = current_setting('app.tenant_id', true)::int);

CREATE POLICY tenant_isolation_memberships
ON memberships
USING (tenant_id = current_setting('app.tenant_id', true)::int);

CREATE POLICY tenant_isolation_short_links
ON short_links
USING (tenant_id = current_setting('app.tenant_id', true)::int);

CREATE POLICY tenant_isolation_metric_events
ON metric_events
USING (tenant_id = current_setting('app.tenant_id', true)::int);

CREATE POLICY tenant_isolation_audit_logs
ON audit_logs
USING (tenant_id = current_setting('app.tenant_id', true)::int);

CREATE POLICY tenant_isolation_invite_tokens
ON invite_tokens
USING (tenant_id = current_setting('app.tenant_id', true)::int);
