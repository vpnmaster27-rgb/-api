import 'dotenv/config';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withDb, shutdown } from '../src/db.js';

const schemaFile = fileURLToPath(new URL('../sql/schema.sql', import.meta.url));

try {
  const schema = await fs.readFile(schemaFile, 'utf8');
  await withDb((conn) => conn.query(schema));
  const rotationSchema = await fs.readFile(new URL('../sql/rotation.sql', import.meta.url), 'utf8');
  await withDb((conn) => conn.query(rotationSchema));
  console.log('Supabase PostgreSQL 資料表結構已就緒。');
} finally {
  await shutdown();
}
