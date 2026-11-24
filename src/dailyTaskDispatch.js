import { withDb } from './db.js';
import { nextDailyDispatchAt, taipeiDateKey, taskStartDateKey, taipeiTimeIsPastDispatch } from './taskDates.js';

export async function dispatchTasksForDate(dateKey = taipeiDateKey()) {
  return withDb(async (conn) => {
    const rows = await conn.query('SELECT id, payload FROM public.work_orders');
    let dispatched = 0;
    for (const row of rows ?? []) {
      let task;
      try { task = JSON.parse(String(row.payload ?? '')); } catch { continue; }
      if (taskStartDateKey(task) !== dateKey || task.mobileDispatchDate === dateKey) continue;
      const updated = { ...task, mobileDispatchDate: dateKey };
      await conn.query(
        'UPDATE public.work_orders SET payload = $1, updated_at = $2 WHERE id = $3',
        [JSON.stringify(updated), Date.now(), String(row.id)],
      );
      dispatched += 1;
    }
    return dispatched;
  });
}

export function startDailyTaskDispatch() {
  let stopped = false;
  let timer = null;

  const run = async () => {
    if (stopped) return;
    if (taipeiTimeIsPastDispatch()) {
      try {
        const dateKey = taipeiDateKey();
        const count = await dispatchTasksForDate(dateKey);
        console.log(`[task-dispatch] ${dateKey} 已派送 ${count} 筆今日任務至 App`);
      } catch (error) {
        console.error('[task-dispatch] 今日任務派送失敗，1 分鐘後重試', error?.message || error);
        timer = setTimeout(run, 60 * 1000);
        return;
      }
    }
    if (stopped) return;
    timer = setTimeout(run, Math.max(1, nextDailyDispatchAt() - Date.now()));
  };

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
