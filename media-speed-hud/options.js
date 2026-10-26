/* =============================================================================
 * Media Speed HUD — options 页面
 * 所有修改自动保存（settings → storage.sync，memory / siteOff → storage.local）
 * ============================================================================= */

const K_SETTINGS = 'settings';
const K_MEMORY = 'memory';
const K_SITEOFF = 'siteOff';

const DEFAULTS = {
  enabled: true,
  step: 0.1,
  min: 0.1,
  max: 4,
  autoRestore: true,
  forceDefault: true,
  includeAudio: true,
  takeover: 'global',
  hudMs: 1200,
  hudAlpha: 0.55,
  hudSize: 1,
  showBar: true,
  showNote: true,
  scaleHud: true,
  ttlDays: 30,
  presets: [
    { id: 'reset', label: '复原 1×', keys: ['Digit1', 'Numpad1'], action: 'set', value: 1 },
    { id: 'x2', label: '2 倍速', keys: ['Digit2', 'Numpad2'], action: 'set', value: 2 },
    { id: 'x15', label: '1.5 倍速', keys: ['Digit5', 'Numpad5'], action: 'set', value: 1.5 }
  ],
  keysDown: ['Minus', 'NumpadSubtract'],
  keysUp: ['Equal', 'NumpadAdd']
};

const MEMORY_MAX = 1200;

let settings = JSON.parse(JSON.stringify(DEFAULTS));
let memory = {};
let siteOff = {};
let saveTimer = 0;
let armedRow = null; // 正在等待按键的 {kind:'preset'|'down'|'up', index}

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

function flashSaved() {
  const flag = $('#savedFlag');
  flag.classList.add('on');
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => flag.classList.remove('on'), 1200);
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({ [K_SETTINGS]: settings }, flashSaved);
  }, 180);
}

function queueLocalSave() {
  clearTimeout(queueLocalSave._t);
  queueLocalSave._t = setTimeout(() => {
    chrome.storage.local.set({ [K_MEMORY]: memory, [K_SITEOFF]: siteOff }, flashSaved);
  }, 180);
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

// ---------------------------------------------------------------------------
// 快捷键 UI
// ---------------------------------------------------------------------------

const KEY_LABELS = {
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Space: 'Space',
  BracketL: '[', BracketR: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Backquote: '`', NumpadDecimal: '小键盘 .', NumpadEnter: '小键盘 ↵'
};

function keyLabel(code) {
  if (!code) return '';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  let m = code.match(/^Numpad(.+)$/);
  if (m) return `小键盘 ${m[1]}`;
  m = code.match(/^Digit(\d)$/);
  if (m) return m[1];
  m = code.match(/^Key([A-Z])$/);
  if (m) return m[1].toLowerCase();
  return code;
}

function renderKeys() {
  const box = $('#keyRows');
  box.innerHTML = '';

  (settings.presets || []).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    row.dataset.kind = 'preset';
    row.dataset.index = String(i);

    const label = document.createElement('input');
    label.className = 'label';
    label.value = p.label || '';
    label.placeholder = '说明';
    label.addEventListener('change', () => {
      settings.presets[i].label = label.value;
      queueSave();
    });

    const value = document.createElement('input');
    value.className = 'value';
    value.type = 'number';
    value.step = '0.05';
    value.min = '0.05';
    value.max = '16';
    value.value = String(p.value);
    value.addEventListener('change', () => {
      const n = Number(value.value);
      if (!Number.isFinite(n) || n <= 0) { value.value = String(p.value); return; }
      settings.presets[i].value = Math.round(n * 100) / 100;
      settings.presets[i].action = 'set';
      // 自动生成的名称跟着速度变（用户自己改过的名字保留）
      const label = (settings.presets[i].label || '').trim();
      if (!label || /^[\d.]+\s*(×|倍速|倍)/.test(label)) {
        settings.presets[i].label = `${settings.presets[i].value}× 速度`;
      }
      queueSave();
      renderKeys();
    });

    const keys = document.createElement('div');
    keys.className = 'keys';
    renderKeyChips(keys, p.keys || [], (idx) => {
      settings.presets[i].keys.splice(idx, 1);
      queueSave();
      renderKeys();
    });
    renderCaptureChip(keys, { kind: 'preset', index: i });

    const del = document.createElement('button');
    del.className = 'btn small ghost danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      settings.presets.splice(i, 1);
      queueSave();
      renderKeys();
    });

    row.append(label, value, keys, del);
    box.appendChild(row);
  });

  // 减速 / 加速两行
  box.appendChild(stepRow('down', `减速 −${settings.step}`, settings.keysDown, (keys) => { settings.keysDown = keys; }));
  box.appendChild(stepRow('up', `加速 +${settings.step}`, settings.keysUp, (keys) => { settings.keysUp = keys; }));
}

