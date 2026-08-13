const { app, BrowserWindow, globalShortcut, ipcMain, Menu, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// ============ 🔒 설치 인증 (기기잠금 + PC별 인증키) ============
// 라이선스 = 그 PC의 기기코드를 개인키로 서명한 값(=인증키). 앱엔 공개키만 있어 검증만 가능(위조 불가).
// 인증키는 '키발급기'(개인키 보유, 배포 안 함)로만 생성 → 소유자가 PC별로 발급.
// ── 🌐 온라인 인증요청/승인폴링 + 피드백용 Supabase(공개 anon 키 — 코드에 있어도 안전, RLS로 접근통제) ──
const SUPA_URL = 'https://sihczrtbjxnrgeneyyhq.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaGN6cnRianhucmdlbmV5eWhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDg2MDEsImV4cCI6MjA5NjAyNDYwMX0.udtMDESv6fFFyIJnpFN88vnZP9FXKpzakwsHLVv2kBU';
// 렌더러 fetch는 file:// Origin=null이라 CORS로 막힐 수 있어 main 프로세스에서 Node https로 호출(모바일 supa.js와 동일 REST 규약).
function supaReq(method, path, bodyObj, extraHeaders) {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const u = new URL(SUPA_URL + '/rest/v1/' + path);
      const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : null;
      const headers = Object.assign({
        'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json'
      }, extraHeaders || {});
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 8000 }, (res) => {
        let raw = '';
        res.on('data', d => { raw += d; });
        res.on('end', () => {
          let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (e) {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, data: null }); });
      req.on('error', () => resolve({ ok: false, status: 0, data: null }));
      if (bodyStr) req.write(bodyStr);
      req.end();
    } catch (e) { resolve({ ok: false, status: 0, data: null }); }
  });
}
const LICENSE_PUBKEY = '-----BEGIN PUBLIC KEY-----\n'
  + 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE37dMiJMFZzIPmKeqva3Sj3XF/7pY\n'
  + 'dWb0nw9Kmn0No/InMOCwRpG5uX/Oho4lWb2gKGPfha2l9Xd4qWasZLhfqA==\n'
  + '-----END PUBLIC KEY-----';
