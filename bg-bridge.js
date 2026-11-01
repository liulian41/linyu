/* ============================================================
   bg-bridge.js —— 主线程 ↔ Service Worker 任务交接层
   ------------------------------------------------------------
   设计原则：
     前台：完全用本地 setTimeout，精确不丢
     后台：页面 hidden 时把 5 分钟内的任务打包交给 SW 保活
     回前台：RECLAIM 收回，按剩余时间重算本地定时器
     任何时刻同一任务只在"一处"计时，避免双触发

   对外 API：
     Bg.init({askPermission})   初始化 + 注册 SW
     Bg.at(when, opts)          单次任务，返回 id
     Bg.every(ms, opts)         周期任务，返回 id
     Bg.cancel(id)              取消
     Bg.delegateAll()           手动移交（自动在 hidden 时调用）
     Bg.reclaim()               手动收回（自动在 visible 时调用）
     Bg.catchUp()               补发已过期任务
     Bg.showNotification(task)  直接弹通知
     Bg.test(seconds)           测试：N 秒后弹通知（强制走 SW）
     Bg.diagnose()              诊断信息
     Bg.onFire(fn)              注册触发回调

   任务触发时统一派发：
     document.dispatchEvent(new CustomEvent('cx-bg-fire', {detail: task}))
   ============================================================ */

