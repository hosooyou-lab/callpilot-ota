// ============================================================
//  콜파일럿 PC판 — 같은 wifi LAN 동기화 서버
//
//  폰(콜파일럿 모바일)이 http://이PC의IP:8787/sync 로 POST 하면,
//  고객·통화기록을 서로 병합해서 돌려준다. 클라우드 없음.
//   - 통화기록: PC electron-store 'dialRecords' <-> 모바일 records (ts/mid 키, 합집합)
//   - 고객: electron-store 'mobileCustomers' <-> 모바일 customers (id LWW + 번호 dedup + tombstone)
//   - ⛔ 수신거부 대장: electron-store 'tmcrm_optout' <-> 모바일 cp_optout_v1 (digits 합집합, ts 최신 우선).
//     대장에 오른 번호의 고객은 병합에서 파기하고 tombstone 으로 삭제를 전파 — 폰에서 거부한 번호를
//     PC(TM·다이얼러)가 재발신하지 않게, 그 반대도 마찬가지로.
//   - 화면 우하단에 이 PC의 동기화 IP 배지를 띄워 폰에 입력하게 한다.
//
//  main.js 의 app.whenReady 에서 startSyncServer(store, () => mainWindow) 로 기동.
//  실패해도 앱 본체엔 영향 없도록 전부 방어.
// ============================================================
const http = require('http');
const os = require('os');
const crypto = require('crypto');
// 작업8: dialRecords 는 단일 병합 writer(dialer-main.js writeDialRecords)를 거쳐서만 쓴다.
// 여기서 store.set('dialRecords', ...) 를 직접 부르면 dialer:setRecords(렌더러) 의 디바운스
// 저장과 서로 덮어쓰는 경합이 생긴다.
const { writeDialRecords } = require('./dialer/dialer-main');

const PORT = 8787;

function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function nowIso() { return new Date().toISOString(); }

// 🔒 페어링 코드 — 이 PC 고유 6자리(혼동문자 O0I1 제외). 폰이 같은 코드를 보내야만 동기화 허용.
//    (다른 PC/다른 폰이 실수로 붙어도 코드가 달라 데이터 교환 차단)
function genPairCode() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(6);
  let s = ''; for (let i = 0; i < 6; i++) s += alpha[b[i] % alpha.length];
  return s;
}
function getPairCode(store) {
  let c = null;
  try { c = store.get('syncPairCode'); } catch (e) {}
  if (!c || typeof c !== 'string' || c.length < 4) { c = genPairCode(); try { store.set('syncPairCode', c); } catch (e) {} }
  return c;
}
function pairOk(sent, expected) {
  const a = String(sent == null ? '' : sent).trim().toUpperCase();
  const b = String(expected || '').toUpperCase();
  if (!a || a.length !== b.length) return false;
  // 상수시간 비교(타이밍 노출 최소화)
  let diff = 0; for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function lanIp() {
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const i of ifs[name] || []) {
        if (i.family === 'IPv4' && !i.internal &&
            /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
      }
    }
  } catch (e) {}
  return null;
}

// ── 통화기록 매핑 (mid=모바일 원본 id 를 보존해 왕복 중복 방지) ──
function pcRecordToMobile(r) {
  return {
    id: r.mid || r.ts || (digits(r.number) + '|' + (r.dialAt || '')),
    number: digits(r.number), name: r.name || '', tag: r.tag || '', memo: r.memo || '',
    dialAt: r.dialAt || r.ts || nowIso(),
    durationSec: (r.duration != null ? r.duration : 0) || 0,
    updatedAt: r.ts || nowIso(),
  };
}
function mobileRecordToPc(m) {
  return {
    mid: m.id, number: digits(m.number), name: m.name || '', tag: m.tag || '', memo: m.memo || '',
    dialAt: m.dialAt || '', time: m.dialAt || '',
    duration: (m.durationSec != null ? m.durationSec : null),
    ts: m.updatedAt || m.dialAt || nowIso(),
  };
}
function recKey(r) { return r.mid || r.ts || (digits(r.number) + '|' + (r.dialAt || '')); }