function verifyKey(mid, authKey) {
  try {
    const sig = Buffer.from(String(authKey || '').trim(), 'base64');
    if (!sig.length) return false;
    return crypto.verify('sha256', Buffer.from(String(mid)), { key: LICENSE_PUBKEY, dsaEncoding: 'ieee-p1363' }, sig);
  } catch (e) { return false; }
}
function licenseFiles() {   // 앱 폴더(복사되면 함께 이동→불일치로 차단) + 사용자데이터(읽기전용 설치 대비)
  const arr = [path.join(__dirname, '..', 'license.dat')];
  try { arr.push(path.join(app.getPath('userData'), 'license.dat')); } catch (e) {}
  return arr;
}
function machineId() {
  try {
    const out = require('child_process').execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8', windowsHide: true });
    const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    if (m) return crypto.createHash('sha256').update('cp:' + m[1]).digest('hex').slice(0, 24);
  } catch (e) {}
  try { return crypto.createHash('sha256').update('cp:' + os.hostname() + '|' + ((os.cpus()[0] || {}).model || '')).digest('hex').slice(0, 24); } catch (e) { return 'na'; }
}
// ── 🔗 LAN 공유 인증: 같은 사용자의 다른 기기(폰 등)에서 받은 (기기코드,키) 쌍. 공개키로 검증 가능 → 위조 불가 ──
function sharedLicenseFiles() {
  const arr = [path.join(__dirname, '..', 'shared-license.dat')];
  try { arr.push(path.join(app.getPath('userData'), 'shared-license.dat')); } catch (e) {}
  return arr;
}
function readSharedLicense() {
  for (const f of sharedLicenseFiles()) {
    try { const L = JSON.parse(fs.readFileSync(f, 'utf8')); if (L && L.deviceCode && L.key && verifyKey(L.deviceCode, L.key)) return { deviceCode: L.deviceCode, key: L.key }; }
    catch (e) {}
  }
  return null;
}
function writeSharedLicense(deviceCode, key) {
  if (!verifyKey(deviceCode, key)) return false;
  const data = JSON.stringify({ deviceCode: String(deviceCode), key: String(key), ts: Date.now() });
  let ok = false;
  for (const f of sharedLicenseFiles()) { try { fs.writeFileSync(f, data, 'utf8'); ok = true; } catch (e) {} }
  return ok;
}
function readOwnKey() {
  const mid = machineId();
  for (const f of licenseFiles()) {
    try { const L = JSON.parse(fs.readFileSync(f, 'utf8')); if (L && L.key && verifyKey(mid, L.key)) return L.key; }
    catch (e) {}
  }
  return null;
}
function isActivated() {
  const mid = machineId();
  for (const f of licenseFiles()) {
    try { const L = JSON.parse(fs.readFileSync(f, 'utf8')); if (L && L.key && verifyKey(mid, L.key)) return true; }
    catch (e) {}   // 파일 없음/손상 → 다음 후보 확인, 최종 미활성이면 인증키 입력창
  }
  // 🔗 자기 인증이 없어도, LAN으로 받은 유효한 공유 인증이 있으면 활성 (additive — 기존 경로는 그대로)
  if (readSharedLicense()) return true;
  return false;
}
// 폰에 넘겨줄 인증(자기 인증 우선 → 없으면 이미 받은 공유 인증)
function ownActivation() {
  const k = readOwnKey();
  if (k) return { deviceCode: machineId(), key: k };
  return readSharedLicense();
}
// 폰이 보낸 인증쌍을 받아 공유 저장 — 내가 미인증일 때만. 유효하면 저장 + (잠겨 있었으면) 바로 실행.
function acceptSharedActivation(pair) {
  try {
    if (!pair || !pair.deviceCode || !pair.key) return false;
    if (isActivated()) return false;
    if (!verifyKey(pair.deviceCode, pair.key)) return false;
    const ok = writeSharedLicense(pair.deviceCode, pair.key);
    if (ok && !mainWindow) {   // 인증창이 떠 있던 잠금 상태 → 바로 열어줌
      try { if (activationWin) { const w = activationWin; activationWin = null; w.close(); } } catch (e) {}
      try { createWindow(); registerHotkeys(); } catch (e) {}
    }
    return ok;
  } catch (e) { return false; }
}
function writeLicense(key) {
  const data = JSON.stringify({ key: String(key || '').trim(), ts: Date.now() });
  let ok = false;
  for (const f of licenseFiles()) { try { fs.writeFileSync(f, data, 'utf8'); ok = true; } catch (e) {} }
  return ok;
}
function tryActivate(authKey) {
  if (verifyKey(machineId(), authKey)) return writeLicense(authKey);
  return false;
}
let activationWin = null;
function showActivationWindow() {
  if (activationWin) { try { activationWin.focus(); } catch (e) {} return; }
  activationWin = new BrowserWindow({
    width: 440, height: 380, resizable: false, center: true, title: '콜파일럿 정품 인증',
    backgroundColor: '#161310', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'callpilot.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload-activation.js'), contextIsolation: true, nodeIntegration: false, devTools: false }
  });
  activationWin.setMenuBarVisibility(false);
  activationWin.loadFile(path.join(__dirname, 'renderer', 'activation.html'));
  activationWin.on('closed', () => { if (activationWin) { activationWin = null; app.quit(); } });   // 인증 안 하고 닫으면 종료
}
ipcMain.handle('license:activate', (e, code) => {
  if (tryActivate(code)) {
    if (activationWin) { const w = activationWin; activationWin = null; try { w.close(); } catch (x) {} }
    createWindow(); registerHotkeys();
    try { scheduleHeartbeat(); checkRevocation().then(rev => { if (rev.reached && rev.blocked) lockDown(rev.wipe); }); } catch (x) {}
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle('license:machineId', () => machineId());
ipcMain.handle('license:quit', () => app.quit());
// 🌐 온라인 인증 요청 — 이 PC의 기기코드를 요청 목록에 올림(관리자가 콘솔에서 승인)
ipcMain.handle('license:requestActivation', async () => {
  const r = await supaReq('POST', 'license_requests', { device_code: machineId(), platform: 'pc', label: '' }, { 'Prefer': 'return=minimal' });
  return { ok: r.ok };
});
// 🌐 승인 폴링 — 승인된 인증키가 있으면 문자열, 없으면 null(오프라인/미승인이어도 안전하게 null)
ipcMain.handle('license:pollActivation', async () => {
  const mid = machineId();
  const p = 'license_requests?device_code=eq.' + encodeURIComponent(mid) + '&status=eq.approved&select=approved_key,approved_at&order=approved_at.desc&limit=1';
  const r = await supaReq('GET', p, null);
  if (r.ok && Array.isArray(r.data) && r.data[0] && r.data[0].approved_key) return r.data[0].approved_key;
  return null;
});
// ✍ 의견(피드백) 전송 — 실패해도 크래시 없이 {ok:false}
ipcMain.handle('app:feedback', async (e, msg) => {
  const r = await supaReq('POST', 'feedback', { device_code: machineId(), platform: 'pc', message: String(msg || '') }, { 'Prefer': 'return=minimal' });
  return { ok: r.ok };
});

// ============ 🔑 배분 CRM 로그인 (상담사 아이디·비번 — 시작 게이트) ============
// 로그인 아이디(한글 가능) → 합성 이메일(cp_xxx@call.local) 매핑 RPC → Supabase Auth 비밀번호 로그인
// → cp_profiles 조회로 role/status 확인. 기존 기기인증(라이선스)과는 별개 — SUPA_URL/SUPA_KEY/supaReq 재사용.
// 렌더러(file://)의 fetch가 CORS로 막힐 수 있어 main 프로세스 IPC로 처리(기존 license 방식과 동일한 구조).
function supaAuthReq(authPath, bodyObj) {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const u = new URL(SUPA_URL + '/auth/v1/' + authPath);
      const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : null;
      const headers = { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' };
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers, timeout: 8000 }, (res) => {
        let raw = '';
        res.on('data', d => { raw += d; });
        res.on('end', () => {
          let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (e) {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, data: null }); });
      req.on('error', () => resolve({ ok: false, status: 0, data: null }));
      if (bodyStr) req.write(bodyStr);
      req.end();
    } catch (e) { resolve({ ok: false, status: 0, data: null }); }
  });
}
// JWT 페이로드에서 sub(=user id)만 꺼냄(서명검증 없음 — 어차피 서버에 다시 물어 확인하므로 위조돼도 무해)
function decodeJwtSub(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return (payload && payload.sub) || null;
  } catch (e) { return null; }
}
function crmSessionFile() {
  try { return path.join(app.getPath('userData'), 'cp-agent-session.dat'); }
  catch (e) { return path.join(__dirname, '..', 'cp-agent-session.dat'); }
}
function readCrmSession() { try { return JSON.parse(fs.readFileSync(crmSessionFile(), 'utf8')); } catch (e) { return null; } }
function writeCrmSession(obj) { try { fs.writeFileSync(crmSessionFile(), JSON.stringify(obj)); return true; } catch (e) { return false; } }
function clearCrmSession() { try { fs.unlinkSync(crmSessionFile()); } catch (e) {} }
// 그 JWT로 cp_profiles를 조회해 본인 행을 찾고 role/status를 확인 → { ok, reason, message, profile }
async function crmValidateSession(accessToken) {
  // edu_enabled = 「교육」 창 편집 권한(마스터 콘솔에서 부여). 아직 SQL을 안 돌린 환경에서는
  // 이 컬럼이 없어 PostgREST가 400을 준다 → 그때는 옛 select로 한 번 더 시도해 로그인이 깨지지 않게 한다.
  let r = await supaReq('GET', 'cp_profiles?select=id,name,role,status,login_id,edu_enabled,wipe', null, { 'Authorization': 'Bearer ' + accessToken });
  if (!r.ok && (r.status === 400 || r.status === 404)) {   // wipe 컬럼 아직 없음(SQL 미실행) → edu_enabled까진 유지
    r = await supaReq('GET', 'cp_profiles?select=id,name,role,status,login_id,edu_enabled', null, { 'Authorization': 'Bearer ' + accessToken });
  }
  if (!r.ok && (r.status === 400 || r.status === 404)) {   // edu_enabled도 없는 구환경 → 최소 컬럼
    r = await supaReq('GET', 'cp_profiles?select=id,name,role,status,login_id', null, { 'Authorization': 'Bearer ' + accessToken });
  }
  if (r.status === 0) return { ok: false, reason: 'offline', message: '인터넷 연결이 필요합니다. 연결 후 다시 로그인해 주세요.' };
  if (r.status === 401 || r.status === 403) return { ok: false, reason: 'expired', message: '세션이 만료되었습니다. 다시 로그인해 주세요.' };
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, reason: 'error', message: '서버 확인 중 오류가 발생했습니다. 다시 로그인해 주세요.' };
  const sub = decodeJwtSub(accessToken);
  const row = r.data.find(x => x && sub && String(x.id) === String(sub)) || (r.data.length === 1 ? r.data[0] : null);
  if (!row) return { ok: false, reason: 'forbidden', message: '계정 정보를 찾을 수 없습니다. 관리자에게 문의하세요.' };
  if (row.status === 'blocked') return { ok: false, reason: 'blocked', wipe: row.wipe === true, message: '차단된 계정입니다. 관리자에게 문의하세요.' };
  if (row.status !== 'active') return { ok: false, reason: 'inactive', message: '사용할 수 없는 계정 상태입니다. 관리자에게 문의하세요.' };
  if (row.role !== 'agent' && row.role !== 'master') return { ok: false, reason: 'role', message: '상담사 계정이 아닙니다. 관리자에게 문의하세요.' };
  return { ok: true, profile: row };
}
let crmLoginWin = null;
let crmSession = null;   // 로그인 성공 세션(토큰 등) — 메모리에만 보관(자동로그인 안 함), Phase2에서 사용
// ── 🔒 로그인 후 계정 상태 주기 재검증 (2026-07-31) ──
// 예전엔 로그인 '순간'에만 status='blocked'를 검사해서, 이미 켜둔 앱은 관리자가 차단해도
// 껐다 켜기 전까지 계속 동작했다. 이제 15분마다 서버에 다시 물어보고, 차단/비활성이면 즉시 로그아웃(재시작).
// 토큰이 만료됐으면(1시간) refresh_token으로 조용히 갱신 → 정상 사용자는 재로그인 요구 없음, 차단자만 튕겨남.
let __crmRevalTimer = null;
const CRM_REVAL_MS = 15 * 60 * 1000;   // 15분마다
async function crmRefreshToken() {
  if (!crmSession || !crmSession.refresh_token) return false;
  const r = await supaAuthReq('token?grant_type=refresh_token', { refresh_token: crmSession.refresh_token });
  if (r.ok && r.data && r.data.access_token) {
    crmSession.access_token = r.data.access_token;
    if (r.data.refresh_token) crmSession.refresh_token = r.data.refresh_token;
    return true;
  }
  return false;
}
function startCrmRevalidation() {
  if (__crmRevalTimer) return;
  __crmRevalTimer = setInterval(async () => {
    if (!crmSession) return;
    let v = await crmValidateSession(crmSession.access_token);
    if (v.reason === 'expired') {                                   // 토큰 만료 → refresh 시도
      if (await crmRefreshToken()) { v = await crmValidateSession(crmSession.access_token); }
      else { return; }                                             // 갱신 실패(만료·네트워크)는 이번 주기 건너뜀 — 차단자는 refresh가 되므로 여기로 안 옴
    }
    if (v.ok) return;                                               // 여전히 정상 — 통과
    if (v.reason === 'offline' || v.reason === 'error') return;     // 일시적 실패는 봐줌(정상 사용자 강제 로그아웃 방지)
    // blocked/inactive/forbidden/role 확정 신호 → 즉시 로그아웃. 차단+삭제 지정이면 로컬 데이터도 파기.
    forceCrmLogout(v.message || '계정 상태가 변경되었습니다. 다시 로그인해 주세요.', v.reason === 'blocked' && v.wipe === true);
  }, CRM_REVAL_MS);
}
function stopCrmRevalidation() { if (__crmRevalTimer) { clearInterval(__crmRevalTimer); __crmRevalTimer = null; } }
// 강제 로그아웃 = 세션 비우고 앱 재시작 → 로그인창에서 차단이 다시 걸린다(로그인 자체가 거부됨).
// doWipe=true(차단+데이터삭제 지정)면 재시작 전에 이 PC의 로컬 고객데이터·녹음을 파기한다.
function forceCrmLogout(message, doWipe) {
  stopCrmRevalidation();
  crmSession = null;
  const opts = {
    type: 'warning', title: '콜파일럿',
    message: doWipe ? '접근이 종료되어 이 PC의 콜파일럿 데이터를 삭제합니다.' : '로그아웃되었습니다.',
    detail: message, buttons: ['확인']
  };
  try { if (mainWindow) dialog.showMessageBoxSync(mainWindow, opts); else dialog.showMessageBoxSync(opts); } catch (e) {}
  if (doWipe) {
    // 1차: 창을 닫기 전에 먼저 지운다 — 고객DB(callpilot-data.json)·통화녹음·백업은 창과 무관하게
    //      바로 삭제되므로, 창 닫기/재시작 타이밍이 어긋나도 핵심 데이터 파기는 보장된다.
    try { wipeLocalData(); } catch (e) {}
    // 창을 닫아 Local Storage(LevelDB) 잠금을 푼 뒤 2차로 한 번 더 — Local Storage까지 확실히 삭제.
    try { if (mainWindow) { const w = mainWindow; mainWindow = null; try { w.destroy(); } catch (e) {} } } catch (e) {}
    try { wipeLocalData(); } catch (e) {}
  }
  try { app.relaunch(); } catch (e) {}
  app.exit(0);
}
function showCrmLoginWindow(message, prefillId) {
  if (crmLoginWin) {
    try { crmLoginWin.focus(); if (message) crmLoginWin.webContents.send('crmlogin:notice', message); } catch (e) {}
    return;
  }
  crmLoginWin = new BrowserWindow({
    width: 440, height: 460, resizable: false, center: true, title: '콜파일럿 로그인',
    backgroundColor: '#161310', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'callpilot.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload-crm-login.js'), contextIsolation: true, nodeIntegration: false, devTools: false }
  });
  crmLoginWin.setMenuBarVisibility(false);
  crmLoginWin.loadFile(path.join(__dirname, 'renderer', 'crm-login.html'));
  crmLoginWin.webContents.on('did-finish-load', () => {
    try {
      if (message) crmLoginWin.webContents.send('crmlogin:notice', message);
      if (prefillId) crmLoginWin.webContents.send('crmlogin:prefill', prefillId);
    } catch (e) {}
  });
  crmLoginWin.on('closed', () => { if (crmLoginWin) { crmLoginWin = null; app.quit(); } });   // 로그인 안 하고 닫으면 종료
}
// ⚠ startMainApp은 crmlogin:submit(IPC 핸들러) 안에서 불려서, 여기서 예외가 나면 크래시 창 없이
//   조용히 삼켜진다(로그인창은 이미 닫힘) — 창은 뜨는데 메뉴·핫키·이후 초기화가 다 빠진 반쪽 상태가 됨.
//   실제로 메뉴 템플릿 예외로 영어 기본 메뉴가 뜨는 사고가 있었다. 반드시 잡아서 로그+알림.
function mainErrorLogPath() { try { return path.join(app.getPath('userData'), 'main-error.log'); } catch (e) { return 'main-error.log'; } }
function logMainError(tag, err) {
  try {
    fs.appendFileSync(mainErrorLogPath(), '[' + new Date().toISOString() + '] ' + tag + ': ' + (err && err.stack ? err.stack : String(err)) + '\n');
  } catch (e) {}
}
function startMainApp() {
  try {
    createWindow(); registerHotkeys();
  } catch (err) {
    logMainError('startMainApp', err);
    try { dialog.showErrorBox('콜파일럿 시작 오류', '시작 중 문제가 발생했습니다.\n\n' + (err && err.message ? err.message : String(err)) + '\n\n기록: ' + mainErrorLogPath()); } catch (e) {}
  }
}
// 시작 게이트: 저장된 세션 → 서버 재검증(만료면 refresh 시도) → 통과하면 메인창, 아니면 로그인창
// 매번 로그인 요구 — 자동 로그인 안 함. 저장해둔 아이디만 미리 채워줌(비번은 항상 직접 입력).
async function crmStartupGate() {
  let savedId = '';
  try { const s = readCrmSession(); if (s && s.login_id) savedId = s.login_id; } catch (e) {}
  showCrmLoginWindow(null, savedId);
}
// 아이디→합성이메일 매핑 → 비밀번호 로그인 → 프로필 확인까지 한 번에 처리
ipcMain.handle('crmlogin:submit', async (e, loginIdRaw, passwordRaw, remember) => {
  const loginId = String(loginIdRaw || '').trim();
  const password = String(passwordRaw || '');
  if (!loginId || !password) return { ok: false, message: '아이디와 비밀번호를 입력하세요.' };
  // 아이디에 '@'가 있으면 이메일로 직접 로그인(마스터 등 이메일 계정), 아니면 아이디→합성이메일 매핑
  let email;
  if (loginId.includes('@')) {
    email = loginId;
  } else {
    const emailR = await supaReq('POST', 'rpc/cp_email_for_login', { p_login_id: loginId });
    if (emailR.status === 0) return { ok: false, message: '인터넷 연결을 확인해 주세요.' };
    if (!emailR.ok || typeof emailR.data !== 'string' || !emailR.data) return { ok: false, message: '아이디를 찾을 수 없습니다.' };
    email = emailR.data;
  }
  const authR = await supaAuthReq('token?grant_type=password', { email, password });
  if (authR.status === 0) return { ok: false, message: '인터넷 연결을 확인해 주세요.' };
  if (!authR.ok || !authR.data || !authR.data.access_token) return { ok: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' };
  const v = await crmValidateSession(authR.data.access_token);
  if (!v.ok) {
    // 차단+데이터삭제 대상이 로그인 시도(비번은 맞음) → 이 PC의 로컬 데이터를 파기한다.
    if (v.reason === 'blocked' && v.wipe === true) { try { wipeLocalData(); } catch (e) {} }
    return { ok: false, message: v.message || '로그인할 수 없습니다.' };
  }
  // 토큰은 메모리에만(자동로그인 안 함). 디스크엔 '아이디 저장'일 때 login_id만 남긴다.
  crmSession = {
    access_token: authR.data.access_token,
    refresh_token: authR.data.refresh_token,
    user_id: (authR.data.user && authR.data.user.id) || decodeJwtSub(authR.data.access_token),
    login_id: loginId,
    name: v.profile.name,
    role: v.profile.role,
    edu_enabled: v.profile.edu_enabled === true
  };
  if (remember === false) clearCrmSession(); else writeCrmSession({ login_id: loginId });
  if (crmLoginWin) { const w = crmLoginWin; crmLoginWin = null; try { w.close(); } catch (x) {} }
  startMainApp();
  startCrmRevalidation();   // 🔒 로그인 후 15분마다 계정 상태 재확인(차단되면 즉시 로그아웃)
  return { ok: true };
});
ipcMain.handle('crmlogin:quit', () => app.quit());

// ── Phase2: 서버에서 내 배정 고객 가져오기 ──
// crmSession 은 메모리에만 있고(자동로그인 안 함) 토큰은 절대 렌더러로 넘기지 않는다 — main 안에서만 사용.
async function crmFetchAssigned() {
  if (!crmSession) return { ok: false, reason: 'nosession' };
  const p = 'cp_customers?assigned_to=eq.' + encodeURIComponent(crmSession.user_id)
    + '&select=id,phone,name,region,grade,status,assigned_at&order=assigned_at.asc';
  const r = await supaReq('GET', p, null, { 'Authorization': 'Bearer ' + crmSession.access_token });
  if (r.status === 0) return { ok: false, reason: 'offline' };
  if (r.status === 401 || r.status === 403) return { ok: false, reason: 'expired' };
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, reason: 'error' };
  return { ok: true, items: r.data };
}
// 렌더러에는 최소 정보만(내 이름/역할 표시용) — 토큰은 절대 넘기지 않는다.
ipcMain.handle('crm:me', () => {
  if (!crmSession) return { ok: false };
  return { ok: true, user_id: crmSession.user_id, login_id: crmSession.login_id, name: crmSession.name,
           role: crmSession.role, edu_enabled: crmSession.edu_enabled === true };
});
ipcMain.handle('crm:assigned', () => crmFetchAssigned());

