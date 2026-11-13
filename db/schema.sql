-- acceptance schema (NAS Postgres 16 / 库 kexlabs_acceptance)
-- 应用方式（必须用 kexlabs_web 身份，保证对象 owner 正确）：
--   set -a; . .../acceptance-web/secrets/pg.env; set +a
--   psql -v ON_ERROR_STOP=1 -f schema.sql
-- 幂等：可重复执行。

CREATE SCHEMA IF NOT EXISTS acceptance;

-- 原始数据快照（JSON 原文 + 内容哈希，按 (kind, sha256) 去重）
CREATE TABLE IF NOT EXISTS acceptance.snapshots (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  sha256 text NOT NULL,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, sha256)
);

-- 任务看板（T-xxx / 里程碑之外的执行项）
CREATE TABLE IF NOT EXISTS acceptance.tasks (
  id text PRIMARY KEY,
  title text,
  owner text,
  rail text,
  status text,
  start_ts timestamptz,
  end_ts timestamptz,
  progress int,
  depends_on text[] NOT NULL DEFAULT '{}',
  blocked_by text,
  evidence text,
  estimated boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acceptance.milestones (
  id text PRIMARY KEY,
  name text,
  at_ts timestamptz,
  state text,
  detail text,
  payload jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 验收视频 job（S0/S1 …）
CREATE TABLE IF NOT EXISTS acceptance.jobs (
  id text PRIMARY KEY,
  track text,
  task_id text,
  title text,
  status text,
  status_label text,
  passed int,
  total int,
  judged int,
  duration_s numeric,
  fps numeric,
  width int,
  height int,
  frames int,
  source_start numeric,
  has_qc boolean,
  summary jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acceptance.job_criteria (
  job_id text NOT NULL REFERENCES acceptance.jobs (id) ON DELETE CASCADE,
  key text NOT NULL,
  name text,
  value text,
  threshold text,
  pass boolean,
  detail text,
  source text,
  PRIMARY KEY (job_id, key)
);

CREATE TABLE IF NOT EXISTS acceptance.job_metrics (
  job_id text NOT NULL REFERENCES acceptance.jobs (id),
  metric text NOT NULL,
  series jsonb,
  stats jsonb,
  PRIMARY KEY (job_id, metric)
);

CREATE TABLE IF NOT EXISTS acceptance.artifacts (
  id bigserial PRIMARY KEY,
  job_id text,
  kind text NOT NULL,
  path text NOT NULL,
  size_bytes bigint,
  sha256 text,
  mtime timestamptz,
  UNIQUE (job_id, kind, path)
);

CREATE TABLE IF NOT EXISTS acceptance.events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  type text,
  actor text,
  entity text,
  payload jsonb
);

CREATE TABLE IF NOT EXISTS acceptance.sync_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz,
  finished_at timestamptz,
  source text,
  stats jsonb,
  ok boolean
);

CREATE INDEX IF NOT EXISTS tasks_status_start_ts_idx ON acceptance.tasks (status, start_ts);
CREATE INDEX IF NOT EXISTS jobs_track_status_idx ON acceptance.jobs (track, status);
CREATE INDEX IF NOT EXISTS events_at_desc_idx ON acceptance.events (at DESC);
CREATE INDEX IF NOT EXISTS artifacts_job_id_idx ON acceptance.artifacts (job_id);
