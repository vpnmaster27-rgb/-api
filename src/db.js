import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('缺少 DATABASE_URL，請設定 Supabase PostgreSQL 連線字串');
}

// node-postgres connection-string SSL options replace its explicit `ssl`
// object. Strip Supabase's optional sslmode parameter so TLS is controlled here.
const connectionUrl = new URL(connectionString);
connectionUrl.searchParams.delete('sslmode');

// Render 與其他雲端主機使用環境變數保存連線字串；不得輸出連線資訊。
export const pool = new Pool({
  connectionString: connectionUrl.toString(),
  ssl: { rejectUnauthorized: false },
  max: Number.parseInt(process.env.DB_POOL_SIZE ?? '5', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  console.error('[database] 閒置連線發生錯誤', error?.message || error);
});

/** 使用共用 PostgreSQL 連線池執行資料庫工作。 */
export async function withDb(work) {
  return work({
    async query(text, values = []) {
      const result = await pool.query(text, values);
      return result.rows;
    },
  });
}

/** Rotation, its audit records and work orders commit together on one connection. */
export async function withDispatchTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(72411026)");
    const result = await work({ query: async (sql, values = []) => (await client.query(sql, values)).rows });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** 連線測試：回傳帳號筆數，不回傳任何個人或密碼資料。 */
export async function healthCheck() {
  const rows = await withDb((conn) => conn.query('SELECT COUNT(*)::int AS user_count FROM public.users'));
  return { ok: true, users: Number(rows[0]?.user_count ?? 0) };
}

export async function shutdown() {
  await pool.end();
}
