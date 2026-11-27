import { randomBytes, createHash } from 'node:crypto';
import { withDb } from './db.js';

export const SESSION_MS = 10 * 60 * 1000;
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const publicUser = (u) => ({ id: Number(u.id), account: Number(u.account), username: u.username, group: u.group_label ?? null, supervisor: u.supervisor === true, mustChangePassword: u.must_change_password === true });
export async function issueSession(user, connection = null) {
  const token = randomBytes(32).toString('base64url');
  const insert = c => c.query('INSERT INTO public.app_sessions(token_hash,user_id,last_active_at) VALUES($1,$2,NOW())', [tokenHash(token), user.id]);
  if (connection) await insert(connection); else await withDb(insert);
  return { ...publicUser(user), token };
}
export async function requireSession(req, res, next) {
  try {
    const token = req.get('Authorization')?.replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ message: '請重新登入' });
    const [user] = await withDb(c => c.query(`SELECT u.*, s.token_hash, s.created_at AS session_created_at FROM public.app_sessions s JOIN public.users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.last_active_at > NOW() - INTERVAL '10 minutes'`, [tokenHash(token)]));
    if (!user) return res.status(401).json({ message: '登入已逾時，請重新登入' });
    req.authUser = user;
    next();
  } catch (error) { next(error); }
}
