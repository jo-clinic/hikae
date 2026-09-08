/* カード控えアプリ PWA v0.1 — 依存ライブラリなし。すべてブラウザ標準API。 */
'use strict';
const CFG = window.APP_CONFIG;
const $ = s => document.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();

const CATEGORIES = [
  ['5110','旅費交通費'],['5120','会議費'],['5130','交際費'],['5140','消耗品費'],['5150','通信費'],
  ['5160','新聞図書費'],['5170','研修費'],['5180','広告宣伝費'],['5190','支払手数料'],['5200','水道光熱費'],
  ['5210','福利厚生費'],['5220','車両費'],['5230','雑費'],['9000','私用']
];

/* ---------- IndexedDB ---------- */
const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('hikae', 1);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        d.createObjectStore('meta');
        d.createObjectStore('receipts', { keyPath: 'id' });
        d.createObjectStore('images');
        d.createObjectStore('history', { autoIncrement: true });
      };
      r.onsuccess = () => { idb.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = idb.db.transaction(store, mode), s = t.objectStore(store);
      const q = fn(s);
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
    });
  },
  get: (s, k) => idb.tx(s, 'readonly', st => st.get(k)),
  put: (s, v, k) => idb.tx(s, 'readwrite', st => k === undefined ? st.put(v) : st.put(v, k)),
  del: (s, k) => idb.tx(s, 'readwrite', st => st.delete(k)),
  all: s => idb.tx(s, 'readonly', st => st.getAll()),
  clear: s => idb.tx(s, 'readwrite', st => st.clear()),
};

/* ---------- 暗号（合言葉 → KEK → マスターキー） ---------- */
const cryptoV = {
  master: null,
  rand: n => crypto.getRandomValues(new Uint8Array(n)),
  b64: u8 => btoa(String.fromCharCode(...u8)),
  unb64: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
  async kek(secret, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(secret.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  },
  async wrap(master, secret, salt) {
    const k = await cryptoV.kek(secret, salt), iv = cryptoV.rand(12);
    const w = new Uint8Array(await crypto.subtle.wrapKey('raw', master, k, { name: 'AES-GCM', iv }));
    return { iv: cryptoV.b64(iv), data: cryptoV.b64(w) };
  },
  async unwrap(wrapped, secret, salt) {
    const k = await cryptoV.kek(secret, salt);
    return crypto.subtle.unwrapKey('raw', cryptoV.unb64(wrapped.data), k, { name: 'AES-GCM', iv: cryptoV.unb64(wrapped.iv) },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  },
  async encrypt(u8) {
    const iv = cryptoV.rand(12);
    const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoV.master, u8));
    const out = new Uint8Array(12 + c.length); out.set(iv); out.set(c, 12); return out;
  },
  async decrypt(u8) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, cryptoV.master, u8.slice(12)));
  },
  encJSON: o => cryptoV.encrypt(enc.encode(JSON.stringify(o))),
  decJSON: async u8 => JSON.parse(dec.decode(await cryptoV.decrypt(u8))),
  recoveryCode() {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = cryptoV.rand(24);
    return Array.from(b, x => a[x % 32]).join('').match(/.{4}/g).join('-');
  },
};

/* ---------- 金庫（vault.json = salt と2通りの包んだ鍵） ---------- */
const vault = {
  async exists() { return !!(await idb.get('meta', 'vault')); },
  async setup(pass) {
    const master = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const salt = cryptoV.rand(16), rc = cryptoV.recoveryCode();
    const v = { v: 1, salt: cryptoV.b64(salt), byPass: await cryptoV.wrap(master, pass, salt), byRecovery: await cryptoV.wrap(master, rc, salt), created: new Date().toISOString() };
    await idb.put('meta', v, 'vault');
    cryptoV.master = master;
    return rc;
  },
  async unlock(secret, which = 'byPass') {
    const v = await idb.get('meta', 'vault');
    cryptoV.master = await cryptoV.unwrap(v[which], secret, cryptoV.unb64(v.salt));
    return true;
  },
  async rewrapPass(newPass) {
    const v = await idb.get('meta', 'vault');
    v.byPass = await cryptoV.wrap(cryptoV.master, newPass, cryptoV.unb64(v.salt));
    await idb.put('meta', v, 'vault');
  },
};

