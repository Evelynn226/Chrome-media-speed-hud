/* =============================================================================
 * Media Speed HUD — content script (v1.2.0)
 * -----------------------------------------------------------------------------
 * 1) 快捷键调节本页媒体（video / audio）播放速度
 * 2) 视频左上角短暂显示速度提示（出现/消失/连续按键弹跳，大小与透明度可调）
 * 3) 新视频默认 1×；看过的视频按“媒体身份键”记忆并恢复，可按保留期自动淘汰
 * 4) 全屏兼容：B 站等把播放器容器 requestFullscreen 的站点，HUD 自动挂进全屏元素内部
 * ============================================================================= */

(() => {
  'use strict';

  const K_SETTINGS = 'settings';
  const K_MEMORY = 'memory';
  const K_SITEOFF = 'siteOff';

  const MEMORY_MAX = 1200;      // 记忆条目硬上限（按最近使用淘汰）
  const DEEP_EVERY = 4;         // 每 N 次扫描才穿透一次 open shadow DOM
  const SCAN_MS = 1600;         // 兜底轮询（SPA 换源）
  const MIN_VIDEO_AREA = 7000;  // 小于此面积视为装饰预览，不抢占键盘（约 100x70）
  const HTTP_RE = /^(https?|file|chrome-extension|moz-extension|data):/i;
  const EPS = 1e-3;

  const DEFAULTS = {
    enabled: true,
    step: 0.1,
    min: 0.1,
    max: 4,
    autoRestore: true,
    forceDefault: true,
    includeAudio: true,
    takeover: 'global',   // global | hover | page
    ttlDays: 30,          // 记忆保留天数（0 = 不按时间淘汰）
    hudMs: 1200,
    hudAlpha: 0.55,       // 背景不透明度 0.15 – 1
    hudSize: 1,           // 提示框整体大小 0.6 – 1.8
    showBar: true,
    showNote: true,
    scaleHud: true,
    presets: [
      { id: 'reset', label: '复原 1×', keys: ['Digit1', 'Numpad1'], action: 'set', value: 1 },
      { id: 'x2', label: '2 倍速', keys: ['Digit2', 'Numpad2'], action: 'set', value: 2 },
      { id: 'x15', label: '1.5 倍速', keys: ['Digit5', 'Numpad5'], action: 'set', value: 1.5 }
    ],
    keysDown: ['Minus', 'NumpadSubtract'],
    keysUp: ['Equal', 'NumpadAdd']
  };

  let settings = clone(DEFAULTS);
  let memory = {};
  let siteOff = {};
  let offForSite = false;
  let contextDead = false;

  const tracked = new WeakMap(); // media -> { key, sig, rate }
  const registry = new Set();    // 已知媒体元素：扫描时增量维护，按键时不再重扫全页
  const pointer = { x: -1, y: 0, at: 0 };

  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  // ------------------------------- 小工具 ---------------------------------- //

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function fmtRate(r) {
    const n = round2(r);
    return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}×`;
  }

  function normalize(stored) {
    return Object.assign(clone(DEFAULTS), stored && typeof stored === 'object' ? stored : {});
  }

  function storageGet(area, keys) {
    return new Promise((resolve) => {
      if (!hasChrome || contextDead) return resolve({});
      try {
        chrome.storage[area].get(keys, (val) => resolve(val || {}));
      } catch (err) {
        contextDead = true;
        resolve({});
      }
    });
  }

  function storageSet(area, obj) {
    if (!hasChrome || contextDead) return;
    try {
      chrome.storage[area].set(obj);
    } catch (err) {
      contextDead = true;
    }
  }

  function sendMessage(msg) {
    if (!hasChrome || contextDead) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (err) {
      contextDead = true;
    }
  }

  // -------------------------------- 启动 ----------------------------------- //

  async function boot() {
    if (!hasChrome) return;

    const [sy, lo] = await Promise.all([
      storageGet('sync', [K_SETTINGS]),
      storageGet('local', [K_MEMORY, K_SITEOFF])
    ]);

    settings = normalize(sy[K_SETTINGS]);
    memory = lo[K_MEMORY] && typeof lo[K_MEMORY] === 'object' ? lo[K_MEMORY] : {};
    siteOff = lo[K_SITEOFF] && typeof lo[K_SITEOFF] === 'object' ? lo[K_SITEOFF] : {};

    if (pruneMemory() > 0) flushMemory();
    refreshSiteOff();

    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[K_SETTINGS]) {
          settings = normalize(changes[K_SETTINGS].newValue);
          refreshSiteOff();
        } else if (area === 'local' && changes[K_MEMORY]) {
          memory = changes[K_MEMORY].newValue || {};
        } else if (area === 'local' && changes[K_SITEOFF]) {
          siteOff = changes[K_SITEOFF].newValue || {};
          refreshSiteOff();
        }
      });
    }

    attachEvents();
    scan();
  }

  function refreshSiteOff() {
    offForSite = !settings.enabled || !!siteOff[location.origin || location.href];
  }

  // ------------------- 媒体收集：轻扫 + 间隔性深度扫描 ---------------------- //

  function mediaSelector() {
    return settings.includeAudio ? 'video,audio' : 'video';
  }

  function collectMedia(deep) {
    const out = [];
    const seen = new Set();
    let visited = 0;

    const step = (root, depth) => {
      if (visited > 6000 || depth > 4) return;
      let nodes;
      try {
        nodes = root.querySelectorAll(mediaSelector());
      } catch (err) {
        return;
      }
      for (const el of nodes) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
      if (!deep) return; // querySelectorAll('*') 在大页面有成本，只在深度扫描时做
      let hosts;
      try {
        hosts = root.querySelectorAll('*');
      } catch (err) {
        return;
      }
      for (const host of hosts) {
        if (visited > 6000) return;
        visited++;
        if (host.shadowRoot) step(host.shadowRoot, depth + 1);
      }
    };

    step(document, 0);
    return out;
  }

  function refreshMedia(deep) {
    let found;
    try {
      found = collectMedia(deep);
    } catch (err) {
      try {
        found = Array.from(document.querySelectorAll(mediaSelector()));
      } catch (err2) {
        found = [];
      }
    }
    for (const el of found) registry.add(el);
    for (const el of Array.from(registry)) {
      if (!el.isConnected) registry.delete(el);
    }
  }

  function mediaList() {
    return Array.from(registry);
  }

  // ---------------------- 媒体身份键（“看过的视频”对号） -------------------- //

  let pageIdCache = { id: '', url: '' };

  /** 页面级 id，缓存后避免每次扫描重复解析 URL */
  function pageId() {
    const url = location.href;
    if (pageIdCache.url === url) return pageIdCache.id;

    const host = location.hostname.replace(/^www\./, '');
    const paths = decodeURIComponent(location.pathname || '');
    const params = new URLSearchParams(location.search);
    let id = '';

    if (/youtube\.com$|youtube-nocookie\.com$|youtu\.be$/.test(host)) {
      const v = params.get('v') ||
        (paths.match(/\/(shorts|embed|live|v)\/([\w-]{6,})/) || [])[2] ||
        (paths.match(/\/watch\/([\w-]{6,})/) || [])[1];
      if (v) id = `yt:${v}`;
    } else if (/bilibili\.(com|tv)$/.test(host)) {
      const bv = paths.match(/\/(BV[0-9A-Za-z]{8,})/);
      const av = paths.match(/\/av(\d{3,})/i);
      const p = params.get('p');
      if (bv) id = `bili:${bv[1]}${p ? ':' + p : ''}`;
      else if (av) id = `bili:av${av[1]}${p ? ':' + p : ''}`;
    }

    if (!id) {
      for (const name of ['v', 'video', 'videoId', 'vid', 'id', 'media', 'source']) {
        const val = params.get(name);
        if (val && val.length >= 5 && val.length <= 128) {
          id = `q:${name}=${val}`;
          break;
        }
      }
    }
    if (!id) id = `p:${paths.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'}`;

    pageIdCache = { id, url };
    return id;
  }

  function computeKey(el, raw, dur) {
    // 有真实地址 → origin + pathname（忽略 ?query：签名、时间戳不会让记忆失效）
    if (typeof raw === 'string' && HTTP_RE.test(raw)) {
      try {
        const u = new URL(raw, location.href);
        return `s|${u.origin}|${u.pathname}`;
      } catch (err) {
        /* 继续走页面 id 方案 */
      }
    }
    // blob: / MediaSource（YouTube、B 站等）→ 域名 + 元素类型 + 视频 id + 时长
    const d = Number.isFinite(dur) && dur > 0 ? Math.round(dur * 10) / 10 : 0;
    return `p|${location.hostname.replace(/^www\./, '')}|${el.tagName.toLowerCase()}|${pageId()}|${d}`;
  }

  function signatureOf(el) {
    return `${el.currentSrc || el.src || ''}\u0000${el.duration}`;
  }

  /** 带签名缓存的身份键：src / 时长未变就复用，避免重复构造 URL 对象 */
  function keyOf(el, t) {
    const sig = signatureOf(el);
    if (t && t.sig === sig && t.key) return t.key;
    return computeKey(el, el.currentSrc || el.src || '', el.duration);
  }

  function mediaReady(raw, dur) {
    return HTTP_RE.test(raw || '') || (Number.isFinite(dur) && dur > 0);
  }

  // ------------- 选“当前这个视频”：PiP > 获焦 > 悬停 > 播放中 > 面积 --------- //

  function isPointerOver(r) {
    if (pointer.x < 0 || performance.now() - pointer.at > 4000) return false;
    return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
  }

  /** 候选媒体：一次性测量 rect，避免同一元素重复读取布局 */
  function candidates() {
    const out = [];
    for (const el of mediaList()) {
      const r = el.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      const isAudio = el.tagName === 'AUDIO';
      const onScreen = r.width > 8 && r.height > 8 &&
        r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      if (!onScreen) continue;
      if (!isAudio && area < MIN_VIDEO_AREA) continue;
      if (el.muted && el.paused && area < MIN_VIDEO_AREA * 4) continue;
      out.push({ el, r, area });
    }
    return out;
  }

  function pickMedia() {
    const cands = candidates();
    if (!cands.length) return null;

    const pip = document.pictureInPictureElement;
    let best = cands[0];
    let bestScore = -Infinity;

    for (const c of cands) {
      let score = c.area;
      if (pip === c.el) score += 9e9;
      if (document.activeElement === c.el) score += 7e9;
      if (isPointerOver(c.r)) score += 6e9;
      if (!c.el.paused) score += 5e9;
      if (c.el.tagName === 'AUDIO') score += 1e9;
      if (c.el.ended) score -= 1e9;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best.el;
  }

  // ------------------------------ 速度：读取 / 设置 ------------------------- //

  function currentRate(el) {
    const r = Number(el.playbackRate);
    return Number.isFinite(r) && r > 0 ? r : 1;
  }

  /**
   * @param {HTMLMediaElement} el
   * @param {number} rate
   * @param {{silent?:boolean, restored?:boolean, note?:string, kind?:string}} opts
   */
  function setRate(el, rate, opts = {}) {
    const next = clamp(round2(rate), settings.min, settings.max);
    const prev = currentRate(el);

    try {
      el.playbackRate = next;
    } catch (err) {
      return null;
    }

    const t = tracked.get(el) || {};
    if (!t.key) {
      t.key = keyOf(el, t);
      t.sig = signatureOf(el);
    }
    t.rate = next;
    tracked.set(el, t);

    if (!opts.silent) {
      persistMemory(t.key, next);
      const kind = opts.kind ||
        (opts.restored ? 'restored' : next > prev + EPS ? 'up' : next < prev - EPS ? 'down' : 'flat');
      showHud(el, next, kind, opts.note);
    }
    sendMessage({ type: 'vsh:rate', rate: next });
    return next;
  }

  // ------------------------------ 记忆读写与淘汰 --------------------------- //

  let memTimer = 0;

  function persistMemory(key, rate) {
    if (!hasChrome || contextDead || !key) return;
    memory[key] = { rate: round2(rate), ts: Date.now() };
    clearTimeout(memTimer);
    memTimer = setTimeout(flushMemory, 350);
  }

  function flushMemory() {
    clearTimeout(memTimer);
    if (!hasChrome || contextDead) return;
    pruneMemory();
    const keys = Object.keys(memory);
    if (keys.length > MEMORY_MAX) {
      keys.sort((a, b) => (memory[a].ts || 0) - (memory[b].ts || 0));
      for (let i = 0; i < keys.length - MEMORY_MAX; i++) delete memory[keys[i]];
    }
    storageSet('local', { [K_MEMORY]: memory });
  }

  /** 按“最近使用时间”淘汰陈旧记忆（ttlDays = 0 时不按时间淘汰） */
  function pruneMemory() {
    const days = Number(settings.ttlDays) || 0;
    // cutoff 用 -1 而不是 Infinity，否则 ttlDays = 0 会把记忆全部删光
    const cutoff = days > 0 ? Date.now() - days * 86400000 : -1;
    let removed = 0;
    for (const k of Object.keys(memory)) {
      const v = memory[k];
      if (!v || typeof v.rate !== 'number' || !Number.isFinite(v.rate) ||
          typeof v.ts !== 'number' || v.ts < cutoff) {
        delete memory[k];
        removed++;
      }
    }
    return removed;
  }

  // -------------------- 新视频 / SPA 换视频：恢复记忆或回 1× ---------------- //

  function adoptNewMedia(el, key) {
    const t = tracked.get(el) || {};
    t.key = key;
    t.sig = signatureOf(el);
    tracked.set(el, t);

    if (!mediaReady(el.currentSrc || el.src || '', el.duration)) {
      t.rate = currentRate(el); // 元数据未就绪：等 loadedmetadata 再定稿
      return;
    }

    const saved = memory[key];
    const savedRate = saved && typeof saved.rate === 'number' ? saved.rate : null;

    if (savedRate !== null && settings.autoRestore && Math.abs(savedRate - 1) > EPS) {
      setRate(el, savedRate, { restored: true, note: '已恢复上次速度' });
      return;
    }

    if (settings.forceDefault || savedRate !== null) {
      const target = clamp(savedRate !== null ? savedRate : 1, settings.min, settings.max);
      if (Math.abs(currentRate(el) - target) > EPS) {
        try {
          el.playbackRate = target;
        } catch (err) {
          /* 少数加密播放器会拒绝写入，忽略 */
        }
      }
    }
    t.rate = currentRate(el);
    sendMessage({ type: 'vsh:rate', rate: t.rate });
  }

  let scanTick = 0;

  /** 扫描页面：发现新媒体 / SPA 换源 / 站点自行改速 */
  function scan() {
    if (contextDead || document.hidden) return; // 后台标签页不做任何布局读取

    refreshMedia(++scanTick % DEEP_EVERY === 1);

    for (const el of mediaList()) {
      const t = tracked.get(el);
      const key = keyOf(el, t);

      if (!t) {
        adoptNewMedia(el, key);
        continue;
      }
      if (t.key !== key) {
        adoptNewMedia(el, key); // 同一个 <video> 换了视频（连播）
        continue;
      }
      const now = currentRate(el);
      if (Math.abs(now - (t.rate ?? 1)) > EPS) persistMemory(t.key, now); // 采纳站点自带倍速
      t.rate = now;
    }
  }

  // ------------------------------ 键盘快捷键 ------------------------------ //

  function resolveAction(e) {
    const code = e.code || '';
    const key = e.key || '';

    for (const p of settings.presets || []) {
      if (!p || !Array.isArray(p.keys)) continue;
      if (p.keys.includes(code) || p.keys.includes(key)) {
        const v = Number(p.value);
        return { kind: v === 1 ? 'reset' : 'set', value: v };
      }
    }
    if ((settings.keysDown || []).includes(code) || (settings.keysDown || []).includes(key)) {
      return { kind: 'down', delta: -Math.abs(settings.step), note: `−${Math.abs(settings.step)}` };
    }
    if ((settings.keysUp || []).includes(code) || (settings.keysUp || []).includes(key)) {
      return { kind: 'up', delta: Math.abs(settings.step), note: `+${Math.abs(settings.step)}` };
    }
    return null;
  }

  function takeoverAllowed() {
    if (settings.takeover !== 'hover') return true;
    if (document.pictureInPictureElement) return true;
    for (const c of candidates()) {
      if (document.activeElement === c.el || isPointerOver(c.r)) return true;
    }
    return false;
  }

  function isTypingTarget(target) {
    if (!target) return false;
    if (target.nodeType && target.nodeType !== 1) target = target.parentElement;
    if (!target) return false;
    const tag = (target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const type = (target.getAttribute('type') || '').toLowerCase();
      return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
    }
    if (target.isContentEditable) return true;
    if (!target.getAttribute) return false;
    return target.getAttribute('contenteditable') === 'true' || target.getAttribute('role') === 'textbox';
  }

  function onKeyDown(e) {
    if (contextDead || offForSite) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;

    const act = resolveAction(e);
    if (!act) return;
    if (isTypingTarget(e.target)) return;   // 正在输入文字时不抢按键
    if (!takeoverAllowed()) return;

    const el = pickMedia();
    if (!el) return;                        // 页面没有可控制媒体 → 完全放行给站点

    if (settings.takeover !== 'page') {
      e.preventDefault();
      e.stopPropagation(); // capture 阶段拦截，优先于站点自身的 1 / 2 / 5
    }

    const cur = currentRate(el);
    const next = act.delta !== undefined ? cur + act.delta : act.value;
    const kind = act.delta !== undefined
      ? act.kind
      : (next > cur + EPS ? 'up' : next < cur - EPS ? 'down' : 'reset');

    setRate(el, next, { kind, note: act.note });
  }

  // ---------------------------------------------------------------------------
  // 提示 HUD：外层只负责定位，内层卡片只负责出现/消失动画（避免 transform 冲突）
  // ---------------------------------------------------------------------------

  const hud = {
    root: null, card: null, rateEl: null, arrowEl: null, noteEl: null, barEl: null,
    target: null, hideAt: 0, raf: 0, removeTimer: 0
  };

  const ARROWS = { up: '▲', down: '▼', reset: '＝', flat: '●', restored: '↺' };

  function ensureHud() {
    if (hud.root && hud.root.isConnected) return hud.root;

    const root = document.createElement('div');
    root.className = 'vsh-hud';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<div class="vsh-card">' +
      '<div class="vsh-row"><span class="vsh-arrow"></span><span class="vsh-rate"></span></div>' +
      '<div class="vsh-note"></div>' +
      '<div class="vsh-bar"><i></i></div>' +
      '</div>';

    hud.root = root;
    hud.card = root.querySelector('.vsh-card');
    hud.rateEl = root.querySelector('.vsh-rate');
    hud.arrowEl = root.querySelector('.vsh-arrow');
    hud.noteEl = root.querySelector('.vsh-note');
    hud.barEl = root.querySelector('.vsh-bar i');
    // Keep the hidden node only while it may be reused for a quick repeat keypress.
    mountHud(true);
    return root;
  }

  /** 全屏元素如果是播放器容器，HUD 必须挂进它内部才会被绘制（Chrome 顶层层） */
  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
      document.msFullscreenElement || null;
  }

  function hostElement() {
    const fs = fullscreenElement();
    // media 元素自身全屏时无法在其上叠加 DOM，只能退回 body
    if (fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'AUDIO') return fs;
    return document.body || document.documentElement;
  }

  function mountHud(force = false) {
    // A detached, hidden HUD must stay detached; otherwise fullscreen changes
    // could put its backdrop layer back over the video after the toast expires.
    if (!hud.root || (!force && !hud.root.classList.contains('vsh-show'))) return;
    const host = hostElement();
    if (hud.root.parentElement !== host) host.appendChild(hud.root);
  }

  function showHud(el, rate, kind, note) {
    const root = ensureHud();
    clearTimeout(hud.removeTimer);
    hud.removeTimer = 0;
    hud.target = el;

    root.dataset.kind = kind || 'flat';

    const a = clamp(Number(settings.hudAlpha ?? 0.55), 0.15, 1);
    hud.card.style.setProperty('--vsh-a1', Math.min(1, a + 0.07).toFixed(3));
    hud.card.style.setProperty('--vsh-a2', a.toFixed(3));

    hud.rateEl.textContent = fmtRate(rate);
    hud.arrowEl.textContent = ARROWS[kind] || '●';
    hud.noteEl.textContent = settings.showNote
      ? (kind === 'restored' ? (note || '已恢复上次速度') : note || '')
      : '';

    root.classList.toggle('vsh-hide-bar', !settings.showBar);
    const span = Math.max(settings.max - settings.min, 0.1);
    hud.barEl.style.width = clamp(((rate - settings.min) / span) * 100, 2, 100).toFixed(1) + '%';

    root.classList.remove('vsh-show', 'vsh-bump');
    void root.offsetWidth; // 重启动画：连续按键每次都有反馈
    root.classList.add('vsh-show');
    root.setAttribute('aria-hidden', 'false');
    mountHud();
    root.classList.add('vsh-bump');

    positionHud();
    hud.hideAt = performance.now() +
      (kind === 'restored' ? Math.max(settings.hudMs, 2000) : Math.max(400, settings.hudMs));
    startTicker();
  }

  function hideHud() {
    if (hud.root) {
      const root = hud.root;
      root.classList.remove('vsh-show', 'vsh-bump');
      root.setAttribute('aria-hidden', 'true');
      clearTimeout(hud.removeTimer);
      // Let the 280 ms fade finish, then remove the overlay node entirely so
      // Chrome can restore the video's direct-composition path.
      hud.removeTimer = setTimeout(() => {
        if (hud.root === root && !hud.target && !root.classList.contains('vsh-show')) {
          root.remove();
        }
        hud.removeTimer = 0;
      }, 320);
    }
    hud.target = null;
    stopTicker();
  }

  function positionHud() {
    const el = hud.target;
    const root = hud.root;
    if (!el || !root) return stopTicker();
    if (!el.isConnected) return hideHud();

    const r = el.getBoundingClientRect();
    const visible = r.width > 8 && r.height > 8 &&
      r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    if (!visible) return hideHud();

    // 自适应缩放 × 用户设定的整体大小
    let s = clamp(Number(settings.hudSize ?? 1), 0.6, 1.8);
    if (settings.scaleHud) {
      const auto = clamp((el.tagName === 'AUDIO' ? 480 : Math.min(r.width, 1100)) / 900, 0.8, 1.25);
      s = clamp(s * auto, 0.5, 2);
    }

    // HUD 挂在全屏元素内部时，坐标基准换成该元素左上角
    const fs = fullscreenElement();
    const inFs = !!fs && root.parentElement === fs;
    const base = inFs ? fs.getBoundingClientRect() : { left: 0, top: 0 };

    const pad = Math.round(10 * s);
    const x = Math.max(4, Math.round(r.left - base.left + pad));
    const y = Math.max(4, Math.round(r.top - base.top + pad));

    root.style.transform = `translate(${x}px, ${y}px) scale(${s.toFixed(3)})`;
  }

  let rafId = 0;

  function startTicker() {
    if (rafId) return;
    const loop = () => {
      rafId = 0;
      if (!hud.root || !hud.target) return;
      if (performance.now() > hud.hideAt) {
        hideHud();
        return;
      }
      positionHud();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function stopTicker() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // ------------------------------ 事件绑定 -------------------------------- //

  let scanTimer = 0;

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function attachEvents() {
    document.addEventListener('keydown', onKeyDown, { capture: true });

    document.addEventListener('pointermove', (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.at = performance.now();
    }, { capture: true, passive: true });

    // loadstart = 换源；loadedmetadata / durationchange = 身份键可定稿
    for (const type of ['loadstart', 'loadedmetadata', 'durationchange']) {
      document.addEventListener(type, (e) => {
        const el = e.target;
        if (!el || !el.tagName) return;
        const tag = el.tagName.toUpperCase();
        if (tag !== 'VIDEO' && tag !== 'AUDIO') return;
        scheduleScan(type === 'loadedmetadata' ? 60 : 220);
      }, { capture: true });
    }

    // SPA 换视频通常伴随 DOM 变化
    if (window.MutationObserver) {
      try {
        new MutationObserver(() => scheduleScan(400))
          .observe(document.documentElement, { childList: true, subtree: true });
      } catch (err) {
        /* 个别 frame 不允许 */
      }
    }

    // 兜底轮询（SPA 只换 src 不换 DOM，YouTube 常见）；后台标签页直接跳过
    setInterval(() => {
      if (!document.hidden) scan();
    }, SCAN_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushMemory();
      else scheduleScan(200);
    });
    window.addEventListener('pagehide', flushMemory);

    // 进入 / 退出全屏：把 HUD 重新挂到正确的宿主元素上（B 站全屏就靠这一步）
    for (const type of ['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange']) {
      document.addEventListener(type, () => {
        mountHud();
        if (hud.target) positionHud();
      }, { capture: true });
    }

    const reposition = () => {
      if (hud.target) positionHud();
    };
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition, { passive: true });

    if (hasChrome && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(onMessage);
    }
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'vsh:query') {
      const el = pickMedia();
      sendResponse({
        ok: true,
        hasMedia: !!el,
        rate: el ? round2(currentRate(el)) : null,
        title: document.title,
        url: location.href,
        count: candidates().length
      });
      return true;
    }

    if (msg.type === 'vsh:set') {
      const el = pickMedia();
      if (!el) {
        sendResponse({ ok: false, reason: 'no-media' });
        return true;
      }
      sendResponse({ ok: true, rate: setRate(el, msg.rate, { kind: msg.kind, note: msg.note }) });
      return true;
    }

    return false;
  }

  boot();
})();
