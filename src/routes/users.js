import { Router } from 'express';
import { withDb } from '../db.js';
import { serverClock } from '../serverClock.js';

export const usersRouter = Router();

/**
 * GET /api/users
 *
 * 技師名冊的資料來源：Supabase public.users.username 欄位。
 * 回傳登入識別碼與顯示名稱／群組；password 永遠不會離開伺服器。
 *
 * 前端停留在「技師名冊」時會定時輪詢這支端點，
 * 因此在資料庫更新使用者後，名冊會自動跟著變動。
 */
usersRouter.get('/users', async (_req, res, next) => {
  try {
    const users = await withDb(async (conn) => {
      const rows = await conn.query(
        'SELECT id, account, username, group_label AS "group", supervisor FROM public.users ORDER BY id',
      );
      return (rows ?? []).map((row) => ({
        id: Number(row.id),
        account: row.account == null ? null : Number(row.account),
        username: String(row.username ?? '').trim(),
        group: row.group == null ? null : String(row.group).trim(),
        supervisor: row.supervisor === true,
      }));
    });

    // 資料隨時可能被 Access 修改，不讓瀏覽器或代理快取
    res.set('Cache-Control', 'no-store');
    res.json({
      users,
      count: users.length,
      source: 'public.users.username',
      // 一併回傳伺服器時間，前端以它記錄同步時間並重排下一次 09:00
      ...serverClock(),
    });
  } catch (err) {
    return next(err);
  }
});