/* ---------- 設定・ライセンス・ネット ---------- */
const state = { online: false, lic: null, settings: null, queue: [], cur: null, driveToken: null };

async function loadSettings() {
  const raw = await idb.get('meta', 'settings');
  state.settings = raw ? await cryptoV.decJSON(raw) : { cards: [], rules: {}, license: null };
}
async function saveSettings() { await idb.put('meta', await cryptoV.encJSON(state.settings), 'settings'); }

async function checkOnline() {
  try {
    const c = new AbortController(); setTimeout(() => c.abort(), 3000);
    const r = await fetch(CFG.PROXY_URL + '/health', { signal: c.signal });
    state.online = r.ok;
  } catch { state.online = false; }
  return state.online;
}

async function verifyLicense() {
  const L = state.settings.license;
  if (!L || !L.key) { state.lic = { ok: false, reason: 'キー未設定' }; return; }
  if (state.online) {
    try {
      const r = await fetch(CFG.PROXY_URL + '/v1/license/verify', { headers: { 'X-License-Key': L.key } });
      const j = await r.json();
      if (j.ok) { L.lastVerified = Date.now(); L.plan = j.plan; L.expires = j.expires; await saveSettings(); }
      state.lic = j.ok ? { ok: true, ...j } : { ok: false, reason: j.reason };
      return;
    } catch { /* fall through to grace */ }
  }
  const days = L.lastVerified ? (Date.now() - L.lastVerified) / 86400000 : 999;
  state.lic = days <= CFG.LICENSE_GRACE_DAYS ? { ok: true, plan: L.plan, grace: true } : { ok: false, reason: 'オンラインで再確認が必要' };
}

