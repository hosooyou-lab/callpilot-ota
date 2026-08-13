// ============ 🔄 자동 업데이트 클라이언트 ============
// 마스터콘솔(callpilot-ota/docs/admin.html의 'PC 업데이트 발행' 탭)이 GitHub 저장소에 올린
// 서명된 manifest(pc/manifest.json)를 확인해, 로컬과 해시가 다른 파일만 내려받아 갈아끼운다.
// - 대상은 src/ 안의 파일뿐 — 콜파일럿.exe·node_modules·adb는 절대 건드리지 않는다(그건 zip 재배포).
// - manifest는 ECDSA P-256 서명 검증을 통과해야만 적용된다(저장소가 털려도 서명키 없인 위조 불가).
// - 버전 비교가 아니라 "파일 내용 해시 비교"라서, 손상된 파일도 다음 확인 때 자동 복구된다.
// - 실패는 전부 조용히 로그로만 남긴다(수동 확인일 때만 대화상자 표시) — 앱 본체에 영향 없음.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_BASE = process.env.CP_UPDATE_BASE || 'https://raw.githubusercontent.com/hosooyou-lab/callpilot-ota/main/pc/';
const MANIFEST_URL = () => REPO_BASE + 'manifest.json?t=' + Date.now();   // raw CDN 캐시(5분) 우회
const FILE_URL = (relPath, sha) => REPO_BASE + 'src/' + relPath.split('/').map(encodeURIComponent).join('/') + '?v=' + sha.slice(0, 12);

// 발행 서명 검증용 공개키 — 개인키는 마스터콘솔 쪽에만 있음(Downloads의 서명키 백업 파일 참조)
const UPDATE_PUBKEY = '-----BEGIN PUBLIC KEY-----\n'
  + 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6mOlq0XNmcGGGh2/X+mxWL/nNWDm\n'
  + 'cjGh5LZ2PuBCsTaFyBh7a9dA4/palNLfRGymm60h9RlAoVA1nZlUhs5EaQ==\n'
  + '-----END PUBLIC KEY-----\n';

const FETCH_TIMEOUT_MS = 15000;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;   // 정상 발행은 수 MB 수준 — 그 이상이면 뭔가 잘못된 것
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;   // 킬스위치 하트비트와 같은 3시간 주기

// ── 공용 유틸 (콘솔 발행 코드와 반드시 동일한 규약) ──
// 서명 대상 = version + (path,sha256)만 뽑아 path 기준 정렬한 canonical JSON.
// 콘솔(admin.html)의 canonicalPayload()와 한 글자도 다르면 안 된다.
function canonicalPayload(manifest) {
  const files = (manifest.files || [])
    .map(f => ({ path: f.path, sha256: f.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({ version: manifest.version, files });
}
function verifySignature(manifest) {
  try {
    return crypto.verify('sha256', Buffer.from(canonicalPayload(manifest), 'utf8'),
      { key: UPDATE_PUBKEY, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(manifest.sig || ''), 'base64'));
  } catch (e) { return false; }
}
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 경로 안전장치: manifest가 서명돼 있어도 한 겹 더 — src/ 밖으로 나가는 경로는 무조건 거부
function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 240) return false;
  if (p.includes('..') || p.includes('\\') || p.startsWith('/') || p.includes('\0')) return false;
  if (p.toLowerCase() === 'version.json') return false;   // version.json은 클라이언트가 직접 쓴다
  return /^[0-9A-Za-z가-힣._\-/ ()]+$/.test(p);
}

async function fetchWithTimeout(url, asBuffer) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, data: asBuffer ? Buffer.from(await r.arrayBuffer()) : await r.text() };
  } catch (e) {
    return { ok: false, status: 0, error: e && e.message };
  } finally { clearTimeout(timer); }
}