// 🔗 TM 고객관리 → 서버 업로드(마스터 전용) — cp_customers.phone엔 유니크 제약이 없어
// 기존 번호를 전부 조회해 애플리케이션 레벨에서 중복을 막는다. 업로드분은 미배정 풀로 들어가도록
// assigned_to는 넣지 않는다(마스터 콘솔에서 배정).
async function crmUploadCustomers(items) {
  if (!crmSession) return { ok: false, reason: 'nosession' };
  if (crmSession.role !== 'master') return { ok: false, reason: 'notmaster' };
  if (!Array.isArray(items) || !items.length) return { ok: true, added: 0, skipped: 0 };

  // 1) 정제: 전화번호 숫자만 추출 + 유효 자릿수(10~11) + 같은 요청 안 중복 제거
  const seen = new Set();
  const cleaned = [];
  items.forEach((it) => {
    if (!it) return;
    const digits = String(it.phone || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) return;
    if (seen.has(digits)) return;
    seen.add(digits);
    cleaned.push({
      phone: digits,
      name: it.name != null ? String(it.name) : '',
      grade: it.grade != null ? String(it.grade) : '',
      extra: {
        tmStatus: it.status != null ? String(it.status) : '',
        memo: it.memo != null ? String(it.memo) : '',
        source: 'tm-upload'
      }
    });
  });
  if (!cleaned.length) return { ok: true, added: 0, skipped: items.length };

  // 2) 기존 번호 전체 조회 — PostgREST 기본 1000행 제한을 Range 헤더 페이지네이션으로 우회
  const authHeader = { 'Authorization': 'Bearer ' + crmSession.access_token };
  const existing = new Set();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const r = await supaReq('GET', 'cp_customers?select=phone&order=id.asc', null,
      Object.assign({ 'Range': offset + '-' + (offset + PAGE - 1) }, authHeader));
    if (r.status === 0) return { ok: false, reason: 'offline' };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'expired' };
    if (!r.ok || !Array.isArray(r.data)) return { ok: false, reason: 'error' };
    r.data.forEach((row) => { if (row && row.phone) existing.add(String(row.phone)); });
    if (r.data.length < PAGE) break;   // 마지막 페이지(응답이 페이지 크기보다 작음)
  }

  // 3) 서버에 없는 번호만 500개씩 배치 삽입
  const toInsert = cleaned.filter((c) => !existing.has(c.phone));
  let added = 0;
  const BATCH = 500;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH).map((c) => ({
      phone: c.phone, name: c.name, grade: c.grade, status: 'new', extra: c.extra
    }));
    const r = await supaReq('POST', 'cp_customers', batch, Object.assign({ 'Prefer': 'return=minimal' }, authHeader));
    if (r.status === 0) return { ok: false, reason: 'offline' };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'expired' };
    if (!r.ok) return { ok: false, reason: 'error' };
    added += batch.length;
  }
  return { ok: true, added, skipped: items.length - added };
}
ipcMain.handle('crm:upload', (e, items) => crmUploadCustomers(items));

