// ============================================================
//  dialer-main.js — 다이얼러 메인프로세스 측 (IPC + 영속화)
//  main.js 에서 registerDialer(ipcMain, store, app, appRoot) 호출
// ============================================================
const path = require('path');
const fs = require('fs');
const { Adb } = require('./adb');

// ── 작업8: dialRecords 단일 병합 writer ──────────────────────────────────
// registerDialer() 가 호출되면 실제 store 를 쥔 writeDialRecords 클로저가 여기에 연결된다.
// sync-server.js 는 이 모듈을 require 해서 module.exports.writeDialRecords 를 통해서만
// dialRecords 를 쓴다 — store.set('dialRecords', ...) 를 직접 부르지 않는다(두 writer 경합 방지).
let __sharedWriteDialRecords = null;

// dialRecords 병합 키 — sync-server.js recKey() / dialer.renderer.js recSyncKey() 와 동일 규칙으로
// 맞춰야 한다(mid=모바일 원본id 우선 > ts > 번호+시각). 셋 중 하나만 바뀌면 dedup 이 깨진다.
function dlRecKey(r) {
  if (!r) return '';
  return r.mid || r.ts || (String(r.number || '').replace(/\D/g, '') + '|' + (r.dialAt || r.time || ''));
}

function registerDialer(ipcMain, store, app, appRoot, getWindow, dialog) {
  const adb = new Adb(appRoot);

  // ip.txt 경로: 앱 폴더 옆 (adb 와 같은 위치 우선), 없으면 userData
  const ipTxtCandidates = [
    path.join(appRoot, 'adb', 'ip.txt'),
    path.join(appRoot, 'ip.txt'),
    path.join(app.getPath('userData'), 'ip.txt'),
  ];
  function ipTxtPath() {
    for (const p of ipTxtCandidates) if (fs.existsSync(p)) return p;
    // 없으면 userData 에 새로 만든다 (배포 폴더가 읽기전용일 수 있으므로)
    return path.join(app.getPath('userData'), 'ip.txt');
  }

  // ip.txt 에서 IP 로드 — # 주석/빈 줄 무시, 첫 유효 줄. 폴백: store.dialerIp
  function loadIp() {
    try {
      const p = ipTxtPath();
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/);
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          return line;
        }
      }
    } catch (e) {}
    return store.get('dialerIp') || '';
  }

  // ip.txt 에 저장 — 주석은 보존, 마지막 유효 줄만 교체. 빈 값은 저장 안 함(실수 보호)
  function saveIp(ip) {
    if (!ip || !ip.trim()) return;
    store.set('dialerIp', ip.trim());
    try {
      const p = ipTxtPath();
      let comments = [
        '# 폰 IP 설정 파일. 메모장으로 열어서 수정 가능합니다.',
        '# 폰 IP가 바뀌면 아래 줄을 새 IP로 바꿔주세요.',
        '# (# 으로 시작하는 줄은 무시됩니다)',
      ];
      if (fs.existsSync(p)) {
        const existing = fs.readFileSync(p, 'utf-8').split(/\r?\n/).filter(l => l.trim().startsWith('#'));
        if (existing.length) comments = existing;
      }
      fs.writeFileSync(p, comments.join('\r\n') + '\r\n' + ip.trim() + '\r\n', 'utf-8');
    } catch (e) { /* 배포 폴더 읽기전용이면 store 만으로 충분 */ }
  }

  // ---- IPC ----
  ipcMain.handle('dialer:loadIp', () => loadIp());
  ipcMain.handle('dialer:saveIp', (e, ip) => { saveIp(ip); return true; });

  ipcMain.handle('dialer:connect', async (e, ip) => {
    if (ip) saveIp(ip);
    const r = await adb.connect(ip || loadIp());
    if (r && r.ok) {
      const good = (ip || loadIp() || '').trim();
      if (good) store.set('dialerLastGoodIp', good);   // 마지막 성공 IP 기억
    }
    return r;
  });
  // 앱 시작 시 자동연결용 IP: 마지막 성공 IP 우선 → 박스 IP → ip.txt
  ipcMain.handle('dialer:autostartIp', () => store.get('dialerLastGoodIp') || loadIp());
  ipcMain.handle('dialer:lastGoodIp', () => store.get('dialerLastGoodIp') || '');
  ipcMain.handle('dialer:reconnect', async (e, ip) => adb.reconnect(ip || loadIp()));
  // 🔍 폰 자동 탐색 — IP 가 바뀌어도 같은 와이파이에서 찾아 연결. 성공하면 새 IP 저장.
  ipcMain.handle('dialer:autoFind', async () => {
    const prefer = store.get('dialerLastGoodIp') || loadIp();
    const r = await adb.autoFind(prefer);
    if (r && r.ok && r.ip) {
      saveIp(r.ip);
      store.set('dialerLastGoodIp', r.ip + ':5555');
    }
    // 실패 시 안내용: 폰의 '예전 IP'를 함께 넘겨 렌더러가 '다른 Wi-Fi' 여부를 판단
    return Object.assign({ lastIp: String(prefer || '').split(':')[0] }, r);
  });
  ipcMain.handle('dialer:devices', async () => adb.devices());
  ipcMain.handle('dialer:dial', async (e, number) => adb.dial(number));
  ipcMain.handle('dialer:smsCompose', async (e, number, body) => adb.smsCompose(number, body));
  // 📷 문자에 붙일 사진 고르기 (PC 파일 선택창)
  ipcMain.handle('dialer:pickImage', async () => {
    try {
      const win = (typeof getWindow === 'function') ? getWindow() : null;
      const r = await dialog.showOpenDialog(win, {
        title: '문자에 붙일 사진 고르기',
        properties: ['openFile'],
        filters: [{ name: '사진', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
      });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0] };
    } catch (err) { return { ok: false, message: String((err && err.message) || err) }; }
  });
  // 📷 사진을 폰으로 옮겨 메시지앱에 실어 연다 (실제 전송은 사용자가)
  ipcMain.handle('dialer:mmsCompose', async (e, number, body, paths) => adb.mmsCompose(number, body, paths));
  ipcMain.handle('dialer:endCall', async () => adb.endCall());
  ipcMain.handle('dialer:callState', async () => adb.callState());
  ipcMain.handle('dialer:callInfo', async () => adb.callInfo());       // 상태+걸려온 번호
  ipcMain.handle('dialer:lastCall', async () => adb.lastCall());       // 통화기록 최근 1건(폴백)
  ipcMain.handle('dialer:activeCall', async () => adb.activeCall());   // 진행 중 통화 번호(발신 실시간)
  ipcMain.handle('dialer:answerCall', async () => adb.answerCall());   // 걸려온 전화 받기
  ipcMain.handle('dialer:blockedNumbers', async () => adb.blockedNumbers()); // 폰 차단번호 목록
  ipcMain.handle('dialer:addBlockedContact', async (e, number) => adb.addBlockedContact(number)); // 폰 연락처에 차단요청N 저장
  ipcMain.handle('dialer:callLogList', async (e, limit) => adb.callLogList(limit)); // 통화기록 다건(횟수 집계)
  ipcMain.handle('dialer:smsFor', async (e, number) => adb.smsFor(number));         // 번호별 문자(SMS)
  ipcMain.handle('dialer:recordingsFor', async (e, number) => adb.recordingsFor(number)); // 번호별 통화녹음 목록
  // 통화녹음을 임시폴더로 내려받고 재생 준비 (로컬 경로 반환)
  ipcMain.handle('dialer:pullRecording', async (e, remote, name) => {
    try {
      const dir = path.join(app.getPath('temp'), 'callpilot-rec');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'rec').replace(/[\\/:*?"<>|]/g, '_');
      const local = path.join(dir, safe);
      return await adb.pullFile(remote, local);
    } catch (err) { return { ok: false, path: '', message: String(err && err.message || err) }; }
  });
  // 파일을 기본 플레이어로 열기 (인앱 재생 실패 시 폴백)
  ipcMain.handle('dialer:openPath', async (e, p) => { try { const { shell } = require('electron'); await shell.openPath(p); return { ok: true }; } catch (err) { return { ok: false }; } });
  // 🆕 P2) 법정 증빙 녹음 이관 — 통화 녹음을 영구 보관 폴더(userData\consent-evidence)로 내려받기.
  //    pullRecording(temp, OS가 청소함)과 달리 증빙은 지워지면 안 되므로 별도 폴더. 이름 충돌 시 (n) 붙여 보존.
  ipcMain.handle('dialer:pullEvidence', async (e, remote, name) => {
    try {
      const dir = path.join(app.getPath('userData'), 'consent-evidence');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'rec').replace(/[\\/:*?"<>|]/g, '_');
      let local = path.join(dir, safe);
      if (fs.existsSync(local)) {
        const ext = path.extname(safe), base = path.basename(safe, ext);
        let n = 2;
        while (fs.existsSync(local = path.join(dir, base + '(' + n + ')' + ext))) n++;
      }
      return await adb.pullFile(remote, local);
    } catch (err) { return { ok: false, path: '', message: String(err && err.message || err) }; }
  });

  // 🚫 차단목록 — 개인 PC(userData)에만 저장. 앱 폴더엔 안 둠 → 배포/설치파일에 안 딸려감(개인정보 보호).
  const blocklistUserPath = path.join(app.getPath('userData'), 'blocklist.json');
  const blocklistLegacyApp = path.join(appRoot, 'blocklist.json');   // 예전 앱폴더 사본(있으면 읽어와 병합 후 정리)
  function readOneBl(p) { try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(a) ? a.map(x => String(x).replace(/\D/g, '')).filter(Boolean) : []; } catch (e) { return []; } }
  function readBlocklist() { return [...new Set([...readOneBl(blocklistUserPath), ...readOneBl(blocklistLegacyApp)])]; }
  function writeBlocklist(arr) {
    let ok = false;
    try { fs.writeFileSync(blocklistUserPath, JSON.stringify(arr), 'utf8'); ok = true; } catch (e) {}
    try { if (fs.existsSync(blocklistLegacyApp)) fs.unlinkSync(blocklistLegacyApp); } catch (e) {}   // 앱폴더 사본은 제거(배포 누수 방지)
    return ok;
  }
  ipcMain.handle('dialer:getBlocklist', () => readBlocklist());
  ipcMain.handle('dialer:addBlocked', (e, number) => {
    const d = String(number || '').replace(/\D/g, ''); if (!d) return { ok: false };
    const arr = readBlocklist(); if (!arr.includes(d)) { arr.push(d); writeBlocklist(arr); }
    return { ok: true, count: arr.length };
  });
  ipcMain.handle('dialer:removeBlocked', (e, number) => {
    const d = String(number || '').replace(/\D/g, '');
    writeBlocklist(readBlocklist().filter(x => x !== d));
    return { ok: true };
  });
  ipcMain.handle('dialer:addBlockedBulk', (e, numbers) => {
    const arr = readBlocklist();
    const set = new Set(arr);
    let added = 0;
    (numbers || []).forEach(n => { const d = String(n || '').replace(/\D/g, ''); if (d && !set.has(d)) { set.add(d); arr.push(d); added++; } });
    if (added) writeBlocklist(arr);
    return { ok: true, added, total: arr.length };
  });
  ipcMain.handle('dialer:setSerial', (e, s) => { adb.setSerial(s); return true; });

  // 발신 큐 (번호 목록) 영속화
  // 발신목록/기록은 빠르게 자주 바뀌므로 디바운스로 모아 기록 (메인 멈춤 방지)
  const __dlPending = {}; let __dlTimer = null;
  function __dlFlush() {
    __dlTimer = null;
    for (const k of Object.keys(__dlPending)) {
      try { store.set(k, __dlPending[k]); } catch (e) {}
      delete __dlPending[k];
    }
  }
  function __dlSet(key, val) {
    __dlPending[key] = val;
    if (__dlTimer) clearTimeout(__dlTimer);
    __dlTimer = setTimeout(__dlFlush, 400);
  }
  try { app.on('before-quit', __dlFlush); } catch (e) {}
  ipcMain.handle('dialer:getQueue', () => (__dlPending.dialQueue !== undefined ? __dlPending.dialQueue : (store.get('dialQueue') || [])));
  ipcMain.handle('dialer:setQueue', (e, q) => { __dlSet('dialQueue', q || []); return true; });

  // ── 통화 기록 (스크립트보드와 공유하는 통합 기록) ──────────────────────────
  // 작업8: 단일 병합 writer. dialer:setRecords(렌더러) 와 sync-server.js(폰 LAN 동기화)
  // 둘 다 이 writeDialRecords() 하나만 거쳐서 store 에 쓴다. 항상 "__dlPending 우선 → store"
  // 순으로 지금 가장 최신인 값을 읽어 합친 뒤 다시 __dlSet 에 태우므로, 어느 한쪽의 디바운스
  // 저장이 다른 쪽이 방금 넣은 값을 덮어써 날리는 일이 없다.
  function currentDialRecords() {
    return (__dlPending.dialRecords !== undefined) ? __dlPending.dialRecords : (store.get('dialRecords') || []);
  }
  function sortRecs(list) {
    return list.slice().sort((a, b) => String(a.ts || a.dialAt || '').localeCompare(String(b.ts || b.dialAt || '')));
  }
  // 같은 키(dlRecKey) 중복 항목 정리 — 나중 것(배열 뒤쪽)이 최신이라 가정하고 그것으로 덮어씀.
  function dedupeByKey(list) {
    const m = new Map();
    list.forEach(r => { const k = dlRecKey(r); if (k) m.set(k, r); });
    return [...m.values()];
  }
  // 렌더러가 마지막으로 "통째로" 보낸(=알고 있던) dialRecords 키 스냅샷.
  // 렌더러가 보낸 배열에 없는 키라도 baseline 에 없던 것(=렌더러가 모르는 사이 sync-server 가 폰에서
  // 추가한 것)이면 "삭제 의도"가 아니라 "렌더러가 아직 모르는 추가분"으로 보고 보존한다.
  // baseline 에는 있었는데 렌더러가 보낸 배열엔 없다 = 사용자가 그 화면에서 의도적으로 지운 것 → 반영.
  let __dlRecBaseline = null;
  function writeDialRecords(incoming, opts) {
    opts = opts || {};
    incoming = Array.isArray(incoming) ? incoming : [];
    const current = currentDialRecords();
    let merged, extras;
    if (opts.fromRenderer) {
      if (!__dlRecBaseline) __dlRecBaseline = new Set(current.map(dlRecKey));
      const incomingKeys = new Set(incoming.map(dlRecKey));
      extras = current.filter(r => { const k = dlRecKey(r); return !incomingKeys.has(k) && !__dlRecBaseline.has(k); });
      merged = extras.length ? incoming.concat(extras) : incoming.slice();
      merged = sortRecs(dedupeByKey(merged));
      // ⚠ baseline은 "렌더러가 이제 알게 된 상태"를 반영하는 것이므로 렌더러 경로에서만 갱신한다.
      // sync-server 경로에서 갱신하면, 렌더러가 아직 편입 전인데도 다음 setRecords 때 그 폰 기록이
      // "이미 알던 것"으로 오인되어 삭제로 취급될 수 있다(테스트 [4]에서 실제로 재현됨).
      __dlRecBaseline = new Set(merged.map(dlRecKey));
    } else {
      // sync-server(폰) 경로: 순수 합집합만 — 기존 기록을 지우는 로직이 전혀 없어 항상 안전.
      // baseline은 건드리지 않는다(위 주석 참고) — 렌더러가 다음 setRecords로 이 추가분을 받아가
      // (extras) 자기 메모리에 편입한 뒤에야, 그 setRecords 호출이 baseline을 올바르게 갱신한다.
      const byKey = new Map();
      current.forEach(r => byKey.set(dlRecKey(r), r));
      incoming.forEach(r => { const k = dlRecKey(r); if (k && !byKey.has(k)) byKey.set(k, r); });
      merged = sortRecs([...byKey.values()]);
      extras = [];
    }
    __dlSet('dialRecords', merged);
    return { merged, extras };
  }
  __sharedWriteDialRecords = writeDialRecords;

  ipcMain.handle('dialer:getRecords', () => currentDialRecords());
  // 렌더러가 보낸 배열을 그대로 저장하지 않고 writeDialRecords 로 병합 저장한다.
  // 반환값(extras)은 "이 화면이 아직 모르는, 다른 writer가 추가한 기록" — 렌더러가 자기
  // 메모리 records 배열에 편입시켜야 다음 저장에서도 안 잃는다(dialer.renderer.js persistRecords 참고).
  ipcMain.handle('dialer:setRecords', (e, r) => {
    const { extras } = writeDialRecords(r || [], { fromRenderer: true });
    return extras;
  });

  // 다이얼러 설정 (통화 후 대기초 등)
  ipcMain.handle('dialer:getSettings', () => store.get('dialerSettings') || { waitSec: 3 });
  ipcMain.handle('dialer:setSettings', (e, s) => { store.set('dialerSettings', s || {}); return true; });

}

// 작업8: sync-server.js 가 dialRecords 를 쓸 때 반드시 이 함수를 거치게 한다(store.set 직접 호출 금지).
// registerDialer() 가 아직 호출되지 않은 극히 예외적인 순서 문제 대비로 안전 폴백을 둔다(호출측이
// 반환된 merged 를 그대로 쓰면 최소한 데이터 유실은 없음 — 단, 그 경우 store 저장은 호출측 책임).
function writeDialRecords(incoming, opts) {
  if (__sharedWriteDialRecords) return __sharedWriteDialRecords(incoming, opts);
  const arr = Array.isArray(incoming) ? incoming : [];
  return { merged: arr, extras: [] };
}

module.exports = { registerDialer, writeDialRecords, dlRecKey };