/* ---------- Google Drive（implicit flow・リダイレクト方式） ---------- */
const drive = {
  SCOPE: 'https://www.googleapis.com/auth/drive.file',
  token() {
    const t = JSON.parse(sessionStorage.getItem('gtoken') || 'null');
    return t && t.exp > Date.now() ? t.v : null;
  },
  connect() {
    const p = new URLSearchParams({ client_id: CFG.GOOGLE_CLIENT_ID, redirect_uri: location.origin + location.pathname,
      response_type: 'token', scope: drive.SCOPE, include_granted_scopes: 'true', prompt: 'select_account' });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
  },
  catchRedirect() {
    if (!location.hash.includes('access_token')) return;
    const h = new URLSearchParams(location.hash.slice(1));
    sessionStorage.setItem('gtoken', JSON.stringify({ v: h.get('access_token'), exp: Date.now() + (+h.get('expires_in') - 60) * 1000 }));
    history.replaceState(null, '', location.pathname);
  },
  async api(url, opt = {}) {
    const t = drive.token(); if (!t) throw new Error('Drive未接続');
    opt.headers = Object.assign({ Authorization: 'Bearer ' + t }, opt.headers || {});
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error('Drive ' + r.status);
    return r;
  },
  async folder(name, parent) {
    const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
    const j = await (await drive.api('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id)')).json();
    if (j.files.length) return j.files[0].id;
    const meta = { name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : [] };
    return (await (await drive.api('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) })).json()).id;
  },
  async find(name, parent) {
    const q = `name='${name}' and '${parent}' in parents and trashed=false`;
    const j = await (await drive.api('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id)')).json();
    return j.files[0] && j.files[0].id;
  },
  async upload(name, parent, blob, mime) {
    const existing = await drive.find(name, parent);
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(existing ? {} : { name, parents: [parent] })], { type: 'application/json' }));
    fd.append('file', new Blob([blob], { type: mime }));
    const url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    return (await drive.api(url, { method: existing ? 'PATCH' : 'POST', body: fd })).json();
  },
  async download(id) { return new Uint8Array(await (await drive.api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).arrayBuffer()); },
  async sync() {
    const root = await drive.folder(CFG.DRIVE_FOLDER_NAME);
    // 1) 金庫情報（他端末での復元用。鍵そのものは合言葉/リカバリーコードがなければ開けない）
    await drive.upload('vault.json', root, JSON.stringify(await idb.get('meta', 'vault')), 'application/json');
    // 2) DB（暗号化した1ファイル）
    const receipts = await getReceipts();
    const payload = await cryptoV.encJSON({ v: 1, exported: new Date().toISOString(), receipts, settings: state.settings, history: await idb.all('history') });
    await drive.upload('db.json.enc', root, payload, 'application/octet-stream');
    // 3) 画像（未アップロード分のみ・平文）
    const orig = await drive.folder('原本', root);
    let n = 0, d = 0;
    for (const r of receipts) {
      if (r.status === 'void') {
        if (r.pendingDriveDelete && r.driveFileId) {
          try { await drive.api(`https://www.googleapis.com/drive/v3/files/${r.driveFileId}`, { method: 'DELETE' }); } catch (e) { if (!String(e).includes('404')) throw e; }
          r.driveFileId = null; r.pendingDriveDelete = false; await putReceipt(r); d++;
        }
        continue;
      }
      if (r.driveFileId) continue;
      const img = await idb.get('images', r.id); if (!img) continue;
      const ym = (r.txn_date || r.captured_utc).slice(0, 7);
      const f = await drive.folder(ym, orig);
      const j = await drive.upload(r.id + '.jpg', f, await cryptoV.decrypt(img), 'image/jpeg');
      r.driveFileId = j.id; await putReceipt(r); n++;
    }
    state.settings.lastSync = new Date().toISOString(); await saveSettings();
    return { n, d };
  },
  async restore() {
    const root = await drive.folder(CFG.DRIVE_FOLDER_NAME);
    const id = await drive.find('db.json.enc', root); if (!id) return 0;
    const d = await cryptoV.decJSON(await drive.download(id));
    for (const r of d.receipts) await putReceipt(r);
    state.settings = Object.assign(state.settings, d.settings); await saveSettings();
    return d.receipts.length;
  },
};

/* ---------- 控えデータ ---------- */
async function getReceipts() { const a = []; for (const e of await idb.all('receipts')) a.push(await cryptoV.decJSON(e.blob)); return a; }
async function putReceipt(r) { r.updated_at = new Date().toISOString(); await idb.put('receipts', { id: r.id, blob: await cryptoV.encJSON(r) }); }
async function logHistory(id, field, oldV, newV, by) { await idb.put('history', { receipt_id: id, field, old: oldV, new: newV, by, at: new Date().toISOString() }); }
const uuid = () => crypto.randomUUID();
const normMerchant = s => (s || '').toLowerCase().replace(/[\s\-_・\.,。、（）()]/g, '');

async function downscale(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const r = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = bmp.width * r; c.height = bmp.height * r;
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
}

async function extractViaProxy(blob) {
  const fd = new FormData();
  fd.append('image', blob, 'r.jpg');
  const rules = Object.entries(state.settings.rules).slice(0, 30).map(([m, code]) => ({ merchant_norm: m, code }));
  fd.append('context', JSON.stringify({ categories: CATEGORIES.map(([code, name]) => ({ code, name })), rules, cards: state.settings.cards }));
  const r = await fetch(CFG.PROXY_URL + '/v1/extract', { method: 'POST', body: fd, headers: { 'X-License-Key': state.settings.license.key, 'X-Device-Id': await deviceId() } });
  if (!r.ok) throw new Error((await r.json()).detail || r.status);
  return r.json();
}
async function deviceId() { let d = await idb.get('meta', 'device'); if (!d) { d = uuid(); await idb.put('meta', d, 'device'); } return d; }