function stepRow(kind, title, keys, onChange) {
  const row = document.createElement('div');
  row.className = 'key-row';
  row.dataset.kind = kind;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = title;

  const keysBox = document.createElement('div');
  keysBox.className = 'keys';
  renderKeyChips(keysBox, keys, (idx) => {
    const next = keys.slice();
    next.splice(idx, 1);
    onChange(next);
    queueSave();
    renderKeys();
  });
  renderCaptureChip(keysBox, { kind, index: -1 });

  const speed = document.createElement('div');
  speed.className = 'hint';
  speed.style.margin = '0';
  speed.textContent = '幅度可在左侧「微调幅度」修改';

  row.append(label, keysBox, speed);
  return row;
}

function renderKeyChips(container, keys, onRemove) {
  keys.forEach((code, idx) => {
    const k = document.createElement('kbd');
    k.className = 'rm';
    k.title = `${code}（点击移除）`;
    k.textContent = keyLabel(code);
    k.addEventListener('click', () => onRemove(idx));
    container.appendChild(k);
  });
}

function renderCaptureChip(container, target) {
  const k = document.createElement('kbd');
  k.className = 'capture';
  k.textContent = '按下按键…';
  k.title = '点击后按一个键即可添加';
  k.addEventListener('click', () => {
    if (armedRow && armedRow.el === k) { disarm(); return; }
    disarm();
    armedRow = Object.assign({}, target, { el: k });
    k.classList.add('armed');
    k.textContent = '请按键…（Esc 取消）';
  });
  container.appendChild(k);
}

function disarm() {
  if (!armedRow) return;
  if (armedRow.el) {
    armedRow.el.classList.remove('armed');
    armedRow.el.textContent = '按下按键…';
  }
  armedRow = null;
}

document.addEventListener('keydown', (e) => {
  if (!armedRow) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') { disarm(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) {
    armedRow.el.textContent = '不支持组合键，重按…';
    return;
  }

  const code = e.code || e.key;
  const t = armedRow;
  let list;
  if (t.kind === 'preset') list = (settings.presets[t.index].keys || []).slice();
  else if (t.kind === 'down') list = (settings.keysDown || []).slice();
  else list = (settings.keysUp || []).slice();

  if (!list.includes(code)) list.push(code);

  if (t.kind === 'preset') settings.presets[t.index].keys = list;
  else if (t.kind === 'down') settings.keysDown = list;
  else settings.keysUp = list;

  disarm();
  queueSave();
  renderKeys();
}, { capture: true });

$('#btnAddPreset').addEventListener('click', () => {
  settings.presets = settings.presets || [];
  settings.presets.push({ id: `p${Date.now()}`, label: '新速度', keys: [], action: 'set', value: 1.25 });
  queueSave();
  renderKeys();
});

$('#btnResetKeys').addEventListener('click', () => {
  settings.presets = cloneDefaults().presets;
  settings.keysDown = cloneDefaults().keysDown;
  settings.keysUp = cloneDefaults().keysUp;
  queueSave();
  renderKeys();
});

