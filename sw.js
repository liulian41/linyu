/* sw.js —— 传讯后台保活 / 延时通知 Service Worker */
const VERSION = 'cx-bg-v3';
const HOLD_CAP_MS = 5 * 60 * 1000; // 单个 message 事件最长保活约 5 分钟
const MAX_FIRED = 30;

const tasks = new Map();  // id -> task
const timers = new Map(); // id -> timeoutId
const holds = new Map();  // id -> { resolve, timer }
const fired = new Map();  // id -> { task, firedAt }

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

/* ============================================================
   接收主线程任务
   SCHEDULE: 主线程 -> SW，带 fireAt 的任务
   CANCEL:   取消某个任务
   RECLAIM:  页面回到前台，收回未触发任务 + 已触发历史
   ACK:      主线程确认已消费过的触发记录
   FLUSH:    补触发已过期的任务
   ============================================================ */
self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = obj => {
    if (!port) return;
    try { port.postMessage(obj); } catch (e) {}
  };

  switch (data.type) {
    case 'PING':
      reply({ ok: true, version: VERSION, now: Date.now(), holding: tasks.size });
      return;

    case 'SCHEDULE':
      scheduleTask(data.task, event, reply);
      return;

    case 'CANCEL':
      cancelTask(data.id);
      reply({ ok: true });
      return;

    case 'ACK':
      (data.ids || []).forEach(id => fired.delete(id));
      reply({ ok: true, cleared: (data.ids || []).length });
      return;

    case 'RECLAIM':
      reclaim(reply, data.includeFired !== false);
      return;

    case 'FLUSH':
      fireOverdue();
      reply({ ok: true });
      return;

    default:
      reply({ ok: false, error: 'unknown type' });
  }
});

function scheduleTask(task, event, reply) {
  if (!task || !task.id || !task.fireAt) {
    reply({ ok: false, error: 'bad task' });
    return;
  }

  // 同 id 任务先清掉，避免重复
  cancelTask(task.id);
  tasks.set(task.id, task);

  const delay = task.fireAt - Date.now();

  if (delay <= 0) {
    const p = fireTask(task.id);
    if (event.waitUntil) event.waitUntil(p);
    reply({ ok: true, id: task.id, immediate: true });
    return;
  }

  timers.set(task.id, setTimeout(() => fireTask(task.id), delay));

  // 关键：event.waitUntil 保活，让 SW 在到点前不被回收
  // 但只对 5 分钟以内的任务有效；更远的任务主线程自己用 setTimeout 兜底
  if (delay <= HOLD_CAP_MS && event.waitUntil) {
    const hold = new Promise(resolve => {
      const timer = setTimeout(resolve, Math.min(delay + 500, HOLD_CAP_MS));
      holds.set(task.id, { resolve, timer });
    });
    event.waitUntil(hold);
  }

  reply({ ok: true, id: task.id, delay });
}

function cancelTask(id) {
  if (!id) return;
  clearTimer(id);
  tasks.delete(id);
  releaseHold(id);
}

function clearTimer(id) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function releaseHold(id) {
  const h = holds.get(id);
  if (!h) return;
  clearTimeout(h.timer);
  holds.delete(id);
  try { h.resolve(); } catch (e) {}
}

/* ============================================================
   到点触发：通知页面 + 弹系统通知
   ============================================================ */
async function fireTask(id) {
  const task = tasks.get(id);
  if (!task) {
    releaseHold(id);
    return;
  }

  clearTimer(id);
  tasks.delete(id);

  // 记录已触发历史，页面回来时可以回填业务事件
  fired.set(task.id, { task, firedAt: Date.now() });
  while (fired.size > MAX_FIRED) {
    fired.delete(fired.keys().next().value);
  }

  const clientList = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });
  clientList.forEach(client => {
    try { client.postMessage({ type: 'TASK_FIRED', task }); } catch (e) {}
  });

  // 页面就在前台时，这类任务不再弹系统通知，避免和界面内的提示重复
  const focused = clientList.some(c => c && c.focused);
  if (task.muteIfVisible && focused) {
    releaseHold(id);
    return;
  }

  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return;
    await self.registration.showNotification(task.title || '传讯', {
      body: task.body || '',
      tag: task.tag || ('cx-' + task.id),
      renotify: true,
      requireInteraction: !!task.requireInteraction,
      timestamp: task.fireAt,
      icon: task.icon || 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: task.vibrate || [80, 40, 80],
      data: {
        taskId: task.id,
        kind: task.kind || null,
        url: task.url || self.registration.scope,
        payload: task.payload || null
      }
    });
  } catch (e) {
    // 权限被拒 / 浏览器不支持时静默失败
  } finally {
    // 通知完成后再释放 waitUntil，避免 SW 在弹通知前被回收
    releaseHold(id);
  }
}

function reclaim(reply, includeFired) {
  const pending = [];

  for (const [id, task] of tasks.entries()) {
    pending.push(task);
    clearTimer(id);
    tasks.delete(id);
    releaseHold(id);
  }

  const firedList = includeFired ? Array.from(fired.values()) : [];
  reply({ ok: true, tasks: pending, fired: firedList });
}

function fireOverdue() {
  const now = Date.now();
  const due = [];
  for (const [id, task] of tasks.entries()) {
    if (task.fireAt <= now) due.push(id);
  }
  due.forEach(id => fireTask(id));
}

/* ============================================================
   点击通知：优先聚焦已打开页面，否则新开窗口
   ============================================================ */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || self.registration.scope;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clientList) {
      try { client.postMessage({ type: 'NOTIFICATION_CLICKED', data }); } catch (e) {}
      if ('focus' in client) {
        try { return await client.focus(); } catch (e) {}
      }
    }

    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