// ============ 🛑 원격 차단(킬스위치) + 오프라인 유예 ============
// 관리자가 콘솔에서 이 기기를 '차단'하면(license_requests.blocked=true) 앱이 잠금 상태로 떨어진다.
// 서버 확인(하트비트)은 시작 시 + 3시간마다. 인터넷이 3일 넘게 끊기면(유예 소진) 재확인 전까지 잠근다.
const REVOKE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;   // 오프라인 허용 유예 = 3일
let __hbTimer = null;
function heartbeatFile() {
  try { return path.join(app.getPath('userData'), 'cp-heartbeat.dat'); }
  catch (e) { return path.join(__dirname, '..', 'cp-heartbeat.dat'); }
}
function loadHeartbeat() { try { return JSON.parse(fs.readFileSync(heartbeatFile(), 'utf8')); } catch (e) { return null; } }
function saveHeartbeat(obj) { try { fs.writeFileSync(heartbeatFile(), JSON.stringify(obj)); } catch (e) {} }
// 관측한 최대 시각을 단조 증가로 기록 → 시계를 되돌려 유예를 무한 연장하는 우회를 차단
function touchClock() {
  const hb = loadHeartbeat() || {};
  hb.max = Math.max(hb.max || 0, Date.now());
  saveHeartbeat(hb);
  return hb;
}
// 서버 확인 성공 시각 갱신(=유예 타이머 리셋)
function markHeartbeatOk() {
  const hb = loadHeartbeat() || {};
  const now = Date.now();
  hb.max = Math.max(hb.max || 0, now);
  hb.last = Math.max(now, hb.max);
  saveHeartbeat(hb);
}
// 마지막 서버 확인 이후 3일 초과? (아직 한 번도 확인 못 했으면 유예 소진 아님 — 오프라인 발급 사용자 배려)
function graceExpired() {
  const hb = loadHeartbeat();
  if (!hb || !hb.last) return false;
  const nowish = Math.max(Date.now(), hb.max || 0);
  return (nowish - hb.last) > REVOKE_GRACE_MS;
}
// 이 기기의 차단 여부를 서버에 질의 → { reached, blocked, wipe }
async function checkRevocation() {
  const mid = machineId();
  const p = 'license_requests?device_code=eq.' + encodeURIComponent(mid) + '&select=blocked,wipe';
  const r = await supaReq('GET', p, null);
  if (r.ok && Array.isArray(r.data)) {
    markHeartbeatOk();
    const row = r.data.find(x => x && x.blocked);
    if (row) return { reached: true, blocked: true, wipe: !!row.wipe };
    return { reached: true, blocked: false, wipe: false };
  }
  return { reached: false, blocked: false, wipe: false };   // 오프라인/실패
}
function clearLicense() {
  for (const f of licenseFiles()) { try { fs.unlinkSync(f); } catch (e) {} }
  for (const f of sharedLicenseFiles()) { try { fs.unlinkSync(f); } catch (e) {} }
}
// ⚠️ 관리자가 '데이터도 삭제'를 켰을 때만 호출 — 이 PC의 고객 데이터를 제거
function wipeLocalData() {
  try {
    const ud = app.getPath('userData');
    for (const t of ['config.json', 'callpilot-data.json', 'jipsooho-data.json', 'blocklist.json']) {
      try { fs.unlinkSync(path.join(ud, t)); } catch (e) {}
    }
    for (const d of ['auto-backups', 'Local Storage', 'consent-evidence']) {   // consent-evidence = 통화 녹음 증빙 — 퇴사 와이프 시 함께 파기
      try { fs.rmSync(path.join(ud, d), { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
}
// 잠금: 본창 닫기 → (선택)데이터 삭제 → 인증파일 삭제 → 인증창 표시
// 창을 먼저 닫아야 Local Storage 잠금이 풀려 데이터가 확실히 지워진다.
function lockDown(wipe) {
  try { if (mainWindow) { const w = mainWindow; mainWindow = null; w.destroy(); } } catch (e) {}
  try { if (wipe) wipeLocalData(); } catch (e) {}
  clearLicense();
  try { showActivationWindow(); } catch (e) {}
}
// 오프라인 유예 소진 잠금 — 인터넷 연결 안내 후 종료
function showOfflineLock() {
  try {
    dialog.showMessageBoxSync({
      type: 'warning', title: '콜파일럿 — 인터넷 연결 필요',
      message: '인터넷 연결이 3일 넘게 확인되지 않았습니다.',
      detail: '인터넷에 연결한 뒤 콜파일럿을 다시 실행해 주세요.', buttons: ['종료']
    });
  } catch (e) {}
  app.quit();
}
function scheduleHeartbeat() {
  if (__hbTimer) return;
  __hbTimer = setInterval(async () => {
    touchClock();
    const rev = await checkRevocation();
    if (rev.reached && rev.blocked) lockDown(rev.wipe);
  }, 30 * 60 * 1000);   // 30분마다
}

// ============ 사용자 데이터 폴더 ============
// 폴더 이름: CallScriptMemo (영문, 친구에게 노출되어도 무난)
// 기존 사용자는 '집수호 스크립트보드' 폴더에 데이터가 있으므로
// 앱 시작 시 자동으로 옛 폴더 → 새 폴더로 이름 변경 (데이터 유실 없음)
const APP_DATA_FOLDER = 'CallScriptMemo';
const LEGACY_FOLDER = '집수호 스크립트보드';
const userDataPath = path.join(app.getPath('appData'), APP_DATA_FOLDER);
const legacyPath = path.join(app.getPath('appData'), LEGACY_FOLDER);

try {
  // 옛 폴더만 있고 새 폴더가 없으면 → 폴더 이름 변경 (마이그레이션)
  if (fs.existsSync(legacyPath) && !fs.existsSync(userDataPath)) {
    fs.renameSync(legacyPath, userDataPath);
    console.log(`데이터 폴더 마이그레이션 완료: ${LEGACY_FOLDER} → ${APP_DATA_FOLDER}`);
  }
  // 둘 다 있으면 (사용자가 수동으로 뭔가 한 경우): 새 폴더 우선, 옛 폴더는 그대로 둠
  // 새 폴더만 있으면: 정상 신규 상태
} catch (e) {
  console.error('데이터 폴더 마이그레이션 실패 (옛 경로로 fallback):', e);
}

app.setPath('userData', userDataPath);

// 작업표시줄/알림에 표시되는 앱 이름을 '콜파일럿'으로 (exe에 박힌 옛 이름 'CallScriptMemo' 대신)
try { app.setName('콜파일럿'); } catch (e) {}
try { app.setAppUserModelId('콜파일럿'); } catch (e) {}

const { registerDialer } = require('./dialer/dialer-main');
const Store = require('electron-store');
// 데이터 파일 이름변경 마이그레이션: jipsooho-data.json → callpilot-data.json (기존 데이터 보존)
try {
  const ud = app.getPath('userData');
  const oldF = path.join(ud, 'jipsooho-data.json'), newF = path.join(ud, 'callpilot-data.json');
  if (fs.existsSync(oldF) && !fs.existsSync(newF)) fs.copyFileSync(oldF, newF);
} catch (e) {}
const store = new Store({
  name: 'callpilot-data',
  defaults: {
    cards: null, customers: [], callLogs: [], favorites: [], cardOrder: null,
    settings: {
      alwaysOnTop: false,
      hotkey: 'CommandOrControl+Shift+Space',
      windowBounds: { width: 1400, height: 900 }
    }
  }
});

// ============ 🛡️ 자동 백업 (실수 복구용) ============
// 초기화/복원 직전에 현재 데이터를 timestamp 파일로 보관
// 최근 7개만 유지하고 오래된 건 자동 삭제
function saveAutoBackup(reason) {
  try {
    try { __flushNow(); } catch (e) {}   // 대기 중 저장분 먼저 반영 후 백업
    const dir = path.join(app.getPath('userData'), 'auto-backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    const reasonTag = reason ? `.${reason}` : '';
    const file = path.join(dir, `callpilot-data.${ts}${reasonTag}.json`);
    fs.writeFileSync(file, JSON.stringify(store.store, null, 2), 'utf-8');
    // 최근 7개만 유지 (구 jipsooho-data 백업도 함께 정리)
    // ⚠ 반드시 접두사를 뗀 '타임스탬프' 기준으로 정렬할 것 — 파일명 전체를 sort().reverse() 하면
    //    사전순으로 j(jipsooho…) > c(callpilot…) 라 옛 jipsooho 백업 7개가 항상 상위를 차지하고,
    //    방금 쓴 callpilot 백업이 곧바로 프루닝으로 삭제됐다(2026-07-04 개명 이후 백업이 하나도
    //    안 남던 실사고의 원인 — 백업은 매일 써졌지만 그 자리에서 지워지고 있었다).
    const backupTs = f => f.replace(/^(callpilot|jipsooho)-data\./, '');
    const files = fs.readdirSync(dir)
      .filter(f => (f.startsWith('callpilot-data.') || f.startsWith('jipsooho-data.')) && f.endsWith('.json'))
      .sort((a, b) => backupTs(b).localeCompare(backupTs(a)));   // 타임스탬프 최신순
    files.slice(7).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    });
    return file;
  } catch (e) {
    console.error('자동 백업 실패:', e);
    return null;
  }
}

// 하루 1회 시작 시 백업 (같은 날 startup 백업이 이미 있으면 건너뜀)
function saveDailyStartupBackup() {
  try {
    const dir = path.join(app.getPath('userData'), 'auto-backups');
    const now = new Date();
    const today = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    if (fs.existsSync(dir)) {
      const has = fs.readdirSync(dir).some(f => (f.startsWith(`callpilot-data.${today}`) || f.startsWith(`jipsooho-data.${today}`)) && f.includes('.startup'));
      if (has) return;
    }
    saveAutoBackup('startup');
  } catch (e) {}
}

let mainWindow = null;

// ============================================================
//  🖥 화면에 맞추기(fit zoom) — 어느 모니터에서든 '내가 설정해 둔 배치'가 똑같이 보이게.
//  ------------------------------------------------------------
//  · layout.js 가 자기 배치 총폭(보이는 패널 px 합 + 스플리터, CSS px)을 'zoom:fit' 으로 알려준다
//    → 줌 = 창 폭 ÷ 배치폭. 그러면 CSS 뷰포트 폭이 항상 배치폭과 같아진다.
//    → 작은 모니터든 4K든 패널 비율·버튼 모양·줄 수가 **완전히 동일**하고, 큰 모니터에선
//      전체가 통째로 커질 뿐이다. (모니터 간 DPI 차이는 DIP 값에 이미 반영돼 있음)
//  · 예전엔 startup 때 1회 + 최대 100% 로 묶여 있어서, 큰 모니터로 옮기면 줌은 그대로인 채
//    남는 폭을 콜관리가 전부 흡수해 화면 비율이 완전히 달라졌다.
//  · createWindow 가 여러 경로(인증 통과 등)에서 불릴 수 있어 핸들러는 모듈 스코프에 1회만 등록한다
//    (ipcMain.handle 은 같은 채널 재등록 시 예외를 던진다).
// ============================================================
let fitLayoutW = 0;
let fitMinW = 0;    // 최소 배치폭(보이는 패널 min-width 합) — 확대 상한: 이보다 뷰포트가 좁아지면 패널이 뭉개짐
let fitTimer = null;
// 🙋 수동 확대/축소는 '절대 배율'이 아니라 fit 대비 **상대 배율**로 기억한다(기본 1.0 = 딱 맞춤).
//    이유: 줌을 바꾸면 렌더러 뷰포트가 변해 layout.js 가 resize→apply→zoom:fit 을 다시 쏜다.
//    이때 자동 맞춤이 배율을 모르면 곧바로 fit 값으로 '스냅백'해 확대/축소 버튼이 죽는다.
//    배율을 식에 넣어두면 → 스냅백도 없고, 창 크기 변경·모니터 이동 때 자동 맞춤도 계속 살아있고,
//    사용자 취향("fit보다 10% 크게")도 모니터를 옮겨도 그대로 유지된다. Ctrl+0 으로 1.0 복귀.
let zoomBias = 1;
function applyFitZoom() {
  if (!mainWindow || mainWindow.isDestroyed() || !(fitLayoutW > 0)) return;
  try {
    const cw = mainWindow.getContentBounds().width;
    if (!(cw > 0)) return;
    // 확대 상한: 줌을 z로 올리면 CSS 뷰포트 폭이 cw/z 로 줄어든다. cw/z 가 최소 배치폭(fitMinW)보다
    // 좁아지면 모든 패널이 min-width 에 눌려 뭉개지거나 오른쪽이 잘림 → z ≤ cw/fitMinW 로 캡.
    // (확대 자체는 그 전에 흡수 패널(콜관리)이 좁아지는 것으로 자연스럽게 소화된다)
    const zCap = (fitMinW > 0 && cw / fitMinW < 3) ? (cw / fitMinW) : 3;
    const z = Math.max(0.4, Math.min(zCap, (cw / fitLayoutW) * zoomBias));
    // 같은 값 재적용은 건너뜀 — resize→zoom→resize 되먹임 방지
    if (Math.abs(mainWindow.webContents.getZoomFactor() - z) > 0.005) mainWindow.webContents.setZoomFactor(z);
  } catch (e) {}
}
// 창 테두리를 끌어 라이브 리사이즈하는 동안 native resize 가 촘촘히 오므로 디바운스
// (setZoomFactor 는 전체 재레이아웃이라 매 프레임 호출하면 버벅인다)
// ⚠ on('resize', applyFitZoom) 처럼 직접 바인딩하지 말 것 — 이벤트 객체가 인자로 들어간다.
function scheduleFitZoom() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => applyFitZoom(), 120);
}
// 수동 확대/축소 — role:zoomIn/zoomOut 을 안 쓰는 이유는 배율(zoomBias)을 기억해야 하기 때문
// 배율은 store(settings.zoomBias)에 저장해 앱을 껐다 켜도 유지된다.
function bumpZoom(mult) {
  zoomBias = Math.max(0.4, Math.min(3, zoomBias * mult));
  try { store.set('settings.zoomBias', zoomBias); } catch (e) {}
  applyFitZoom();
}
function resetZoom() {
  zoomBias = 1;
  try { store.set('settings.zoomBias', 1); } catch (e) {}
  applyFitZoom();
}
ipcMain.handle('zoom:fit', (e, layoutW, minW, keepZoom) => {
  if (layoutW > 0) {
    // 🔒 패널을 켜고 끌 때(Ctrl+1/Ctrl+2)는 배치폭이 확 바뀌지만 화면 배율은 그대로 둔다.
    //    안 그러면 패널 하나 껐을 뿐인데 글씨가 1.4배로 커지고, 정작 남은 칸은 넓어지지 않는다.
    //    (배율 z = 창폭/배치폭 × bias 이므로, 배치폭이 준 만큼 bias 를 같이 줄이면 z 가 불변)
    if (keepZoom && fitLayoutW > 0) {
      zoomBias = Math.max(0.4, Math.min(3, zoomBias * (layoutW / fitLayoutW)));
      try { store.set('settings.zoomBias', zoomBias); } catch (err) {}
    }
    fitLayoutW = layoutW;
    if (minW > 0 && minW <= layoutW) fitMinW = minW;   // 구버전 렌더러(인자 1개)와도 호환
    // 다음 부팅 때 첫 페인트부터 정확한 줌을 걸기 위해 저장 (부팅 시 100%→축소 '번쩍임' 제거)
    try { store.set('settings.fitLayoutW', fitLayoutW); store.set('settings.fitMinW', fitMinW); } catch (err) {}
    applyFitZoom();
  }
});

// ============================================================
//  🎓 교육 창 — 노션 대체(12세션 저장소·콜 라이브러리·진도·주간지표·MY DREAM)
//  · 같은 preload.js 를 쓰므로 렌더러에서 window.api.store / window.api.crm.me 를 그대로 쓴다.
//    (tmcrm 처럼 iframe+브리지를 둘 필요가 없어 훨씬 단순하다)
//  · 권한 분기는 education.html 안에서 crm.me().role 로 한다 — master=교육담당(전원), agent=상담사(본인만).
// ============================================================
let educationWin = null;
function openEducationWindow() {
  if (educationWin && !educationWin.isDestroyed()) { educationWin.focus(); return; }
  educationWin = new BrowserWindow({
    width: 1180, height: 820, minWidth: 820, minHeight: 560,
    title: '콜파일럿 — 교육',
    backgroundColor: '#0f0d0a',
    icon: path.join(__dirname, 'assets', 'callpilot.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    }
  });
  educationWin.setMenuBarVisibility(false);
  educationWin.loadFile(path.join(__dirname, 'renderer', 'education.html'));
  educationWin.on('closed', () => { educationWin = null; });
}

function createWindow() {
  const bounds = store.get('settings.windowBounds') || {};
  // 🔎 저장된 확대/축소 배율 복원(fit 대비 상대배율) — 재시작해도 사용자가 키운 크기 그대로
  { const zb = Number(store.get('settings.zoomBias')); if (zb >= 0.4 && zb <= 3) zoomBias = zb; }
  // 🔎 지난 실행의 배치폭 복원 — layout.js가 첫 보고를 하기 전에도 정확한 fit 줌을 걸 수 있게.
  //    (없으면 아래 applyAutoZoom 폴백이 잠깐 대략값을 씀 → 켤 때마다 글씨가 커졌다 작아지는 번쩍임의 원인이었음)
  {
    const fw = Number(store.get('settings.fitLayoutW'));
    if (fw > 0) fitLayoutW = fw;
    const fm = Number(store.get('settings.fitMinW'));
    if (fm > 0 && fm <= fitLayoutW) fitMinW = fm;
  }
  // 🖥 현재(주) 모니터 작업영역 안으로 창 크기를 제한 — 다른 큰 모니터에서 저장된 값이나
  //    엉뚱한 위치 때문에 노트북에서 창이 화면 밖으로 나가거나 잘리는 것 방지.
  //    x/y는 쓰지 않고 화면 중앙에 띄운 뒤(아래 center) 최대화한다.
  let waW = 1400, waH = 900;
  try { const wa = screen.getPrimaryDisplay().workAreaSize; waW = wa.width || waW; waH = wa.height || waH; } catch (e) {}
  const winW = Math.min(Math.max(bounds.width || 1400, 900), waW);
  const winH = Math.min(Math.max(bounds.height || 900, 560), waH);
  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: Math.min(900, waW),
    minHeight: Math.min(560, waH),
    center: true,
    title: '콜파일럿 — 자동발신 + 콜 스크립트',
    backgroundColor: '#161310',
    icon: path.join(__dirname, 'assets', 'callpilot.ico'),
    alwaysOnTop: store.get('settings.alwaysOnTop'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false   // 🔒 개발자도구 차단 — F12/콘솔로 데이터 덤프 방지
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 🖥 시작 시 창 최대화 — 다른 PC로 넘겨도 항상 풀스크린으로 동일하게 뜨도록.
  //    (창 복원/위치는 위 windowBounds 로 보존됨)
  mainWindow.maximize();

  // 🖥 창 크기 변경·모니터 이동 때마다 배치폭에 맞춰 다시 줌 (fit zoom — 모듈 위쪽 정의 참고)
  mainWindow.on('resize', scheduleFitZoom);
  mainWindow.on('move', scheduleFitZoom);   // 다른 모니터로 끌어다 놓기

  // 🛟 폴백 — layout.js 가 배치폭을 알려주기 전(또는 못 알려줄 때)만 쓰는 초기 줌.
  //    노트북·고배율 환경에서 첫 화면이 잘리지 않게. 곧 fit zoom 이 덮어쓴다.
  const applyAutoZoom = () => {
    try {
      if (fitLayoutW > 0) return applyFitZoom();   // 저장·수신된 배치폭이 있으면 첫 페인트부터 정확한 줌
      const wa = screen.getDisplayMatching(mainWindow.getBounds()).workAreaSize;
      const z = Math.max(0.62, Math.min(1, (wa.width - 24) / 1440));
      mainWindow.webContents.setZoomFactor(z);
    } catch (e) {}
  };
  mainWindow.webContents.on('did-finish-load', applyAutoZoom);

  // F5 키로 새로고침 (Ctrl+R과 동일)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' && !input.alt && !input.control && !input.shift && !input.meta) {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  const menuTemplate = [
    {
      label: '파일',
      submenu: [
        { label: '데이터 불러오기 (복원)', accelerator: 'CommandOrControl+I', click: () => importData() },
        { type: 'separator' },
        {
          label: '⚠️ 데이터 전체 초기화 (백지 상태로)',
          click: async () => {
            const r1 = dialog.showMessageBoxSync(mainWindow, {
              type: 'warning',
              buttons: ['취소', '초기화 진행'],
              defaultId: 0,
              cancelId: 0,
              title: '데이터 전체 초기화',
              message: '정말 모든 데이터를 백지 상태로 되돌리시겠습니까?',
              detail: '삭제 대상:\n  • 모든 카드 (직접 만든 카드 포함)\n  • 메모, 메모 양식\n  • 빠른응대 키워드\n  • 즐겨찾기, 통화 기록\n  • 글씨 설정 등 모든 설정\n\n💡 안심하세요: 초기화 직전 자동 백업이 만들어지므로,\n실수로 누르셔도 [↩️ 초기화 되돌리기]로 복구 가능합니다.'
            });
            if (r1 !== 1) return;
            // 두 번째 확인 (실수 방지)
            const r2 = dialog.showMessageBoxSync(mainWindow, {
              type: 'warning',
              buttons: ['취소', '예, 모두 삭제하고 백지로'],
              defaultId: 0,
              cancelId: 0,
              title: '한 번 더 확인',
              message: '정말 모든 데이터를 삭제하고 백지 상태로 시작하시겠습니까?',
              detail: '확인을 누르면 즉시 자동 백업 후 모든 데이터가 삭제되고 앱이 재시작됩니다.'
            });
            if (r2 !== 1) return;
            try {
              // 🛡️ 자동 백업 (실수 복구용)
              const backupFile = saveAutoBackup('before-reset');
              // 데이터 전체 삭제
              store.clear();
              // 🔒 빠른대응 키워드 기본값 부활 방지
              //    store.clear() 후 키가 사라지면 renderer가 '첫 실행'으로 오해해서
              //    DEFAULT_QUICK_KEYWORDS를 다시 주입함. 빈 배열로 못박아서 차단.
              store.set('quickKeywords', []);
              dialog.showMessageBoxSync(mainWindow, {
                type: 'info',
                title: '초기화 완료',
                message: '모든 데이터가 백지 상태로 돌아갔습니다.',
                detail: `🛡️ 안전 백업이 만들어졌습니다:\n${backupFile ? path.basename(backupFile) : '(백업 실패)'}\n\n실수로 누르셨다면 메뉴 → 파일 → [↩️ 초기화 되돌리기]로\n방금 백업으로 복원할 수 있습니다.\n\n확인을 누르면 앱이 재시작됩니다.`
              });
              app.relaunch();
              app.exit(0);
            } catch (e) {
              dialog.showErrorBox('초기화 실패', '초기화 중 오류가 발생했습니다: ' + e.message);
            }
          }
        },
        {
          label: '↩️ 초기화 되돌리기 (자동 백업에서 복원)',
          click: async () => {
            const autoBackupDir = path.join(app.getPath('userData'), 'auto-backups');
            if (!fs.existsSync(autoBackupDir)) {
              dialog.showMessageBoxSync(mainWindow, {
                type: 'info',
                title: '복원할 백업이 없습니다',
                message: '자동 백업이 아직 만들어지지 않았습니다.',
                detail: '데이터를 초기화한 적이 없거나, 백업 파일이 모두 삭제되었습니다.'
              });
              return;
            }
            const files = fs.readdirSync(autoBackupDir)
              .filter(f => (f.startsWith('callpilot-data.') || f.startsWith('jipsooho-data.')) && f.endsWith('.json'))
              .sort()
              .reverse()
              .slice(0, 3); // 최대 3개만 표시
            if (files.length === 0) {
              dialog.showMessageBoxSync(mainWindow, {
                type: 'info',
                title: '복원할 백업이 없습니다',
                message: '자동 백업 폴더가 비어있습니다.'
              });
              return;
            }

            // 상대 시간 포맷 ("방금 전", "15분 전", "어제" 등)
            const formatRelative = (date) => {
              const diffMs = Date.now() - date.getTime();
              const diffMin = Math.floor(diffMs / 60000);
              const diffHour = Math.floor(diffMin / 60);
              const diffDay = Math.floor(diffHour / 24);
              if (diffMin < 1) return '방금 전';
              if (diffMin < 60) return `${diffMin}분 전`;
              if (diffHour < 24) return `${diffHour}시간 전`;
              if (diffDay === 1) return '어제';
              if (diffDay < 7) return `${diffDay}일 전`;
              return `${diffDay}일 전`;
            };

            // 각 백업 정보 수집
            const backups = files.map(filename => {
              const fpath = path.join(autoBackupDir, filename);
              const stat = fs.statSync(fpath);
              let counts = { cards: 0, notes: 0, noteTemplates: 0, quickKeywords: 0, customers: 0, favorites: 0 };
              try {
                const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
                counts.cards = Array.isArray(data.cards) ? data.cards.length : 0;
                counts.notes = Array.isArray(data.notes) ? data.notes.length : 0;
                counts.noteTemplates = Array.isArray(data.noteTemplates) ? data.noteTemplates.length : 0;
                counts.quickKeywords = Array.isArray(data.quickKeywords) ? data.quickKeywords.length : 0;
                counts.customers = Array.isArray(data.customers) ? data.customers.length : 0;
                counts.favorites = Array.isArray(data.favorites) ? data.favorites.length : 0;
              } catch (e) {}
              let reason = '';
              if (filename.includes('before-reset')) reason = '초기화 직전';
              else if (filename.includes('before-restore')) reason = '복원 직전';
              return {
                filename, filepath: fpath, mtime: stat.mtime,
                sizeKB: (stat.size / 1024).toFixed(1),
                counts, reason,
                rel: formatRelative(stat.mtime),
                abs: stat.mtime.toLocaleString('ko-KR')
              };
            });

            // detail 메시지 구성 (각 백업의 상세 정보)
            let detail = '';
            backups.forEach((b, i) => {
              detail += `\n[${i+1}] ${b.abs}  (${b.rel})`;
              if (b.reason) detail += `  ·  ${b.reason}`;
              detail += `\n     📦 카드 ${b.counts.cards} · 메모 ${b.counts.notes} · 양식 ${b.counts.noteTemplates} · 빠른응대 ${b.counts.quickKeywords} · 고객 ${b.counts.customers} · 즐겨찾기 ${b.counts.favorites}\n`;
            });
            detail += `\n💡 복원 직전 현재 상태도 자동 백업되어, 복원 후 또 마음이 바뀌어도 되돌릴 수 있습니다.`;

            // 버튼 라벨: 짧게 (시간만)
            const buttonLabels = backups.map((b, i) => `[${i+1}] ${b.rel}`);
            const buttons = ['취소', ...buttonLabels];

            const r = dialog.showMessageBoxSync(mainWindow, {
              type: 'question',
              buttons: buttons,
              defaultId: 1, // 기본은 가장 최근 백업
              cancelId: 0,
              title: '복원할 백업 선택',
              message: `어느 시점의 백업으로 되돌리시겠습니까? (${backups.length}개 보유)`,
              detail: detail
            });

            if (r === 0) return; // 취소
            const selected = backups[r - 1];
            if (!selected) return;

            try {
              // 🛡️ 복원 직전에 현재 데이터도 백업 (재복구용)
              saveAutoBackup('before-restore');
              // 선택된 백업 파일 읽기
              const backupData = JSON.parse(fs.readFileSync(selected.filepath, 'utf-8'));
              // store 비우고 백업 데이터로 채움
              store.clear();
              for (const [k, v] of Object.entries(backupData)) {
                store.set(k, v);
              }
              // 🔒 백업에 quickKeywords 키가 없으면(오래된 백업 등) renderer가 '첫 실행'으로
              //    오해해 기본 빠른대응을 되살림 → 초기화 로직과 동일하게 빈 배열로 못박아 차단.
              if (!Object.prototype.hasOwnProperty.call(backupData, 'quickKeywords')) {
                store.set('quickKeywords', []);
              }
              dialog.showMessageBoxSync(mainWindow, {
                type: 'info',
                title: '복원 완료',
                message: `[${r}]번 백업 시점으로 복원되었습니다.`,
                detail: `복원된 시점: ${selected.abs} (${selected.rel})\n${selected.reason ? `사유: ${selected.reason}\n` : ''}\n확인을 누르면 앱이 재시작됩니다.\n\n💡 복원 직전 상태는 또 다른 자동 백업으로 보관되어 있어,\n다시 [↩️ 초기화 되돌리기]를 누르면 그 상태로도 갈 수 있습니다.`
              });
              app.relaunch();
              app.exit(0);
            } catch (e) {
              dialog.showErrorBox('복원 실패', '복원 중 오류가 발생했습니다: ' + e.message);
            }
          }
        },
        {
          label: '자동 백업 폴더 열기',
          click: () => {
            const autoBackupDir = path.join(app.getPath('userData'), 'auto-backups');
            if (!fs.existsSync(autoBackupDir)) fs.mkdirSync(autoBackupDir, { recursive: true });
            shell.openPath(autoBackupDir);
          }
        },
        { type: 'separator' },
        {
          label: '로그아웃',
          click: () => {
            const r = dialog.showMessageBoxSync(mainWindow, {
              type: 'question', buttons: ['취소', '로그아웃'], defaultId: 0, cancelId: 0,
              title: '로그아웃', message: '로그아웃하시겠습니까?',
              detail: '다시 로그인해야 콜파일럿을 사용할 수 있습니다.'
            });
            if (r !== 1) return;
            stopCrmRevalidation();
            clearCrmSession();
            app.relaunch();
            app.exit(0);
          }
        },
        { type: 'separator' },
        { label: '종료', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '편집',
      submenu: [
        // 고정 3분할(발신+멘트·빠른대응+콜관리)로 단순화 — 가운데(멘트)=Ctrl+1, 콜관리=Ctrl+2.
        { label: '가운데 스크립트(멘트·빠른대응) 보기/숨기기', accelerator: 'CommandOrControl+1', click: () => mainWindow && mainWindow.webContents.send('menu:action', 'toggle-memo') },
        { label: '콜 관리 보기/숨기기', accelerator: 'CommandOrControl+2', click: () => mainWindow && mainWindow.webContents.send('menu:action', 'toggle-crm') },
        { type: 'separator' },
        { label: '글씨 설정', click: () => mainWindow && mainWindow.webContents.send('menu:action', 'font-settings') },
        { type: 'separator' },
        { label: '기본 배치로 복원', click: () => mainWindow && mainWindow.webContents.send('menu:action', 'layout-reset') },
      ]
    },
    {
      label: '교육',
      submenu: [
        { label: '🎓 교육 창 열기', accelerator: 'CommandOrControl+3', click: () => openEducationWindow() }
      ]
    },
    {
      label: '보기',
      submenu: [
        {
          label: '항상 위에 표시',
          type: 'checkbox',
          checked: store.get('settings.alwaysOnTop'),
          click: (item) => {
            store.set('settings.alwaysOnTop', item.checked);
            mainWindow.setAlwaysOnTop(item.checked);
          }
        },
        { type: 'separator' },
        { role: 'reload', label: '새로고침' },
        { type: 'separator' },
        // 초기화 = 100% 가 아니라 '화면에 맞추기'(배율 1.0 = 배치가 창을 딱 채움).
        // 100%로 되돌리면 큰 모니터에서 다시 비율이 틀어진다.
        { label: '확대/축소 초기화 (화면에 맞추기)', accelerator: 'CommandOrControl+0', click: () => resetZoom() },
        { label: '확대', accelerator: 'CommandOrControl+Plus', click: () => bumpZoom(1.1) },
        { label: '축소', accelerator: 'CommandOrControl+-', click: () => bumpZoom(1 / 1.1) },
        // 숨은 단축키 — 'CommandOrControl+Plus' 는 실제로 Ctrl+Shift+= 라(+ 가 shift 문자) 사람들이
        // 그냥 누르는 Ctrl+= 나 숫자패드 +/- 가 안 먹는다. 눈에 안 보이는 항목으로 함께 받아준다.
        // ⚠ visible:false 여도 label(또는 role/type)이 반드시 있어야 한다 — 없으면 buildFromTemplate가
        //   "Invalid template for MenuItem" 예외를 던져 메뉴 전체가 안 깔리고 영어 기본 메뉴로 떨어진다(실제 발생).
        { label: '확대(Ctrl+=)', accelerator: 'CommandOrControl+=', visible: false, click: () => bumpZoom(1.1) },
        { label: '확대(숫자패드+)', accelerator: 'CommandOrControl+numadd', visible: false, click: () => bumpZoom(1.1) },
        { label: '축소(숫자패드-)', accelerator: 'CommandOrControl+numsub', visible: false, click: () => bumpZoom(1 / 1.1) }
      ]
    },
    {
      label: '도움말',
      submenu: [
        {
          label: '🎓 튜토리얼 다시 보기',
          click: () => mainWindow && mainWindow.webContents.send('menu:action', 'tutorial')
        },
        { type: 'separator' },
        {
          label: '🔄 업데이트 확인',
          click: () => {
            try { require('./updater').manualCheck({ app, dialog, getWindow: () => mainWindow }); }
            catch (e) { logMainError('updater-manual', e); }
          }
        },
        { type: 'separator' },
        {
          label: '단축키',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info', title: '단축키',
              message: '콜파일럿 단축키',
              detail: [
                '전역 (다른 프로그램 위에서도):',
                '  Ctrl + Shift + Space  →  창 띄우기/숨기기',
                '',
                '발신(다이얼러):',
                '  Ctrl + Enter  →  다음 번호 (자동종료→기록저장→대기→다음 발신)',
                '',
                '패널 보기/숨기기:',
                '  Ctrl + 1  →  가운데 스크립트(멘트·빠른대응)',
                '  Ctrl + 2  →  콜 관리',
                '',
                '화면 크기:',
                '  Ctrl + 0  →  화면에 맞추기 (배치가 창을 딱 채우게 — 모니터 바뀌어도 같은 화면)',
                '  Ctrl + =  →  확대   ·   Ctrl + -  →  축소 (맞춤 대비 배율로 기억되어 계속 유지됨)',
                '',
                '앱 안에서:',
                '  /  →  검색창 포커스',
                '  Esc  →  편집 취소 / 모달 닫기',
                '  Ctrl + N  →  새 카드',
                '  Ctrl + F  →  검색',
                '  Ctrl + S  →  편집 저장',
                '  Ctrl + I  →  데이터 불러오기 (복원)'
              ].join('\n')
            });
          }
        }
      ]
    }
  ];
  // 메뉴가 깨져도 앱은 계속 살리고(기본 메뉴로 폴백), 원인은 main-error.log에 남긴다.
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  } catch (e) {
    logMainError('menu', e);
  }

  mainWindow.on('close', () => {
    if (mainWindow) store.set('settings.windowBounds', mainWindow.getBounds());
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// IPC
// 저장 최적화: 빠른 연속 set 을 모아 디바운스로 한 번에 디스크 기록 (메인 프로세스 멈춤 방지)
const __pendingWrites = {};
let __flushTimer = null;
function __flushWrites() {
  __flushTimer = null;
  const keys = Object.keys(__pendingWrites);
  if (!keys.length) return;
  const batch = {};
  keys.forEach(k => { batch[k] = __pendingWrites[k]; delete __pendingWrites[k]; });
  try { store.set(batch); } catch (e) { console.error('store flush 실패:', e); } // 객체 set = 파일 1회 기록
}
function __scheduleFlush() {
  if (__flushTimer) clearTimeout(__flushTimer);
  __flushTimer = setTimeout(__flushWrites, 400);
}
function __flushNow() { if (__flushTimer) clearTimeout(__flushTimer); __flushWrites(); }

ipcMain.handle('store:get', (e, key) => {
  if (Object.prototype.hasOwnProperty.call(__pendingWrites, key)) return __pendingWrites[key]; // 아직 안 쓴 최신값 우선
  return store.get(key);
});
ipcMain.handle('store:set', (e, key, value) => { __pendingWrites[key] = value; __scheduleFlush(); return true; });
ipcMain.handle('store:delete', (e, key) => { delete __pendingWrites[key]; store.delete(key); return true; });
ipcMain.handle('window:setAlwaysOnTop', (e, v) => {
  if (mainWindow) { mainWindow.setAlwaysOnTop(v); store.set('settings.alwaysOnTop', v); }
  return v;
});
ipcMain.handle('window:getAlwaysOnTop', () => store.get('settings.alwaysOnTop'));
// 🩹 재렌더 후 입력 포커스가 빠져 타이핑이 안 되던 문제(다른 창 갔다와야 풀림) → webContents 포커스 재확보
ipcMain.handle('window:refocus', () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // webContents.focus()만으론 네이티브 다이얼로그(confirm/alert)가 가져간 OS 키보드 포커스가 안 돌아온다.
      // 창을 blur→focus 해서 "다른 창 갔다오기"를 코드로 재현 → 키 입력 복구. (사용자가 손으로 하던 동작 자동화)
      mainWindow.blur();
      mainWindow.focus();
      mainWindow.webContents.focus();
      setTimeout(() => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus(); } catch (e) {} }, 50);
    }
  } catch (e) {}
  return true;
});
ipcMain.handle('app:import', () => importData());
ipcMain.handle('app:pickJsonFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'JSON 파일 선택',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try { return fs.readFileSync(r.filePaths[0], 'utf-8'); }
  catch (err) { dialog.showErrorBox('파일 읽기 실패', err.message); return null; }
});


