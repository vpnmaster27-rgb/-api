import { createHash } from 'node:crypto';
import { Router } from 'express';
import { withDb } from '../db.js';
import { taipeiDateKey, taskStartDateKey, taskDeadlineAt } from '../taskDates.js';

export const tasksRouter = Router();

const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64 && !id.includes('\0');
const validTask = (task) => task && typeof task === 'object' && !Array.isArray(task)
  && validId(String(task.id ?? ''));

/** 表單內容僅供 App 當次填寫，不送回或保存到後端。 */
function withoutFormData(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
  const { formData: _formData, ...savedTask } = task;
  return { ...savedTask, dueAt: taskDeadlineAt(savedTask) };
}

async function readTasks(conn) {
  const rows = await conn.query('SELECT payload FROM public.work_orders ORDER BY updated_at DESC');
  return (rows ?? []).flatMap((row) => {
    try {
      const task = JSON.parse(String(row.payload ?? ''));
      return validTask(task) ? [withoutFormData(task)] : [];
    } catch {
      return [];
    }
  });
}

async function upsertTask(conn, task) {
  const savedTask = withoutFormData(task);
  const updated = await conn.query(
    `INSERT INTO public.work_orders (id, payload, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
     SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
     WHERE COALESCE((public.work_orders.payload::jsonb->>'transferredAt')::bigint, 0)
       <= COALESCE((EXCLUDED.payload::jsonb->>'transferredAt')::bigint, 0)
     RETURNING id`,
    [String(savedTask.id), JSON.stringify(savedTask), Date.now()],
  );
  if (!updated.length) {
    const error = new Error('任務已轉移，請重新整理後再操作');
    error.status = 409;
    throw error;
  }
  return savedTask;
}

function markForToday(task) {
  const today = taipeiDateKey();
  return taskStartDateKey(task) === today && task.mobileDispatchDate !== today
    ? { ...task, mobileDispatchDate: today }
    : task;
}