async function handleFiles(files) {
  const canCloud = state.online && state.lic && state.lic.ok;
  for (const f of files) {
    const blob = await downscale(f);
    const id = uuid();
    await idb.put('images', await cryptoV.encrypt(new Uint8Array(await blob.arrayBuffer())), id);
    const r = { id, captured_utc: new Date().toISOString(), captured_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      entity: 'company', currency: 'JPY', status: 'pending', processing_mode: canCloud ? 'cloud' : 'local', memo: '', ai_json: null };
    if (canCloud) {
      try {
        const j = await extractViaProxy(blob);
        r.ai_json = j; r.txn_date = j.txn_date; r.merchant_raw = j.merchant; r.amount = j.amount; r.currency = j.currency || 'JPY';
        r.tax_rate = j.tax_rate; r.category = (j.category_suggestion || {}).code; r.confidence = Math.min(...Object.values(j.fields_confidence || { x: 0 }));
        if (j.entity_suggestion) r.entity = j.entity_suggestion;
        const card = state.settings.cards.find(c => c.last4 && j.card_last4 === c.last4); if (card) r.card_id = card.id;
        const known = state.settings.rules[normMerchant(j.merchant_normalized || j.merchant)]; if (known) r.category = known;
      } catch (e) { r.error = String(e.message); }
    } else { r.status = 'provisional'; }
    await putReceipt(r); state.queue.push(r);
  }
  showReview();
}

/* ---------- 画面 ---------- */
const go = id => { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + id)); document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.go === id)); if (id === 'home') renderHome(); if (id === 'list') renderList(); if (id === 'settings') renderSettings(); window.scrollTo(0, 0); };
const msg = (sel, text, cls = 'err') => { $(sel).innerHTML = text ? `<div class="msg ${cls}">${text}</div>` : ''; };
const yen = n => '¥' + Math.round(n || 0).toLocaleString('ja-JP');

async function renderHome() {
  const ym = new Date().toISOString().slice(0, 7);
  $('#home-month').textContent = ym.replace('-', '年') + '月';
  $('#st-net').textContent = state.online ? 'クラウド' : 'オフライン（端末内処理）'; $('#st-net').className = state.online ? 'on' : 'off';
  $('#st-lic').textContent = state.lic && state.lic.ok ? `ライセンス ${state.lic.plan}${state.lic.grace ? '（猶予中）' : ''}` : 'ライセンス: ' + (state.lic ? state.lic.reason : '未確認');
  $('#st-lic').className = state.lic && state.lic.ok ? 'on' : 'ng';
  $('#st-drive').textContent = drive.token() ? 'Drive接続中' : 'Drive未接続'; $('#st-drive').className = drive.token() ? 'on' : 'off';
  const all = (await getReceipts()).filter(r => r.status !== 'void');
  const prev = new Date(); prev.setDate(1); prev.setMonth(prev.getMonth() - 1); const pym = prev.toISOString().slice(0, 7);
  const inMonth = (r, m) => (r.txn_date || r.captured_utc).startsWith(m);
  const amt = r => r.currency === 'JPY' ? +r.amount || 0 : +r.amount_jpy || 0;
  const sum = (e, m) => all.filter(r => r.entity === e && inMonth(r, m)).reduce((a, r) => a + amt(r), 0);
  $('#tot-company').textContent = yen(sum('company', ym)); $('#tot-private').textContent = yen(sum('private', ym));
  const pend = all.filter(r => r.status !== 'confirmed').length;
  const prevTotal = sum('company', pym) + sum('private', pym);
  $('#pending-note').textContent = [prevTotal ? `前月（${pym.replace('-', '年')}月）合計 ${yen(prevTotal)}` : '', pend ? `未確認 ${pend} 件（一覧から開けます）` : ''].filter(Boolean).join(' ／ ');
  $('#btn-shoot').disabled = !(state.lic && state.lic.ok);
}