function mergeRecords(store, mobileRecords) {
  const incomingPc = (mobileRecords || []).filter(Boolean).map(mobileRecordToPc);
  // 작업8: 단일 병합 writer 경유 — 기존 기록을 지우는 로직이 없는 순수 합집합이라 항상 안전.
  // 작업4: 저장 상한(2000건) 제거 — 통화기록은 전량 영구 보존한다.
  let merged;
  try {
    const res = writeDialRecords(incomingPc, { fromRenderer: false });
    merged = Array.isArray(res && res.merged) ? res.merged : null;
  } catch (e) { merged = null; }
  if (!merged) {
    // 폴백(단일 writer 모듈을 못 불러온 극히 예외적인 경우) — 그래도 데이터를 잃지 않게 직접 합집합.
    const pc = store.get('dialRecords') || [];
    const byKey = new Map();
    pc.forEach(r => byKey.set(recKey(r), r));
    incomingPc.forEach(r => { const k = recKey(r); if (!byKey.has(k)) byKey.set(k, r); });
    merged = [...byKey.values()].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
    store.set('dialRecords', merged);
  }
  return merged.map(pcRecordToMobile);
}

// ── ⛔ 수신거부 대장 병합 ──
//  모바일 cp_optout_v1 ↔ PC store 'tmcrm_optout' (TM tmcrm_optout_v1 의 미러) — digits 합집합.
//  같은 번호가 양쪽에 있으면 ts 최신 쪽 승자, {...패자, ...승자} 스프레드로 승자에 없는
//  감사 필드(said/agent/callSec/src — 모바일 엔트리엔 없음)까지 보존한다.
function mergeOptout(store, mobileOptout) {
  let local = [];
  try { local = store.get('tmcrm_optout') || []; } catch (e) { local = []; }
  if (!Array.isArray(local)) local = [];
  const byDigits = new Map();
  local.forEach(o => { if (o && o.digits) byDigits.set(String(o.digits), o); });
  let changed = false;
  (mobileOptout || []).forEach(it => {
    if (!it) return;
    const d = digits(it.digits || it.phone); if (!d) return;
    const ex = byDigits.get(d);
    if (!ex) { byDigits.set(d, Object.assign({}, it, { digits: d, src: it.src || '모바일' })); changed = true; }
    else if (String(it.ts || '') > String(ex.ts || '')) { byDigits.set(d, Object.assign({}, ex, it, { digits: d })); changed = true; }
  });
  const merged = [...byDigits.values()];
  if (changed) { try { store.set('tmcrm_optout', merged); } catch (e) {} }
  return { merged: merged, changed: changed, digitsSet: new Set(byDigits.keys()) };
}

// ⛔ 병합된 대장을 PC 화면(부모 renderer)에 반영 — tmcrm.bridge 가 cp:optout-sync 를 받아
//    dialer(발신 잠금 optOutSet, 기존 dialer:optout-update 재사용)와 TM iframe(대장 병합+고객 파기)에 전파.
function notifyOptout(win, items) {
  try {
    if (!win || win.isDestroyed()) return;
    const js = "(function(){try{document.dispatchEvent(new CustomEvent('cp:optout-sync',{detail:{items:" + JSON.stringify(items || []) + "}}))}catch(e){}})()";
    win.webContents.executeJavaScript(js).catch(function () {});
  } catch (e) {}
}