// ---------------------------------------------------------------------------
// 普通设置项
// ---------------------------------------------------------------------------

function bindNumber(sel, key, lo, hi) {
  const input = $(sel);
  input.addEventListener('change', () => {
    let n = Number(input.value);
    if (!Number.isFinite(n)) n = DEFAULTS[key];
    n = Math.min(hi, Math.max(lo, n));
    input.value = String(n);
    settings[key] = n;
    queueSave();
  });
}

function bindCheck(sel, key) {
  const input = $(sel);
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    queueSave();
  });
}

function renderSettings() {
  $('#stepInput').value = String(settings.step);
  $('#minInput').value = String(settings.min);
  $('#maxInput').value = String(settings.max);
  $('#hudMsInput').value = String(settings.hudMs);
  $('#alphaInput').value = String(settings.hudAlpha ?? 0.55);
  $('#alphaVal').textContent = String(settings.hudAlpha ?? 0.55);
  $('#sizeInput').value = String(settings.hudSize ?? 1);
  $('#sizeVal').textContent = Number(settings.hudSize ?? 1).toFixed(2);
  $('#ttlSel').value = String(settings.ttlDays ?? 30);
  $('#takeoverSel').value = settings.takeover;
  $('#swAudio').checked = settings.includeAudio !== false;
  $('#swBar').checked = settings.showBar !== false;
  $('#swNote').checked = settings.showNote !== false;
  $('#swScale').checked = settings.scaleHud !== false;
  $('#swRestore').checked = settings.autoRestore !== false;
  $('#swForce').checked = settings.forceDefault !== false;
  $('#swEnabled').checked = settings.enabled !== false;
  renderKeys();
}

bindNumber('#stepInput', 'step', 0.05, 1);
bindNumber('#minInput', 'min', 0.05, 1);
bindNumber('#maxInput', 'max', 1, 16);
bindNumber('#hudMsInput', 'hudMs', 400, 5000);
bindCheck('#swAudio', 'includeAudio');
bindCheck('#swBar', 'showBar');
bindCheck('#swNote', 'showNote');
bindCheck('#swScale', 'scaleHud');
bindCheck('#swRestore', 'autoRestore');
bindCheck('#swForce', 'forceDefault');
bindCheck('#swEnabled', 'enabled');

$('#takeoverSel').addEventListener('change', (e) => {
  settings.takeover = e.target.value;
  queueSave();
});

$('#alphaInput').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('#alphaVal').textContent = v.toFixed(2);
});
$('#alphaInput').addEventListener('change', (e) => {
  settings.hudAlpha = clampNum(Number(e.target.value), 0.15, 1, 0.55);
  queueSave();
});

$('#sizeInput').addEventListener('input', (e) => {
  $('#sizeVal').textContent = Number(e.target.value).toFixed(2);
});
$('#sizeInput').addEventListener('change', (e) => {
  settings.hudSize = clampNum(Number(e.target.value), 0.6, 1.8, 1);
  queueSave();
});

$('#ttlSel').addEventListener('change', (e) => {
  settings.ttlDays = Math.round(Number(e.target.value) || 0);
  queueSave();
  // 改保留期后立刻执行一次淘汰，页面上一眼就能看到变化
  pruneNow();
  renderMemory();
});

