/* ============================================================
 patch-features.js —— 传讯 4 项需求补丁
 引入顺序（必须）：
   1) 初版.html 原有脚本（全部逻辑）
   2) ./v2/bg-bridge.js      ← 提供 window.Bg
   3) ./v2/patch-features.js ← 本文件（提供 window.CXPatch）
 依赖全局：DB / openModal / toast / $ / DB.settings / DB.setSettings
 需求 1：同意一起听后不重复邀请
 需求 2：朋友圈/信件 频率可控
 需求 3：商城订单推送去重
 需求 4：后台保活
============================================================ */
(function () {
  'use strict';

  const LOG = '[CXPatch]';
  const VERSION = '1.0.0';
  const DEFAULTS = {
    momentIntervalMin: 30,
    momentDailyCap: 3,
    letterIntervalMin: 60,
    letterDailyCap: 2,
    bgKeepAlive: true,
    bgSilentAudio: false,
    bgNotifyTest: true,
    bgTestReminderMin: 0
  };

  const LS = {
    QUOTA_MOMENT: 'cx_quota_moment',
    QUOTA_LETTER: 'cx_quota_letter',
    LAST_MOMENT: 'cx_last_moment',
    LAST_LETTER: 'cx_last_letter',
    INVITE: 'cx_invite_state',
    NOTICED: 'cx_patch_noticed',
    PUSH_HIST: 'cx_push_history'
  };

  function log() {
    try {
      const a = Array.prototype.slice.call(arguments);
      a.unshift(LOG);
      console.log.apply(console, a);
    } catch (e) {}
  }

  function now() { return Date.now(); }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function num(v, def) {
    const n = Number(v);
    return isFinite(n) ? n : def;
  }

  function readLS(key, def) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === '') return def;
      return raw;
    } catch (e) { return def; }
  }

  function writeLS(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function callGlobal(name, args) {
    try {
      if (typeof window[name] === 'function') return window[name].apply(null, args || []);
    } catch (e) { log('call', name, 'failed', e); }
    return undefined;
  }

  /* ---------- 设置读写 ---------- */
  function baseSettings() {
    let s = {};
    try {
      if (window.DB && typeof DB.settings === 'function') s = DB.settings() || {};
    } catch (e) {}
    return s;
  }

  function settings() {
    const s = baseSettings();
    const out = Object.assign({}, DEFAULTS, s);
    out.momentIntervalMin = Math.max(1, num(out.momentIntervalMin, DEFAULTS.momentIntervalMin));
    out.momentDailyCap = Math.max(0, Math.floor(num(out.momentDailyCap, DEFAULTS.momentDailyCap)));
    out.letterIntervalMin = Math.max(1, num(out.letterIntervalMin, DEFAULTS.letterIntervalMin));
    out.letterDailyCap = Math.max(0, Math.floor(num(out.letterDailyCap, DEFAULTS.letterDailyCap)));
    out.bgTestReminderMin = Math.max(0, num(out.bgTestReminderMin, DEFAULTS.bgTestReminderMin));
    out.bgKeepAlive = !!out.bgKeepAlive;
    out.bgSilentAudio = !!out.bgSilentAudio;
    out.bgNotifyTest = !!out.bgNotifyTest;
    return out;
  }

  function patchSettings(patch) {
    if (!patch || typeof patch !== 'object') return settings();
    const cur = baseSettings();
    const next = Object.assign({}, DEFAULTS, cur, patch);
    const save = Object.assign({}, cur);
    ['anim', 'waitMin', 'waitMax', 'autoLetter', 'letterUseSticker',
      'letterCardsCount', 'autoMoment', 'momentCardsCount'].forEach(function (k) {
      if (k in next) save[k] = next[k];
    });
    Object.keys(DEFAULTS).forEach(function (k) { save[k] = next[k]; });
    try {
      if (window.DB && typeof DB.setSettings === 'function') DB.setSettings(save);
    } catch (e) { log('patchSettings save failed', e); }

    if ('bgKeepAlive' in patch || 'bgSilentAudio' in patch) {
      try {
        if (save.bgKeepAlive) KeepAlive.enable({ askPermission: false });
        else KeepAlive.disable();
      } catch (e) {}
    }
    if ('momentIntervalMin' in patch || 'letterIntervalMin' in patch ||
      'autoMoment' in patch || 'autoLetter' in patch ||
      'momentDailyCap' in patch || 'letterDailyCap' in patch ||
      'bgTestReminderMin' in patch) {
      try { Scheduler.rescheduleAll(); } catch (e) {}
    }
    return settings();
  }

  /* ---------- 每日配额 ---------- */
  function quotaGet(key) {
    const raw = readLS(key, '');
    if (!raw) return { date: todayKey(), count: 0 };
    const parts = String(raw).split('|');
    const date = parts[0] || todayKey();
    const count = num(parts[1], 0);
    if (date !== todayKey()) return { date: todayKey(), count: 0 };
    return { date: date, count: count };
  }

  function quotaBump(key) {
    const q = quotaGet(key);
    q.date = todayKey();
    q.count = q.count + 1;
    writeLS(key, q.date + '|' + q.count);
    return q.count;
  }

  function quotaLeft(key, cap) {
    return Math.max(0, cap - quotaGet(key).count);
  }

  /* ============================================================
     需求 1：一起听邀请去重
  ============================================================ */

  const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

  function together() {
    try {
      if (window.DB && typeof DB.together === 'function') return DB.together() || null;
      if (window.DB && typeof DB.getTogether === 'function') return DB.getTogether() || null;
      const raw = localStorage.getItem('cx_together');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function isListeningTogether() {
    const t = together();
    return !!(t && t.status === 'active');
  }

  /**
   * 是否允许发起邀请 -> { ok, reason }
   */
  function canInviteTogether(friendId) {
    const t = together();
    if (t && t.status === 'active') {
      return { ok: false, reason: '你们正在一起听，无需再邀请' };
    }
    if (t && t.status === 'waiting') {
      return { ok: false, reason: '邀请已发出，等待对方回应' };
    }
    if (t && t.endedAt && (now() - t.endedAt) < 10 * 60 * 1000) {
      const rest = Math.ceil((10 * 60 * 1000 - (now() - t.endedAt)) / 60000);
      return { ok: false, reason: '刚结束一起听，' + rest + ' 分钟后再试' };
    }
    return { ok: true, reason: '' };
  }

  /**
   * 接受邀请后的收尾
   */
  function onInviteAccepted(messageId, friendId) {
    try {
      if (window.DB && typeof DB.chat === 'function' && typeof DB.setChat === 'function') {
        const fid = friendId || (together() && together().friendId);
        const list = DB.chat(fid) || [];
        let changed = false;
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m || m.type !== 'invite') continue;
          if (m.id === messageId) {
            if (m.inviteStatus !== 'accepted') { m.inviteStatus = 'accepted'; changed = true; }
          } else if (m.inviteStatus === 'pending' || m.inviteStatus === 'waiting') {
            m.inviteStatus = 'superseded';
            changed = true;
          }
        }
        if (changed) DB.setChat(fid, list);
      }
    } catch (e) { log('onInviteAccepted failed', e); }

    expireStaleInvites();
    syncInviteButton();
    log('邀请已接受，残留邀请已清理');
    return true;
  }

  function expireStaleInvites() {
    try {
      if (!window.DB || typeof DB.chat !== 'function' || typeof DB.setChat !== 'function') return;
      const t = together();
      const targets = [];
      if (t && t.friendId) targets.push(t.friendId);
      if (window.state && state.currentChat && targets.indexOf(state.currentChat) < 0) {
        targets.push(state.currentChat);
      }
      targets.forEach(function (id) {
        const list = DB.chat(id) || [];
        let changed = false;
        list.forEach(function (m) {
          if (m && m.type === 'invite' &&
            (m.inviteStatus === 'pending' || m.inviteStatus === 'waiting')) {
            if (m.ts && (now() - m.ts) > INVITE_TTL_MS) {
              m.inviteStatus = 'ended';
              changed = true;
            }
          }
        });
        if (changed) DB.setChat(id, list);
      });
    } catch (e) {}
  }

  function syncInviteButton() {
    try {
      const btn = document.getElementById('btnInvite');
      if (!btn) return;
      const r = canInviteTogether();
      if (r.ok) {
        btn.removeAttribute('disabled');
        btn.style.opacity = '';
        btn.dataset.cxBlocked = '';
        btn.title = '';
      } else {
        btn.setAttribute('disabled', 'disabled');
        btn.style.opacity = '0.45';
        btn.dataset.cxBlocked = r.reason;
        btn.title = r.reason;
      }
    } catch (e) {}
  }

  /**
   * 是否允许「对方」生成新邀请（替换原 Math.random() < 0.1 处）
   */
  function shouldGenerateIncomingInvite() {
    const t = together();
    if (t && t.status === 'active') return false;
    if (t && t.status === 'waiting') return false;
    if (t && t.endedAt && (now() - t.endedAt) < 10 * 60 * 1000) return false;

    try {
      if (window.DB && typeof DB.chat === 'function') {
        const fid = (t && t.friendId) || (window.state && state.currentChat) || 'c1';
        const list = DB.chat(fid) || [];
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (m && m.type === 'invite' &&
            (m.inviteStatus === 'pending' || m.inviteStatus === 'waiting')) {
            return false;
          }
        }
      }
    } catch (e) {}

    return Math.random() < 0.1;
  }

  function inviteStatusText(status) {
    switch (status) {
      case 'pending': return '待处理';
      case 'waiting': return '等待对方回应';
      case 'accepted': return '已接受';
      case 'rejected': return '已拒绝';
      case 'superseded': return '已失效（已被新邀请取代）';
      case 'ended': return '已结束';
      default: return '';
    }
  }/* ============================================================
     需求 2：朋友圈 / 信件 频率控制
  ============================================================ */

  function inQuietHours() {
    const h = new Date().getHours();
    return h >= 23 || h < 7;
  }

  /**
   * kind: 'moment' | 'letter'
   * -> { ok, reason, waitMs }
   */
  function checkAllow(kind) {
    const st = settings();
    const isMoment = kind === 'moment';
    const enable = isMoment ? st.autoMoment : st.autoLetter;
    const intervalMin = isMoment ? st.momentIntervalMin : st.letterIntervalMin;
    const cap = isMoment ? st.momentDailyCap : st.letterDailyCap;
    const quotaKey = isMoment ? LS.QUOTA_MOMENT : LS.QUOTA_LETTER;
    const lastKey = isMoment ? LS.LAST_MOMENT : LS.LAST_LETTER;
    const label = isMoment ? '朋友圈' : '信件';

    if (!enable) return { ok: false, reason: label + '自动发送未开启', waitMs: 0 };
    if (inQuietHours()) return { ok: false, reason: '免打扰时段（23:00-07:00）', waitMs: 0 };

    const q = quotaGet(quotaKey);
    if (cap > 0 && q.count >= cap) {
      return { ok: false, reason: '今日' + label + '已达上限（' + cap + '）', waitMs: 0 };
    }

    const last = num(readLS(lastKey, 0), 0);
    if (last > 0) {
      const gap = intervalMin * 60 * 1000;
      const rest = last + gap - now();
      if (rest > 0) {
        return { ok: false, reason: '距上次不足 ' + intervalMin + ' 分钟', waitMs: rest };
      }
    }
    return { ok: true, reason: '', waitMs: 0 };
  }

  function allowAutoMoment() { return checkAllow('moment').ok; }
  function allowAutoLetter() { return checkAllow('letter').ok; }

  function noteMomentPosted() {
    writeLS(LS.LAST_MOMENT, now());
    quotaBump(LS.QUOTA_MOMENT);
    Scheduler.rescheduleMoment();
  }

  function noteLetterPosted() {
    writeLS(LS.LAST_LETTER, now());
    quotaBump(LS.QUOTA_LETTER);
    Scheduler.rescheduleLetter();
  }

  function frequencyStatus() {
    function one(kind) {
      const st = settings();
      const isMoment = kind === 'moment';
      const intervalMin = isMoment ? st.momentIntervalMin : st.letterIntervalMin;
      const cap = isMoment ? st.momentDailyCap : st.letterDailyCap;
      const quotaKey = isMoment ? LS.QUOTA_MOMENT : LS.QUOTA_LETTER;
      const lastKey = isMoment ? LS.LAST_MOMENT : LS.LAST_LETTER;
      const q = quotaGet(quotaKey);
      const last = num(readLS(lastKey, 0), 0);
      let nextIn = 0;
      if (last > 0) nextIn = Math.max(0, last + intervalMin * 60 * 1000 - now());
      return {
        enabled: isMoment ? st.autoMoment : st.autoLetter,
        intervalMin: intervalMin,
        cap: cap,
        used: q.count,
        left: cap > 0 ? Math.max(0, cap - q.count) : -1,
        nextInMs: nextIn,
        quiet: inQuietHours()
      };
    }
    return { moment: one('moment'), letter: one('letter') };
  }

  /* ============================================================
     需求 3：商城订单推送去重
     wish / req_pay 同商品 5 分钟内只推一次；buy 放行
  ============================================================ */

  const PUSH_TYPES = ['wish', 'req_pay'];
  const DUP_WINDOW_MS = 5 * 60 * 1000;
  const PUSH_MEM = {};

  function pushKey(type, productName, price) {
    return String(type) + '|' + String(productName || '') + '|' + String(price == null ? '' : price);
  }

  function allowOrderPush(action, productName, price) {
    if (PUSH_TYPES.indexOf(action) < 0) return true;

    const k = pushKey(action, productName, price);
    const t = now();
    const last = PUSH_MEM[k] || 0;
    if (last && (t - last) < DUP_WINDOW_MS) {
      log('订单推送去重：', k, '剩余', Math.ceil((DUP_WINDOW_MS - (t - last)) / 1000) + 's');
      return false;
    }
    PUSH_MEM[k] = t;
    Object.keys(PUSH_MEM).forEach(function (kk) {
      if ((t - PUSH_MEM[kk]) > DUP_WINDOW_MS * 12) delete PUSH_MEM[kk];
    });
    return true;
  }

  function settleOrder(action, productName, price) {
    try {
      const k = pushKey(action, productName, price);
      writeLS('cx_order_settled_' + encodeURIComponent(k), now());
      log('订单已结算：', k);
    } catch (e) {}
    return true;
  }

  /**
   * 替换原 autoSimulateShop 里的随机推送
   */
  function maybePushOrderRandom(msg) {
    if (!msg) return false;
    const p = msg.product || msg.pushData || msg;
    const action = msg.action || (msg.pushData && msg.pushData.action) || p.action || '';
    const name = p.name || p.productName || '';
    const price = p.price;
    if (!allowOrderPush(action, name, price)) return false;
    try {
      if (typeof appendMessage === 'function') {
        appendMessage(msg);
        settleOrder(action, name, price);
        return true;
      }
    } catch (e) { log('maybePushOrderRandom append failed', e); }
    return false;
  }/* ============================================================
     需求 4-A：KeepAlive（后台保活）
     优先级：本地定时器 > SW 5 分钟接力 > 回前台补发
  ============================================================ */

  const KeepAlive = {
    _on: false,
    _audio: null,
    _wakeLock: null,
    _bound: false,

    isSupported: function () { return !!window.Bg; },
    isOn: function () { return this._on; },

    enable: function (opts) {
      opts = opts || {};
      if (!window.Bg) {
        log('KeepAlive.enable 失败：Bg 未加载（检查 bg-bridge.js 是否引入）');
        return false;
      }
      this._on = true;
      this.bind();
      const st = settings();
      if (st.bgSilentAudio) this.startSilentAudio();
      this.requestWakeLock();
      try { Bg.init({ askPermission: !!opts.askPermission }); } catch (e) {}
      try { Bg.reclaim(); } catch (e) {}
      try { Bg.catchUp(); } catch (e) {}
      log('KeepAlive 已启用');
      return true;
    },

    disable: function () {
      this._on = false;
      this.stopSilentAudio();
      this.releaseWakeLock();
      try { if (window.Bg) Bg.cancelAll(); } catch (e) {}
      log('KeepAlive 已停用');
      return true;
    },

    bind: function () {
      if (this._bound) return;
      this._bound = true;
      const self = this;

      document.addEventListener('cx-bg-fire', function (ev) {
        self.handleFire(ev.detail || {});
      });
      document.addEventListener('cx-bg-notify-failed', function (ev) {
        log('通知发送失败：', ev.detail && ev.detail.reason);
      });
      document.addEventListener('cx-bg-unreliable', function (ev) {
        log('SW 保活不可靠：', ev.detail && ev.detail.id);
      });
      document.addEventListener('cx-bg-clicked', function (ev) {
        log('用户点击通知：', ev.detail);
        try { if (window.Bg) Bg.catchUp(); } catch (e) {}
      });

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          try { if (window.Bg) { Bg.reclaim(); Bg.catchUp(); } } catch (e) {}
          self.requestWakeLock();
        } else {
          try { if (window.Bg) Bg.delegateAll(); } catch (e) {}
        }
      });

      window.addEventListener('pageshow', function () {
        try { if (window.Bg) Bg.catchUp(); } catch (e) {}
      });
      window.addEventListener('online', function () {
        try { if (window.Bg) Bg.catchUp(); } catch (e) {}
      });
    },

    handleFire: function (t) {
      if (!t || !t.kind) return;
      const st = settings();
      log('任务触发：', t.kind, t.id || '');

      if (t.kind === 'moment') {
        const c = checkAllow('moment');
        if (!c.ok) { log('朋友圈跳过：', c.reason); return; }
        if (fireAutoMoment()) noteMomentPosted();
      } else if (t.kind === 'letter') {
        const c = checkAllow('letter');
        if (!c.ok) { log('信件跳过：', c.reason); return; }
        if (fireAutoLetter()) noteLetterPosted();
      } else if (t.kind === 'order') {
        if (document.visibilityState === 'visible') callGlobal('renderShop');
      } else if (t.kind === 'test') {
        log('保活自检成功 @', new Date().toLocaleTimeString());
        if (st.bgTestReminderMin > 0) {
          try { Bg.at(now() + st.bgTestReminderMin * 60000, { id: 'cx-test', kind: 'test' }); } catch (e) {}
        }
      }
    },

    startSilentAudio: function () {
      if (this._audio) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ac = new Ctx();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        gain.gain.value = 0.0001;
        osc.frequency.value = 20;
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start();
        this._audio = { ac: ac, osc: osc };
        log('静音音频保活已开启');
      } catch (e) { log('静音音频启动失败', e); }
    },

    stopSilentAudio: function () {
      try {
        if (this._audio) {
          this._audio.osc.stop();
          this._audio.ac.close();
        }
      } catch (e) {}
      this._audio = null;
    },

    requestWakeLock: function () {
      const self = this;
      try {
        if (!('wakeLock' in navigator) || this._wakeLock) return;
        navigator.wakeLock.request('screen').then(function (lock) {
          self._wakeLock = lock;
          lock.addEventListener('release', function () { self._wakeLock = null; });
        }).catch(function () {});
      } catch (e) {}
    },

    releaseWakeLock: function () {
      try { if (this._wakeLock) this._wakeLock.release(); } catch (e) {}
      this._wakeLock = null;
    },

    diagnose: async function () {
      const base = (window.Bg && typeof Bg.diagnose === 'function')
        ? (await Bg.diagnose())
        : { supported: false };
      base.keepAliveOn = this._on;
      base.silentAudio = !!this._audio;
      base.wakeLock = !!this._wakeLock;
      base.visibility = document.visibilityState;
      return base;
    },

    test: function (seconds) {
      return (window.Bg && typeof Bg.test === 'function')
        ? Bg.test(seconds)
        : Promise.resolve({ ok: false, reason: 'Bg 未加载' });
    }
  };

  function fireAutoMoment() {
    const names = ['addAutoMoment', 'autoAddMoment', 'postAutoMoment'];
    for (let i = 0; i < names.length; i++) {
      if (typeof window[names[i]] === 'function') {
        try { window[names[i]](); return true; } catch (e) { log(names[i], 'failed', e); }
      }
    }
    if (typeof window.checkAutoMoment === 'function') {
      try {
        window.checkAutoMoment();
        if (document.visibilityState === 'visible') callGlobal('renderMoments');
        return true;
      } catch (e) { log('checkAutoMoment failed', e); }
    }
    log('未找到朋友圈自动生成函数，跳过');
    return false;
  }

  function fireAutoLetter() {
    const names = ['addAutoLetter', 'autoAddLetter', 'pushAutoLetter'];
    for (let i = 0; i < names.length; i++) {
      if (typeof window[names[i]] === 'function') {
        try { window[names[i]](); return true; } catch (e) { log(names[i], 'failed', e); }
      }
    }
    if (typeof window.checkAutoLetter === 'function') {
      try { window.checkAutoLetter(); return true; } catch (e) { log('checkAutoLetter failed', e); }
    }
    log('未找到信件自动生成函数，跳过');
    return false;
  }/* ============================================================
     需求 4-B：Scheduler（后台任务排期）
  ============================================================ */

  const Scheduler = {
    _momentId: 'cx-moment',
    _letterId: 'cx-letter',

    _nextMomentAt: function () {
      const st = settings();
      if (!st.autoMoment) return 0;
      if (st.momentDailyCap > 0 && quotaLeft(LS.QUOTA_MOMENT, st.momentDailyCap) <= 0) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(0, 5, 0, 0);
        return d.getTime();
      }
      const last = num(readLS(LS.LAST_MOMENT, 0), 0);
      const intervalMs = st.momentIntervalMin * 60 * 1000;
      return last > 0 ? Math.max(now() + 5000, last + intervalMs) : (now() + intervalMs);
    },

    _nextLetterAt: function () {
      const st = settings();
      if (!st.autoLetter) return 0;
      if (st.letterDailyCap > 0 && quotaLeft(LS.QUOTA_LETTER, st.letterDailyCap) <= 0) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(0, 5, 0, 0);
        return d.getTime();
      }
      const last = num(readLS(LS.LAST_LETTER, 0), 0);
      const intervalMs = st.letterIntervalMin * 60 * 1000;
      return last > 0 ? Math.max(now() + 5000, last + intervalMs) : (now() + intervalMs);
    },

    rescheduleMoment: function () {
      if (!window.Bg) return;
      try { Bg.cancel(this._momentId); } catch (e) {}
      const at = this._nextMomentAt();
      if (!at || at - now() <= 0) return;
      try {
        Bg.at(at, { id: this._momentId, kind: 'moment' });
        log('朋友圈排期：', new Date(at).toLocaleTimeString(),
          '（' + Math.round((at - now()) / 60000) + ' 分钟后）');
      } catch (e) { log('排期失败', e); }
    },

    rescheduleLetter: function () {
      if (!window.Bg) return;
      try { Bg.cancel(this._letterId); } catch (e) {}
      const at = this._nextLetterAt();
      if (!at || at - now() <= 0) return;
      try {
        Bg.at(at, { id: this._letterId, kind: 'letter' });
        log('信件排期：', new Date(at).toLocaleTimeString(),
          '（' + Math.round((at - now()) / 60000) + ' 分钟后）');
      } catch (e) { log('排期失败', e); }
    },

    rescheduleAll: function () {
      try { this.rescheduleMoment(); } catch (e) {}
      try { this.rescheduleLetter(); } catch (e) {}
      const st = settings();
      if (st.bgTestReminderMin > 0) {
        try { Bg.at(now() + st.bgTestReminderMin * 60000, { id: 'cx-test', kind: 'test' }); } catch (e) {}
      }
    },

    status: async function () {
      const out = {
        momentAt: this._nextMomentAt(),
        letterAt: this._nextLetterAt(),
        swTasks: []
      };
      try {
        if (window.Bg && typeof Bg.diagnose === 'function') {
          const d = (await Bg.diagnose()) || {};
          out.swTasks = d.swTasks || [];
        }
      } catch (e) {}
      return out;
    }
  };

  /* ============================================================
     设置面板：频率与保活
  ============================================================ */

  function fmtMin(ms) {
    if (!ms || ms <= 0) return '即将';
    const m = Math.round(ms / 60000);
    if (m < 1) return '不到 1 分钟';
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    return h + ' 小时 ' + (m % 60) + ' 分';
  }

  function rowHTML(label, desc, control) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;' +
      'padding:12px 0;border-bottom:1px solid rgba(128,128,128,.18);gap:12px">' +
      '<div style="flex:1;min-width:0">' +
      '<div style="font-size:15px;color:inherit">' + label + '</div>' +
      (desc ? '<div style="font-size:12px;opacity:.55;margin-top:3px;line-height:1.4">' + desc + '</div>' : '') +
      '</div>' +
      '<div style="flex:0 0 auto">' + control + '</div>' +
      '</div>';
  }

  function inputHTML(id, value, min, max, unit) {
    return '<input id="' + id + '" type="number" value="' + value + '" min="' + min +
      '" max="' + max + '" style="width:64px;padding:6px 8px;border-radius:8px;' +
      'border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;' +
      'font-size:14px;text-align:center;outline:none">' +
      '<span style="font-size:13px;opacity:.6;margin-left:4px">' + unit + '</span>';
  }

  function switchHTML(id, on) {
    return '<div id="' + id + '" data-on="' + (on ? '1' : '0') + '" style="width:48px;height:28px;' +
      'border-radius:14px;background:' + (on ? '#34c759' : 'rgba(128,128,128,.4)') + ';' +
      'position:relative;transition:background .2s;cursor:pointer">' +
      '<div style="position:absolute;top:2px;left:' + (on ? '22px' : '2px') + ';width:24px;height:24px;' +
      'border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .2s"></div>' +
      '</div>';
  }

  async function openFrequencySettings() {
    const st = settings();
    const f = frequencyStatus();
    const diag = (window.Bg && typeof Bg.diagnose === 'function')
      ? ((await Bg.diagnose()) || { supported: false })
      : { supported: false };

    const momentDesc = st.autoMoment
      ? ('今日已发 ' + f.moment.used + '/' + (f.moment.cap || '∞') + '，下次约 ' + fmtMin(f.moment.nextInMs))
      : '已关闭';
    const letterDesc = st.autoLetter
      ? ('今日已发 ' + f.letter.used + '/' + (f.letter.cap || '∞') + '，下次约 ' + fmtMin(f.letter.nextInMs))
      : '已关闭';

    let body = '';
    body += '<div style="font-size:13px;opacity:.55;margin:4px 0 8px">自动化频率</div>';
    body += rowHTML('朋友圈最小间隔', momentDesc, inputHTML('cxFreqMoment', st.momentIntervalMin, 1, 1440, '分'));
    body += rowHTML('朋友圈每日上限', '0 = 不限', inputHTML('cxCapMoment', st.momentDailyCap, 0, 99, '条'));
    body += rowHTML('信件最小间隔', letterDesc, inputHTML('cxFreqLetter', st.letterIntervalMin, 1, 1440, '分'));
    body += rowHTML('信件每日上限', '0 = 不限', inputHTML('cxCapLetter', st.letterDailyCap, 0, 99, '封'));
    body += '<div style="font-size:12px;opacity:.5;margin:8px 0 4px">免打扰时段固定为 23:00 – 07:00</div>';

    body += '<div style="font-size:13px;opacity:.55;margin:18px 0 8px">后台保活</div>';
    body += rowHTML('启用后台保活', '离开应用后仍尝试按时触发', switchHTML('cxSwKeep', st.bgKeepAlive));
    body += rowHTML('静音音频兜底', '部分移动端可防冻结，较耗电', switchHTML('cxSwAudio', st.bgSilentAudio));
    body += rowHTML('后台触发时通知', '需要通知权限', switchHTML('cxSwNotify', st.bgNotifyTest));
    body += rowHTML('保活自检间隔', '0 = 关闭自检', inputHTML('cxTestMin', st.bgTestReminderMin, 0, 240, '分'));

    body += '<div style="font-size:13px;opacity:.55;margin:18px 0 8px">运行环境</div>';
    body += '<div id="cxDiagBox" style="font-size:12.5px;line-height:1.75;opacity:.75;' +
      'background:rgba(128,128,128,.1);padding:10px 12px;border-radius:10px;' +
      'white-space:pre-wrap;word-break:break-all">' + diagText(diag) + '</div>';

    body += '<div style="font-size:11.5px;opacity:.45;line-height:1.6;margin-top:12px">' +
      'Service Worker 保活上限约 5 分钟，超过 5 分钟的任务只会在你回到应用时补发。<br>' +
      'iOS 必须「添加到主屏幕」并手动授权通知；Android 建议允许后台活动与通知。</div>';

    const modal = openModal({
      title: '频率与保活',
      bodyHTML: body,
      bottom: '<button id="cxTestBtn" style="flex:1;padding:12px;border-radius:12px;border:none;' +
        'background:rgba(128,128,128,.18);color:inherit;font-size:15px">测试保活</button>' +
        '<button id="cxInstallBtn" style="flex:1;padding:12px;border-radius:12px;border:none;' +
        'background:rgba(128,128,128,.18);color:inherit;font-size:15px">添加到主屏幕</button>'
    });

    function diagText(d) {
      const lines = [];
      lines.push('SW 支持：' + (d.supported ? '是' : '否'));
      lines.push('已受控：' + (d.controlled ? '是' : '否'));
      lines.push('SW 版本：' + (d.swVersion || '—'));
      lines.push('通知权限：' + (d.permission || '未知'));
      lines.push('独立窗口(PWA)：' + (d.standalone ? '是' : '否'));
      lines.push('保活开关：' + (d.keepAliveOn ? '开' : '关'));
      lines.push('SW 待执行：' + ((d.swTasks && d.swTasks.length) || 0) + ' 个');
      return lines.join('\n');
    }

    async function refreshDiag() {
      const box = document.getElementById('cxDiagBox');
      if (!box) return;
      const d = (window.Bg && typeof Bg.diagnose === 'function')
        ? ((await KeepAlive.diagnose()) || { supported: false })
        : { supported: false };
      box.textContent = diagText(d);
    }

    // 输入框提交
    function bindNum(id, key, defMin, defMax) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        let v = Number(el.value);
        if (!isFinite(v)) v = DEFAULTS[key];
        v = Math.min(defMax, Math.max(defMin, v));
        el.value = v;
        patchSettings({ [key]: v });
        toast && toast('已保存');
        refreshDiag();
      });
    }
    bindNum('cxFreqMoment', 'momentIntervalMin', 1, 1440);
    bindNum('cxCapMoment', 'momentDailyCap', 0, 99);
    bindNum('cxFreqLetter', 'letterIntervalMin', 1, 1440);
    bindNum('cxCapLetter', 'letterDailyCap', 0, 99);
    bindNum('cxTestMin', 'bgTestReminderMin', 0, 240);

    // 开关
    function bindSwitch(id, key, onChange) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function () {
        const on = el.dataset.on !== '1';
        el.dataset.on = on ? '1' : '0';
        el.style.background = on ? '#34c759' : 'rgba(128,128,128,.4)';
        const knob = el.firstElementChild;
        if (knob) knob.style.left = on ? '22px' : '2px';
        patchSettings({ [key]: on });
        if (onChange) onChange(on);
        refreshDiag();
      });
    }
    bindSwitch('cxSwKeep', 'bgKeepAlive');
    bindSwitch('cxSwAudio', 'bgSilentAudio', function (on) {
      if (on) KeepAlive.startSilentAudio();
      else KeepAlive.stopSilentAudio();
    });
    bindSwitch('cxSwNotify', 'bgNotifyTest');

    // 测试保活
    const testBtn = document.getElementById('cxTestBtn');
    if (testBtn) {
      testBtn.addEventListener('click', function () {
        const btn = testBtn;
        btn.textContent = '测试中…（10 秒）';
        btn.disabled = true;
        KeepAlive.test(10).then(function (r) {
          btn.disabled = false;
          btn.textContent = '测试保活';
          const mode = r && r.mode ? r.mode : '未知';
          if (r && r.ok) {
            toast && toast('保活测试已启动（' + mode + '），10 秒后请确认');
          } else {
            toast && toast('保活测试失败：' + ((r && r.reason) || '未知原因'));
          }
          refreshDiag();
        }).catch(function () {
          btn.disabled = false;
          btn.textContent = '测试保活';
          toast && toast('保活测试异常');
        });
      });
    }

    // 添加到主屏幕
    const instBtn = document.getElementById('cxInstallBtn');
    if (instBtn) {
      instBtn.addEventListener('click', function () {
        const ev = window.__deferredInstall;
        if (ev && typeof ev.prompt === 'function') {
          ev.prompt();
          window.__deferredInstall = null;
          if (modal && modal.close) modal.close();
        } else {
          openModal({
            title: '添加到主屏幕',
            text: 'iOS Safari：点「分享」→「添加到主屏幕」。\n\n' +
              'Android Chrome：点右上角「⋮」→「添加到主屏幕 / 安装应用」。\n\n' +
              '添加后从桌面图标打开，后台通知与保活才可靠。'
          });
        }
      });
    }

    // 面板打开时刷新一次诊断
    setTimeout(refreshDiag, 200);
    return modal;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__deferredInstall = e;
    log('已捕获安装提示事件');
  });/* ============================================================
   启动
   ============================================================ */
