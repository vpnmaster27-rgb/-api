import { Router } from 'express';
import { serverClock } from '../serverClock.js';

export const systemRouter = Router();

/**
 * GET /api/time
 *
 * 以伺服器（本機）系統時間為準的校時端點。
 * 前端用它校正瀏覽器時鐘，並取得「今天 09:00 / 下一次 09:00」的邊界，
 * 避免使用者電腦時間錯誤時名冊同步跟著出錯。
 */
systemRouter.get('/time', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(serverClock());
});
