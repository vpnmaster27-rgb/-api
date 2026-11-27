import 'dotenv/config';

const { createApp } = await import('./app.js');
const { shutdown, healthCheck } = await import('./db.js');
const { startDailyTaskDispatch } = await import('./dailyTaskDispatch.js');
const { startRosterRotationWatch } = await import('./rosterRotationWatch.js');
const { startPushNotifications } = await import('./pushNotifications.js');

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

try {
  await healthCheck();
  console.log('[dispatch-api] Supabase PostgreSQL 連線正常');
} catch (error) {
  console.error('[dispatch-api] 無法連線到 PostgreSQL', error?.message || error);
  process.exit(1);
}

const app = createApp();
const stopDailyTaskDispatch = startDailyTaskDispatch();
const stopRosterRotationWatch = startRosterRotationWatch();
const stopPushNotifications = startPushNotifications();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dispatch-api] 已在 0.0.0.0:${PORT} 啟動`);
});

async function stop(signal) {
  console.log(`\n[dispatch-api] 收到 ${signal}，正在關閉…`);
  server.close(async () => {
    stopDailyTaskDispatch();
    stopRosterRotationWatch();
    stopPushNotifications();
    await shutdown();
    process.exit(0);
  });
  // 避免連線卡住無法結束
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