// ── 고객 매핑 ──
function mergeCustomers(store, mobileCustomers, mobileTombs, optoutSet) {
  const local = store.get('mobileCustomers') || [];
  const localTombs = store.get('mobileTombstones') || [];
  const byId = new Map();
  // 같은 id 충돌 시 승자(최신 updatedAt)를 고르되 {...패자, ...승자} 스프레드로 승자에 없는
  // 미지 필드(callbackAt 등)까지 보존한다. 명시 필드(name/number/memo/updatedAt/done)는 그대로 정규화.
  const put = c => {
    if (!c || !c.id) return;
    const norm = Object.assign({}, c, { number: digits(c.number), memo: c.memo || '', updatedAt: c.updatedAt || '', done: !!c.done });
    const ex = byId.get(norm.id);
    if (!ex) { byId.set(norm.id, norm); return; }
    const normWins = String(norm.updatedAt || '') > String(ex.updatedAt || '');
    byId.set(norm.id, normWins ? Object.assign({}, ex, norm) : Object.assign({}, norm, ex));
  };
  local.forEach(put);
  (mobileCustomers || []).forEach(put);
  const byNum = new Map();
  // 같은 번호 충돌도 동일하게 — 정렬 오름차순이라 뒤에 오는 c가 최신(또는 동일)이므로 {...ex(패자), ...c(승자)}
  [...byId.values()].sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''))).forEach(c => {
    const ex = byNum.get(c.number);
    byNum.set(c.number, ex ? Object.assign({}, ex, c) : c);
  });
  let list = [...byNum.values()];
  const tombByNum = new Map();
  [...localTombs, ...(mobileTombs || [])].forEach(t => { if (!t) return; const n = digits(t.number); const ex = tombByNum.get(n); if (!ex || String(t.at) > String(ex.at)) tombByNum.set(n, { number: n, at: t.at }); });
  list = list.filter(c => { const t = tombByNum.get(c.number); return !(t && String(t.at) >= String(c.updatedAt || '')); });
  // ⛔ 수신거부 대장 번호는 병합 결과에서 파기 + tombstone 으로 삭제 전파 — 폰·PC 어느 쪽에서 거부를
  //    기록했든 양쪽 고객 DB에서 함께 사라진다(재발신 방지 최소 정보는 대장에만 남음).
  if (optoutSet && optoutSet.size) {
    list = list.filter(c => {
      if (!optoutSet.has(c.number)) return true;
      const ex = tombByNum.get(c.number);
      if (!ex || String(c.updatedAt || '') >= String(ex.at)) tombByNum.set(c.number, { number: c.number, at: nowIso() });
      return false;
    });
  }
  const tombs = [...tombByNum.values()];
  store.set('mobileCustomers', list);
  store.set('mobileTombstones', tombs);
  return { customers: list, tombstones: tombs };
}

function injectBadge(win, ip, code) {
  try {
    if (!win || win.isDestroyed()) return;
    const label = '📱 폰 동기화  IP ' + (ip || '') + ':' + PORT + '  ·  코드 ' + (code || '');
    const js = "(function(){var e=document.getElementById('cp-lanip');if(!e){e=document.createElement('div');e.id='cp-lanip';e.style.cssText='position:fixed;bottom:8px;right:10px;z-index:99999;background:#1e1a16;color:#e8a84a;border:1px solid #5a4520;border-radius:8px;padding:6px 10px;font:12px sans-serif;opacity:.92;user-select:text';document.body.appendChild(e);}e.textContent=" + JSON.stringify(label) + ";})()";
    win.webContents.executeJavaScript(js).catch(function () {});
  } catch (e) {}
}

// 📞 폰에서 통화가 시작/진행/종료되면 PC 화면 상단에 "폰 통화" 배너를 띄운다(번호·이름·상태).
function injectCallBanner(win, p) {
  try {
    if (!win || win.isDestroyed()) return;
    const num = digits(p.number);
    const numFmt = num.length === 11 ? num.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3') : num;
    const st = String(p.state || '');
    const end = (st === 'end' || st === 'DISCONNECTED' || st === 'IDLE' || st === '');
    const incoming = !!p.incoming;
    const active = (st === 'active' || st === 'ACTIVE' || st === 'OFFHOOK');
    const label = incoming ? '📲 폰 수신' : '📞 폰 발신';
    const sub = active ? '통화 중' : (incoming ? '전화 옴 — 받는 중' : '거는 중');
    const main = (p.name ? p.name + ' · ' : '') + numFmt;
    const data = JSON.stringify({ end: end, label: label, main: main, sub: sub });
    const js = "(function(){var d=" + data + ";var e=document.getElementById('cp-phonecall');"
      + "if(d.end){if(e){if(e._t)clearTimeout(e._t);e.remove();}return;}"
      + "if(!e){e=document.createElement('div');e.id='cp-phonecall';"
      + "e.style.cssText='position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;background:#1e1a16;border:1px solid #c96442;border-radius:12px;padding:10px 18px;font:14px -apple-system,Malgun Gothic,sans-serif;color:#f0ece6;box-shadow:0 6px 24px rgba(0,0,0,.5);display:flex;align-items:center;gap:12px';"
      + "var a=document.createElement('span');a.id='cp-pc-label';a.style.cssText='font-weight:800;color:#c96442';"
      + "var b=document.createElement('span');b.id='cp-pc-main';b.style.cssText='font-size:18px;font-weight:800';"
      + "var c=document.createElement('span');c.id='cp-pc-sub';c.style.cssText='color:#a29a8f';"
      + "e.appendChild(a);e.appendChild(b);e.appendChild(c);document.body.appendChild(e);}"
      + "e.querySelector('#cp-pc-label').textContent=d.label;"
      + "e.querySelector('#cp-pc-main').textContent=d.main;"
      + "e.querySelector('#cp-pc-sub').textContent=d.sub;"
      + "if(e._t)clearTimeout(e._t);e._t=setTimeout(function(){if(e)e.remove();},120000);"
      + "})()";
    win.webContents.executeJavaScript(js).catch(function () {});
  } catch (e) {}
}

