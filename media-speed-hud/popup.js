/* =============================================================================
 * Media Speed HUD — popup（v1.2.0）
 * 只保留两块：当前速度控制、本页快捷键开关。其余设置在 options 页。
 * ============================================================================= */

const K_SETTINGS = 'settings';
const K_SITEOFF = 'siteOff';

const PRESET_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];

const $ = (s) => document.querySelector(s);

let tab = null;
let origin = '';
let current = 1;
let settings = {};

const el = {
  pageInfo: $('#pageInfo'),
  rateValue: $('#rateValue'),
  slider: $('#slider'),
  presets: $('#presets'),
  swSiteOff: $('#swSiteOff'),
  siteNote: $('#siteNote'),
  statusLine: $('#statusLine'),
  btnMinus: $('#btnMinus'),
  btnPlus: $('#btnPlus')
};

function fmt(r) {
  const n = Math.round(r * 100) / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}×`;
}

function renderRate(rate) {
  current = Math.round(rate * 100) / 100;
  el.rateValue.textContent = fmt(current);
  el.slider.value = String(Math.min(Math.max(current, Number(el.slider.min)), Number(el.slider.max)));
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('active', Math.abs(Number(c.dataset.rate) - current) < 1e-6);
  });
}

function renderPresets() {
  el.presets.innerHTML = '';
  for (const rate of PRESET_RATES) {
    if (rate < settings.min || rate > settings.max) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.rate = String(rate);
    b.textContent = fmt(rate);
    b.classList.toggle('active', Math.abs(rate - current) < 1e-6);
    b.addEventListener('click', () => applyRate(rate));
    el.presets.appendChild(b);
  }
}

function status(text, warn) {
  el.statusLine.textContent = text;
  el.statusLine.classList.toggle('warn', !!warn);
}

async function sendToTab(msg) {
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    return null; // 该标签页没有注入内容脚本（扩展页 / 应用商店 / PDF 等）
  }
}

async function applyRate(rate) {
  const res = await sendToTab({ type: 'vsh:set', rate, kind: 'set' });
  if (res && res.ok) {
    renderRate(res.rate);
    status('');
  } else {
    status('无法连接页面，刷新后再试', true);
  }
}

async function refreshLive() {
  const res = await sendToTab({ type: 'vsh:query' });
  if (!res) {
    origin = '';
    el.pageInfo.textContent = '此页面不可注入（扩展页 / 应用商店 / PDF）';
    setControlsEnabled(false);
    status('本页只可调设置，不能控制媒体', true);
    return;
  }

  setControlsEnabled(true);
  status('');
  try {
    origin = new URL(res.url).origin;
  } catch (err) {
    origin = '';
  }

  const title = (res.title || '').trim();
  el.pageInfo.textContent = `${res.count || 0} 个媒体 · ${title.length > 34 ? title.slice(0, 34) + '…' : title || '(无标题)'}`;
  renderRate(res.rate ?? 1);
  await refreshSiteOff();
}

function setControlsEnabled(on) {
  const nodes = [el.slider, el.btnMinus, el.btnPlus, el.presets];
  for (const n of nodes) {
    n.style.opacity = on ? '1' : '0.4';
    n.style.pointerEvents = on ? 'auto' : 'none';
  }
}

async function refreshSiteOff() {
  if (!origin) return;
  const stored = await chrome.storage.local.get([K_SITEOFF]);
  const map = stored[K_SITEOFF] || {};
  el.swSiteOff.checked = !!map[origin];
  el.siteNote.textContent = el.swSiteOff.checked ? `已禁用：${origin}` : '站点快捷键冲突时打开';
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

el.slider.addEventListener('input', () => renderRate(Number(el.slider.value)));
el.slider.addEventListener('change', () => applyRate(Number(el.slider.value)));

el.btnMinus.addEventListener('click', () => applyRate(current - (settings.step || 0.1)));
el.btnPlus.addEventListener('click', () => applyRate(current + (settings.step || 0.1)));

document.querySelectorAll('.quick .chip').forEach((c) => {
  c.addEventListener('click', () => applyRate(Number(c.dataset.rate)));
});

el.swSiteOff.addEventListener('change', async () => {
  if (!origin) {
    el.swSiteOff.checked = false;
    status('本页无法注入，不能设置例外', true);
    return;
  }
  const stored = await chrome.storage.local.get([K_SITEOFF]);
  const map = stored[K_SITEOFF] || {};
  if (el.swSiteOff.checked) map[origin] = true;
  else delete map[origin];
  await chrome.storage.local.set({ [K_SITEOFF]: map });
  el.siteNote.textContent = el.swSiteOff.checked ? `已禁用：${origin}` : '站点快捷键冲突时打开';
});

$('#btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async () => {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.sync.get([K_SETTINGS])
  ]);

  tab = tabs[0] || null;
  settings = stored[K_SETTINGS] || {};

  el.slider.min = String(settings.min ?? 0.1);
  el.slider.max = String(settings.max ?? 4);
  renderRate(1);
  renderPresets();

  if (!tab) {
    el.pageInfo.textContent = '没有活动标签页';
    setControlsEnabled(false);
    return;
  }
  await refreshLive();
})();
