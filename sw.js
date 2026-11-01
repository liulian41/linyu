/* ============================================================
   sw.js —— 传讯 后台延时通知 Service Worker（v2）
   ------------------------------------------------------------
   相比 v1 的增强：
     1. IndexedDB 持久化任务，SW 被系统杀掉重启后可恢复补发
     2. SCHEDULE_BATCH 批量注册（一次 postMessage 排多个任务）
     3. RECLAIM 收回未触发任务，避免页面与 SW 双触发
     4. HEARTBEAT 心跳校时，顺带补发已到期任务
     5. ACK 确认机制，页面可确认任务真的被接收
     6. STATUS 诊断，便于设置页自查
     7. 任务 TTL 过期清理，防止僵尸任务堆积
     8. sync 事件（cx-flush）在网络恢复时补发
     9. push 事件接收端（为将来接服务端 Web Push 预留）

   保活真相：waitUntil 最多撑约 5 分钟，超时必然不可靠。
   超过 5 分钟的任务只能"到期后补发"，不能"准点触发"。
   ============================================================ */

const VERSION = 'cx-bg-v2';

const HOLD_CAP_MS = 5 * 60 * 1000;      // waitUntil 可靠保活上限
const HARD_CAP_MS = 5 * 60 * 1000;      // 超过则标记 unreliable
const TASK_TTL_MS = 12 * 60 * 60 * 1000; // 任务最长存活 12 小时
const HOLD_RELEASE_MARGIN = 800;         // 保活兜底多等的余量

const DB_NAME = 'cx-bg-db';
const DB_VERSION = 1;
const STORE = 'tasks';

const tasks = new Map();   // id -> task
const timers = new Map();  // id -> { timeoutId, holdRelease }
const holds = new Map();   // id -> resolve（保活 promise 的释放函数）

/* ============================================================
   1. IndexedDB 持久化
   ============================================================ */

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function dbPut(task) {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(task);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; tx.onabort = r; });
  } catch (e) { /* 忽略 */ }
}

async function dbDel(id) {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; tx.onabort = r; });
  } catch (e) { /* 忽略 */ }
}

async function dbAll() {
  const db = await openDB();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    return await new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

/* ============================================================
   2. 生命周期
   ============================================================ */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    // SW 重启后恢复未触发任务
    const saved = await dbAll();
    const now = Date.now();
    for (const task of saved) {
      if (!task || !task.id || !task.fireAt) { await dbDel(task && task.id); continue; }
      if (now - task.fireAt > TASK_TTL_MS) {
        await dbDel(task.id);
        continue;
      }
      // 已过期但未超 TTL 的，立即补发
      if (task.fireAt <= now) {
        fireTask(task.id, task);
      } else {
        // 重新挂上定时器（无 event，故不保活）
        await schedule(task, null);
      }
    }
  })());
});

/* ============================================================
   3. 消息协议
   ============================================================ */

self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];

  const reply = obj => {
    if (!port) return;
    try { port.postMessage(obj); } catch (e) {}
  };

  const type = data.type;

  /* --- PING：连通性探测 --- */
  if (type === 'PING') {
    reply({ ok: true, type: 'PONG', version: VERSION, now: Date.now(), count: tasks.size });
    return;
  }

  /* --- SCHEDULE：单个任务注册 --- */
  if (type === 'SCHEDULE') {
    const task = normalize(data.task);
    if (!task) { reply({ ok: false, error: 'bad-task' }); return; }
    event.waitUntil((async () => {
      const r = await schedule(task, event);
      reply(r);
    })());
    return;
  }

  /* --- SCHEDULE_BATCH：批量注册 --- */
  if (type === 'SCHEDULE_BATCH') {
    const list = Array.isArray(data.tasks) ? data.tasks : [];
    event.waitUntil((async () => {
      const accepted = [];
      const rejected = [];
      for (const raw of list) {
        const task = normalize(raw);
        if (!task) { rejected.push({ id: raw && raw.id, error: 'bad-task' }); continue; }
        try {
          await schedule(task, event);
          accepted.push(task.id);
        } catch (e) {
          rejected.push({ id: task.id, error: String(e && e.message || e) });
        }
      }
      reply({ ok: true, accepted, rejected });
    })());
    return;
  }

  /* --- CANCEL：取消任务 --- */
  if (type === 'CANCEL') {
    const id = data.id;
    event.waitUntil((async () => {
      clearTaskTimer(id);
      tasks.delete(id);
      await dbDel(id);
      reply({ ok: true, id });
    })());
    return;
  }

  /* --- RECLAIM：页面回前台，收回未触发任务 --- */
  if (type === 'RECLAIM') {
    const ids = Array.isArray(data.ids) ? data.ids : null;
    event.waitUntil((async () => {
      const out = [];
      const now = Date.now();
      for (const [id, task] of tasks.entries()) {
        if (ids && ids.length && !ids.includes(id)) continue;
        clearTaskTimer(id);
        tasks.delete(id);
        await dbDel(id);
        out.push({ ...task, overdue: task.fireAt <= now });
      }
      reply({ ok: true, tasks: out, now });
    })());
    return;
  }

  /* --- FLUSH / HEARTBEAT：补发到期任务 --- */
  if (type === 'FLUSH' || type === 'HEARTBEAT') {
    event.waitUntil((async () => {
      const now = Date.now();
      const fired = [];
      for (const [id, task] of Array.from(tasks.entries())) {
        if (task.fireAt <= now) {
          fired.push(id);
          fireTask(id, task);
        }
      }
      // TTL 清理
      for (const [id, task] of Array.from(tasks.entries())) {
        if (now - task.fireAt > TASK_TTL_MS) {
          clearTaskTimer(id);
          tasks.delete(id);
          await dbDel(id);
        }
      }
      reply({ ok: true, fired, remaining: tasks.size, now, version: VERSION });
    })());
    return;
  }

  /* --- STATUS：诊断 --- */
  if (type === 'STATUS') {
    event.waitUntil((async () => {
      const now = Date.now();
      const list = Array.from(tasks.values()).map(t => ({
        id: t.id,
        kind: t.kind || '',
        fireAt: t.fireAt,
        in: t.fireAt - now,
        holdable: (t.fireAt - now) <= HOLD_CAP_MS
      }));
      reply({
        ok: true,
        version: VERSION,
        now,
        count: tasks.size,
        permission: self.Notification ? self.Notification.permission : 'unsupported',
        tasks: list
      });
    })());
    return;
  }

  /* --- ACK：页面确认已收到某任务触发 --- */
  if (type === 'ACK') {
    reply({ ok: true });
    return;
  }

  reply({ ok: false, error: 'unknown-type:' + type });
});