function startSyncServer(store, getWin, opts) {
  opts = opts || {};
  const pairCode = getPairCode(store);   // 이 PC의 페어링 코드(폰이 이 코드를 보내야 동기화 허용)
  const server = http.createServer(function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200); res.end('callpilot'); return; }
    // 📞 폰 통화 실시간 알림 — 폰이 발신/수신/종료를 보내면 PC 화면에 배너로 표시
    if (req.method === 'POST' && req.url === '/livecall') {
      let body = '';
      req.on('data', function (d) { body += d; if (body.length > 1024 * 1024) req.destroy(); });
      req.on('end', function () {
        try {
          const p = JSON.parse(body || '{}');
          if (!pairOk(p.pairCode, pairCode)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"pair"}'); return; }
          injectCallBanner(getWin && getWin(), p);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
        } catch (e) { res.writeHead(500); res.end('err'); }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/sync') {
      let body = '';
      req.on('data', function (d) { body += d; if (body.length > 20 * 1024 * 1024) req.destroy(); });
      req.on('end', function () {
        try {
          const p = JSON.parse(body || '{}');
          // 🔒 페어링 코드 검증 — 일치하지 않으면(다른 PC/다른 폰) 데이터 교환 거부
          if (!pairOk(p.pairCode, pairCode)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'pair' }));
            return;
          }
          // 🔗 인증 공유: 폰이 보낸 인증쌍을 받아(내가 미인증이면) 저장·잠금해제
          try { if (p.activation && opts.acceptActivation) opts.acceptActivation(p.activation); } catch (e) {}
          // ⛔ 수신거부 대장을 고객보다 먼저 병합 — 이번에 폰이 보낸 거부 번호가 곧바로 고객 병합에서 파기되게.
          const oo = mergeOptout(store, p.optout);
          const records = mergeRecords(store, p.records);
          const cust = mergeCustomers(store, p.customers, p.tombstones, oo.digitsSet);
          if (oo.changed) notifyOptout(getWin && getWin(), oo.merged);
          let activation = null;
          try { if (opts.getActivation) activation = opts.getActivation() || null; } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ customers: cust.customers, records: records, tombstones: cust.tombstones, optout: oo.merged, activation: activation }));
        } catch (e) { res.writeHead(500); res.end('err'); }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('error', function (e) { console.error('[CallPilot] 동기화 서버 오류:', e && e.message); });
  const port = opts.port || PORT;   // opts.port = 테스트 하네스용 오버라이드(기본 8787)
  server.listen(port, function () {
    const ip = lanIp();
    console.log('[CallPilot] LAN 동기화 서버 http://' + (ip || '0.0.0.0') + ':' + port);
    // 🔗 계정 기반 자동연결(C안 1단계) — 이 주소를 main 이 받아 서버에 올려두면
    //    같은 아이디로 로그인한 폰이 IP·코드 입력 없이 찾아온다. 실패해도 LAN 동기화엔 영향 없다.
    try { if (opts.onReady) opts.onReady({ ip: ip, port: port, code: pairCode }); } catch (e) {}
    let tries = 0;
    (function tryBadge() {
      const w = getWin && getWin();
      if (w && !w.isDestroyed()) {
        injectBadge(w, ip, pairCode);
        try { w.webContents.on('did-finish-load', function () { injectBadge(w, ip, pairCode); }); } catch (e) {}
      } else if (tries++ < 20) { setTimeout(tryBadge, 1500); }
    })();
  });
  return server;
}

module.exports = { startSyncServer, lanIp };
