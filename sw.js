/* sw.js —— 后台延时通知 Service Worker */
const VERSION = 'cx-bg-v1';
const HOLD_CAP_MS = 5 * 60 * 1000; // SW 保活上限约 5 分钟
const tasks = new Map(); // id -> task
const timers = new Map(); // id -> timeoutId

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];

  const reply = obj => {
    if (port) {
      try { port.postMessage(obj); } catch (e) {}
    }
  };

  if (data.type === 'PING') {
    reply({ ok: true, version: VERSION, now: Date.now() });
    return;
  }

  if (data.type === 'SCHEDULE' && data.task) {
    const task = data.task;
    if (!task.id || !task.fireAt) {
      reply({ ok: false, error: 'bad task' });
      return;
    }

    // 已存在先清掉
    clearTaskTimer(task.id);

    tasks.set(task.id, task);
    const delay = Math.max(0, task.fireAt - Date.now());

    if (delay <= 0) {
      fireTask(task.id);
      reply({ ok: true, id: task.id, immediate: true });
      return;
    }

    const timer = setTimeout(() => {
      fireTask(task.id);
    }, delay);

    timers.set(task.id, timer);

    // 关键：waitUntil 保活，但只保 5 分钟以内
    if (delay <= HOLD_CAP_MS && event.waitUntil) {
      event.waitUntil(
        new Promise(resolve => {
          const holdTimer = setTimeout(resolve, delay + 500);
          // 任务触发时提前释放
          const check = setInterval(() => {
            if (!timers.has(task.id)) {
              clearInterval(check);
              clearTimeout(holdTimer);
              resolve();
            }
          }, 250);
        })
      );
    }

    reply({ ok: true, id: task.id, delay });
    return;
  }

  if (data.type === 'CANCEL' && data.id) {
    clearTaskTimer(data.id);
    tasks.delete(data.id);
    reply({ ok: true });
    return;
  }

  if (data.type === 'RECLAIM') {
    // 页面回到前台，把未触发任务交还
    const list = Array.from(tasks.values());
    reply({ ok: true, tasks: list });
    return;
  }

  if (data.type === 'FLUSH') {
    // 网络恢复等场景，可补触发过期任务
    const now = Date.now();
    for (const [id, task] of tasks.entries()) {
      if (task.fireAt <= now) fireTask(id);
    }
    reply({ ok: true });
    return;
  }

  reply({ ok: false, error: 'unknown type' });
});

function clearTaskTimer(id) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

async function fireTask(id) {
  const task = tasks.get(id);
  if (!task) return;

  clearTaskTimer(id);
  tasks.delete(id);

  // 通知客户端：任务已触发
  const clientList = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });
  clientList.forEach(client => {
    client.postMessage({ type: 'TASK_FIRED', task });
  });

  // 弹系统通知
  try {
    await self.registration.showNotification(task.title || '传讯', {
      body: task.body || '',
      tag: task.tag || ('cx-' + task.id),
      data: {
        taskId: task.id,
        url: task.url || self.location.origin,
        payload: task.payload || null
      },
      renotify: true,
      timestamp: task.fireAt
    });
  } catch (e) {
    // 权限被拒时静默失败
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || self.location.origin;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    // 已打开页面则聚焦并通知页面
    for (const client of clientList) {
      if ('focus' in client) {
        client.postMessage({
          type: 'NOTIFICATION_CLICKED',
          data
        });
        return client.focus();
      }
    }

    // 没打开则打开新窗口
    if (self.clients.openWindow) {
      return self.clients.openWindow(url);
    }
  })());
});