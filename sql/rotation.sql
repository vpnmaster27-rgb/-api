CREATE TABLE IF NOT EXISTS public.task_rotation_states (
  task_key TEXT PRIMARY KEY,
  state JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS public.task_auto_assignments (
  work_order_id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  assignment JSONB NOT NULL
);
ALTER TABLE public.task_rotation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_auto_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.task_rotation_states, public.task_auto_assignments FROM anon, authenticated, service_role;
