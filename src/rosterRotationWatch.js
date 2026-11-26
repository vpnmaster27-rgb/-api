import { createHash } from 'node:crypto';
import { rotateScheduledTasks } from './rotationDispatch.js';
import { taipeiDateKey } from './taskDates.js';

// This key cannot collide with job keys, which are JSON arrays.
const ROSTER_KEY = '__eligible_roster_signature__';

export async function refreshRosterAssignments(transaction) {
  const execute = transaction || (await import('./db.js')).withDispatchTransaction;
  return execute(async conn => {
    const people = await conn.query('SELECT id, account, username FROM public.users WHERE supervisor = false ORDER BY id');
    const signature = createHash('sha256').update(JSON.stringify(people)).digest('hex');
    const [previous] = await conn.query('SELECT state FROM public.task_rotation_states WHERE task_key=$1', [ROSTER_KEY]);
    if (previous?.state?.signature === signature) return false;
    // Rebuild only previews. Actual dispatch logs and manually transferred tasks
    // remain authoritative. Each task retains its own frozen round membership.
    await rotateScheduledTasks(conn, taipeiDateKey(), false);
    await conn.query('INSERT INTO public.task_rotation_states (task_key,state) VALUES ($1,$2::jsonb) ON CONFLICT (task_key) DO UPDATE SET state=EXCLUDED.state', [ROSTER_KEY,JSON.stringify({ signature })]);
    return true;
  });
}

export function startRosterRotationWatch() {
  let stopped = false, timer;
  const run = async () => {
    try {
      if (await refreshRosterAssignments()) console.log('[task-rotation] 人員名冊變更，已重算未派送任務；新人從各任務下一輪加入');
    } catch (error) { console.error('[task-rotation] 名冊偵測失敗，30 秒後重試', error?.message); }
    if (!stopped) timer = setTimeout(run, 30000);
  };
  void run();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