// ── 핵심: 확인 + 적용 ──
// 반환: { status: 'uptodate'|'updated'|'error'|'busy', ... } — 대화상자·재시작은 호출자가 결정.
// opts로 경로·URL·공개키를 주입할 수 있어 일렉트론 없이 순수 노드로도 검증 가능.
let __running = false;
async function runUpdateCheck(opts) {
  opts = opts || {};
  if (__running) return { status: 'busy' };
  __running = true;
  try { return await doRunUpdateCheck(opts); }
  finally { __running = false; }
}
async function doRunUpdateCheck(opts) {
  const srcDir = opts.srcDir || __dirname;
  const backupRoot = opts.backupDir;   // 미지정이면 백업 생략하지 않고 srcDir 옆에 둔다
  const log = opts.log || (() => {});
  const pubkey = opts.pubkeyPem;   // 테스트 주입용 — 미지정 시 내장 공개키

  // 1) manifest 받기
  const mr = await fetchWithTimeout(opts.manifestUrl || MANIFEST_URL(), false);
  if (!mr.ok) {
    // 첫 발행 전(404)이나 오프라인은 정상 상황 — 조용히 종료
    return { status: mr.status === 404 ? 'uptodate' : 'error', reason: 'manifest-fetch', httpStatus: mr.status, detail: mr.error };
  }
  let manifest = null;
  try { manifest = JSON.parse(mr.data); } catch (e) { return { status: 'error', reason: 'manifest-parse' }; }
  if (!manifest || !manifest.version || !Array.isArray(manifest.files)) return { status: 'error', reason: 'manifest-shape' };

  // 2) 서명 검증 — 실패하면 어떤 파일도 받지 않는다
  const sigOk = pubkey
    ? (() => { try { return crypto.verify('sha256', Buffer.from(canonicalPayload(manifest), 'utf8'), { key: pubkey, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(manifest.sig || ''), 'base64')); } catch (e) { return false; } })()
    : verifySignature(manifest);
  if (!sigOk) { log('서명 검증 실패 — 발행 무시 (version=' + manifest.version + ')'); return { status: 'error', reason: 'bad-signature', version: manifest.version }; }

  // 3) 로컬과 비교해 바뀐 파일만 추림
  const changed = [];
  let total = 0;
  for (const f of manifest.files) {
    if (!f || !isSafeRelPath(f.path) || !/^[0-9a-f]{64}$/.test(String(f.sha256 || ''))) {
      return { status: 'error', reason: 'bad-entry', path: f && f.path };
    }
    total += Number(f.size) || 0;
    const abs = path.join(srcDir, f.path);
    let same = false;
    try { same = fs.existsSync(abs) && sha256Hex(fs.readFileSync(abs)) === f.sha256; } catch (e) {}
    if (!same) changed.push(f);
  }
  if (total > MAX_TOTAL_BYTES) return { status: 'error', reason: 'too-big', total };
  const localVersion = readLocalVersion(srcDir);
  if (!changed.length) {
    // 파일은 전부 최신인데 version.json만 뒤처졌으면 표기만 맞춰둔다
    if (localVersion !== manifest.version) writeLocalVersion(srcDir, manifest, log);
    return { status: 'uptodate', version: manifest.version };
  }

  // 4) 전부 내려받아 해시 검증(하나라도 실패하면 아무것도 적용 안 함)
  const staged = [];
  for (const f of changed) {
    const fr = await fetchWithTimeout(opts.fileUrl ? opts.fileUrl(f.path, f.sha256) : FILE_URL(f.path, f.sha256), true);
    if (!fr.ok) return { status: 'error', reason: 'file-fetch', path: f.path, httpStatus: fr.status };
    if (sha256Hex(fr.data) !== f.sha256) { log('해시 불일치: ' + f.path); return { status: 'error', reason: 'file-hash', path: f.path }; }
    staged.push({ path: f.path, data: fr.data });
  }

  // 5) 백업 → .cp-new로 쓰기 → 교체(rename). 교체 도중 실패하면 이미 바꾼 것들을 백업으로 되돌린다.
  const backupDir = path.join(backupRoot || path.join(srcDir, '..', 'update-backup'), (localVersion || 'unknown') + '_' + Date.now());
  const swapped = [];
  try {
    for (const s of staged) {
      const abs = path.join(srcDir, s.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (fs.existsSync(abs)) {
        const bak = path.join(backupDir, s.path);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(abs, bak);
      }
      fs.writeFileSync(abs + '.cp-new', s.data);
    }
    for (const s of staged) {
      const abs = path.join(srcDir, s.path);
      fs.renameSync(abs + '.cp-new', abs);
      swapped.push(s.path);
    }
  } catch (e) {
    log('적용 중 오류(' + (e && e.message) + ') — 되돌리기 시도');
    for (const p of swapped) {
      try { const bak = path.join(backupDir, p); if (fs.existsSync(bak)) fs.copyFileSync(bak, path.join(srcDir, p)); } catch (e2) {}
    }
    for (const s of staged) { try { fs.rmSync(path.join(srcDir, s.path) + '.cp-new', { force: true }); } catch (e2) {} }
    return { status: 'error', reason: 'apply', detail: e && e.message };
  }

  writeLocalVersion(srcDir, manifest, log);
  pruneBackups(backupRoot || path.join(srcDir, '..', 'update-backup'), log);
  log('업데이트 적용: ' + (localVersion || '(첫 적용)') + ' → ' + manifest.version + ' (' + staged.length + '개 파일)');
  return { status: 'updated', version: manifest.version, previous: localVersion, notes: manifest.notes || '', count: staged.length };
}

function readLocalVersion(srcDir) {
  try { return JSON.parse(fs.readFileSync(path.join(srcDir, 'version.json'), 'utf8')).version || null; }
  catch (e) { return null; }
}
function writeLocalVersion(srcDir, manifest, log) {
  try {
    fs.writeFileSync(path.join(srcDir, 'version.json'),
      JSON.stringify({ version: manifest.version, notes: manifest.notes || '', appliedAt: new Date().toISOString() }, null, 2));
  } catch (e) { (log || (() => {}))('version.json 기록 실패: ' + (e && e.message)); }
}
// 백업은 최근 5개만 유지 — 상담사 PC 용량을 조용히 먹지 않도록
function pruneBackups(root, log) {
  try {
    const list = fs.readdirSync(root).filter(n => /_\d{13}$/.test(n))
      .sort((a, b) => Number(a.slice(-13)) - Number(b.slice(-13)));
    while (list.length > 5) { const old = list.shift(); fs.rmSync(path.join(root, old), { recursive: true, force: true }); }
  } catch (e) {}
}

// ── 일렉트론 연결부 ──
// initAutoUpdate: 시작 8초 뒤 1회 + 3시간마다 자동 확인. manualCheck: 도움말 메뉴에서 즉시 확인.
function makeLogger(app) {
  return (msg) => {
    try {
      const p = path.join(app.getPath('userData'), 'update.log');
      try { if (fs.existsSync(p) && fs.statSync(p).size > 512 * 1024) fs.truncateSync(p, 0); } catch (e) {}
      fs.appendFileSync(p, '[' + new Date().toISOString() + '] ' + msg + '\n');
    } catch (e) {}
  };
}
function electronOpts(app) {
  return { log: makeLogger(app), backupDir: path.join(app.getPath('userData'), 'update-backup') };
}
async function checkAndPrompt(ctx, manual) {
  const { app, dialog, getWindow } = ctx;
  const log = makeLogger(app);
  let res = null;
  try { res = await runUpdateCheck(electronOpts(app)); }
  catch (e) { res = { status: 'error', reason: 'unexpected', detail: e && e.message }; log('예상외 오류: ' + (e && e.stack || e)); }
  if (!manual && res.status !== 'updated') {
    if (res.status === 'error') log('자동 확인 실패: ' + res.reason + (res.detail ? ' — ' + res.detail : '') + (res.httpStatus ? ' (HTTP ' + res.httpStatus + ')' : ''));
    return res;
  }
  const win = (typeof getWindow === 'function' && getWindow()) || null;
  const show = (o) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));
  try {
    if (res.status === 'updated') {
      const r = await show({
        type: 'info', title: '업데이트 완료',
        message: '새 버전이 적용됐어요 (' + res.version + ')',
        detail: (res.notes ? '변경 내용: ' + res.notes + '\n\n' : '') + '다시 시작하면 새 버전으로 열립니다.',
        buttons: ['지금 다시 시작', '나중에(다음 실행 때 적용)'], defaultId: 0, cancelId: 1, noLink: true
      });
      if (r && r.response === 0) { app.relaunch(); app.exit(0); }
    } else if (manual && res.status === 'uptodate') {
      await show({ type: 'info', title: '업데이트 확인', message: '지금이 최신 버전이에요' + (res.version ? ' (' + res.version + ')' : '') + '.', buttons: ['확인'], noLink: true });
    } else if (manual && res.status === 'busy') {
      await show({ type: 'info', title: '업데이트 확인', message: '이미 확인 중이에요. 잠시 후 다시 시도해주세요.', buttons: ['확인'], noLink: true });
    } else if (manual) {
      const why = res.reason === 'bad-signature'
        ? '업데이트 서명이 올바르지 않아 적용하지 않았어요. 관리자에게 알려주세요.'
        : '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해주세요.';
      await show({ type: 'warning', title: '업데이트 확인 실패', message: why, detail: '(' + res.reason + (res.httpStatus ? ', HTTP ' + res.httpStatus : '') + ')', buttons: ['확인'], noLink: true });
    }
  } catch (e) { log('대화상자 오류: ' + (e && e.message)); }
  return res;
}
function initAutoUpdate(ctx) {
  setTimeout(() => { checkAndPrompt(ctx, false); }, 8000);
  setInterval(() => { checkAndPrompt(ctx, false); }, CHECK_INTERVAL_MS);
}
function manualCheck(ctx) { return checkAndPrompt(ctx, true); }
function currentVersion() { return readLocalVersion(__dirname); }

module.exports = { initAutoUpdate, manualCheck, runUpdateCheck, currentVersion, _internals: { canonicalPayload, isSafeRelPath, sha256Hex } };
