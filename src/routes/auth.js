import { Router } from 'express';
import { withDb, withDispatchTransaction } from '../db.js';
import { issueSession, requireSession, publicUser } from '../authSessions.js';

export const authRouter = Router();

const MAX_ACCOUNT_VALUE = 2147483647; // 保持現有員工編號 API 範圍

/**
 * 依目前業務要求，以 users.password 明碼保存與比對密碼。
 */

/** 驗證輸入，回傳錯誤訊息；通過則回傳 null */
function validateCredentials(account, password) {
  if ((typeof account !== 'string' && typeof account !== 'number') || typeof password !== 'string') {
    return '請提供 account 與 password';
  }
  const value = String(account).trim();
  if (!/^\d+$/.test(value)) return 'account 需為數字';
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_ACCOUNT_VALUE) {
    return 'account 超出資料庫 Integer 欄位可儲存的範圍';
  }
  if (!password) return 'password 不可為空';
  return null;
}

/** Access 的唯一索引違反錯誤 */
function isDuplicateKeyError(err) {
  return err?.code === '23505';
}

/**
 * POST /api/register
 * body: { account, username, password }
 */
authRouter.post('/register', async (req, res, next) => {
  try {
    const { account, username, password } = req.body ?? {};
    const problem = validateCredentials(account, password);
    if (problem) {
      return res.status(400).json({ error: 'invalid_request', message: problem });
    }

    const accountNumber = Number(String(account).trim());
    const displayName = typeof username === 'string' ? username.trim() : '';
    if (!displayName) {
      return res.status(400).json({ error: 'invalid_request', message: '請提供 username 顯示名稱' });
    }
    if ([...password].length < 4 || [...password].length > 10) return res.status(400).json({ message: '密碼長度需為 4～10 碼' });

    const outcome = await withDb(async (conn) => {
      const rows = await conn.query(
        `INSERT INTO public.users (account, username, password, group_label)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [accountNumber, displayName, password],
      );
      if (!rows.length) return { conflict: true };
      return { id: Number(rows[0].id) };
    });

    if (outcome.conflict) {
      return res.status(409).json({ error: 'account_or_username_taken', message: '此員工編號或顯示名稱已被使用' });
    }

    return res.status(201).json({
      id: outcome.id,
      account: accountNumber,
      username: displayName,
      message: '註冊成功',
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return res.status(409).json({ error: 'account_or_username_taken', message: '此員工編號或顯示名稱已被使用' });
    }
    return next(err);
  }
});

/**
 * POST /api/login
 * body: { account, password }
 */
authRouter.post('/login', async (req, res, next) => {
  try {
    const { account, password } = req.body ?? {};
    const problem = validateCredentials(account, password);
    if (problem) {
      return res.status(400).json({ error: 'invalid_request', message: problem });
    }

    const accountNumber = Number(String(account).trim());

    const rows = await withDb((conn) => conn.query(
      `SELECT *
       FROM public.users WHERE account = $1`,
      [accountNumber],
    ));

    const user = rows?.[0];

    // 帳號不存在與密碼錯誤回傳相同訊息，避免洩漏帳號是否存在
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'invalid_credentials', message: '帳號或密碼錯誤' });
    }

    return res.status(200).json(await issueSession(user));
  } catch (err) {
    return next(err);
  }
});

authRouter.post('/session/resume', requireSession, async (req, res, next) => {
  try {
    await withDb(c => c.query('UPDATE public.app_sessions SET last_active_at=NOW() WHERE token_hash=$1', [req.authUser.token_hash]));
    res.json(publicUser(req.authUser));
  } catch (error) { next(error); }
});

authRouter.post('/session/logout', requireSession, async (req, res, next) => {
  try {
    await withDb(c => c.query('DELETE FROM public.app_sessions WHERE token_hash=$1', [req.authUser.token_hash]));
    // Explicit logout revokes login only. app_devices.last_user_id remains for push.
    res.json({ ok: true });
  } catch (error) { next(error); }
});

authRouter.post('/password/change', requireSession, async (req, res, next) => {
  try {
    const { password, confirmation } = req.body ?? {};
    if (typeof password !== 'string' || [...password].length < 4 || [...password].length > 10 || password !== confirmation) {
      return res.status(400).json({ message: '新密碼需為 4～10 碼，且兩次輸入必須一致' });
    }
    // Reusing the initial password is allowed by the agreed business rule.
    const session = await withDispatchTransaction(async c => {
      await c.query('UPDATE public.users SET password=$1,must_change_password=false WHERE id=$2', [password, req.authUser.id]);
      await c.query('DELETE FROM public.app_sessions WHERE user_id=$1', [req.authUser.id]);
      return issueSession({ ...req.authUser, must_change_password: false }, c);
    });
    res.json(session);
  } catch (error) { next(error); }
});

authRouter.post('/devices/bind', requireSession, async (req, res, next) => {
  try {
    if (req.authUser.must_change_password && req.body?.enabled === true) return res.status(403).json({ message: '請先完成首次密碼變更' });
    const { deviceId, pushToken, enabled } = req.body ?? {};
    if (typeof deviceId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deviceId)
      || (pushToken != null && (typeof pushToken !== 'string' || !/^(ExponentPushToken|ExpoPushToken)\[[\w-]+\]$/.test(pushToken)))) {
      return res.status(400).json({ message: '裝置通知資料不正確' });
    }
    // Device identity stays on this installation. Account switches replace its owner.
    await withDispatchTransaction(async c => {
      if (pushToken) await c.query('UPDATE public.app_devices SET push_token=NULL,enabled=false WHERE push_token=$1 AND device_id<>$2', [pushToken, deviceId]);
      await c.query(`INSERT INTO public.app_devices(device_id,last_user_id,push_token,enabled,binding_session_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(device_id) DO UPDATE SET last_user_id=EXCLUDED.last_user_id,push_token=EXCLUDED.push_token,enabled=EXCLUDED.enabled,updated_at=NOW(),binding_session_at=EXCLUDED.binding_session_at
        WHERE app_devices.binding_session_at<=EXCLUDED.binding_session_at`,
      [deviceId, req.authUser.id, pushToken || null, enabled === true && Boolean(pushToken),req.authUser.session_created_at]);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
