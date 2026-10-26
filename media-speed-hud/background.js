/* =============================================================================
 * Media Speed HUD — background service worker (v1.2.0)
 * 职责：
 *   1) 工具栏徽标显示各标签页当前速度
 *   2) 每天有限次地清理过期速度记忆（Service Worker 常被唤醒，加节流避免无谓 IO）
 * ============================================================================= */

const K_SETTINGS = 'settings';
const K_MEMORY = 'memory';
const K_SITEOFF = 'siteOff';
const K_LAST_PRUNE = 'lastPrune';

const MEMORY_MAX = 1200;
const PRUNE_INTERVAL = 6 * 3600 * 1000; // 至少间隔 6 小时才重复清理

/** 与 content.js / options.js 保持一致 */
const DEFAULTS = {
  enabled: true,
  step: 0.1,
  min: 0.1,
  max: 4,
  autoRestore: true,
  forceDefault: true,
  includeAudio: true,
  takeover: 'global',
  ttlDays: 30,
  hudMs: 1200,
  hudAlpha: 0.55,
  hudSize: 1,
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

let pruning = null;

async function pruneStoredMemory() {
  if (pruning) return pruning; // 去重：同一时间只做一次

  pruning = (async () => {
    const [lo, sy] = await Promise.all([
      chrome.storage.local.get([K_MEMORY, K_LAST_PRUNE]),
      chrome.storage.sync.get([K_SETTINGS])
    ]);

    const last = Number(lo[K_LAST_PRUNE]) || 0;
    if (Date.now() - last < PRUNE_INTERVAL) return;

    const memory = lo[K_MEMORY];
    if (!memory || typeof memory !== 'object') {
      await chrome.storage.local.set({ [K_LAST_PRUNE]: Date.now() });
      return;
    }

    const ttlDays = Number((sy[K_SETTINGS] && sy[K_SETTINGS].ttlDays) || 0);
    // ttlDays <= 0 表示不按时间淘汰（cutoff 用 -1，不能用 Infinity）
    const cutoff = ttlDays > 0 ? Date.now() - ttlDays * 86400000 : -1;
    let changed = false;

    for (const k of Object.keys(memory)) {
      const v = memory[k];
      if (!v || typeof v.rate !== 'number' || typeof v.ts !== 'number' || v.ts < cutoff) {
        delete memory[k];
        changed = true;
      }
    }

    const keys = Object.keys(memory);
    if (keys.length > MEMORY_MAX) {
      keys.sort((a, b) => (memory[a].ts || 0) - (memory[b].ts || 0));
      for (let i = 0; i < keys.length - MEMORY_MAX; i++) delete memory[keys[i]];
      changed = true;
    }

    const patch = { [K_LAST_PRUNE]: Date.now() };
    if (changed) patch[K_MEMORY] = memory;
    await chrome.storage.local.set(patch);
  })().catch(() => { /* 存储不可用时静默 */ });

  try {
    await pruning;
  } finally {
    pruning = null;
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.sync.get([K_SETTINGS]);
  if (!stored[K_SETTINGS]) chrome.storage.sync.set({ [K_SETTINGS]: DEFAULTS });
  if (details.reason === 'install') chrome.storage.local.set({ [K_MEMORY]: {}, [K_SITEOFF]: {} });
  await chrome.storage.local.remove(K_LAST_PRUNE); // 安装/更新后立刻允许做一次清理
  pruneStoredMemory();
});

chrome.runtime.onStartup.addListener(pruneStoredMemory);

/** 内容脚本上报速度 → 徽标 */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'vsh:rate') return;
  if (!sender.tab || sender.tab.id === undefined) return;

  const rate = Number(msg.rate);
  if (!Number.isFinite(rate) || rate <= 0) return;

  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: Math.abs(rate - 1) < 1e-3 ? '' : String(rate) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: rate > 1 ? '#3fd39b' : '#ffb35c' });
});

pruneStoredMemory();
