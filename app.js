// ===== IndexedDB =====
const DB_NAME = 'FilamentDB';
const DB_VERSION = 2;

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('templates')) {
        const ts = db.createObjectStore('templates', { keyPath: 'id', autoIncrement: true });
        ts.createIndex('brand', 'brand', { unique: false });
      }
      if (!db.objectStoreNames.contains('spools')) {
        const ss = db.createObjectStore('spools', { keyPath: 'id', autoIncrement: true });
        ss.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('consumptions')) {
        const cs = db.createObjectStore('consumptions', { keyPath: 'id', autoIncrement: true });
        cs.createIndex('spoolId', 'spoolId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }

function idbReq(os) {
  return new Promise((resolve, reject) => {
    const req = os;
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ===== Data Operations =====

// Templates
async function getTemplates() {
  const all = await idbReq(tx('templates', 'readonly').getAll());
  return all || [];
}

async function getTemplate(id) {
  return idbReq(tx('templates', 'readonly').get(id));
}

async function saveTemplate(data) {
  data.updatedAt = new Date().toISOString();
  if (data.id) {
    return idbReq(tx('templates', 'readwrite').put(data));
  } else {
    data.createdAt = new Date().toISOString();
    return idbReq(tx('templates', 'readwrite').add(data));
  }
}

async function deleteTemplate(id) {
  return idbReq(tx('templates', 'readwrite').delete(id));
}

// Spools
async function getSpools() {
  const all = await idbReq(tx('spools', 'readonly').getAll());
  return (all || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function getSpool(id) {
  return idbReq(tx('spools', 'readonly').get(id));
}

async function saveSpool(data) {
  data.updatedAt = new Date().toISOString();
  if (data.id) {
    return idbReq(tx('spools', 'readwrite').put(data));
  } else {
    data.createdAt = new Date().toISOString();
    if (!data.consumedWeight) data.consumedWeight = 0;
    return idbReq(tx('spools', 'readwrite').add(data));
  }
}

async function deleteSpool(id) {
  // delete all related consumptions
  const cs = await getConsumptions(id);
  const st = tx('consumptions', 'readwrite');
  await Promise.all(cs.map(c => idbReq(st.delete(c.id))));
  return idbReq(tx('spools', 'readwrite').delete(id));
}

// Consumptions
async function getConsumptions(spoolId) {
  const all = await idbReq(tx('consumptions', 'readonly').getAll());
  return (all || []).filter(c => c.spoolId === spoolId).sort((a, b) => b.time.localeCompare(a.time));
}

async function addConsumption(data) {
  data.time = new Date().toISOString();
  return idbReq(tx('consumptions', 'readwrite').add(data));
}

async function deleteConsumption(id) {
  return idbReq(tx('consumptions', 'readwrite').delete(id));
}

// Settings
async function getSetting(key) {
  return idbReq(tx('settings', 'readonly').get(key));
}
async function setSetting(key, value) {
  return idbReq(tx('settings', 'readwrite').put({ key, value }));
}

// ===== Backup (Download) =====
const BACKUP_FILENAME = '3d-filament-backup.json';
const APP_VERSION = 'v1.1.0';

let isDirty = false;

async function markDataChanged() {
  const now = new Date().toISOString();
  await setSetting('lastChange', now);
  isDirty = true;
  updateBackupStatus();
}

async function backupNow() {
  try {
    const templates = await getTemplates();
    const spools = await getSpools();
    const allConsumptions = [];
    for (const s of spools) {
      const cs = await getConsumptions(s.id);
      allConsumptions.push(...cs);
    }

    const backupData = { version: 1, lastBackup: new Date().toISOString(), templates, spools, consumptions: allConsumptions };
    const json = JSON.stringify(backupData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = BACKUP_FILENAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const now = new Date().toISOString();
    await setSetting('lastBackup', now);
    isDirty = false;
    updateBackupStatus();
    toast('备份完成');
  } catch (err) {
    console.error(err);
    toast('备份失败，请重试');
  }
}

async function restoreFromBackup() {
  if (!('showOpenFilePicker' in window)) {
    toast('浏览器不支持，请用 Chrome/Edge/华为浏览器');
    return;
  }

  let file;

  try {
    const [fh] = await window.showOpenFilePicker({
      types: [{ description: '备份文件', accept: { 'application/json': ['.json'] } }],
      multiple: false
    });
    file = await fh.getFile();
  } catch (err) {
    if (err.name !== 'AbortError') toast('读取文件失败');
    return;
  }

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.version || !data.templates || !data.spools) {
      toast('备份文件格式不正确');
      return;
    }

    let count = { templates: 0, spools: 0, consumptions: 0 };

    const tpls = await getTemplates();
    for (const t of tpls) await deleteTemplate(t.id);
    const spls = await getSpools();
    for (const s of spls) {
      const cs = await getConsumptions(s.id);
      for (const c of cs) await deleteConsumption(c.id);
      await idbReq(tx('spools', 'readwrite').delete(s.id));
    }

    const tplIdMap = {};
    for (const t of data.templates) {
      const newId = await idbReq(tx('templates', 'readwrite').add({
        brand: t.brand, material: t.material, color: t.color,
        source: t.source || '', initWeight: t.initWeight || 1000,
        createdAt: t.createdAt || new Date().toISOString(),
        updatedAt: t.updatedAt || new Date().toISOString()
      }));
      tplIdMap[t.id] = newId;
      count.templates++;
    }

    const spoolIdMap = {};
    for (const s of data.spools) {
      const newId = await idbReq(tx('spools', 'readwrite').add({
        brand: s.brand, material: s.material, color: s.color,
        source: s.source || '', initWeight: s.initWeight || 1000,
        consumedWeight: s.consumedWeight || 0,
        dryDate: s.dryDate || null,
        createdAt: s.createdAt || new Date().toISOString(),
        updatedAt: s.updatedAt || new Date().toISOString()
      }));
      spoolIdMap[s.id] = newId;
      count.spools++;
    }

    for (const c of (data.consumptions || [])) {
      await idbReq(tx('consumptions', 'readwrite').add({
        spoolId: spoolIdMap[c.spoolId] || c.spoolId,
        amount: c.amount,
        time: c.time || new Date().toISOString()
      }));
      count.consumptions++;
    }

    closeModal('modal-backup-restore');
    isDirty = false;
    await setSetting('lastBackup', new Date().toISOString());
    await renderInventory();
    await renderTemplates();
    updateBackupStatus();
    closePrivacyWarning();
    toast(`恢复完成: ${count.templates} 模板, ${count.spools} 耗材, ${count.consumptions} 记录`);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      toast('恢复失败: ' + (err.message || '文件格式错误'));
    }
  }
}

// ===== Backup Status Bar =====
async function updateBackupStatus() {
  const statusEl = document.getElementById('backup-status');
  const btnEl = document.getElementById('backup-bar-actions');
  if (!statusEl) return;

  const setting = await getSetting('lastBackup');
  const lastTime = setting ? setting.value : null;
  const timeStr = lastTime ? fmtTimeShort(lastTime) : '-';

  if (isDirty) {
    statusEl.className = 'backup-bar backup-dirty';
    statusEl.innerHTML = `🔴 需备份`;
  } else if (lastTime) {
    statusEl.className = 'backup-bar backup-active';
    statusEl.innerHTML = `🔒 已备份 · ${BACKUP_FILENAME} · <span class="backup-hint" title="文件已保存到浏览器默认下载目录">${timeStr}</span>`;
  } else {
    statusEl.className = 'backup-bar backup-active';
    statusEl.innerHTML = `📁 尚未备份`;
  }

  if (btnEl) {
    btnEl.innerHTML = `
      <button class="btn-backup-sm ${isDirty ? 'btn-backup-primary' : ''}" onclick="backupNow()">💾 备份</button>
      <button class="btn-backup-sm" onclick="openModal('modal-backup-restore')">🔄 恢复</button>`;
  }
}

function fmtTimeShort(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${h}:${mi}`;
}

// ===== Privacy Mode Detection =====
async function checkPrivacyMode() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota && est.quota < 150 * 1024 * 1024) return true;
    }
  } catch (_) {}
  return false;
}

function showPrivacyWarning() { document.getElementById('privacy-warning').style.display = 'flex'; }
function closePrivacyWarning() { const el = document.getElementById('privacy-warning'); if (el) el.style.display = 'none'; }

// ===== Utility =====
function fmtDate(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDateTime(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  return fmtDate(isoStr) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

function daysSince(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.remove('show'), 2000);
}

// ===== Modal Helper =====
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ===== Confirm Dialog =====
let confirmCallback = null;
function showConfirm(msg, cb) {
  document.getElementById('confirm-message').textContent = msg;
  confirmCallback = cb;
  openModal('modal-confirm');
}

// ===== Inventory Page =====
async function renderInventory() {
  const spools = await getSpools();
  const listEl = document.getElementById('inventory-list');
  const emptyEl = document.getElementById('inventory-empty');

  document.getElementById('total-spools').textContent = spools.length;

  // 按材料类型计算总剩余量
  const materialTotals = {};
  let totalRemaining = 0;
  spools.forEach(s => {
    const remaining = (s.initWeight || 0) - (s.consumedWeight || 0);
    totalRemaining += remaining;
    const mat = s.material || '其他';
    if (!materialTotals[mat]) materialTotals[mat] = 0;
    materialTotals[mat] += remaining;
  });

  // 显示总剩余量（超过 1kg 用 kg 显示）
  const displayTotal = totalRemaining >= 1000
    ? (totalRemaining / 1000).toFixed(1) + 'kg'
    : totalRemaining.toFixed(1) + 'g';
  document.getElementById('total-remaining').textContent = displayTotal;

  // 显示按材料类型分类的剩余量
  const breakdownEl = document.getElementById('remaining-breakdown');
  const sortedMats = Object.keys(materialTotals).sort((a, b) => a.localeCompare(b, 'zh'));
  if (sortedMats.length > 0) {
    breakdownEl.innerHTML = sortedMats.map(mat => {
      const val = materialTotals[mat];
      const displayVal = val >= 1000 ? (val / 1000).toFixed(1) + 'kg' : val.toFixed(1) + 'g';
      return `<span class="remaining-breakdown-tag">${escHtml(mat)} ${displayVal}</span>`;
    }).join('');
  } else {
    breakdownEl.innerHTML = '';
  }

  if (spools.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  // 按品牌分组，品牌内按材料类型分组
  const brandGroups = {};
  spools.forEach(s => {
    const brand = s.brand || '未分类';
    if (!brandGroups[brand]) brandGroups[brand] = {};
    const mat = s.material || '其他';
    if (!brandGroups[brand][mat]) brandGroups[brand][mat] = [];
    brandGroups[brand][mat].push(s);
  });

  const sortedBrands = sortBrandKeys(Object.keys(brandGroups));

  function spoolCard(s) {
    const remaining = (s.initWeight || 0) - (s.consumedWeight || 0);
    let remainClass = 'remaining';
    if (remaining <= 0) remainClass += ' remaining-empty';
    else if (remaining < s.initWeight * 0.2) remainClass += ' remaining-low';

    const ds = daysSince(s.dryDate);
    let dryText = '';
    let dryClass = '';
    if (s.dryDate) {
      dryText = `上次烘干: ${fmtDate(s.dryDate)} (${ds}天前)`;
      dryClass = ds > 30 ? 'dry-warning' : 'dry-ok';
    } else {
      dryText = '未烘干';
      dryClass = 'dry-ok';
    }

    return `
      <div class="card" onclick="openSpoolDetail(${s.id})">
        <div class="card-header">
          <div>
            <div class="card-title">${colorSwatchHTML(s.color, 22)} ${escHtml(colorName(s.color))}</div>
            <div class="card-subtitle">${escHtml(s.source || '未填渠道')}</div>
          </div>
          <div class="${remainClass}">${remaining.toFixed(1)}g</div>
        </div>
        <div class="card-tags">
          <span class="tag tag-material">${escHtml(s.material)}</span>
        </div>
        <div class="card-footer">
          <span>录入: ${fmtDate(s.createdAt)}</span>
          <span class="${dryClass}">${dryText}</span>
        </div>
      </div>
    `;
  }

  let html = '';
  sortedBrands.forEach(brand => {
    const matGroups = brandGroups[brand];
    const totalInBrand = Object.values(matGroups).reduce((sum, arr) => sum + arr.length, 0);
    const sortedMats = Object.keys(matGroups).sort((a, b) => a.localeCompare(b, 'zh'));
    const brandKey = brand.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');

    html += `<div class="group-header brand-header" data-toggle="brand-${brandKey}">
      <div class="group-header-left">
        <span class="group-toggle" data-toggle="brand-${brandKey}">▼</span>
        <span class="group-title">${escHtml(brand)}</span>
      </div>
      <span class="group-count">${totalInBrand}卷</span>
    </div>`;
    html += `<div class="group-body" id="body-brand-${brandKey}">`;

    sortedMats.forEach(mat => {
      const items = matGroups[mat];
      const matKey = brandKey + '-' + mat.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');

      html += `<div class="group-subheader material-subheader" data-toggle="mat-${matKey}">
        <span class="group-toggle" data-toggle="mat-${matKey}">▼</span>
        <span>${escHtml(mat)} · ${items.length}卷</span>
      </div>`;
      html += `<div class="group-body" id="body-mat-${matKey}">`;
      html += items.map(spoolCard).join('');
      html += `</div>`;
    });

    html += `</div>`;
  });

  listEl.innerHTML = html;
}

// Event delegation for group header toggles - inventory
document.getElementById('inventory-list').addEventListener('click', function(e) {
  handleGroupToggle(e);
});

// Event delegation for group header toggles - template list
document.getElementById('template-list').addEventListener('click', function(e) {
  handleGroupToggle(e);
  // Also prevent triggering edit/delete on template card body
  if (e.target.closest('[data-toggle]')) return;
});

function handleGroupToggle(e) {
  const toggleEl = e.target.closest('[data-toggle]');
  if (!toggleEl) return;
  const bodyId = toggleEl.dataset.toggle;
  const body = document.getElementById('body-' + bodyId);
  if (!body) return;

  body.classList.toggle('collapsed');
  const parent = toggleEl.closest('.group-header, .group-subheader');
  if (parent) {
    parent.querySelectorAll('.group-toggle').forEach(icon => {
      icon.classList.toggle('collapsed', body.classList.contains('collapsed'));
    });
  }
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 品牌预设排序（和下拉菜单顺序一致）
const BRAND_ORDER = ['Bambu Lab', '彩格', 'Polymaker', 'SunLu', 'R3D'];

// 颜色预设：10 组共 58 色（B 方案 + 金属色系）
const COLOR_GROUPS = [
  {
    label: '无彩色',
    colors: [
      { name: '白', hex: '#FFFFFF' },
      { name: '乳白', hex: '#F8F4EE' },
      { name: '象牙白', hex: '#F5F0E0' },
      { name: '浅灰', hex: '#C8C8C8' },
      { name: '中灰', hex: '#888888' },
      { name: '深灰', hex: '#505050' },
      { name: '黑', hex: '#1A1A1A' }
    ]
  },
  {
    label: '红色系',
    colors: [
      { name: '浅粉', hex: '#F8BBD0' },
      { name: '桃粉', hex: '#F48FB1' },
      { name: '珊瑚粉', hex: '#FF8A80' },
      { name: '粉红', hex: '#E91E63' },
      { name: '红', hex: '#E53935' },
      { name: '砖红', hex: '#C62828' },
      { name: '深红', hex: '#B71C1C' },
      { name: '酒红', hex: '#7B1F2B' }
    ]
  },
  {
    label: '橙色系',
    colors: [
      { name: '浅橙', hex: '#FFCC80' },
      { name: '橙', hex: '#FF9800' },
      { name: '深橙', hex: '#E65100' },
      { name: '赤陶', hex: '#B15533' }
    ]
  },
  {
    label: '黄色系',
    colors: [
      { name: '浅黄', hex: '#FFF9C4' },
      { name: '黄', hex: '#FFEB3B' },
      { name: '金黄', hex: '#FFC107' },
      { name: '深黄', hex: '#F9A825' }
    ]
  },
  {
    label: '绿色系',
    colors: [
      { name: '黄绿', hex: '#9CCC65' },
      { name: '草绿', hex: '#66BB6A' },
      { name: '薄荷绿', hex: '#4DB6AC' },
      { name: '绿', hex: '#43A047' },
      { name: '翠绿', hex: '#00897B' },
      { name: '深绿', hex: '#2E7D32' },
      { name: '墨绿', hex: '#1B5E20' }
    ]
  },
  {
    label: '青色系',
    colors: [
      { name: '浅青', hex: '#80DEEA' },
      { name: '青', hex: '#00BCD4' },
      { name: '深青', hex: '#00838F' }
    ]
  },
  {
    label: '蓝色系',
    colors: [
      { name: '天蓝', hex: '#64B5F6' },
      { name: '冰蓝', hex: '#B3E5FC' },
      { name: '蓝', hex: '#1E88E5' },
      { name: '宝蓝', hex: '#1565C0' },
      { name: '靛蓝', hex: '#283593' },
      { name: '深蓝', hex: '#0D47A1' },
      { name: '藏青', hex: '#1A237E' }
    ]
  },
  {
    label: '紫色系',
    colors: [
      { name: '浅紫', hex: '#CE93D8' },
      { name: '紫', hex: '#8E24AA' },
      { name: '深紫', hex: '#4A148C' },
      { name: '品红', hex: '#C2185B' }
    ]
  },
  {
    label: '棕色系',
    colors: [
      { name: '米色', hex: '#F5DEB3' },
      { name: '沙色', hex: '#D2B48C' },
      { name: '驼色', hex: '#C4A882' },
      { name: '浅棕', hex: '#A1887F' },
      { name: '可可棕', hex: '#5D4037' },
      { name: '深棕', hex: '#3E2723' }
    ]
  },
  {
    label: '金属色',
    colors: [
      { name: '金', hex: '#FFD700' },
      { name: '太空银', hex: '#C0C4C8' },
      { name: '铜', hex: '#B87333' },
      { name: '古铜', hex: '#8B6F47' },
      { name: '玫瑰金', hex: '#E0BFB8' },
      { name: '香槟金', hex: '#F7E7CE' },
      { name: '铁灰', hex: '#717B84' },
      { name: '青铜', hex: '#725C3A' }
    ]
  }
];

// 扁平化：所有预设色块
const COLOR_PRESETS = [];
COLOR_GROUPS.forEach(g => { g.colors.forEach(c => COLOR_PRESETS.push(c)); });

// 色名 → hex 快速查表
const COLOR_NAME_MAP = {};
COLOR_PRESETS.forEach(c => { COLOR_NAME_MAP[c.name] = c.hex; });
// 常见别名（兼容旧数据）
COLOR_NAME_MAP['白色'] = '#FFFFFF';
COLOR_NAME_MAP['黑色'] = '#1A1A1A';
COLOR_NAME_MAP['红色'] = '#E53935';
COLOR_NAME_MAP['橙色'] = '#FF9800';
COLOR_NAME_MAP['黄色'] = '#FFEB3B';
COLOR_NAME_MAP['绿色'] = '#43A047';
COLOR_NAME_MAP['青色'] = '#00BCD4';
COLOR_NAME_MAP['蓝色'] = '#1E88E5';
COLOR_NAME_MAP['紫色'] = '#8E24AA';
// 旧拓竹色号兼容
COLOR_NAME_MAP['竹绿'] = '#00AE42';
COLOR_NAME_MAP['热粉'] = '#F5547C';
COLOR_NAME_MAP['沙漠棕'] = '#E8DBB7';
COLOR_NAME_MAP['丁香紫'] = '#AE96D4';
COLOR_NAME_MAP['海军蓝'] = '#0078BF';
COLOR_NAME_MAP['拿铁棕'] = '#D3B7A7';
COLOR_NAME_MAP['勃艮第红'] = '#951E23';
COLOR_NAME_MAP['橄榄'] = '#789D4A';
COLOR_NAME_MAP['蔚蓝'] = '#489FDF';
COLOR_NAME_MAP['橘黄'] = '#FFC72C';
COLOR_NAME_MAP['橘'] = '#FF6A13';
COLOR_NAME_MAP['正红'] = '#D32941';
COLOR_NAME_MAP['洋红'] = '#AF1685';
COLOR_NAME_MAP['砖红'] = '#9F332A';
COLOR_NAME_MAP['紫罗兰'] = '#583061';
COLOR_NAME_MAP['孔雀绿'] = '#16B08E';
COLOR_NAME_MAP['钛灰'] = '#565656';
COLOR_NAME_MAP['水银'] = '#9EA2A2';
COLOR_NAME_MAP['葡萄冻'] = '#D6ABFF';
COLOR_NAME_MAP['水晶蓝'] = '#7EB4E1';
COLOR_NAME_MAP['火焰浅'] = '#F1AAA8';
COLOR_NAME_MAP['火焰深'] = '#D21B3C';
COLOR_NAME_MAP['冰晶白'] = '#FFFFEE';
COLOR_NAME_MAP['冰晶蓝'] = '#40B6E4';

// 合并所有色名到快速查询表（含预设 + 别名）
function buildAllColorMap() {
  return { ...COLOR_NAME_MAP };
}
let ALL_COLOR_MAP = null;
function getAllColorMap() {
  if (!ALL_COLOR_MAP) ALL_COLOR_MAP = buildAllColorMap();
  return ALL_COLOR_MAP;
}

// 兼容旧数据：color 为字符串 → 转为对象
function normalizeColor(color) {
  if (!color) return { name: '', hex: '#888888' };
  if (typeof color === 'object' && color.hex) return color;
  // 旧数据：纯字符串
  const name = color.trim();
  const map = getAllColorMap();
  const hex = map[name]
    || map[name.replace('色', '')]
    || '#888888';
  return { name: name.replace('色', ''), hex };
}

// 获取颜色的 hex
function colorHex(color) {
  return normalizeColor(color).hex;
}

// 获取颜色的显示名
function colorName(color) {
  return normalizeColor(color).name;
}

// 生成颜色方块 HTML
function colorSwatchHTML(color, size) {
  const { hex, name } = normalizeColor(color);
  const s = size || 20;
  const isWhite = hex.toLowerCase() === '#ffffff' || hex.toLowerCase() === '#fff';
  const extraBorder = isWhite ? 'border-color:#bbb' : '';
  return `<span class="color-swatch" style="width:${s}px;height:${s}px;background:${escHtml(hex)};${extraBorder}" title="${escHtml(name)}"></span>`;
}

// ===== Color Picker =====

// 渲染颜色选择器：按分组显示全部 58 色预设 → 其他
function renderColorPicker(swatchContainerId, colorInputId) {
  const container = document.getElementById(swatchContainerId);
  if (!container) return;

  let html = '';
  COLOR_GROUPS.forEach(group => {
    html += `<span class="color-section-label">${group.label}</span>`;
    group.colors.forEach(c => {
      const isWhite = c.hex.toUpperCase() === '#FFFFFF' || c.hex.toUpperCase() === '#FFF9C4' || c.hex.toUpperCase() === '#FFFFEE';
      const border = isWhite ? 'border-color:#bbb' : '';
      html += `<button type="button" class="color-swatch-btn" data-color-name="${escHtml(c.name)}" data-color-hex="${escHtml(c.hex)}" title="${escHtml(c.name)}" style="background:${escHtml(c.hex)};${border}"></button>`;
    });
  });

  const otherHtml = `<button type="button" class="color-swatch-btn color-swatch-other" data-color-name="__other__" data-color-hex="" title="其他颜色">+</button>`;
  container.innerHTML = html + otherHtml;
}

// 颜色选择器：获取当前选中值
function getColorPickerValue(swatchContainerId, colorInputId) {
  const container = document.getElementById(swatchContainerId);
  if (!container) return { name: '', hex: '#888888' };
  
  // 输入框有值 → 优先使用（支持用户修改预设名）
  const nameInput = colorInputId ? document.getElementById(colorInputId) : null;
  const customName = nameInput ? nameInput.value.trim() : '';

  const sel = container.querySelector('.selected');
  if (!sel) return { name: customName || '', hex: '#888888' };
  
  const dataName = sel.dataset.colorName;
  if (dataName === '__other__') {
    return { name: customName || '自定义', hex: '#FFFFFF' };
  }
  
  return { name: customName || dataName, hex: sel.dataset.colorHex };
}

// 颜色选择器：设置选中值
function setColorPickerValue(swatchContainerId, colorInputId, color) {
  const container = document.getElementById(swatchContainerId);
  if (!container) return;
  const { name, hex } = normalizeColor(color);

  container.querySelectorAll('.selected').forEach(b => b.classList.remove('selected'));

  // try to match in current swatches (both basics and specials)
  const preset = container.querySelector(`[data-color-name="${escHtml(name)}"]`);
  if (preset) {
    preset.classList.add('selected');
    showCustomColorInputs(colorInputId, true, hex);
    const nameInput = colorInputId ? document.getElementById(colorInputId) : null;
    if (nameInput) { nameInput.value = name; nameInput.dataset.userTyped = ''; }
    return;
  }

  // not found in swatches → treat as custom
  if (name) {
    const otherBtn = container.querySelector('[data-color-name="__other__"]');
    if (otherBtn) otherBtn.classList.add('selected');
    const nameInput = colorInputId ? document.getElementById(colorInputId) : null;
    if (nameInput) { nameInput.value = name; nameInput.dataset.userTyped = '1'; }
    showCustomColorInputs(colorInputId, true);
  }
}

// 颜色选择器：重置
function resetColorPicker(swatchContainerId, colorInputId) {
  const container = document.getElementById(swatchContainerId);
  if (!container) return;
  container.querySelectorAll('.selected').forEach(b => b.classList.remove('selected'));
  if (colorInputId) {
    const nameInput = document.getElementById(colorInputId);
    if (nameInput) { nameInput.value = ''; nameInput.dataset.userTyped = ''; }
    showCustomColorInputs(colorInputId, false);
  }
}

// 显示/隐藏自定义颜色输入框
// show=false 隐藏；show=true 显示，可传 hex 控制预览色块
function showCustomColorInputs(colorInputId, show, hex) {
  const customRow = document.getElementById(colorInputId.replace('-custom-name', '-custom-row'));
  if (!customRow) return;
  customRow.style.display = show ? 'flex' : 'none';
  if (show) {
    const preview = document.getElementById(colorInputId.replace('-custom-name', '-custom-preview'));
    if (preview) {
      preview.style.background = hex || '#FFFFFF';
      preview.style.borderColor = (hex && hex.toUpperCase() !== '#FFFFFF' && hex.toUpperCase() !== '#FFF') ? '' : '#bbb';
    }
  }
}

// 初始化所有颜色选择器
function initColorPickers() {
  initSingleColorPicker('spool-color-swatches', 'spool-color-custom-name');
  initSingleColorPicker('template-color-swatches', 'template-color-custom-name');
}

function initSingleColorPicker(swatchContainerId, colorInputId) {
  const container = document.getElementById(swatchContainerId);
  if (!container) return;

  // 首次渲染
  renderColorPicker(swatchContainerId, colorInputId);

  // 色块点击事件（事件委托）
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.color-swatch-btn');
    if (!btn) return;
    const name = btn.dataset.colorName;

    if (name === '__other__') {
      // "其他" → 选中并显示白色块+文本输入
      container.querySelectorAll('.selected').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const nameInput = document.getElementById(colorInputId);
      if (nameInput) { nameInput.value = ''; nameInput.dataset.userTyped = ''; }
      showCustomColorInputs(colorInputId, true);
      return;
    }

    // 预设色块：选中并显示名称输入框（预填预设名，用户可修改）
    container.querySelectorAll('.selected').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const hex = btn.dataset.colorHex;
    showCustomColorInputs(colorInputId, true, hex);
    const nameInput = document.getElementById(colorInputId);
    if (nameInput) { nameInput.value = name; nameInput.dataset.userTyped = ''; }
  });

  // 名称输入框：跟踪用户输入
  const nameInput = document.getElementById(colorInputId);
  if (nameInput) {
    nameInput.addEventListener('input', function() {
      nameInput.dataset.userTyped = '1';
    });
  }
}

// 按品牌预设顺序排序
function sortByBrand(a, b) {
  const ia = BRAND_ORDER.indexOf(a);
  const ib = BRAND_ORDER.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b, 'zh');
}

// 品牌排序：预设品牌在前，其余按拼音，未分类放最后
function sortBrandKeys(keys) {
  return keys.sort((a, b) => {
    if (a === '未分类') return 1;
    if (b === '未分类') return -1;
    return sortByBrand(a, b);
  });
}

// select-with-other: get actual value from select+input combo
function getSelectValue(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return '';
  const val = sel.value;
  if (val === '__other__') {
    const otherId = sel.dataset.other;
    const otherInput = otherId ? document.getElementById(otherId) : null;
    return otherInput ? otherInput.value.trim() : '';
  }
  return val;
}

// select-with-other: set value (preset or custom)
function setSelectValue(selectId, value) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const otherId = sel.dataset.other;
  const otherInput = otherId ? document.getElementById(otherId) : null;

  // check if value is a preset option
  let isPreset = false;
  for (const opt of sel.options) {
    if (opt.value === value) { isPreset = true; break; }
  }

  if (isPreset) {
    sel.value = value;
    if (otherInput) { otherInput.value = ''; otherInput.style.display = 'none'; }
  } else if (value) {
    sel.value = '__other__';
    if (otherInput) { otherInput.value = value; otherInput.style.display = 'block'; }
  } else {
    sel.value = '';
    if (otherInput) { otherInput.value = ''; otherInput.style.display = 'none'; }
  }
}

// select-with-other: reset to empty/default
function resetSelectValue(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.value = '';
  const otherId = sel.dataset.other;
  const otherInput = otherId ? document.getElementById(otherId) : null;
  if (otherInput) { otherInput.value = ''; otherInput.style.display = 'none'; }
}

// Set up all select-with-other toggles
function setupSelectOther() {
  document.querySelectorAll('.select-with-other').forEach(sel => {
    const otherId = sel.dataset.other;
    const otherInput = otherId ? document.getElementById(otherId) : null;
    if (!otherInput) return;

    // initialize: hide by default
    otherInput.style.display = 'none';

    sel.addEventListener('change', () => {
      if (sel.value === '__other__') {
        otherInput.style.display = 'block';
        otherInput.focus();
      } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
      }
    });
  });
}

// ===== Add / Edit Spool =====
async function openAddSpool() {
  document.getElementById('spool-edit-id').value = '';
  document.querySelector('#modal-add-spool .modal-header h2').textContent = '新增耗材';

  // populate template select
  const templates = await getTemplates();
  // 按品牌排序
  templates.sort((a, b) => {
    const c = sortByBrand(a.brand || '', b.brand || '');
    if (c !== 0) return c;
    return (a.material || '').localeCompare(b.material || '', 'zh');
  });
  const select = document.getElementById('spool-template-select');
  select.innerHTML = '<option value="">-- 选择模板或手动填写 --</option>' +
    templates.map(t => `<option value="${t.id}">${escHtml(t.brand)} | ${escHtml(t.material)} | ${escHtml(colorName(t.color))} | ${t.initWeight}g</option>`).join('');

  // reset form
  resetSelectValue('spool-brand-select');
  resetSelectValue('spool-material-select');
  resetColorPicker('spool-color-swatches', 'spool-color-custom-name');
  resetSelectValue('spool-source-select');
  document.getElementById('spool-init-weight').value = '1000';
  document.getElementById('spool-dry-date').value = '';

  openModal('modal-add-spool');
}

async function editSpool(id) {
  closeModal('modal-spool-detail');
  const s = await getSpool(id);
  if (!s) return;

  document.getElementById('spool-edit-id').value = s.id;
  document.querySelector('#modal-add-spool .modal-header h2').textContent = '编辑耗材';

  // populate template select (don't auto-fill, let user choose to override)
  const templates = await getTemplates();
  // 按品牌排序
  templates.sort((a, b) => {
    const c = sortByBrand(a.brand || '', b.brand || '');
    if (c !== 0) return c;
    return (a.material || '').localeCompare(b.material || '', 'zh');
  });
  const select = document.getElementById('spool-template-select');
  select.innerHTML = '<option value="">-- 点击模板覆盖当前值 --</option>' +
    templates.map(t => `<option value="${t.id}">${escHtml(t.brand)} | ${escHtml(t.material)} | ${escHtml(colorName(t.color))} | ${t.initWeight}g</option>`).join('');

  setSelectValue('spool-brand-select', s.brand || '');
  setSelectValue('spool-material-select', s.material || '');
  setColorPickerValue('spool-color-swatches', 'spool-color-custom-name', s.color);
  setSelectValue('spool-source-select', s.source || '');
  document.getElementById('spool-init-weight').value = s.initWeight || 1000;
  document.getElementById('spool-dry-date').value = s.dryDate || '';

  openModal('modal-add-spool');
}

document.getElementById('spool-template-select').addEventListener('change', async function() {
  const id = parseInt(this.value);
  if (!id) return;
  const t = await getTemplate(id);
  if (!t) return;
  setSelectValue('spool-brand-select', t.brand || '');
  setSelectValue('spool-material-select', t.material || '');
  setColorPickerValue('spool-color-swatches', 'spool-color-custom-name', t.color);
  setSelectValue('spool-source-select', t.source || '');
  document.getElementById('spool-init-weight').value = t.initWeight || 1000;
});

document.getElementById('btn-save-spool').addEventListener('click', async () => {
  const brand = getSelectValue('spool-brand-select');
  const material = getSelectValue('spool-material-select');
  const color = getColorPickerValue('spool-color-swatches', 'spool-color-custom-name');
  const source = getSelectValue('spool-source-select');
  const initWeight = parseFloat(document.getElementById('spool-init-weight').value);
  const dryDate = document.getElementById('spool-dry-date').value || null;
  const editId = document.getElementById('spool-edit-id').value;

  if (!brand || !material || !color.name || isNaN(initWeight) || initWeight <= 0) {
    toast('请填写品牌、材料类型、颜色和有效的初始重量');
    return;
  }

  if (editId) {
    // 编辑模式：保留已有的消耗数据
    const existing = await getSpool(parseInt(editId));
    const data = {
      id: parseInt(editId),
      brand, material, color, source, initWeight, dryDate,
      consumedWeight: existing ? (existing.consumedWeight || 0) : 0,
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    };
    await saveSpool(data);
  } else {
    await saveSpool({ brand, material, color, source, initWeight, dryDate, consumedWeight: 0 });
  }

  closeModal('modal-add-spool');
  toast(editId ? '耗材已更新' : '耗材已添加');
  renderInventory();
  markDataChanged();
  // 如果之前打开了详情，刷新详情
  if (editId && currentSpoolId === parseInt(editId)) {
    renderDetailInfo();
  }
});

// ===== Spool Detail =====
let currentSpoolId = null;

async function openSpoolDetail(id) {
  currentSpoolId = id;
  const s = await getSpool(id);
  if (!s) return;

  const remaining = (s.initWeight || 0) - (s.consumedWeight || 0);
  const ds = daysSince(s.dryDate);
  const dryInfo = s.dryDate
    ? `${fmtDate(s.dryDate)} (距今 ${ds} 天，${ds > 30 ? '建议烘干' : '正常'})`
    : '未记录';

  document.getElementById('detail-title').textContent = s.brand + ' ' + s.material;
  document.getElementById('detail-info').innerHTML = `
    <div class="detail-row"><span class="label">品牌</span><span class="value">${escHtml(s.brand)}</span></div>
    <div class="detail-row"><span class="label">材料类型</span><span class="value">${escHtml(s.material)}</span></div>
    <div class="detail-row"><span class="label">颜色</span><span class="value">${colorSwatchHTML(s.color, 18)} ${escHtml(colorName(s.color))}</span></div>
    <div class="detail-row"><span class="label">购买渠道</span><span class="value">${escHtml(s.source || '未填写')}</span></div>
    <div class="detail-row"><span class="label">初始重量</span><span class="value">${s.initWeight.toFixed(1)}g</span></div>
    <div class="detail-row"><span class="label">累计消耗</span><span class="value">${(s.consumedWeight || 0).toFixed(1)}g</span></div>
    <div class="detail-row"><span class="label">剩余量</span><span class="value" style="color:${remaining <= 0 ? 'var(--danger)' : 'var(--success)'};font-size:18px;">${remaining.toFixed(1)}g</span></div>
    <div class="detail-row"><span class="label">录入时间</span><span class="value">${fmtDateTime(s.createdAt)}</span></div>
    <div class="detail-row divider"><span class="label">烘干时间</span><span class="value">${dryInfo}</span></div>
  `;

  document.getElementById('consumption-amount').value = '';
  renderConsumptions(id);
  openModal('modal-spool-detail');
}

async function renderConsumptions(spoolId) {
  const cs = await getConsumptions(spoolId);
  const listEl = document.getElementById('consumption-list');
  const emptyEl = document.getElementById('consumption-empty');

  if (cs.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  listEl.innerHTML = cs.map(c => `
    <div class="consumption-item">
      <span class="amount">-${c.amount.toFixed(1)}g</span>
      <span class="time">${fmtDateTime(c.time)}</span>
      <button class="btn-delete-consume" data-id="${c.id}">删除</button>
    </div>
  `).join('');

  // bind delete buttons
  listEl.querySelectorAll('.btn-delete-consume').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cid = parseInt(btn.dataset.id);
      await deleteConsumption(cid);
      // recalculate
      await recalcConsumed(spoolId);
      await renderConsumptions(spoolId);
      renderDetailInfo();
      renderInventory();
      markDataChanged();
      toast('消耗记录已删除');
    });
  });
}

async function recalcConsumed(spoolId) {
  const cs = await getConsumptions(spoolId);
  const total = cs.reduce((sum, c) => sum + c.amount, 0);
  const s = await getSpool(spoolId);
  s.consumedWeight = total;
  await saveSpool(s);
}

async function renderDetailInfo() {
  if (currentSpoolId) {
    const s = await getSpool(currentSpoolId);
    await openSpoolDetail(currentSpoolId);
  }
}

document.getElementById('btn-add-consumption').addEventListener('click', async () => {
  if (!currentSpoolId) return;
  const amount = parseFloat(document.getElementById('consumption-amount').value);
  if (isNaN(amount) || amount <= 0) {
    toast('请输入有效的消耗量');
    return;
  }
  await addConsumption({ spoolId: currentSpoolId, amount });
  await recalcConsumed(currentSpoolId);
  document.getElementById('consumption-amount').value = '';
  await renderConsumptions(currentSpoolId);
  renderDetailInfo();
  renderInventory();
  markDataChanged();
  toast(`已登记消耗 ${amount.toFixed(1)}g`);
});

document.getElementById('btn-update-dry').addEventListener('click', async () => {
  if (!currentSpoolId) return;
  const today = new Date().toISOString().split('T')[0];
  const s = await getSpool(currentSpoolId);
  s.dryDate = today;
  await saveSpool(s);
  renderDetailInfo();
  renderInventory();
  markDataChanged();
  toast('烘干时间已更新为今天');
});

document.getElementById('btn-delete-spool').addEventListener('click', () => {
  showConfirm('确定要删除这卷耗材吗？相关的消耗记录也将一并删除，此操作不可恢复。', async () => {
    await deleteSpool(currentSpoolId);
    closeModal('modal-spool-detail');
    renderInventory();
    markDataChanged();
    toast('耗材已删除');
  });
});

document.getElementById('btn-edit-spool').addEventListener('click', () => {
  if (currentSpoolId) editSpool(currentSpoolId);
});

// ===== Template Page =====
async function renderTemplates() {
  const templates = await getTemplates();
  const listEl = document.getElementById('template-list');
  const emptyEl = document.getElementById('template-empty');

  if (templates.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  // 按品牌分组
  const brandGroups = {};
  templates.forEach(t => {
    const brand = t.brand || '未分类';
    if (!brandGroups[brand]) brandGroups[brand] = [];
    brandGroups[brand].push(t);
  });

  const sortedBrands = sortBrandKeys(Object.keys(brandGroups));

  let html = '';
  sortedBrands.forEach(brand => {
    const items = brandGroups[brand];
    const brandKey = 'tpl-' + brand.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');

    html += `<div class="group-header brand-header" data-toggle="tpl-brand-${brandKey}">
      <div class="group-header-left">
        <span class="group-toggle" data-toggle="tpl-brand-${brandKey}">▼</span>
        <span class="group-title">${escHtml(brand)}</span>
      </div>
      <span class="group-count">${items.length}个模板</span>
    </div>`;
    html += `<div class="group-body" id="body-tpl-brand-${brandKey}">`;

    items.forEach(t => {
      html += `
        <div class="card template-card">
          <div>
            <div class="card-title" style="font-size:14px">${colorSwatchHTML(t.color, 18)} ${escHtml(t.material)} ${escHtml(colorName(t.color))}</div>
            <div class="card-subtitle">${escHtml(t.source || '未填渠道')} · ${t.initWeight}g</div>
          </div>
          <div class="template-actions">
            <button onclick="editTemplate(${t.id})">编辑</button>
            <button class="danger" onclick="deleteTemplateConfirm(${t.id})">删除</button>
          </div>
        </div>
      `;
    });

    html += `</div>`;
  });

  listEl.innerHTML = html;
}

async function openAddTemplate() {
  document.getElementById('template-modal-title').textContent = '新建模板';
  document.getElementById('template-edit-id').value = '';
  resetSelectValue('template-brand-select');
  resetSelectValue('template-material-select');
  resetColorPicker('template-color-swatches', 'template-color-custom-name');
  resetSelectValue('template-source-select');
  document.getElementById('template-init-weight').value = '1000';
  openModal('modal-template');
}

async function editTemplate(id) {
  const t = await getTemplate(id);
  if (!t) return;
  document.getElementById('template-modal-title').textContent = '编辑模板';
  document.getElementById('template-edit-id').value = t.id;
  setSelectValue('template-brand-select', t.brand || '');
  setSelectValue('template-material-select', t.material || '');
  setColorPickerValue('template-color-swatches', 'template-color-custom-name', t.color);
  setSelectValue('template-source-select', t.source || '');
  document.getElementById('template-init-weight').value = t.initWeight || 1000;
  openModal('modal-template');
}

function deleteTemplateConfirm(id) {
  showConfirm('确定删除此模板吗？已有耗材不受影响。', async () => {
    await deleteTemplate(id);
    renderTemplates();
    markDataChanged();
    toast('模板已删除');
  });
}

document.getElementById('btn-save-template').addEventListener('click', async () => {
  const brand = getSelectValue('template-brand-select');
  const material = getSelectValue('template-material-select');
  const color = getColorPickerValue('template-color-swatches', 'template-color-custom-name');
  const source = getSelectValue('template-source-select');
  const initWeight = parseFloat(document.getElementById('template-init-weight').value);

  if (!brand || !material || !color.name || isNaN(initWeight) || initWeight <= 0) {
    toast('请填写完整的模板信息');
    return;
  }

  const data = { brand, material, color, source, initWeight };
  const editId = document.getElementById('template-edit-id').value;
  if (editId) data.id = parseInt(editId);

  await saveTemplate(data);
  closeModal('modal-template');
  renderTemplates();
  markDataChanged();
  toast(editId ? '模板已更新' : '模板已创建');
});

// ===== Tab Switching =====
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(tab.dataset.tab + '-page').classList.add('active');
  });
});

// ===== Modal Close =====
document.querySelectorAll('.modal-close, [data-close]').forEach(el => {
  el.addEventListener('click', () => {
    const modalId = el.dataset.close || el.closest('.modal').id;
    closeModal(modalId);
  });
});

// close modal on backdrop click
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal.id);
  });
});

// ===== Confirm Dialog =====
document.getElementById('btn-confirm-yes').addEventListener('click', () => {
  closeModal('modal-confirm');
  if (confirmCallback) {
    confirmCallback();
    confirmCallback = null;
  }
});

// ===== Export / Import =====
document.getElementById('btn-export').addEventListener('click', async () => {
  const templates = await getTemplates();
  const spools = await getSpools();
  const allConsumptions = [];
  for (const s of spools) {
    const cs = await getConsumptions(s.id);
    allConsumptions.push(...cs);
  }

  const templateData = templates.map(t => ({
    '品牌': t.brand,
    '材料类型': t.material,
    '颜色': colorName(t.color),
    '颜色Hex': colorHex(t.color),
    '购买渠道': t.source || '',
    '初始重量(g)': t.initWeight,
    '创建时间': t.createdAt
  }));

  const spoolData = spools.map(s => ({
    'ID': s.id,
    '品牌': s.brand,
    '材料类型': s.material,
    '颜色': colorName(s.color),
    '颜色Hex': colorHex(s.color),
    '购买渠道': s.source || '',
    '初始重量(g)': s.initWeight,
    '累计消耗(g)': (s.consumedWeight || 0).toFixed(1),
    '剩余量(g)': ((s.initWeight || 0) - (s.consumedWeight || 0)).toFixed(1),
    '烘干时间': s.dryDate || '',
    '录入时间': s.createdAt
  }));

  const consumptionData = allConsumptions.map(c => ({
    '耗材ID': c.spoolId,
    '消耗量(g)': c.amount.toFixed(1),
    '时间': c.time
  }));

  const wb = XLSX.utils.book_new();
  if (templateData.length > 0) {
    const ws1 = XLSX.utils.json_to_sheet(templateData);
    XLSX.utils.book_append_sheet(wb, ws1, '模板库');
  }
  if (spoolData.length > 0) {
    const ws2 = XLSX.utils.json_to_sheet(spoolData);
    XLSX.utils.book_append_sheet(wb, ws2, '耗材库存');
  }
  if (consumptionData.length > 0) {
    const ws3 = XLSX.utils.json_to_sheet(consumptionData);
    XLSX.utils.book_append_sheet(wb, ws3, '消耗记录');
  }

  XLSX.writeFile(wb, '耗材管理_' + new Date().toISOString().split('T')[0] + '.xlsx');
  toast('导出成功');
});

// ===== Button Bindings =====
document.getElementById('btn-add-spool').addEventListener('click', openAddSpool);
document.getElementById('btn-add-spool-empty').addEventListener('click', openAddSpool);
document.getElementById('btn-add-template').addEventListener('click', openAddTemplate);
document.getElementById('btn-add-template-empty').addEventListener('click', openAddTemplate);

// ===== Init =====
async function init() {
  await openDB();
  setupSelectOther();

  const isPrivate = await checkPrivacyMode();
  if (isPrivate) showPrivacyWarning();

  await renderInventory();
  await renderTemplates();
  await updateBackupStatus();

  // 版本号
  const vl = document.getElementById('version-label');
  if (vl) vl.textContent = APP_VERSION;

  initColorPickers();

  // SW 已于 index.html 中处理，此处不再注册
}

init();