function boot() {
  const st = settings();

  // 1) 后台保活
  if (st.bgKeepAlive) {
    if (window.Bg) {
      KeepAlive.enable({ askPermission: false });
      log('后台保活已按设置恢复');
    } else {
      log('未找到 window.Bg —— 请确认 ./v2/bg-bridge.js 在 patch-features.js 之前引入');
    }
  }

  // 2) 恢复定时任务（把上次未完成的时刻表重新挂上）
  try {
    Scheduler.rescheduleAll();
  } catch (e) {
    log('恢复定时任务失败', e);
  }

  // 3) 清理过期的一起听邀请（超过 24h 仍 pending 的置为 superseded）
  try {
    expireStaleInvites();
    syncInviteButton();
  } catch (e) {
    log('清理过期邀请失败', e);
  }

  // 4) 首次使用提示
  try {
    if (readLS(LS.NOTICED, '') !== '1') {
      writeLS(LS.NOTICED, '1');
      setTimeout(function () {
        if (typeof toast === 'function') {
          toast('已启用：一起听去重 / 频率控制 / 订单去重 / 后台保活', 2600);
        }
      }, 1200);
    }
  } catch (e) {}

  log('补丁加载完成 v' + VERSION);
}

/* ============================================================
   对外导出（方便在控制台调试）
   ============================================================ */