/* ============================================================
   4. 任务规范化 / 排程 / 触发
   ============================================================ */

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ? String(raw.id) : '';
  const fireAt = Number(raw.fireAt);
  if (!id || !isFinite(fireAt) || fireAt <= 0) return null;
  return {
    id,
    fireAt,
    kind: raw.kind || 'generic',
    title: raw.title || '传讯',
    body: raw.body || '',
    url: raw.url || './',
    tag: raw.tag || ('cx-' + id),
    silent: !!raw.silent,
    icon: raw.icon || undefined,
    payload: raw.payload || null,
    createdAt: raw.createdAt || Date.now()
  };
}

function clearTaskTimer(id) {
  const rec = timers.get(id);
  if (rec) {
    if (rec.timeoutId) clearTimeout(rec.timeoutId);
    timers.delete(id);
  }
  const release = holds.get(id);
  if (release) {
    holds.delete(id);
    try { release(); } catch (e) {}
  }
}

async function schedule(task, event) {
  clearTaskTimer(task.id);

  tasks.set(task.id, task);
  await dbPut(task);

  const delay = task.fireAt - Date.now();

  // 已到期：立即触发
  if (delay <= 0) {
    fireTask(task.id, task);
    return { ok: true, id: task.id, immediate: true, reliable: false };
  }

  // 超窗：注册但标记不可靠，只能靠后续唤醒补发
  const reliable = delay <= HOLD_CAP_MS;

  const timeoutId = setTimeout(() => {
    fireTask(task.id, task);
  }, delay);

  timers.set(task.id, { timeoutId });

  // 关键：waitUntil 保活（仅 5 分钟内）
  if (reliable && event && event.waitUntil) {
    const holdPromise = new Promise(resolve => {
      holds.set(task.id, resolve);
      // 兜底：即使 fireTask 没走到，也在 delay + margin 后释放
      setTimeout(resolve, delay + HOLD_RELEASE_MARGIN);
    });
    try { event.waitUntil(holdPromise); } catch (e) {}
  }

  if (!reliable) {
    broadcast({ type: 'TASK_UNRELIABLE', id: task.id, delay }).catch(() => {});
  }

  return { ok: true, id: task.id, delay, reliable };
}

async function broadcast(msg) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clientList.forEach(c => {
    try { c.postMessage(msg); } catch (e) {}
  });
  return clientList;
}

async function fireTask(id, taskOrNull) {
  const task = taskOrNull || tasks.get(id);
  if (!task) return;

  clearTaskTimer(id);
  tasks.delete(id);
  await dbDel(id);

  // 先告诉页面（页面若在前台可直接渲染业务内容）
  await broadcast({ type: 'TASK_FIRED', task, at: Date.now() });

  // 再弹系统通知
  try {
    await self.registration.showNotification(task.title || '传讯', {
      body: task.body || '',
      tag: task.tag || ('cx-' + task.id),
      icon: task.icon,
      badge: task.icon,
      silent: task.silent,
      renotify: true,
      timestamp: task.fireAt,
      data: {
        taskId: task.id,
        kind: task.kind,
        url: task.url || './',
        payload: task.payload || null
      }
    });
  } catch (e) {
    await broadcast({ type: 'NOTIFY_FAILED', task, error: String(e && e.message || e) });
  }
}

/* ============================================================
   5. 通知点击
   ============================================================ */

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || './';

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // 优先聚焦已有窗口
    for (const client of clientList) {
      if ('focus' in client) {
        try {
          client.postMessage({ type: 'NOTIFICATION_CLICKED', data });
          return await client.focus();
        } catch (e) { /* 继续找 */ }
      }
    }
    // 否则新开窗口
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

/* ============================================================
   6. 后台同步补发（网络恢复等）
   ============================================================ */

self.addEventListener('sync', event => {
  if (event.tag !== 'cx-flush') return;
  event.waitUntil((async () => {
    const now = Date.now();
    const all = await dbAll();
    for (const task of all) {
      if (task.fireAt <= now) fireTask(task.id, task);
    }
  })());
});

/* ============================================================
   7. Web Push（预留：需服务端配合，长期任务只能走这条路）
   ============================================================ */

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
  event.waitUntil(
    self.registration.showNotification(payload.title || '传讯', {
      body: payload.body || '',
      tag: payload.tag || 'cx-push',
      icon: payload.icon,
      data: { url: payload.url || './', payload: payload.data || null }
    })
  );
});
