import { Router } from 'express';
import { withDb } from '../db.js';

export const authRouter = Router();

const MAX_ACCOUNT_VALUE = 2147483647; // 保持現有員工編號 API 範圍

/**
 * 注意：本專案目前以「明碼」儲存密碼（使用者要求，僅供內部測試）。
 * 正式上線前應改回 bcrypt 雜湊，並重新產生所有帳號的密碼。
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
      `SELECT id, account, username, password, group_label AS "group", supervisor
       FROM public.users WHERE account = $1`,
      [accountNumber],
    ));

    const user = rows?.[0];

    // 帳號不存在與密碼錯誤回傳相同訊息，避免洩漏帳號是否存在
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'invalid_credentials', message: '帳號或密碼錯誤' });
    }

    return res.status(200).json({
      id: Number(user.id),
      account: Number(user.account),
      username: user.username,
      group: user.group ?? null,
      supervisor: user.supervisor === true,
      message: '登入成功',
    });
  } catch (err) {
    return next(err);
  }
});
