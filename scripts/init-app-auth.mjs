import { pool, shutdown } from '../src/db.js';

// Idempotent: existing users are marked once, never reset on a later deployment.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT true;
    CREATE TABLE IF NOT EXISTS public.app_sessions (
      token_hash text PRIMARY KEY, user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      last_active_at timestamptz NOT NULL DEFAULT NOW(), created_at timestamptz NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS public.app_devices (
      device_id uuid PRIMARY KEY, last_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      push_token text, enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT NOW(), binding_session_at timestamptz NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS app_devices_push_token ON public.app_devices(push_token) WHERE push_token IS NOT NULL;
    CREATE TABLE IF NOT EXISTS public.app_notification_state (task_id text PRIMARY KEY, signature text NOT NULL);
    CREATE TABLE IF NOT EXISTS public.app_notifications (
      id bigserial PRIMARY KEY, user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      task_id text, title text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS public.app_push_deliveries (
      notification_id bigint REFERENCES public.app_notifications(id) ON DELETE CASCADE,
      device_id uuid REFERENCES public.app_devices(device_id) ON DELETE CASCADE,
      push_token text NOT NULL, attempts integer NOT NULL DEFAULT 0, ticket_id text,
      state text NOT NULL DEFAULT 'pending', next_attempt_at timestamptz NOT NULL DEFAULT NOW(), error text,
      PRIMARY KEY(notification_id,device_id));
    ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.app_devices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.app_notification_state ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.app_push_deliveries ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.app_sessions, public.app_devices, public.app_notification_state, public.app_notifications, public.app_push_deliveries FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE public.app_notifications_id_seq FROM anon, authenticated;`);
  // Imported user IDs can leave the serial counter behind existing rows.
  await client.query('LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE');
  await client.query(`SELECT setval(pg_get_serial_sequence('public.users','id'),
    GREATEST(COALESCE((SELECT MAX(id) FROM public.users),1),nextval(pg_get_serial_sequence('public.users','id'))),true)`);
  // Baseline existing orders once; installing notifications must not replay old work.
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const existing = await client.query('SELECT id,payload FROM public.work_orders');
  for (const row of existing.rows) {
    let t; try { t=JSON.parse(row.payload); } catch { continue; }
    const ready=Boolean(t.mobileDispatchDate && t.mobileDispatchDate<=today);
    const sig=[t.assignedAccount ?? t.assignedToId ?? t.technicianId ?? t.assignedTo ?? t.technicianName ?? '',t.mobileDispatchDate || '',t.transferredAt || '',ready?'ready':'future'].join('|');
    await client.query('INSERT INTO public.app_notification_state(task_id,signature) VALUES($1,$2) ON CONFLICT DO NOTHING',[row.id,sig]);
  }
  await client.query('COMMIT');
  const result = await client.query('SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE must_change_password)::int AS pending FROM public.users');
  console.log('App auth schema ready:', result.rows[0]);
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Schema setup failed:', error.message);
  process.exitCode = 1;
} finally { client.release(); await shutdown(); }