async function importData() {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '데이터 불러오기',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return { success: false };
  try {
    const content = fs.readFileSync(r.filePaths[0], 'utf-8');
    const data = JSON.parse(content);
    // 백업 파일 안의 '실제 데이터 키'만 추림 (메타 정보는 store에 안 넣음)
    const META = new Set(['_backup', 'version', 'exportedAt']);
    const keys = Object.keys(data).filter(k => !META.has(k));
    if (!keys.length) { dialog.showErrorBox('실패', '백업 파일에서 데이터를 찾지 못했어요.'); return { success: false }; }
    const cnt = (k) => Array.isArray(data[k]) ? data[k].length : 0;
    const c = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['덮어쓰기', '취소'], defaultId: 1, cancelId: 1,
      title: '데이터 불러오기', message: '이 백업으로 현재 데이터를 덮어쓸까요?',
      detail: `📦 카드 ${cnt('cards')} · 메모 ${cnt('notes')} · 양식 ${cnt('noteTemplates')} · 빠른대응 ${cnt('quickKeywords')} · 발신기록 ${cnt('dialRecords')} · 고객 ${cnt('customers')}\n\n💡 덮어쓰기 직전 현재 상태가 자동 백업되어, 잘못 불러와도\n   [파일 → ↩️ 초기화 되돌리기]로 되돌릴 수 있어요.`
    });
    if (c.response !== 0) return { success: false };
    // 🛡️ 덮어쓰기 직전 현재 상태를 자동 백업 (재복구용)
    saveAutoBackup('before-restore');
    // 백업에 들어있는 키만 덮어씀(merge). 백업에 없는 키는 그대로 둠 →
    // 옛날 4개짜리 백업으로 복원해도 메모·양식·발신기록이 날아가지 않음.
    const batch = {};
    keys.forEach(k => { batch[k] = data[k]; });
    store.set(batch);
    mainWindow.webContents.send('data:imported');
    return { success: true };
  } catch (err) { dialog.showErrorBox('실패', err.message); return { success: false }; }
}