function showReview() {
  state.cur = state.queue.shift();
  if (!state.cur) { go('home'); return; }
  const r = state.cur;
  go('review');
  $('#rev-count').textContent = state.queue.length ? `残り ${state.queue.length}` : '';
  idb.get('images', r.id).then(async b => { $('#rev-img').src = URL.createObjectURL(new Blob([await cryptoV.decrypt(b)], { type: 'image/jpeg' })); });
  msg('#rev-msg', r.error ? '読み取りに失敗しました。手入力してください: ' + r.error : r.status === 'provisional' ? 'オフラインのため未読み取りです。手入力するか、オンライン後に再読み取りできます。' : (r.confidence < 0.8 ? '読み取りの確信度が低い項目があります。確認してください。' : ''), r.error ? 'err' : 'warn');
  setEntity(r.entity);
  $('#f-date').value = r.txn_date || ''; $('#f-amount').value = r.amount ?? ''; $('#f-cur').value = r.currency || 'JPY';
  $('#f-merchant').value = r.merchant_raw || ''; $('#f-tax').value = r.tax_rate ?? ''; $('#f-party').value = r.party_name || ''; $('#f-memo').value = r.memo || '';
  $('#f-cat').innerHTML = '<option value="">-</option>' + CATEGORIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join(''); $('#f-cat').value = r.category || '';
  $('#f-card').innerHTML = '<option value="">-</option>' + state.settings.cards.map(c => `<option value="${c.id}">${c.label} ${c.last4}</option>`).join(''); $('#f-card').value = r.card_id || '';
  const fc = (r.ai_json && r.ai_json.fields_confidence) || {};
  for (const [k, sel] of [['txn_date', '#f-date'], ['amount', '#f-amount'], ['merchant', '#f-merchant'], ['category', '#f-cat']]) $(sel).classList.toggle('lowconf', fc[k] !== undefined && fc[k] < 0.8);
}
function setEntity(e) { state.cur.entity = e; $('#seg-company').classList.toggle('on', e === 'company'); $('#seg-private').classList.toggle('on', e === 'private'); }

async function saveReview() {
  const r = state.cur, before = Object.assign({}, r);
  const f = { txn_date: $('#f-date').value, amount: +$('#f-amount').value || null, currency: $('#f-cur').value.toUpperCase() || 'JPY', merchant_raw: $('#f-merchant').value,
    category: $('#f-cat').value, tax_rate: $('#f-tax').value ? +$('#f-tax').value : null, card_id: $('#f-card').value, party_name: $('#f-party').value, memo: $('#f-memo').value };
  if (!f.txn_date || !f.amount) { msg('#rev-msg', '日付と金額は必須です'); return; }
  for (const k in f) if (before[k] !== f[k]) { await logHistory(r.id, k, before[k] ?? null, f[k], 'user'); r[k] = f[k]; }
  if (before.entity !== r.entity) await logHistory(r.id, 'entity', before.entity, r.entity, 'user');
  r.status = 'confirmed'; r.merchant_norm = normMerchant(r.merchant_raw);
  if (r.category && r.merchant_norm) state.settings.rules[r.merchant_norm] = r.category;   // 学習
  await putReceipt(r); await saveSettings();
  showReview();
}