window.CXPatch = {
  version: VERSION,
  DEFAULTS: DEFAULTS,

  // 设置
  settings: settings,
  patchSettings: patchSettings,

  // 需求 1：一起听去重
  canInviteTogether: canInviteTogether,
  isListeningTogether: isListeningTogether,
  onInviteAccepted: onInviteAccepted,
  syncInviteButton: syncInviteButton,
  shouldGenerateIncomingInvite: shouldGenerateIncomingInvite,
  inviteStatusText: inviteStatusText,
  expireStaleInvites: expireStaleInvites,

  // 需求 2：频率控制
  checkAllow: checkAllow,
  allowAutoMoment: allowAutoMoment,
  allowAutoLetter: allowAutoLetter,
  noteMomentPosted: noteMomentPosted,
  noteLetterPosted: noteLetterPosted,
  frequencyStatus: frequencyStatus,
  inQuietHours: inQuietHours,

  // 需求 3：订单推送去重
  allowOrderPush: allowOrderPush,
  settleOrder: settleOrder,
  maybePushOrderRandom: maybePushOrderRandom,
  pushKey: pushKey,

  // 需求 4：后台保活
  KeepAlive: KeepAlive,
  Scheduler: Scheduler,
  openFrequencySettings: openFrequencySettings,

  // 调试
  diagnose: async function () {
    const out = {};
    try {
      out.version = VERSION;
      out.settings = settings();
      out.frequency = frequencyStatus();
      out.quotaMoment = quotaGet(LS.QUOTA_MOMENT);
      out.quotaLetter = quotaGet(LS.QUOTA_LETTER);
      out.invites = {};
      const inv = readLS(LS.INVITE, {}) || {};
      Object.keys(inv).forEach(function (k) {
        out.invites[k] = { status: inv[k].status, at: inv[k].at };
      });
      out.pushHistory = (readLS(LS.PUSH_HIST, []) || []).length;
      out.keepAlive = await KeepAlive.diagnose();
      out.scheduler = await Scheduler.status();
      out.bg = (window.Bg && window.Bg.diagnose)
        ? await window.Bg.diagnose()
        : { ok: false, reason: 'no-bg-bridge' };
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    try { console.log('[CXPatch.diagnose]', out); } catch (e) {}
    return out;
  },
  manualFireMoment: function () { return fireAutoMoment('manual'); },
  manualFireLetter: function () { return fireAutoLetter('manual'); }
};

/* ============================================================
   启动入口
   ============================================================ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();