(function () {
  'use strict';

  const SW_URL = './sw.js';
  const CAP_MS = 5 * 60 * 1000;     // 只有 5 分钟内的任务才值得交给 SW
  const HEARTBEAT_MS = 20 * 1000;
  const REQ_TIMEOUT = 1500;

  const Bg = {
    ready: false,
    reg: null,
    swActive: false,
    tasks: new Map(),     // id -> {id, fireAt, opts, mode:'local'|'sw', timerId, intervalMs}
    delegated: new Set(), // 已移交给 SW 的 id
    onFire: null,
    lastHeartbeat: 0,
    swVersion: ''
  };

  let seq = 0;
  const newId = (prefix) => (prefix || 'bg') + '-' + Date.now().toString(36) + '-' + (++seq);

  /* ---------------- 与 SW 通信 ---------------- */

  function send(type, payload, timeout) {
    return new Promise((resolve) => {
      if (!navigator.serviceWorker) return resolve({ ok: false, error: 'no-sw' });
      const ctrl = navigator.serviceWorker.controller;
      if (!ctrl) return resolve({ ok: false, error: 'no-controller' });

      let done = false;
      const ch = new MessageChannel();
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { ch.port1.close(); } catch (e) {}
        resolve({ ok: false, error: 'timeout' });
      }, timeout || REQ_TIMEOUT);

      ch.port1.onmessage = (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ch.port1.close(); } catch (err) {}
        resolve(e.data || { ok: false });
      };

      try {
        ctrl.postMessage(Object.assign({ type }, payload || {}), [ch.port2]);
      } catch (e) {
        clearTimeout(timer);
        done = true;
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  /* ---------------- 初始化 ---------------- */

  Bg.init = async function (opts) {
    opts = opts || {};
    if (!('serviceWorker' in navigator)) {
      Bg.ready = false;
      return { ok: false, error: 'unsupported' };
    }

    try {
      Bg.reg = await navigator.serviceWorker.register(SW_URL, { scope: './' });
    } catch (e) {
      Bg.ready = false;
      return { ok: false, error: 'register-failed:' + (e && e.message) };
    }

    // 等 controller 就绪
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }

    // 全局消息监听（SW → 页面）
    navigator.serviceWorker.addEventListener('message', onSwMessage);

    // 生命周期钩子
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', () => { Bg.delegateAll(); });
    window.addEventListener('pageshow', () => { Bg.reclaim(); });
    window.addEventListener('online', () => { send('FLUSH', {}); Bg.catchUp(); });
    document.addEventListener('resume', () => { Bg.reclaim(); Bg.catchUp(); });

    // 心跳：校时 + 顺带补发到期任务
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      Bg.lastHeartbeat = Date.now();
      send('HEARTBEAT', {}, 2000);
    }, HEARTBEAT_MS);

    // 通知权限
    if (opts.askPermission && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (e) {}
    }

    const pong = await send('PING', {});
    Bg.swActive = !!pong.ok;
    Bg.swVersion = pong.version || '';
    Bg.ready = true;

    // 启动时先收回残留任务（可能是上次被冻结前移交的）
    Bg.reclaim();
    Bg.catchUp();

    return { ok: true, version: Bg.swVersion };
  };

  Bg.onFire = function (fn) { Bg.onFire = fn; };

  /* ---------------- SW 消息处理 ---------------- */

  function onSwMessage(e) {
    const d = e.data || {};
    if (d.type === 'TASK_FIRED') {
      const task = d.task || {};
      // SW 触发了任务：清掉本地记录（若有），并派发业务回调
      const rec = Bg.tasks.get(task.id);
      if (rec && rec.timerId) { clearTimeout(rec.timerId); clearInterval(rec.timerId); }
      Bg.tasks.delete(task.id);
      Bg.delegated.delete(task.id);
      emit(task);
      send('ACK', { id: task.id }, 800);
    }
    else if (d.type === 'NOTIFY_FAILED') {
      // 通知失败（多半是权限），派发给页面做兜底提示
      document.dispatchEvent(new CustomEvent('cx-bg-notify-failed', { detail: d }));
      emit(d.task || {}, true);
    }
    else if (d.type === 'TASK_UNRELIABLE') {
      document.dispatchEvent(new CustomEvent('cx-bg-unreliable', { detail: d }));
    }
    else if (d.type === 'NOTIFICATION_CLICKED') {
      document.dispatchEvent(new CustomEvent('cx-bg-clicked', { detail: d.data || {} }));
    }
  }

  function emit(task, wasFailed) {
    try {
      document.dispatchEvent(new CustomEvent('cx-bg-fire', {
        detail: Object.assign({}, task, { __notifyFailed: !!wasFailed })
      }));
    } catch (e) {}
    try { if (typeof Bg.onFire === 'function') Bg.onFire(task); } catch (e) {}
  }

  /* ---------------- 本地定时器 ---------------- */

  function armLocal(id) {
    const rec = Bg.tasks.get(id);
    if (!rec) return;

    if (rec.timerId) { clearTimeout(rec.timerId); rec.timerId = null; }
    if (rec.intervalId) { clearInterval(rec.intervalId); rec.intervalId = null; }

    if (rec.intervalMs) {
      // 周期任务：用 interval，但每次也校验 fireAt
      rec.intervalId = setInterval(() => {
        if (Date.now() >= rec.fireAt) {
          fireLocal(id);
        }
      }, Math.min(rec.intervalMs, 30000));
      // 同时挂一个大 timeout 保证准点
      const delay = Math.max(0, rec.fireAt - Date.now());
      if (delay <= 0x7fffffff) {
        rec.timerId = setTimeout(() => fireLocal(id), delay);
      }
      return;
    }

    let delay = Math.max(0, rec.fireAt - Date.now());

    // 超过 setTimeout 上限需要分段
    const step = () => {
      const left = rec.fireAt - Date.now();
      if (left <= 0) { fireLocal(id); return; }
      rec.timerId = setTimeout(step, Math.min(left, 0x7fffffff));
    };
    rec.timerId = setTimeout(step, Math.min(delay, 0x7fffffff));
  }

  function fireLocal(id) {
    const rec = Bg.tasks.get(id);
    if (!rec) return;

    const task = buildTask(rec);

    if (rec.intervalMs) {
      // 周期任务：重新计算下一次
      rec.fireAt = Date.now() + rec.intervalMs;
      armLocal(id);
    } else {
      if (rec.timerId) clearTimeout(rec.timerId);
      Bg.tasks.delete(id);
    }

    // 前台触发也要弹通知（若 opts.notify 为真）
    if (rec.opts.notify !== false && document.visibilityState === 'hidden') {
      Bg.showNotification(task);
    }

    emit(task);
  }

  function buildTask(rec) {
    const o = rec.opts || {};
    return {
      id: rec.id,
      fireAt: rec.fireAt,
      kind: o.kind || 'generic',
      title: o.title || '传讯',
      body: o.body || '',
      url: o.url || './',
      tag: o.tag || ('cx-' + rec.id),
      silent: !!o.silent,
      icon: o.icon,
      payload: o.payload || null,
      createdAt: rec.createdAt || Date.now()
    };
  }

  /* ---------------- 公开调度 API ---------------- */

  Bg.at = function (when, opts) {
    opts = opts || {};
    let fireAt;
    if (typeof when === 'number' && when < 1e12) {
      // 传的是毫秒数（相对）
      fireAt = Date.now() + when;
    } else if (when instanceof Date) {
      fireAt = when.getTime();
    } else {
      fireAt = Number(when) || (Date.now() + 1000);
    }

    const id = opts.id || newId('at');
    const rec = {
      id, fireAt, opts, intervalMs: 0, createdAt: Date.now(),
      timerId: null, intervalId: null
    };
    Bg.tasks.set(id, rec);

    // 后台且 ≤5 分钟 → 交给 SW
    if (document.visibilityState === 'hidden' && navigator.serviceWorker && navigator.serviceWorker.controller) {
      deferToSw(rec);
    } else {
      armLocal(id);
    }
    return id;
  };

  Bg.every = function (ms, opts) {
    opts = opts || {};
    ms = Math.max(1000, Number(ms) || 60000);
    const id = opts.id || newId('every');
    const rec = {
      id, fireAt: Date.now() + ms, opts, intervalMs: ms, createdAt: Date.now(),
      timerId: null, intervalId: null
    };
    Bg.tasks.set(id, rec);
    armLocal(id);
    return id;
  };

  Bg.cancel = function (id) {
    const rec = Bg.tasks.get(id);
    if (rec) {
      if (rec.timerId) clearTimeout(rec.timerId);
      if (rec.intervalId) clearInterval(rec.intervalId);
      Bg.tasks.delete(id);
    }
    if (Bg.delegated.has(id)) {
      Bg.delegated.delete(id);
      send('CANCEL', { id }, 800);
    }
  };

  Bg.cancelAll = function () {
    Array.from(Bg.tasks.keys()).forEach(id => Bg.cancel(id));
  };

  /* ---------------- 移交 / 收回 ---------------- */

  async function deferToSw(rec) {
    const task = buildTask(rec);
    if (rec.timerId) { clearTimeout(rec.timerId); rec.timerId = null; }
    if (rec.intervalId) { clearInterval(rec.intervalId); rec.intervalId = null; }
    Bg.delegated.add(rec.id);
    const r = await send('SCHEDULE', { task }, 2500);
    if (!r || !r.ok) {
      // 移交失败，退回本地（哪怕在后台也尽力）
      Bg.delegated.delete(rec.id);
      armLocal(rec.id);
    }
    return r;
  }

  Bg.delegateAll = async function () {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return { ok: false };
    const now = Date.now();
    const list = [];

    for (const rec of Bg.tasks.values()) {
      if (rec.intervalMs) continue;           // 周期任务不交给 SW（会漏拍）
      const left = rec.fireAt - now;
      if (left <= 0) continue;                 // 已过期，靠 catchUp
      if (left > CAP_MS) continue;             // 超出保活窗口，交了也没用
      list.push(rec);
    }

    if (!list.length) return { ok: true, count: 0 };

    const tasks = list.map(buildTask);
    const r = await send('SCHEDULE_BATCH', { tasks }, 3000);

    if (r && r.ok) {
      list.forEach(rec => {
        if (rec.timerId) { clearTimeout(rec.timerId); rec.timerId = null; }
        Bg.delegated.add(rec.id);
      });
    }
    return r;
  };

  Bg.reclaim = async function () {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return { ok: false };
    const r = await send('RECLAIM', {}, 2000);
    if (!r || !r.ok) return r;

    const now = Date.now();
    (r.tasks || []).forEach(t => {
      Bg.delegated.delete(t.id);
      let rec = Bg.tasks.get(t.id);
      if (!rec) {
        // 页面侧已无记录（可能被冻结前清掉了），重建
        rec = {
          id: t.id, fireAt: t.fireAt, opts: {
            kind: t.kind, title: t.title, body: t.body, tag: t.tag,
            url: t.url, silent: t.silent, payload: t.payload
          },
          intervalMs: 0, createdAt: t.createdAt || now,
          timerId: null, intervalId: null
        };
        Bg.tasks.set(t.id, rec);
      }
      if (t.fireAt <= now) {
        // 已过期：立即补发
        fireLocal(t.id);
      } else {
        armLocal(t.id);
      }
    });
    return r;
  };

  Bg.catchUp = async function () {
    const now = Date.now();
    const due = [];
    for (const rec of Bg.tasks.values()) {
      if (rec.fireAt <= now) due.push(rec.id);
    }
    due.forEach(id => fireLocal(id));
    // 顺带让 SW 也补一次
    await send('FLUSH', {}, 2000);
    return { fired: due.length };
  };

  /* ---------------- 通知 ---------------- */

  Bg.showNotification = async function (task) {
    task = task || {};
    const title = task.title || '传讯';
    const options = {
      body: task.body || '',
      tag: task.tag || ('cx-' + (task.id || Date.now())),
      icon: task.icon,
      silent: !!task.silent,
      renotify: true,
      data: { taskId: task.id, kind: task.kind, url: task.url || './', payload: task.payload || null }
    };

    // 优先走 SW（后台更可靠）
    if (navigator.serviceWorker && navigator.serviceWorker.controller && Bg.reg) {
      try {
        await Bg.reg.showNotification(title, options);
        return true;
      } catch (e) { /* 落到本地 */ }
    }
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, options);
        return true;
      }
    } catch (e) {}
    return false;
  };

  /* ---------------- 测试与诊断 ---------------- */

  Bg.test = async function (seconds) {
    seconds = Math.max(1, Number(seconds) || 10);
    const id = newId('test');
    const task = {
      id,
      fireAt: Date.now() + seconds * 1000,
      kind: 'test',
      title: '传讯 · 测试提醒',
      body: seconds + ' 秒后触发的测试通知，收到说明后台通道正常。',
      tag: 'cx-test',
      url: './',
      createdAt: Date.now()
    };

    // 强制走 SW，才能真正验证后台链路
    const hasCtrl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!hasCtrl) {
      // 没有 SW，只能用本地
      Bg.at(seconds * 1000, { id: 'test-local-' + id, kind: 'test', title: task.title, body: task.body });
      return { ok: false, mode: 'local', reason: 'no-controller' };
    }

    // 停掉本地计时，全部交给 SW
    Bg.cancel(id);
    const r = await send('SCHEDULE', { task }, 3000);
    Bg.delegated.add(id);
    return r;
  };

  Bg.diagnose = async function () {
    const info = {
      supported: 'serviceWorker' in navigator,
      ready: Bg.ready,
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      swVersion: Bg.swVersion,
      swState: Bg.reg ? (Bg.reg.active ? 'active' : 'installing') : 'none',
      permission: ('Notification' in window) ? Notification.permission : 'unsupported',
      visibility: document.visibilityState,
      standalone: isStandalone(),
      localTasks: Bg.tasks.size,
      delegated: Bg.delegated.size,
      swPending: null,
      swTasks: []
    };
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      const r = await send('STATUS', {}, 2000);
      if (r && r.ok) {
        info.swPending = r.count;
        info.swTasks = (r.tasks || []).slice(0, 10);
        info.swVersion = r.version || info.swVersion;
      }
    }
    return info;
  };

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  Bg.isStandalone = isStandalone;

  /* ---------------- 页面可见性 ---------------- */

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      Bg.delegateAll();
    } else {
      Bg.reclaim().then(() => Bg.catchUp());
    }
  }

  window.Bg = Bg;
})();