async function renderList() {
  if (!$('#l-month').value) $('#l-month').value = new Date().toISOString().slice(0, 7);
  const ym = $('#l-month').value, ent = $('#l-entity').value;
  const rs = (await getReceipts()).filter(r => (r.txn_date || r.captured_utc).startsWith(ym) && (!ent || r.entity === ent) && r.status !== 'void').sort((a, b) => (b.txn_date || '').localeCompare(a.txn_date || ''));
  $('#l-summary').textContent = `${rs.length} 件 / 合計 ${yen(rs.reduce((a, r) => a + (r.currency === 'JPY' ? +r.amount || 0 : +r.amount_jpy || 0), 0))}`;
  const cat = Object.fromEntries(CATEGORIES);
  $('#list').innerHTML = rs.length ? '' : '<p class="muted">この月の控えはまだありません。ホームから撮影してください。</p>';
  for (const r of rs) {
    const el = document.createElement('div'); el.className = 'item ' + r.entity;
    const st = r.status === 'confirmed' ? '' : `<span class="pill warn">${r.status === 'provisional' ? '暫定' : '未確認'}</span>`;
    el.innerHTML = `<img alt=""><div><div class="t">${r.merchant_raw || '（店名なし）'} ${st}</div><div class="s">${r.txn_date || '日付なし'} ・ ${cat[r.category] || '科目なし'}${r.memo ? ' ・ ' + r.memo.slice(0, 20) : ''}</div></div><div class="amt">${r.currency === 'JPY' ? yen(r.amount) : (r.amount ?? '-') + ' ' + r.currency}</div>`;
    idb.get('images', r.id).then(async b => { if (b) el.querySelector('img').src = URL.createObjectURL(new Blob([await cryptoV.decrypt(b)], { type: 'image/jpeg' })); });
    el.onclick = () => { state.queue = [r]; showReview(); };
    $('#list').appendChild(el);
  }
}

function renderSettings() {
  $('#lic').value = (state.settings.license || {}).key || '';
  $('#lic-status').textContent = state.lic ? (state.lic.ok ? `有効: ${state.lic.plan} / 期限 ${state.lic.expires || ''} / 今月 ${state.lic.used_this_month ?? '-'} 枚` : '無効: ' + state.lic.reason) : '';
  $('#drive-status').textContent = drive.token() ? `接続中${state.settings.lastSync ? '（前回同期 ' + state.settings.lastSync.slice(0, 16).replace('T', ' ') + '）' : ''}` : '未接続';
  $('#cards').innerHTML = state.settings.cards.map(c => `<p>${c.label} <span class="pill">${c.last4}</span></p>`).join('') || '<p class="muted">カード未登録</p>';
}

/* ---------- 起動 ---------- */
async function afterUnlock() {
  await loadSettings();
  // 金庫はあるが控えが空でDrive接続済み → 機種変更直後とみなし自動復元
  if (drive.token() && !(await idb.all('receipts')).length) {
    try { const n = await drive.restore(); if (n) alert(`Driveから ${n} 件を復元しました`); } catch { /* ignore */ }
  }
  $('#nav').classList.remove('hidden');
  await checkOnline(); await verifyLicense();
  go('home');
  setInterval(async () => { const was = state.online; await checkOnline(); if (was !== state.online) { await verifyLicense(); if ($('#s-home').classList.contains('on')) renderHome(); } }, 30000);
}

