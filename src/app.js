import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { systemRouter } from './routes/system.js';
import { tasksRouter } from './routes/tasks.js';
import { healthCheck } from './db.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // 512 KB allows a full Access Long Text value while still bounding request size.
  app.use(express.json({ limit: '512kb' }));

  // 派工 APP（React Native / 網頁版）跨域呼叫用
  const allowed = (process.env.CORS_ORIGIN ?? '*').trim();
  app.use(
    cors({
      origin: allowed === '*' ? '*' : allowed.split(',').map((s) => s.trim()),
    }),
  );

  // 全站基本限流，登入端點再套一層較嚴格的限制
  app.use(
    '/api',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );

  app.get('/api/health', async (_req, res, next) => {
    try {
      const result = await healthCheck();
      res.json({ status: 'ok', database: result });
    } catch (err) {
      next(err);
    }
  });

  // 技師名冊資料來源（只讀 public.users）與校時端點。
  // 前端會以伺服器時間判斷每日 09:00 的同步，因此排在登入／註冊用的嚴格限流之前，
  // 但仍受上方 /api 的整體限流保護。
  app.use('/api', systemRouter);
  app.use('/api', usersRouter);
  app.use('/api', tasksRouter);

  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.path === '/health',
    }),
  );

  app.use('/api', authRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: '找不到此端點' });
  });

  // 統一錯誤處理：對外只回通用訊息，細節留在伺服器日誌
  app.use((err, _req, res, _next) => {
    if (err?.status === 409) return res.status(409).json({ error: 'task_conflict', message: err.message });
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: '請求內容不是合法的 JSON' });
    }

    console.error('[api-error]', err);
    return res.status(500).json({ error: 'internal_error', message: '伺服器發生錯誤' });
  });

  return app;
}
