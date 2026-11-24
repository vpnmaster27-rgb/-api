/**
 * 伺服器（本機）系統時間，以及「今天 09:00 / 下一次 09:00」的時間戳。
 *
 * 名冊同步以伺服器時間為準：即使使用者的電腦時間或時區不正確，
 * 仍會依伺服器本機時間判斷 09:00 與是否需要補同步。
 */
export function serverClock() {
  const now = Date.now();

  const today = new Date(now);
  today.setHours(9, 0, 0, 0);
  const todayNineAt = today.getTime();

  let nextNineAt;
  if (now < todayNineAt) {
    nextNineAt = todayNineAt;
  } else {
    const next = new Date(todayNineAt);
    next.setDate(next.getDate() + 1);
    next.setHours(9, 0, 0, 0);
    nextNineAt = next.getTime();
  }

  let timeZone = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    /* 少數環境取不到時區名稱，前端會退回瀏覽器時區顯示 */
  }

  return { serverNow: now, timeZone, todayNineAt, nextNineAt };
}
