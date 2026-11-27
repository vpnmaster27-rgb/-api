import 'dotenv/config';
import { withDb, shutdown } from '../src/db.js';

/**
 * 新增使用者（依業務要求明碼儲存，下次登入強制設定密碼）
 *
 * 用法：
 *   node scripts/add-user.mjs <員工編號> <顯示名稱> <密碼> [群組]
 *   或直接雙擊 add-user.cmd
 */

const [accountArg, usernameArg, password, groupArg = '一般機電'] = process.argv.slice(2);

function usage(message) {
  if (message) console.error(`錯誤：${message}\n`);
  console.error('用法：node scripts/add-user.mjs <員工編號> <顯示名稱> <密碼> [群組]');
  console.error('例如：node scripts/add-user.mjs 900005 王小明 Pass123 一般機電');
  process.exitCode = 1;
}

function validate(account, name, pass) {
  if (!/^\d+$/.test(account)) return '員工編號需為數字';
  const number = Number(account);
  if (!Number.isSafeInteger(number) || number < 0 || number > 2147483647) {
    return '員工編號超出可安全使用的數字範圍';
  }
  if (!name || name.length > 64) return '顯示名稱不可空白或超過 64 個字元';
  if ([...pass].length<4 || [...pass].length>10) return '密碼需為 4～10 碼';
  return null;
}

async function main() {
  if (!accountArg || !usernameArg || !password) {
    usage('缺少員工編號、顯示名稱或密碼');
    return;
  }

  const account = Number(accountArg.trim());
  const name = usernameArg.trim();
  const problem = validate(accountArg.trim(), name, password);
  if (problem) {
    usage(problem);
    return;
  }

  const result = await withDb(async (conn) => {
    const rows = await conn.query(
      `INSERT INTO public.users (account, username, password, group_label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [account, name, password, groupArg],
    );
    return rows.length ? { id: Number(rows[0].id) } : { conflict: true };
  });

  if (result.conflict) {
    console.error(`帳號「${name}」已存在，未新增。`);
    process.exitCode = 1;
    return;
  }

  console.log(`已新增使用者：${name}（id=${result.id}）`);
  console.log('資料庫：Supabase PostgreSQL');
}

try {
  await main();
} finally {
  await shutdown();
}