function registerHotkeys() {
  const hk = store.get('settings.hotkey') || 'CommandOrControl+Shift+Space';
  globalShortcut.register(hk, () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('hotkey:focus-search'); }
  });
}

app.whenReady().then(async () => {
  saveDailyStartupBackup();   // 하루 1회 자동 백업 (최근 7개 유지)
  // 다이얼러(ADB) IPC 등록 — appRoot = resources/app (adb/ 바이너리 위치)
  try { registerDialer(ipcMain, store, app, path.join(__dirname, '..'), () => mainWindow, dialog); }
  catch (e) { console.error('다이얼러 등록 실패:', e); }
  // 📱 같은 wifi LAN 동기화 서버(폰 콜파일럿과 고객·통화기록 동기화) — 실패해도 앱 본체 영향 없음
  try { require('./sync-server').startSyncServer(store, () => mainWindow, { getActivation: ownActivation, acceptActivation: acceptSharedActivation }); }
  catch (e) { console.error('동기화 서버 시작 실패:', e); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) crmStartupGate(); });
  touchClock();   // 시작할 때 관측 최대시각 기록(시계 되돌리기 방지) — 기존 킬스위치 코드는 유지(다른 참조 대비), 시작 분기에서는 미사용
  // 🔄 자동 업데이트(마스터콘솔 발행분) — 시작 8초 뒤 1회 + 3시간마다. 실패해도 앱 본체 영향 없음
  try { require('./updater').initAutoUpdate({ app, dialog, getWindow: () => mainWindow }); }
  catch (e) { logMainError('updater-init', e); }
  // 🔑 시작 게이트: 기기 정품 인증 대신 상담사 아이디·비번 로그인(배분 CRM)으로 진입 확인
  await crmStartupGate();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { try { __flushNow(); } catch (e) {} globalShortcut.unregisterAll(); });
