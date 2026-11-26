import { rotationKey, remainingMembers, chooseRotation } from './taskRotation.js';
import { taskStartDateKey } from './taskDates.js';
import { createHash } from 'node:crypto';
import { isPresentForDispatch, applyAttendanceResult } from './dispatchAttendance.js';

export async function rotateScheduledTasks(conn, dateKey, dispatchToday = false, attendanceCheck = isPresentForDispatch) {
  const people = await conn.query('SELECT id, account, username FROM public.users WHERE supervisor = false ORDER BY id');
  if (!people.length) return 0;
  const rows = await conn.query('SELECT id, payload FROM public.work_orders FOR UPDATE');
  const tasks = rows.flatMap(row => { try { return [JSON.parse(row.payload)]; } catch { return []; } });
  const states = new Map((await conn.query('SELECT task_key, state FROM public.task_rotation_states')).map(r => [r.task_key, r.state]));
  const logs = new Map((await conn.query('SELECT work_order_id, assignment FROM public.task_auto_assignments')).map(r => [r.work_order_id, r.assignment]));
  const accounts = people.map(p => String(p.account));
  // Freeze an initial roster for every planned job, even if its first scheduled
  // occurrence is still in the future. A later newcomer waits for round two.
  for (const task of tasks) {
    const key = rotationKey(task);
    if (key && !states.has(key)) states.set(key, { round: 1, members: [...accounts], used: [] });
  }
  const hours = new Map();
  const daily = new Map();
  const dailyFor = date => { if (!daily.has(date)) daily.set(date, new Map()); return daily.get(date); };
  const occupy = (date, account, workHours) => {
    const id = String(account), h = Number(workHours) || 0;
    const counts = dailyFor(date);
    counts.set(id, (counts.get(id) || 0) + h);
    hours.set(id, (hours.get(id) || 0) + h);
  };
  const saveLog = async (task, assignment) => {
    await conn.query('INSERT INTO public.task_auto_assignments (work_order_id, task_key, assignment) VALUES ($1,$2,$3::jsonb) ON CONFLICT (work_order_id) DO NOTHING', [task.id, rotationKey(task), JSON.stringify(assignment)]);
    logs.set(task.id, assignment);
  };
  const ordered = tasks.slice().sort((a,b) => String(taskStartDateKey(a)).localeCompare(String(taskStartDateKey(b))) || (Number(b.hours)||0)-(Number(a.hours)||0) || String(a.id).localeCompare(String(b.id)));
  // Seed old, already dispatched jobs using the original automation timeline,
  // never the person selected later by a manual transfer.
  for (const task of ordered) {
    const key = rotationKey(task), date = taskStartDateKey(task);
    if (!key || !date || logs.has(task.id) || !(date < dateKey || (task.mobileDispatchDate && task.mobileDispatchDate <= dateKey))) continue;
    const originalName = task.timeline?.find(t => /依自動化規則排程，指派給/.test(t.text || ''))?.text?.split('：').at(-1)?.trim();
    const original = task.autoAssignment?.account
      ? people.find(p => String(p.account) === String(task.autoAssignment.account))
      : originalName ? people.find(p => p.username === originalName)
        : !task.transferredAt && !task.assignedBy ? people.find(p => String(p.id) === String(task.technicianId)) : null;
    // Unknown legacy assignees remain uncounted instead of counting a transferee.
    const state = states.get(key) || {};
    remainingMembers(state, accounts);
    if (original && !state.used.includes(String(original.account))) state.used.push(String(original.account));
    states.set(key, state);
    await saveLog(task, { account: original ? Number(original.account) : null, round: state.round, date, legacy: true });
  }
  for (const task of tasks) {
    const date = taskStartDateKey(task), logged = logs.get(task.id);
    if (logged?.account) occupy(date, logged.account, task.hours);
    else if (!rotationKey(task)) {
      const person = people.find(p => String(p.id) === String(task.technicianId) || p.username === task.technicianId);
      if (person) occupy(date, person.account, task.hours);
    }
  }
  // Persist only actual assignments. Future plans are previews and do not consume rounds.
  let count = 0;
  let persisted = false;
  const persistStates = async () => {
    for (const [key,state] of states) await conn.query('INSERT INTO public.task_rotation_states (task_key,state) VALUES ($1,$2::jsonb) ON CONFLICT (task_key) DO UPDATE SET state=EXCLUDED.state', [key,JSON.stringify(state)]);
    persisted = true;
  };
  for (const task of ordered) {
    const date = taskStartDateKey(task), key = rotationKey(task);
    if (!key || !date || date < dateKey || logs.has(task.id) || task.status === 'done') continue;
    const actual = dispatchToday && date === dateKey;
    if (!actual && !persisted) await persistStates();
    const state = states.get(key) || {};
    let nonce = 0;
    const random = () => createHash('sha256').update(`${task.id}:${state.round || 1}:${nonce++}`).digest().readUInt32BE(0) / 4294967296;
    const person = chooseRotation(state, people, dailyFor(date), hours, random);
    if (!person) continue;
    states.set(key,state);
    occupy(date,person.account,task.hours);
    const assignment = { account: Number(person.account), username: person.username, round: state.round, date, members: [...state.members], preview: !actual };
    let next = { ...task, autoAssignment: assignment };
    if (!task.transferredAt && !task.assignedBy) Object.assign(next, {
      technicianId: Number(person.id), technicianName: person.username, assignedTo: person.username,
      assignedToId: Number(person.account), assignedAccount: Number(person.account),
    });
    if (actual) {
      next = applyAttendanceResult(next, await attendanceCheck(conn, person.account, dateKey));
      await saveLog(task,assignment);
      next.mobileDispatchDate = dateKey;
      next.timeline = [...(task.timeline || []), { time: Date.now(), text: `自動輪派第 ${state.round} 輪：${person.username}` }];
      count++;
    }
    if (JSON.stringify(next) !== JSON.stringify(task)) {
      await conn.query('UPDATE public.work_orders SET payload=$1,updated_at=$2 WHERE id=$3', [JSON.stringify(next),Date.now(),task.id]);
    }
  }
  if (!persisted) await persistStates();
  return count;
}
