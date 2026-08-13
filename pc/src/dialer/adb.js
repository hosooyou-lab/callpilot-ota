// ============================================================
//  adb.js — 오토다이얼러의 두뇌를 Node로 이식
//  (원본 Python/tkinter auto_dialer 의 ADB 로직을 그대로 옮김)
//  child_process.execFile = Python 의 subprocess 대응
// ============================================================
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

// Windows 에서 검은 콘솔창이 깜빡이지 않도록 (원본의 creationflags 대응)
const WIN_NO_WINDOW = process.platform === 'win32' ? { windowsHide: true } : {};

/**
 * adb.exe 자동 탐색. 우선순위 (원본 _find_adb 그대로):
 *   1) 앱 폴더 옆 adb/adb.exe  (이번 통합 배포 구조)
 *   2) 앱 폴더 옆 adb.exe       (평평한 구조)
 *   3) 앱 폴더/platform-tools/adb.exe
 *   4) PATH 의 'adb'
 * appRoot = adb 바이너리를 찾을 기준 폴더 (main 에서 주입)
 */
function findAdb(appRoot) {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    path.join(appRoot, 'adb', exe),
    path.join(appRoot, exe),
    path.join(appRoot, 'platform-tools', exe),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return exe; // PATH 에 등록돼 있다고 가정
}

/**
 * adb 명령 1회 실행 → Promise<{stdout, stderr, ok}>
 * 원본 _run 대응. 타임아웃 기본 12초.
 */
function adbRun(adbPath, args, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(adbPath, args, { timeout, encoding: 'utf8', ...WIN_NO_WINDOW }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve({ ok: false, stdout: '', stderr: 'ADB 명령 시간 초과', timedOut: true });
      } else if (err && err.code === 'ENOENT') {
        resolve({ ok: false, stdout: '', stderr: 'ADB를 찾을 수 없습니다. PATH를 확인하세요.' });
      } else {
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

// adb shell 은 인자들을 공백으로 이어붙여 폰의 sh 에 넘긴다.
// 따옴표 없이 보내면 띄어쓰기가 있는 본문이 통째로 잘려 명령 자체가 실패한다(= 문자창이 안 열림).
function shq(s) {
  const q = String.fromCharCode(39);            // '
  return q + String(s == null ? '' : s).split(q).join(q + '\\' + q + q) + q;
}

// 특정 기기를 겨냥 (멀티 디바이스 충돌 방지 — 원본의 -s 처리 대응)
function withSerial(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

// 이 PC 가 붙어있는 랜(IPv4)들의 /24 서브넷 베이스 목록 → ["192.168.0.", ...]
//   폰은 같은 와이파이에 있으면 이 대역 안에 있으므로, 여기만 훑으면 됨.
function localSubnetBases() {
  const bases = [];
  const seen = new Set();
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (!ni || ni.internal) continue;
      const fam = ni.family;
      if (fam !== 'IPv4' && fam !== 4) continue;       // node 버전에 따라 'IPv4' 또는 4
      const parts = String(ni.address).split('.');
      if (parts.length !== 4) continue;
      const base = parts[0] + '.' + parts[1] + '.' + parts[2] + '.';
      if (!seen.has(base)) { seen.add(base); bases.push(base); }
    }
  }
  return bases;
}

// host:port 에 TCP 로 붙는지 확인 (열려있으면 true). timeout(ms) 안에 응답 없으면 false.
function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch (e) { finish(false); }
  });
}

class Adb {
  constructor(appRoot) {
    this.adbPath = findAdb(appRoot);
    this.serial = null; // "192.168.x.x:5555"
  }

  setSerial(s) { this.serial = s || null; }

  // 무선 연결: adb connect IP:5555
  async connect(ip) {
    const host = ip.includes(':') ? ip : `${ip}:5555`;
    const r = await adbRun(this.adbPath, ['connect', host], 15000);
    const text = (r.stdout + r.stderr).toLowerCase();
    const ok = r.ok && (text.includes('connected') || text.includes('already'));
    if (ok) this.serial = host;
    return { ok, message: (r.stdout || r.stderr).trim(), serial: host };
  }