function completedRetentionHours() {
  const configured = Number(process.env.APP_COMPLETED_TASK_RETENTION_HOURS ?? 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

function isVisibleInApp(task, now = Date.now()) {
  if (!task.mobileDispatchDate) return false;
  const completed = task.status === 'done' || task.mobileStatus === 'done';
  const retentionHours = completedRetentionHours();
  if (!completed || retentionHours === 0) return true;
  const completedAt = Number(task.completedAt);
  // Older completed records without a timestamp remain visible because their age is unknown.
  return !Number.isFinite(completedAt) || completedAt <= 0 || now < completedAt + retentionHours * 60 * 60 * 1000;
}

function isOverdueForApp(task, now = Date.now()) {
  const dueAt = taskDeadlineAt(task);
  const status = task.status === 'done'
    ? 'done'
    : (task.mobileStatus || (() => {
      if (!task.technicianId && task.status === 'pending') return 'unassigned';
      if (task.status === 'parts') return 'waiting_upload';
      return 'todo';
    })());
  return dueAt > 0 && dueAt < now && status !== 'done' && status !== 'unassigned';
}

tasksRouter.get('/tasks', async (_req, res, next) => {
  try {
    const tasks = await withDb(readTasks);
    res.set('Cache-Control', 'no-store');
    res.json({ tasks, count: tasks.length });
  } catch (err) { next(err); }
});

tasksRouter.get('/tasks/app', async (req, res, next) => {
  try {
    const today = taipeiDateKey();
    const tasks = await withDb(readTasks);
    // Keep missed/older unfinished work orders visible as overdue. The daily
    // dispatch marker still controls normal tasks, while supervisors can review
    // every overdue task even if it was created before the daily App dispatch.
    const appTasks = tasks.filter((task) => (
      (task.mobileDispatchDate && task.mobileDispatchDate <= today && isVisibleInApp(task))
      || isOverdueForApp(task)
    ));
    const response = JSON.stringify({
      tasks: appTasks,
      count: appTasks.length,
      date: today,
      timeZone: 'Asia/Taipei',
      completedRetentionHours: completedRetentionHours(),
    });
    const etag = `"${createHash('sha256').update(response).digest('base64url')}"`;
    res.set({ 'Cache-Control': 'no-store', ETag: etag });
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.type('json').send(response);
  } catch (err) { next(err); }
});

/** Web's one-time localStorage migration. The first complete dataset wins. */
tasksRouter.post('/tasks/initialize', async (req, res, next) => {
  try {
    const tasks = req.body?.tasks;
    if (!Array.isArray(tasks) || tasks.length > 10000 || !tasks.every(validTask)) {
      return res.status(400).json({ error: 'invalid_tasks', message: '任務資料格式不正確' });
    }
    const result = await withDb(async (conn) => {
      const current = await conn.query('SELECT COUNT(*)::int AS task_count FROM public.work_orders');
      let imported = 0;
      for (const originalTask of tasks) {
        const task = markForToday(originalTask);
        const exists = await conn.query('SELECT id FROM public.work_orders WHERE id = $1', [String(task.id)]);
        if (exists.length) continue;
        await upsertTask(conn, task);
        imported += 1;
      }
      return { initialized: Number(current?.[0]?.task_count ?? 0) === 0, imported };
    });
    res.status(result.imported ? 201 : 200).json(result);
  } catch (err) { next(err); }
});

tasksRouter.post('/tasks/sync', async (req, res, next) => {
  try {
    const tasks = req.body?.tasks ?? [];
    const deletedIds = req.body?.deletedIds ?? [];
    if (!Array.isArray(tasks) || tasks.length > 10000 || !tasks.every(validTask)
      || !Array.isArray(deletedIds) || deletedIds.length > 10000 || !deletedIds.every(validId)) {
      return res.status(400).json({ error: 'invalid_tasks', message: '任務資料格式不正確' });
    }
    await withDb(async (conn) => {
      for (const task of tasks) await upsertTask(conn, markForToday(task));
      for (const id of deletedIds) await conn.query('DELETE FROM public.work_orders WHERE id = $1', [id]);
    });
    res.json({ saved: tasks.length, deleted: deletedIds.length });
  } catch (err) { next(err); }
});

tasksRouter.post('/tasks/:id/transfer', async (req, res, next) => {
  try {
    if (!validId(req.params.id) || !Number.isInteger(Number(req.body?.account))) {
      return res.status(400).json({ message: '請選擇有效的處理人' });
    }
    const result = await withDb(async (conn) => {
      const [person] = await conn.query('SELECT id, account, username FROM public.users WHERE account = $1', [Number(req.body.account)]);
      if (!person) return { status: 400, message: '找不到指定處理人' };
      const [row] = await conn.query('SELECT payload FROM public.work_orders WHERE id = $1', [req.params.id]);
      if (!row) return { status: 404, message: '找不到此工單' };
      const previous = JSON.parse(row.payload);
      const time = Date.now();
      const from = previous.assignedTo || previous.technicianName || '未分派';
      const actor = String(req.body.actor || 'Web 管理者').slice(0, 100);
      const task = withoutFormData({ ...previous,
        technicianId: Number(person.id), technicianName: person.username,
        assignedTo: person.username, assignedToId: Number(person.account), assignedAccount: Number(person.account),
        assignedBy: actor, transferredAt: time, transferredFrom: from,
        status: 'progress', mobileStatus: 'todo', completedAt: null, companions: [],
        mobileDispatchDate: previous.mobileDispatchDate || taipeiDateKey(),
        timeline: [...(previous.timeline || []), { time, text: `任務轉移：${from} → ${person.username}（操作人：${actor}）` }],
      });
      const updated = await conn.query('UPDATE public.work_orders SET payload = $1, updated_at = $2 WHERE id = $3 AND payload = $4 RETURNING id', [JSON.stringify(task), time, req.params.id, row.payload]);
      return updated.length ? { task } : { status: 409, message: '工單已更新，請重新整理後再轉移' };
    });
    if (result.status) return res.status(result.status).json({ message: result.message });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) { next(err); }
});

tasksRouter.put('/tasks/:id', async (req, res, next) => {
  try {
    const task = req.body && {
      ...req.body,
      technicianName: req.body.technicianName || req.body.assignedTo || '',
      ...(req.body.status === 'done' && !req.body.completedAt ? { completedAt: Date.now() } : {}),
    };
    if (!validId(req.params.id) || !validTask(task) || String(task.id) !== req.params.id) {
      return res.status(400).json({ error: 'invalid_task', message: '任務資料格式不正確' });
    }
    const dispatchedTask = withoutFormData(markForToday(task));
    await withDb((conn) => upsertTask(conn, dispatchedTask));
    res.set('Cache-Control', 'no-store');
    res.json({ task: dispatchedTask });
  } catch (err) { next(err); }
});