function clampNum(n, lo, hi, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function pruneNow() {
  const days = Number(settings.ttlDays) || 0;
  if (days <= 0) return;
  const cutoff = Date.now() - days * 86400000;
  for (const k of Object.keys(memory)) {
    const v = memory[k];
    if (!v || typeof v.ts !== 'number' || v.ts < cutoff) delete memory[k];
  }
  chrome.storage.local.set({ [K_MEMORY]: memory });
}

// step 改动后快捷键行文案也要更新
$('#stepInput').addEventListener('change', () => { renderKeys(); });

// ---------------------------------------------------------------------------
// 站点例外
// ---------------------------------------------------------------------------

function renderSites() {
  const box = $('#siteList');
  box.innerHTML = '';
  const list = Object.keys(siteOff);
  if (!list.length) {
    box.innerHTML = '<span class="empty">暂无例外站点</span>';
    return;
  }
  for (const origin of list) {
    const tag = document.createElement('span');
    tag.className = 'site-tag';
    const text = document.createElement('span');
    text.textContent = origin;
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.title = '移除';
    rm.addEventListener('click', () => {
      delete siteOff[origin];
      queueLocalSave();
      renderSites();
    });
    tag.append(text, rm);
    box.appendChild(tag);
  }
}

$('#btnAddSite').addEventListener('click', () => {
  const raw = $('#siteInput').value.trim();
  if (!raw) return;
  let origin;
  try {
    origin = new URL(raw.startsWith('http') ? raw : `https://${raw}`).origin;
  } catch (err) {
    $('#siteInput').value = '';
    $('#siteInput').placeholder = '格式无效，请输入完整域名或 URL';
    return;
  }
  siteOff[origin] = true;
  $('#siteInput').value = '';
  queueLocalSave();
  renderSites();
});

// ---------------------------------------------------------------------------
// 记忆管理
// ---------------------------------------------------------------------------

function renderMemory() {
  const keys = Object.keys(memory);
  let bytes = 0;
  for (const k of keys) bytes += k.length + 32;

  const ttl = Number(settings.ttlDays) || 0;
  $('#memStats').textContent =
    `${keys.length} 条记忆，约 ${(bytes / 1024).toFixed(1)} KB（存储配额 10 MB）· 条目上限 ${MEMORY_MAX} 条 · ` +
    (ttl > 0 ? `${ttl} 天未使用自动删除` : '未启用时间淘汰') +
    '。后台标签页不做页面扇描，记忆量对这个量级不会造成卡顿。';
}

$('#btnClearMemory').addEventListener('click', () => {
  if (!confirm('确定清空全部播放速度记忆？该操作不可撤销。')) return;
  memory = {};
  chrome.storage.local.set({ [K_MEMORY]: {} }, renderMemory);
  flashSaved();
});

$('#btnExport').addEventListener('click', () => {
  const payload = { app: 'media-speed-hud', version: 1, exportedAt: new Date().toISOString(), memory };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `media-speed-hud-memory-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$('#btnImport').addEventListener('click', () => $('#fileImport').click());

$('#fileImport').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming = data && data.memory ? data.memory : data;
    let n = 0;
    for (const [k, v] of Object.entries(incoming || {})) {
      if (!v || typeof v.rate !== 'number' || typeof k !== 'string') continue;
      memory[k] = { rate: Math.round(v.rate * 100) / 100, ts: Number(v.ts) || Date.now() };
      n++;
    }
    queueLocalSave();
    renderMemory();
    alert(`已导入 ${n} 条记忆`);
  } catch (err) {
    alert('导入失败：文件不是本扩展导出的 JSON');
  }
  e.target.value = '';
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async () => {
  const [sy, lo] = await Promise.all([
    chrome.storage.sync.get([K_SETTINGS]),
    chrome.storage.local.get([K_MEMORY, K_SITEOFF])
  ]);

  settings = Object.assign(cloneDefaults(), sy[K_SETTINGS] || {});
  if (!Array.isArray(settings.presets)) settings.presets = cloneDefaults().presets;
  if (!Array.isArray(settings.keysDown)) settings.keysDown = cloneDefaults().keysDown;
  if (!Array.isArray(settings.keysUp)) settings.keysUp = cloneDefaults().keysUp;

  memory = lo[K_MEMORY] && typeof lo[K_MEMORY] === 'object' ? lo[K_MEMORY] : {};
  siteOff = lo[K_SITEOFF] && typeof lo[K_SITEOFF] === 'object' ? lo[K_SITEOFF] : {};

  renderSettings();
  renderSites();
  pruneNow();
  renderMemory();
})();