  // 연결된 기기 목록
  async devices() {
    const r = await adbRun(this.adbPath, ['devices']);
    const lines = r.stdout.split(/\r?\n/).slice(1)
      .map(l => l.trim()).filter(Boolean)
      .map(l => {
        const [serial, state] = l.split(/\s+/);
        return { serial, state };
      });
    return lines;
  }

  // 재연결 (kill-server → start-server → connect) — 원본 4번 bat 로직
  async reconnect(ip) {
    await adbRun(this.adbPath, ['kill-server'], 8000);
    await adbRun(this.adbPath, ['start-server'], 8000);
    return this.connect(ip);
  }

  // 🔍 폰 자동 탐색 — 폰 IP 가 바뀌어도(집→사무실 등) 같은 와이파이 대역을 훑어
  //    5555 가 열린 기기를 찾아 연결한다. USB 없이 IP 변경에 대응하는 핵심.
  //    ⚠️ 단, 폰이 재부팅됐거나 무선통로가 꺼졌으면(5555 닫힘) 못 찾음 → USB 재설정 필요.
  //    preferIp: 먼저 시도할 이전 IP(살아있으면 스캔 없이 즉시 성공 → 빠름).
  //    반환엔 항상 bases(스캔한 이 PC 의 대역)를 실어 호출측이 '다른 Wi-Fi' 여부를 안내할 수 있게 한다.
  //      성공 { ok:true, ip, serial, bases }
  //      실패 { ok:false, reason:'no-lan'|'none-open'|'not-authorized', bases, openHosts? }
  async autoFind(preferIp) {
    // 한 대역(.1~.254)을 한 배치로 동시 스캔 → 총 시간 ≈ TIMEOUT.
    // TIMEOUT=600: 폰 Wi-Fi 가 절전에서 깨는 첫 응답이 ~230ms 걸리기도 해 넉넉히 둔다(놓침 방지).
    const PORT = 5555, TIMEOUT = 600, BATCH = 256;
    const bases = localSubnetBases();
    if (!bases.length) return { ok: false, reason: 'no-lan', bases: [] };

    // 열린 호스트에 실제 adb connect → 'device'(인증됨)면 성공. 아니면 정리 후 false.
    const tryConnect = async (h) => {
      const host = h + ':' + PORT;
      await adbRun(this.adbPath, ['connect', host], 6000);
      const ds = await this.devices();
      const hit = ds.find(d => d.serial === host);
      if (hit && hit.state === 'device') { this.serial = host; return true; }
      if (hit) await adbRun(this.adbPath, ['disconnect', host], 4000);   // offline/미인증 정리
      return false;
    };

    // ⚡ 빠른 길: 이전 IP 가 아직 살아있으면 전체 스캔 없이 즉시 연결 (보통 10~250ms)
    const prefer = preferIp ? String(preferIp).split(':')[0] : '';
    if (prefer && await probePort(prefer, PORT, TIMEOUT)) {
      if (await tryConnect(prefer)) return { ok: true, ip: prefer, serial: prefer + ':' + PORT, bases };
    }

    // 전체 스캔: 대역별 .1~.254 중 5555 열린 호스트 병렬 수집
    const hosts = [];
    const seen = new Set(prefer ? [prefer] : []);
    for (const base of bases) for (let i = 1; i <= 254; i++) { const h = base + i; if (!seen.has(h)) { seen.add(h); hosts.push(h); } }
    const open = [];
    for (let i = 0; i < hosts.length; i += BATCH) {
      const chunk = hosts.slice(i, i + BATCH);
      const res = await Promise.all(chunk.map(h => probePort(h, PORT, TIMEOUT).then(ok => (ok ? h : null))));
      for (const h of res) if (h) open.push(h);
    }
    if (!open.length) return { ok: false, reason: 'none-open', bases };

    for (const h of open) { if (await tryConnect(h)) return { ok: true, ip: h, serial: h + ':' + PORT, bases }; }
    return { ok: false, reason: 'not-authorized', bases, openHosts: open };
  }

