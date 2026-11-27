import { withDispatchTransaction } from './db.js';
import { taipeiDateKey } from './taskDates.js';

const signature = t => [t.assignedAccount ?? t.assignedToId ?? t.technicianId ?? t.assignedTo ?? t.technicianName ?? '', t.mobileDispatchDate || '', t.transferredAt || '',t.mobileDispatchDate && t.mobileDispatchDate<=taipeiDateKey()?'ready':'future'].join('|');
const headers = () => ({ 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) });

// Durable notification events; delivery always rechecks the device's latest owner.
export async function queueUserNotification(conn, userId, title, body, taskId = null) {
  const [event] = await conn.query('INSERT INTO public.app_notifications(user_id,title,body,task_id) VALUES($1,$2,$3,$4) RETURNING id', [userId, title, body, taskId]);
  await conn.query(`INSERT INTO public.app_push_deliveries(notification_id,device_id,push_token)
    SELECT $1,device_id,push_token FROM public.app_devices WHERE last_user_id=$2 AND enabled AND push_token IS NOT NULL`, [event.id, userId]);
}

export async function runPushCycle() {
  await withDispatchTransaction(async conn => {
    const rows = await conn.query('SELECT id,payload FROM public.work_orders');
    const users = await conn.query('SELECT id,account,username FROM public.users');
    const state = new Map((await conn.query('SELECT task_id,signature FROM public.app_notification_state')).map(row=>[row.task_id,row.signature]));
    for (const row of rows) {
      let task;
      try { task = JSON.parse(row.payload); } catch { continue; }
      const sig = signature(task);
      if (state.get(row.id) === sig) continue;
      await conn.query('INSERT INTO public.app_notification_state(task_id,signature) VALUES($1,$2) ON CONFLICT(task_id) DO UPDATE SET signature=EXCLUDED.signature', [row.id,sig]);
      if (!task.mobileDispatchDate || task.mobileDispatchDate > taipeiDateKey() || task.status === 'done' || task.mobileStatus === 'done') continue;
      const account = task.assignedAccount ?? task.assignedToId;
      const person = account != null ? users.find(u => String(u.account) === String(account))
        : task.technicianId ? users.find(u => String(u.id) === String(task.technicianId))
          : users.find(u => u.username === (task.assignedTo || task.technicianName));
      if (person) await queueUserNotification(conn, person.id, '新任務通知', `${person.username}，您有新的指派任務：${task.title || '請查看任務清單'}`, row.id);
    }
    const deliveries = await conn.query(`SELECT p.*,n.user_id,n.title,n.body,n.task_id,d.last_user_id,d.enabled,d.push_token AS current_token
      FROM public.app_push_deliveries p JOIN public.app_notifications n ON n.id=p.notification_id
      JOIN public.app_devices d ON d.device_id=p.device_id
      WHERE p.state IN ('pending','ticket') AND p.next_attempt_at<=NOW() ORDER BY p.notification_id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`);
    for (const p of deliveries) {
      if (!p.enabled || p.user_id !== p.last_user_id || p.push_token !== p.current_token) {
        await conn.query("UPDATE public.app_push_deliveries SET state='cancelled' WHERE notification_id=$1 AND device_id=$2", [p.notification_id,p.device_id]);
        continue;
      }
      try {
        const receipt = p.state === 'ticket';
        const response = await fetch(`https://exp.host/--/api/v2/push/${receipt ? 'getReceipts' : 'send'}`, {
          method: 'POST', headers: headers(), signal: AbortSignal.timeout(5000),
          body: JSON.stringify(receipt ? { ids:[p.ticket_id] } : { to:p.push_token,title:p.title,body:p.body,sound:'default',channelId:'tasks',data:{ taskId:p.task_id,userId:p.user_id } }),
        });
        if (!response.ok) throw new Error(`Expo HTTP ${response.status}`);
        const result = await response.json();
        const item = receipt ? result.data?.[p.ticket_id] : result.data;
        if (receipt && !item) throw new Error('Receipt pending');
        if (item?.status === 'error') {
          if (item.details?.error === 'DeviceNotRegistered') await conn.query('UPDATE public.app_devices SET enabled=false WHERE device_id=$1 AND push_token=$2', [p.device_id,p.push_token]);
          throw new Error(item.details?.error || item.message);
        }
        if (item?.status !== 'ok' || (!receipt && !item.id)) throw new Error('Invalid Expo response');
        await conn.query(`UPDATE public.app_push_deliveries SET state=$1,ticket_id=$2,next_attempt_at=NOW()+INTERVAL '15 minutes',error=NULL WHERE notification_id=$3 AND device_id=$4`, [receipt?'sent':'ticket',receipt?p.ticket_id:item.id,p.notification_id,p.device_id]);
      } catch (error) {
        await conn.query(`UPDATE public.app_push_deliveries SET attempts=attempts+1,error=$1,state=CASE WHEN attempts>=7 THEN 'failed' ELSE state END,next_attempt_at=NOW()+INTERVAL '2 minutes' WHERE notification_id=$2 AND device_id=$3`, [String(error.message).slice(0,300),p.notification_id,p.device_id]);
      }
    }
  });
}

export function startPushNotifications() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runPushCycle(); } catch (error) { console.warn('[push]', error.message); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 30000);
  void tick();
  return () => clearInterval(timer);
}