async function main() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await idb.open();
  drive.catchRedirect();
  const has = await vault.exists();
  $('#lock-setup').classList.toggle('hidden', has); $('#lock-unlock').classList.toggle('hidden', !has);
  $('#lock-title').textContent = has ? '合言葉を入力' : 'はじめに';

  $('#btn-setup').onclick = async () => {
    const p1 = $('#pw1').value, p2 = $('#pw2').value;
    if (p1.length < 8) return msg('#lock-msg', '合言葉は8文字以上にしてください');
    if (p1 !== p2) return msg('#lock-msg', '合言葉が一致しません');
    const rc = await vault.setup(p1);
    state.settings = { cards: [], rules: {}, license: { key: $('#lic0').value.trim() } }; await saveSettings();
    $('#rc-show').textContent = rc; go('recovery');
    $('#btn-rc-copy').onclick = () => navigator.clipboard.writeText(rc);
    $('#btn-rc-done').onclick = afterUnlock;
  };
  $('#btn-unlock').onclick = async () => {
    try { await vault.unlock($('#pw').value); $('#pw').value = ''; await afterUnlock(); } catch { msg('#lock-msg', '合言葉が違います'); }
  };
  $('#pw').onkeydown = e => { if (e.key === 'Enter') $('#btn-unlock').click(); };
  $('#lnk-recover').onclick = e => { e.preventDefault(); $('#lock-unlock').classList.add('hidden'); $('#lock-recover').classList.remove('hidden'); };
  $('#btn-recover-cancel').onclick = () => { $('#lock-unlock').classList.remove('hidden'); $('#lock-recover').classList.add('hidden'); };
  $('#btn-recover').onclick = async () => {
    try {
      await vault.unlock($('#rc').value.trim().toUpperCase(), 'byRecovery');
      if ($('#pwn').value.length < 8) return msg('#lock-msg', '新しい合言葉は8文字以上');
      await vault.rewrapPass($('#pwn').value); await afterUnlock();
    } catch { msg('#lock-msg', 'リカバリーコードが違います'); }
  };

  document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#btn-shoot').onclick = () => $('#file').click();
  $('#file').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; msg('#home-msg', `${fs.length} 枚を処理中…`, 'ok'); await handleFiles(fs); msg('#home-msg', ''); };
  $('#seg-company').onclick = () => setEntity('company'); $('#seg-private').onclick = () => setEntity('private');
  $('#btn-save').onclick = saveReview;
  $('#btn-discard').onclick = async () => {
    const r = state.cur;
    if (r.status === 'confirmed' && !confirm('この控えを削除します。Drive上の画像も次回同期時に削除されます。よろしいですか？')) return;
    await logHistory(r.id, 'status', r.status, 'void', 'user');
    r.status = 'void'; r.pendingDriveDelete = !!r.driveFileId;
    await idb.del('images', r.id);
    await putReceipt(r); showReview();
  };
  $('#l-month').onchange = renderList; $('#l-entity').onchange = renderList;
  $('#btn-drive').onclick = drive.connect;
  $('#btn-sync').onclick = async () => {
    if (!drive.token()) return alert('先にDriveに接続してください');
    $('#btn-sync').disabled = true;
    try { const { n, d } = await drive.sync(); alert(`同期しました（アップロード ${n} 枚${d ? '、削除 ' + d + ' 枚' : ''}）`); }
    catch (e) { if (String(e).includes('401')) { sessionStorage.removeItem('gtoken'); alert('Driveの接続が切れました。もう一度接続してください'); } else alert('同期エラー: ' + e.message); }
    $('#btn-sync').disabled = false; renderSettings();
  };
  $('#btn-lic').onclick = async () => { state.settings.license = Object.assign(state.settings.license || {}, { key: $('#lic').value.trim() }); await saveSettings(); await checkOnline(); await verifyLicense(); renderSettings(); };
  $('#btn-card').onclick = async () => { const l = $('#c-label').value.trim(), n = $('#c-last4').value.trim(); if (!l || n.length !== 4) return; state.settings.cards.push({ id: uuid(), label: l, last4: n }); await saveSettings(); $('#c-label').value = $('#c-last4').value = ''; renderSettings(); };
  $('#btn-lock').onclick = () => location.reload();
  $('#btn-wipe').onclick = async () => { if (!confirm('この端末のデータを消します。Drive上のデータは残ります。よろしいですか？')) return; for (const s of ['meta', 'receipts', 'images', 'history']) await idb.clear(s); sessionStorage.clear(); location.reload(); };

  // 復元: 金庫がなく、Driveに接続済みなら vault.json を取り込んで合言葉入力へ
  if (!has && drive.token()) {
    try {
      const root = await drive.folder(CFG.DRIVE_FOLDER_NAME), id = await drive.find('vault.json', root);
      if (id) { await idb.put('meta', JSON.parse(dec.decode(await drive.download(id))), 'vault'); msg('#lock-msg', 'Driveのデータが見つかりました。合言葉を入力すると復元します。', 'ok'); location.reload(); }
    } catch { /* ignore */ }
  }
  if (!has) $('#lnk-recover').closest('p').innerHTML = '<span class="muted">機種変更の場合は、先に設定画面のDrive接続を行ってから戻ってきてください。</span><br><a href="#" id="lnk-drive-first">Driveに接続して復元する</a>';
  const lf = $('#lnk-drive-first'); if (lf) lf.onclick = e => { e.preventDefault(); drive.connect(); };
}
main();