  // 발신: am start -a android.intent.action.CALL -d tel:NUMBER
  async dial(number) {
    const clean = String(number).replace(/[^\d+#*]/g, '');
    if (!clean) return { ok: false, message: '번호 없음' };
    const args = withSerial(this.serial, [
      'shell', 'am', 'start',
      '-a', 'android.intent.action.CALL',
      '-d', `tel:${clean}`,
    ]);
    const r = await adbRun(this.adbPath, args);
    const ok = r.ok && !/error/i.test(r.stdout + r.stderr);
    return { ok, message: (r.stdout || r.stderr || '').trim(), number: clean };
  }

  // 📷 사진 1장을 붙여 폰의 메시지앱을 연다 (실제 전송은 사용자가 누른다).
  //    안드로이드는 file:// 를 다른 앱에 넘기는 걸 막는다(FileUriExposedException) →
  //    ① 폰으로 push → ② 사진첩(MediaStore)에 등록 → ③ content:// 주소를 얻어 인텐트에 싣는다.
  //    ⚠ am start 로는 URI '배열'을 넘길 수 없다 → PC판은 1장만. (여러 장은 폰 앱에서)
  async mmsCompose(number, body, localPaths) {
    const clean = String(number).replace(/[^\d+#*]/g, '');
    if (!clean) return { ok: false, message: '번호 없음' };
    const list = (Array.isArray(localPaths) ? localPaths : [localPaths]).filter(Boolean);
    if (!list.length) return this.smsCompose(number, body);
    const src = String(list[0]);
    if (!fs.existsSync(src)) return { ok: false, message: '사진 파일을 찾을 수 없습니다' };

    const ext = (path.extname(src) || '.jpg').toLowerCase();
    const dir = '/sdcard/Pictures/CallPilot';
    const remote = dir + '/cp_' + Date.now() + ext;

    await adbRun(this.adbPath, withSerial(this.serial, ['shell', 'mkdir', '-p', shq(dir)]));
    const pr = await adbRun(this.adbPath, withSerial(this.serial, ['push', src, remote]), 60000);
    if (!pr.ok) return { ok: false, message: '사진을 폰에 옮기지 못했습니다: ' + String(pr.stderr || '').trim() };

    // 사진첩에 등록돼야 content:// 주소가 생긴다 (등록이 조금 늦을 수 있어 몇 번 확인)
    await adbRun(this.adbPath, withSerial(this.serial,
      ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', shq('file://' + remote)]), 20000);
    let uri = '';
    for (let i = 0; i < 6 && !uri; i++) {
      const q = await adbRun(this.adbPath, withSerial(this.serial,
        ['shell', 'content', 'query', '--uri', 'content://media/external/images/media',
         '--projection', '_id', '--where', shq("_data='" + remote + "'")]), 15000);
      const m = /_id=(\d+)/.exec(q.stdout || '');
      if (m) uri = 'content://media/external/images/media/' + m[1];
      else await new Promise(res => setTimeout(res, 500));
    }
    if (!uri) {
      const back = await this.smsCompose(number, body);
      return { ok: false, fellBack: true, sms: back,
               message: '사진을 폰 사진첩에 등록하지 못해 글자만 열었습니다' };
    }

    // 기본 메시지앱을 겨냥 (못 찾으면 앱 선택창이 뜬다)
    let pkg = '';
    try {
      const rp = await adbRun(this.adbPath, withSerial(this.serial,
        ['shell', 'cmd', 'role', 'get-role-holders', 'android.app.role.SMS']), 10000);
      let mm = /([a-zA-Z][\w]*(?:\.[\w]+)+)/.exec(String(rp.stdout || '').trim());
      if (!mm) {
        const rs = await adbRun(this.adbPath, withSerial(this.serial,
          ['shell', 'settings', 'get', 'secure', 'sms_default_application']), 10000);
        mm = /([a-zA-Z][\w]*(?:\.[\w]+)+)/.exec(String(rs.stdout || '').trim());
      }
      if (mm) pkg = mm[1];
    } catch (e) {}

    const base = ['shell', 'am', 'start',
      '-a', 'android.intent.action.SEND',
      '-t', 'image/*',
      '--eu', 'android.intent.extra.STREAM', uri,
      '--es', 'address', shq(clean),
      '--grant-read-uri-permission'];
    if (body && String(body).trim()) base.push('--es', 'android.intent.extra.TEXT', shq(String(body)));

    const withPkg = pkg ? base.concat(['-p', pkg]) : base;
    let r = await adbRun(this.adbPath, withSerial(this.serial, withPkg), 20000);
    let good = r.ok && !/error/i.test(r.stdout + r.stderr);
    // 기본앱 지정이 오히려 막았을 수 있다 → 앱 선택창으로 한 번 더
    if (!good && pkg) {
      r = await adbRun(this.adbPath, withSerial(this.serial, base), 20000);
      good = r.ok && !/error/i.test(r.stdout + r.stderr);
    }
    return { ok: good, message: String(r.stdout || r.stderr || '').trim(), number: clean, uri };
  }

  // ✉️ 폰의 기본 메시지앱을 수신번호·내용 채워서 연다(보내기는 사용자가). ACTION_SENDTO smsto:
  async smsCompose(number, body) {
    const clean = String(number).replace(/[^\d+#*]/g, '');
    if (!clean) return { ok: false, message: '번호 없음' };
    const args = withSerial(this.serial, [
      'shell', 'am', 'start',
      '-a', 'android.intent.action.SENDTO',
      '-d', shq('smsto:' + clean),
    ]);
    if (body && String(body).trim()) { args.push('--es', 'sms_body', shq(String(body))); }
    const r = await adbRun(this.adbPath, args);
    const ok = r.ok && !/error/i.test(r.stdout + r.stderr);
    return { ok, message: (r.stdout || r.stderr || '').trim(), number: clean };
  }

  // 📷 사진 1장을 붙여 폰의 메시지앱을 연다 (실제 전송은 사용자가 누른다).
  //    안드로이드는 file:// 를 다른 앱에 넘기는 걸 막는다(FileUriExposedException) →
  //    ① 폰으로 push → ② 사진첩(MediaStore)에 등록 → ③ content:// 주소를 얻어 인텐트에 싣는다.
  //    ⚠ am start 로는 URI '배열'을 넘길 수 없다 → PC판은 1장만. (여러 장은 폰 앱에서)
  async mmsCompose(number, body, localPaths) {
    const clean = String(number).replace(/[^\d+#*]/g, '');
    if (!clean) return { ok: false, message: '번호 없음' };
    const list = (Array.isArray(localPaths) ? localPaths : [localPaths]).filter(Boolean);
    if (!list.length) return this.smsCompose(number, body);
    const src = String(list[0]);
    if (!fs.existsSync(src)) return { ok: false, message: '사진 파일을 찾을 수 없습니다' };

    const ext = (path.extname(src) || '.jpg').toLowerCase();
    const dir = '/sdcard/Pictures/CallPilot';
    const remote = dir + '/cp_' + Date.now() + ext;

    await adbRun(this.adbPath, withSerial(this.serial, ['shell', 'mkdir', '-p', shq(dir)]));
    const pr = await adbRun(this.adbPath, withSerial(this.serial, ['push', src, remote]), 60000);
    if (!pr.ok) return { ok: false, message: '사진을 폰에 옮기지 못했습니다: ' + String(pr.stderr || '').trim() };

    // 사진첩에 등록돼야 content:// 주소가 생긴다 (등록이 조금 늦을 수 있어 몇 번 확인)
    await adbRun(this.adbPath, withSerial(this.serial,
      ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', shq('file://' + remote)]), 20000);
    let uri = '';
    for (let i = 0; i < 6 && !uri; i++) {
      const q = await adbRun(this.adbPath, withSerial(this.serial,
        ['shell', 'content', 'query', '--uri', 'content://media/external/images/media',
         '--projection', '_id', '--where', shq("_data='" + remote + "'")]), 15000);
      const m = /_id=(\d+)/.exec(q.stdout || '');
      if (m) uri = 'content://media/external/images/media/' + m[1];
      else await new Promise(res => setTimeout(res, 500));
    }
    if (!uri) {
      const back = await this.smsCompose(number, body);
      return { ok: false, fellBack: true, sms: back,
               message: '사진을 폰 사진첩에 등록하지 못해 글자만 열었습니다' };
    }

    // 기본 메시지앱을 겨냥 (못 찾으면 앱 선택창이 뜬다)
    let pkg = '';
    try {
      const rp = await adbRun(this.adbPath, withSerial(this.serial,
        ['shell', 'cmd', 'role', 'get-role-holders', 'android.app.role.SMS']), 10000);
      let mm = /([a-zA-Z][\w]*(?:\.[\w]+)+)/.exec(String(rp.stdout || '').trim());
      if (!mm) {
        const rs = await adbRun(this.adbPath, withSerial(this.serial,
          ['shell', 'settings', 'get', 'secure', 'sms_default_application']), 10000);
        mm = /([a-zA-Z][\w]*(?:\.[\w]+)+)/.exec(String(rs.stdout || '').trim());
      }
      if (mm) pkg = mm[1];
    } catch (e) {}

    const base = ['shell', 'am', 'start',
      '-a', 'android.intent.action.SEND',
      '-t', 'image/*',
      '--eu', 'android.intent.extra.STREAM', uri,
      '--es', 'address', shq(clean),
      '--grant-read-uri-permission'];
    if (body && String(body).trim()) base.push('--es', 'android.intent.extra.TEXT', shq(String(body)));

    const withPkg = pkg ? base.concat(['-p', pkg]) : base;
    let r = await adbRun(this.adbPath, withSerial(this.serial, withPkg), 20000);
    let good = r.ok && !/error/i.test(r.stdout + r.stderr);
    // 기본앱 지정이 오히려 막았을 수 있다 → 앱 선택창으로 한 번 더
    if (!good && pkg) {
      r = await adbRun(this.adbPath, withSerial(this.serial, base), 20000);
      good = r.ok && !/error/i.test(r.stdout + r.stderr);
    }
    return { ok: good, message: String(r.stdout || r.stderr || '').trim(), number: clean, uri };
  }

  // 통화 강제 종료: input keyevent KEYCODE_ENDCALL
  async endCall() {
    const args = withSerial(this.serial, ['shell', 'input', 'keyevent', 'KEYCODE_ENDCALL']);
    const r = await adbRun(this.adbPath, args);
    return { ok: r.ok };
  }

  // 현재 통화 상태: dumpsys telephony.registry → IDLE / RINGING / OFFHOOK
  async callState() {
    const args = withSerial(this.serial, ['shell', 'dumpsys', 'telephony.registry']);
    const r = await adbRun(this.adbPath, args, 8000);
    const m = (r.stdout || '').match(/mCallState\s*=\s*(\d)/);
    if (!m) return 'UNKNOWN';
    return ({ '0': 'IDLE', '1': 'RINGING', '2': 'OFFHOOK' })[m[1]] || 'UNKNOWN';
  }

  // 통화 상태 + 걸려온 번호를 dumpsys 1회로 함께 조회.
  //   mCallIncomingNumber 는 벨이 울리는 동안 걸려온 번호를 담는 경우가 많지만,
  //   안드로이드 9+ 나 일부 기종/권한에서는 비어 있을 수 있다(그럴 땐 '' 반환).
  async callInfo() {
    const args = withSerial(this.serial, ['shell', 'dumpsys', 'telephony.registry']);
    const r = await adbRun(this.adbPath, args, 8000);
    const out = r.stdout || '';
    const ms = out.match(/mCallState\s*=\s*(\d)/);
    const state = ms ? (({ '0': 'IDLE', '1': 'RINGING', '2': 'OFFHOOK' })[ms[1]] || 'UNKNOWN') : 'UNKNOWN';
    const mi = out.match(/mCallIncomingNumber\s*=\s*([+*#\d][-*#\d\s]{2,})/);
    const incoming = mi ? mi[1].replace(/[^\d+*#]/g, '') : '';
    return { state, incoming };
  }

  // 통화기록(call_log)에서 가장 최근 통화의 번호/종류 조회 (mCallIncomingNumber 가 빈 기종의 폴백).
  //   type: 1=수신, 2=발신, 3=부재중. 권한/기종에 따라 실패하면 null.
  async lastCall() {
    const args = withSerial(this.serial, [
      'shell', 'content', 'query',
      '--uri', 'content://call_log/calls',
      '--projection', 'number:type:date',
      '--sort', '"date DESC"',
    ]);
    const r = await adbRun(this.adbPath, args, 8000);
    const out = r.stdout || '';
    const line = out.split(/\r?\n/).find(l => /number=/.test(l));
    if (!line) return null;
    const nm = line.match(/number=([+\d]+)/);
    const tm = line.match(/type=(\d)/);
    const dt = line.match(/date=(\d+)/);
    if (!nm || !nm[1]) return null;
    return { number: nm[1], type: tm ? tm[1] : '', date: dt ? Number(dt[1]) : 0 };
  }

  // 통화기록 전체를 최근순으로 조회 (번호별 통화횟수 집계용). [{number,type,date}]
  //   type: 1=수신, 2=발신, 3=부재중. 최대 limit건(기본 500).
  async callLogList(limit) {
    const cap = limit || 500;
    const args = withSerial(this.serial, [
      'shell', 'content', 'query',
      '--uri', 'content://call_log/calls',
      '--projection', 'number:type:date',
      '--sort', '"date DESC"',
    ]);
    const r = await adbRun(this.adbPath, args, 12000);
    const out = r.stdout || '';
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
      if (!/number=/.test(line)) continue;
      const nm = line.match(/number=([+\d]+)/);
      if (!nm || !nm[1]) continue;
      const tm = line.match(/type=(\d)/);
      const dt = line.match(/date=(\d+)/);
      rows.push({ number: nm[1], type: tm ? tm[1] : '', date: dt ? Number(dt[1]) : 0 });
      if (rows.length >= cap) break;
    }
    return rows;
  }

  // 현재 진행 중인 통화의 번호를 실시간 조회 (dumpsys telecom).
  //   발신을 거는 즉시(DIALING/ACTIVE) 번호가 나오는 경우가 많아, call_log(통화종료 후 기록)보다 빠르다.
  //   기종/안드로이드 버전에 따라 번호가 마스킹(tel:*****)되면 '' 반환 → 호출측이 call_log 로 폴백.
  async activeCall() {
    const args = withSerial(this.serial, ['shell', 'dumpsys', 'telecom']);
    const r = await adbRun(this.adbPath, args, 8000);
    let out = r.stdout || '';
    // ⛔ 과거 통화 이력(Analytics 이하)은 잘라낸다 — 여기 옛 번호를 '현재 통화'로 잘못 집는 게 오검출의 원인.
    //    진행 중 통화는 상단 CallsManager/mCalls 영역에만 있으므로 그 앞부분만 대상으로 삼는다.
    const cut = out.search(/\n\s*Analytics:/);
    if (cut > 0) out = out.slice(0, cut);
    // 현재 통화의 tel: 핸들만 수집. (기종에 따라 번호가 마스킹되면 매칭 0 → 호출측이 통화기록으로 폴백)
    const tels = [];
    const re = /tel:([+\d][\d]{5,})/gi;
    let m;
    while ((m = re.exec(out)) !== null) { tels.push(m[1]); }
    let dir = '';
    if (/callDirection[:=\s]+OUTGOING/i.test(out) || /\bDIALING\b/.test(out)) dir = 'out';
    else if (/callDirection[:=\s]+INCOMING/i.test(out)) dir = 'in';
    const number = tels.length ? tels[tels.length - 1] : '';
    return { number, dir };
  }

  // 특정 번호의 문자(SMS) 조회. type 1=수신, 2=발신. 최근순. [{address,date,type,body}]
  async smsFor(number) {
    const d = String(number).replace(/\D/g, ''); if (!d) return [];
    const key = d.length > 8 ? d.slice(-8) : d;   // 끝 8자리로 매칭(+82/0 접두 차이 흡수)
    const cmd = `content query --uri content://sms --projection address:date:type:body --where "address LIKE '%${key}%'" --sort "date DESC"`;
    const r = await adbRun(this.adbPath, withSerial(this.serial, ['shell', cmd]), 12000);
    const out = r.stdout || '';
    const parts = out.split(/Row:\s*\d+\s+/).slice(1);
    const rows = [];
    for (const p of parts) {
      const addr = (p.match(/address=([^,]*)/) || [])[1] || '';
      const date = (p.match(/date=(\d+)/) || [])[1];
      const type = (p.match(/type=(\d)/) || [])[1] || '';
      const bm = p.match(/body=([\s\S]*)$/);
      const body = bm ? bm[1].replace(/\s+$/, '') : '';
      if (!/^\s*$/.test(addr)) rows.push({ address: addr.trim(), date: date ? Number(date) : 0, type, body });
    }
    return rows;
  }

  // 특정 번호의 통화 녹음 파일 목록 (삼성: /sdcard/Recordings/Call/ "통화 <번호>_YYMMDD_HHMMSS.ext")
  async recordingsFor(number) {
    const d = String(number).replace(/\D/g, ''); if (!d) return [];
    const key = d.length > 8 ? d.slice(-8) : d;
    const dir = '/sdcard/Recordings/Call';
    const cmd = `ls -1 "${dir}" 2>/dev/null | grep ${key}`;
    const r = await adbRun(this.adbPath, withSerial(this.serial, ['shell', cmd]), 12000);
    const list = [];
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const name = line.trim(); if (!name) continue;
      const dt = name.match(/_(\d{6})_(\d{6})\.\w+$/);
      const nm = name.match(/(\d{9,11})/);
      let ts = 0;
      if (dt) {
        const y = 2000 + (+dt[1].slice(0, 2)), mo = (+dt[1].slice(2, 4)) - 1, da = +dt[1].slice(4, 6);
        const h = +dt[2].slice(0, 2), mi = +dt[2].slice(2, 4), s = +dt[2].slice(4, 6);
        ts = new Date(y, mo, da, h, mi, s).getTime();
      }
      list.push({ name, remote: dir + '/' + name, number: nm ? nm[1] : '', ts });
    }
    list.sort((a, b) => b.ts - a.ts);
    return list;
  }

  // 📵 폰 연락처 중 이름에 '차단'이 들어간 것(예: "차단요청4") 조회 → [{number,name}]
  async blockedNumbers() {
    const cmd = `content query --uri content://com.android.contacts/data/phones --projection display_name:data1 --where "display_name LIKE '%차단%'"`;
    const r = await adbRun(this.adbPath, withSerial(this.serial, ['shell', cmd]), 15000);
    const list = [], seen = new Set();
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      if (!/data1=/.test(line)) continue;
      const nm = line.match(/display_name=(.*?),\s*data1=/);
      const num = line.match(/data1=([+\d][-\d\s]*)/);
      const n = (num && num[1]) ? num[1].replace(/[^\d+]/g, '') : '';
      const d = n.replace(/\D/g, '');
      if (d && !seen.has(d)) { seen.add(d); list.push({ number: n, name: (nm && nm[1]) ? nm[1].trim() : '' }); }
    }
    return list;
  }

  // 📵 폰 연락처에 "차단요청{다음순번}" 이름으로 저장. 이미 저장된 번호면 건너뜀. → {ok, name, seq, already}
  async addBlockedContact(number) {
    const d = String(number).replace(/\D/g, ''); if (!d) return { ok: false, message: '번호없음' };
    const key = d.length > 8 ? d.slice(-8) : d;
    // 현재 '차단요청N' 연락처들 → 최대 순번 + 이 번호 중복 여부
    let maxSeq = 0, exists = false;
    try {
      const q = await adbRun(this.adbPath, withSerial(this.serial, ['shell', `content query --uri content://com.android.contacts/data/phones --projection display_name:data1 --where "display_name LIKE '차단요청%'"`]), 12000);
      for (const line of (q.stdout || '').split(/\r?\n/)) {
        const nm = line.match(/display_name=차단요청\s*(\d+)/); if (nm) maxSeq = Math.max(maxSeq, +nm[1]);
        const pm = line.match(/data1=([-\d+\s]+)/); if (pm && pm[1].replace(/\D/g, '').endsWith(key)) exists = true;
      }
    } catch (e) {}
    if (exists) return { ok: true, already: true };
    const seq = maxSeq + 1, name = '차단요청' + seq, acc = 'vnd.sec.contact.phone';
    const disp = d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);
    try {
      await adbRun(this.adbPath, withSerial(this.serial, ['shell', `content insert --uri content://com.android.contacts/raw_contacts --bind account_name:s:${acc} --bind account_type:s:${acc}`]), 10000);
      const r = await adbRun(this.adbPath, withSerial(this.serial, ['shell', `content query --uri content://com.android.contacts/raw_contacts --projection _id --sort "_id DESC"`]), 10000);
      const id = ((r.stdout || '').match(/_id=(\d+)/) || [])[1];
      if (!id) return { ok: false, message: 'raw_contact 실패' };
      await adbRun(this.adbPath, withSerial(this.serial, ['shell', `content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:${id} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:${name}`]), 10000);
      await adbRun(this.adbPath, withSerial(this.serial, ['shell', `content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:${id} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:${disp} --bind data2:i:2`]), 10000);
      return { ok: true, name, seq };
    } catch (e) { return { ok: false, message: String(e && e.message || e) }; }
  }

  // 📞 걸려온 전화 받기 (KEYCODE_CALL). 일부 기종은 HEADSETHOOK 이 필요해 폴백으로 함께 시도.
  async answerCall() {
    let r = await adbRun(this.adbPath, withSerial(this.serial, ['shell', 'input', 'keyevent', 'KEYCODE_CALL']));
    if (!r.ok) r = await adbRun(this.adbPath, withSerial(this.serial, ['shell', 'input', 'keyevent', 'KEYCODE_HEADSETHOOK']));
    return { ok: r.ok };
  }

  // 녹음 파일을 PC 로컬로 내려받기 (재생용). localPath 는 호출측(main)이 지정.
  async pullFile(remote, localPath) {
    const r = await adbRun(this.adbPath, withSerial(this.serial, ['pull', remote, localPath]), 60000);
    const text = (r.stdout || '') + (r.stderr || '');
    const ok = r.ok && /pulled|bytes/i.test(text);
    return { ok, path: ok ? localPath : '', message: text.trim() };
  }
}

module.exports = { Adb, findAdb };
