// ============================================================
//  tmcrm.bridge.js — 콜파일럿 ↔ 집수호 TM 콜매니저 연동 브리지 (부모 창)
//  ------------------------------------------------------------
//  · 발신 패널에서 결과(부재/나중연락/거부/연속부재/가망/방문예약)+메모를
//    [정지]·[메모저장]·[다음 번호]로 확정하면 dialer.renderer.js 가
//    document 이벤트 'dialer:jipsync' 를 쏜다. 여기서 그걸 모아 집수호(iframe)로 전달.
//  · 집수호 창이 닫혀 있어도(=iframe 미생성) 결과를 잃지 않도록 pending 에 쌓아
//    electron-store 에 저장 → 다음에 열 때 한꺼번에 반영(ts로 중복 방지).
//  · 집수호는 한 번 열면 숨김(display) 토글만 하고 계속 살아있어 실시간 반영됨.
//  · 집수호의 전화걸기(tmcrm:dial)는 콜파일럿 ADB 발신(dialer:external-dial)으로 위임.
// ============================================================
(function () {
  'use strict';
  const PKEY = 'tmcrmPending';
  let pending = [];
  let inflight = [];        // 방금 iframe로 보낸(아직 drained 확인 전) 항목들
  let frameReady = false;
  let overlay = null, frame = null;

  const store = (window.api && window.api.store) ? window.api.store : null;

  // ============================================================
  //  🔗 내구화 미러(재설치 생존) — tmcrm(iframe) localStorage ↔ electron-store
  //  · tmcrm 이 save() 할 때마다 전체 고객 스냅샷을 postMessage(tmcrm:persist)로 보내옴
  //    → 여기서 디바운스 후 store 키 'tmcrm_customers' 에 백업(항상 최신 상태로 덮어씀).
  //  · tmcrm 의 localStorage 가 비어있으면(재설치/초기화 직후) tmcrm:req-store 로 요청해와
  //    → store 백업을 tmcrm:restore 로 회신, tmcrm 가 자기 localStorage 가 여전히 빈 경우에만 반영.
  //  · store 전체 파일은 main.js saveAutoBackup 이 주기적으로 백업하므로 이 키도 함께 보호됨.
  // ============================================================
  const TM_STORE_KEY = 'tmcrm_customers';
  let tmPersistTimer = null, tmPersistPending = null;
  function schedulePersistCustomers(data) {
    if (!data || typeof data !== 'object') return;
    tmPersistPending = data;
    if (tmPersistTimer) return;
    tmPersistTimer = setTimeout(() => {
      tmPersistTimer = null;
      const d = tmPersistPending; tmPersistPending = null;
      try { if (store && d) store.set(TM_STORE_KEY, d); } catch (e) {}
    }, 1000);
  }
  async function replyTmRestore(win) {
    if (!win) return;
    let data = null;
    try { if (store) data = await store.get(TM_STORE_KEY); } catch (e) { data = null; }
    try { win.postMessage({ type: 'tmcrm:restore', data: data || null }, '*'); } catch (e) {}
  }

  // ============================================================
  //  ⛔ 수신거부 대장 LAN 동기화 전파 (sync-server → 여기 → dialer + TM iframe)
  //  · sync-server 가 폰 대장을 store 'tmcrm_optout' 에 병합한 뒤 cp:optout-sync 를 쏜다.
  //    → dialer 발신 잠금(optOutSet)은 기존 dialer:optout-update 이벤트 재사용으로 즉시 갱신,
  //    → TM iframe 이 열려 있으면 tmcrm:optout-merge 로 대장 병합 + 해당 고객 파기까지 반영.
  //  · TM 이 닫혀 있었으면 다음 tmcrm:ready 때 store 대장을 밀어줘(재시작 포함) 따라잡는다.
  // ============================================================
  function forwardOptoutMerge(items) {
    if (!Array.isArray(items) || !items.length) return;
    const w = frameWin();
    if (frameReady && w) { try { w.postMessage({ type: 'tmcrm:optout-merge', items: items }, '*'); } catch (e) {} }
  }
  document.addEventListener('cp:optout-sync', (e) => {
    const items = (e && e.detail && e.detail.items) || [];
    try { document.dispatchEvent(new CustomEvent('dialer:optout-update', { detail: { items: items } })); } catch (err) {}
    forwardOptoutMerge(items);
  });
  async function pushOptoutMerge(win) {
    if (!win) return;
    let items = null;
    try { items = store ? await store.get('tmcrm_optout') : null; } catch (e) { items = null; }
    if (Array.isArray(items) && items.length) { try { win.postMessage({ type: 'tmcrm:optout-merge', items: items }, '*'); } catch (e) {} }
  }

  // ============================================================
  //  👥 발신 패널 '고객 불러오기' 공급 — TM 고객 전체를 넘겨준다.
  //  · TM 창이 열려 있으면(frameReady) iframe 에 직접 물어 실시간 값을 받는다(tmcrm:req-full).
  //  · 안 열려 있거나 응답이 없으면 store 미러(tmcrm_customers)의 마지막 스냅샷으로 폴백 —
  //    TM 은 save()/load() 마다 스냅샷을 보내므로 한 번이라도 쓴 적 있으면 여기에 있다.
  // ============================================================
  async function customersFromStore() {
    try {
      const d = store ? await store.get(TM_STORE_KEY) : null;
      return (d && Array.isArray(d.customers)) ? d.customers : [];
    } catch (e) { return []; }
  }
  function getCustomers() {
    return new Promise((resolve) => {
      const w = frameWin();
      if (!w || !frameReady) { customersFromStore().then(resolve); return; }
      let settled = false;
      const onMsg = (e) => {
        const m = (e && e.data) || {};
        if (m.type !== 'tmcrm:full') return;
        settled = true;
        window.removeEventListener('message', onMsg);
        resolve(Array.isArray(m.customers) ? m.customers : []);
      };
      window.addEventListener('message', onMsg);
      try { w.postMessage({ type: 'tmcrm:req-full' }, '*'); } catch (e) {}
      setTimeout(() => {
        if (settled) return;
        window.removeEventListener('message', onMsg);
        customersFromStore().then(resolve);   // 옛 버전 TM 등 응답 없으면 스냅샷으로
      }, 1200);
    });
  }

  // ============================================================
  //  🔗 양방향 고객 미러 — 상태값 변환 + 큐 + 백필
  //  · 고객 목록(CRM, 9종 상태) ↔ TM 고객관리(iframe, 11종 canonical)
  //  · CRM→TM 변경은 crm:sync 이벤트로 받아 iframe에 반영(닫혀있으면 큐).
  //  · TM→CRM 변경은 tmcrm:cust 메시지로 받아 CRM.applyExternal 로 반영.
  //  · 발신결과(dialer:jipsync)는 TM+CRM 양쪽에 반영. 최초 1회 기존 고객 병합(백필).
  // ============================================================
  const CANON2CRM = { '연속부재':'부재', '계약협의':'방문완료', '계약완료':'계약' };
  const CRM2CANON = { '계약':'계약완료' };
  const canon2crm = s => CANON2CRM[s] || s || '';
  const crm2canon = s => CRM2CANON[s] || s || '';

  const CKEY = 'tmcrmCustPending';   // CRM→TM 고객변경 대기 큐 (iframe 닫혀있을 때)
  const BF_KEY = 'tmcrmMirrorBackfill';  // 기존 고객 병합(백필) 1회 완료 플래그
  const ASSIGN_PKEY = 'tmcrmAssignPending';   // 서버 배정 결과 대기 큐 (iframe 닫혀있을 때, 다음 오픈 때 1회 반영)
  let custPending = [];
  let backfillDone = false;

  function persist() { try { if (store) store.set(PKEY, pending); } catch (e) {} }
  async function loadPending() {
    let saved = [];
    try { if (store) saved = (await store.get(PKEY)) || []; } catch (e) { saved = []; }
    if (!Array.isArray(saved)) saved = [];
    // 저장분을 앞에 두고, 그 사이 새로 들어온 것(pending)은 뒤에 이어붙임 → 유실 없음
    pending = saved.concat(pending);
    if (pending.length) { persist(); flush(); }
  }

  function frameWin() { return frame && frame.contentWindow ? frame.contentWindow : null; }
  function flush() {
    if (!frameReady) return;
    const w = frameWin();
    if (!w || !pending.length) return;
    inflight = pending.slice();   // 이번에 보내는 묶음을 기억 → drained 오면 이것만 제거(그 사이 새로 쌓인 건 보존)
    try { w.postMessage({ type: 'tmcrm:bulk', items: inflight }, '*'); } catch (e) {}
  }

  /* ---------- 고객 변경(CRM→TM) 큐 ---------- */
  function persistCust() { try { if (store) store.set(CKEY, custPending); } catch (e) {} }
  function sendCust(item) {
    if (frameReady && frameWin()) { try { frameWin().postMessage(item, '*'); } catch (e) {} }
    else { custPending.push(item); if (custPending.length > 1000) custPending = custPending.slice(-1000); persistCust(); }
  }
  function flushCust() {
    if (!frameReady) return;
    const w = frameWin();
    if (!w || !custPending.length) return;
    const items = custPending.slice(); custPending = []; persistCust();
    items.forEach(it => { try { w.postMessage(it, '*'); } catch (e) {} });
  }
  async function loadCustPending() {
    let saved = [];
    try { if (store) saved = (await store.get(CKEY)) || []; } catch (e) { saved = []; }
    if (!Array.isArray(saved)) saved = [];
    custPending = saved.concat(custPending);
    if (custPending.length) { persistCust(); flushCust(); }
  }

  // 고객 목록(CRM) 변경 → TM 고객관리(iframe)로 반영 (crm.js 가 쏘는 이벤트)
  document.addEventListener('crm:sync', (e) => {
    const d = (e && e.detail) || {};
    if (!d.phone) return;
    const item = { type: 'tmcrm:cust-apply', op: d.op || 'upsert', phone: d.phone,
      name: d.name || '', status: (d.op === 'remove') ? '' : crm2canon(d.status),
      grade: d.grade || '', nextCall: d.nextCall || '' };
    if (d.memo != null) item.memo = d.memo;
    sendCust(item);
  });

  /* ---------- 기존 고객 병합(백필) ---------- */
  async function checkBackfill() { try { backfillDone = !!(store && await store.get(BF_KEY)); } catch (e) { backfillDone = false; } }
  function requestBackfill() {
    if (backfillDone) return;
    const w = frameWin(); if (!w) return;
    try { w.postMessage({ type: 'tmcrm:req-all' }, '*'); } catch (e) {}
  }
  async function onTmcrmAll(m) {
    if (backfillDone) return;
    backfillDone = true;                                   // 재진입 방지 (응답 1회만 처리)
    const active = Array.isArray(m.active) ? m.active : [];
    // (A) TM 활성 고객 → 고객 목록(CRM)에 없으면 추가 (저장소 1회 쓰기)
    if (window.CRM && CRM.applyExternalBulk) {
      const patches = active.map(it => ({ op: 'upsert', phone: it.phone, name: it.name || '',
        status: canon2crm(it.status), grade: it.grade || '', nextCall: it.nextCall || '',
        memo: it.memo || undefined }));
      try { await CRM.applyExternalBulk(patches); } catch (e) {}
    }
    // (B) 고객 목록(CRM) 고객 → TM 에 없으면 추가
    try {
      const crmList = (window.CRM && CRM.snapshotAll) ? CRM.snapshotAll() : [];
      const items = crmList.map(c => ({ phone: c.phone, name: c.name || '', status: crm2canon(c.status),
        grade: c.grade || '', nextCall: c.nextCall || '', memo: '' }));
      const w = frameWin();
      if (items.length && w) { try { w.postMessage({ type: 'tmcrm:backfill', items }, '*'); } catch (e) {} }
    } catch (e) {}
    try { if (store) store.set(BF_KEY, 1); } catch (e) {}
  }

  // 발신 결과가 확정될 때마다 호출됨 (dialer.renderer.js)
  document.addEventListener('dialer:jipsync', (e) => {
    const d = (e && e.detail) || {};
    if (!d.number) return;
    pending.push({
      number: d.number, name: d.name || '', tag: d.tag || '',
      memo: d.memo || '', ts: d.ts || null, dur: (d.dur == null ? null : d.dur),
      legal: d.legal || null,      // 🆕 P1/P2) 출처민원/수신거부/수신동의/증빙 녹음 → TM 법정 로그 처리
      evidence: d.evidence || null, // 🆕 P2) 증빙 녹음 파일의 PC 보관 경로
      cbDate: d.cbDate || null, cbTime: d.cbTime || null, // 🆕 P3) 가망 팝업 콜백 날짜·시각
      said: d.said || null, callSec: (d.callSec == null ? null : d.callSec), // 🆕 P4) 수신거부 사유·통화시간(감사)
      consentAt: d.consentAt || null, consentVia: d.consentVia || null // ✅ P6) 수신동의 체크(일시·방식)
    });
    if (pending.length > 500) pending = pending.slice(-500);
    persist();
    flush();   // 집수호가 살아있으면 즉시 반영, 아니면 다음 open 때
    // 🔗 발신 결과 → 고객 목록(CRM)에도 반영 (TM 고객관리가 한 번도 안 열려 있어도 동작)
    if (window.CRM && CRM.applyExternal) {
      const tag = d.tag || '';
      // 🆕 P3) 수신거부·거부·차단요청 = TM에서 파기됨 → 고객 목록(CRM)에서도 제거
      if (tag === '차단요청' || tag === '거부' || d.legal === '수신거부') { CRM.applyExternal({ op: 'remove', phone: d.number }); }
      else { CRM.applyExternal({ op: 'upsert', phone: d.number, name: d.name || '',
        status: tag ? canon2crm(tag) : '', memo: d.memo || undefined }); }
    }
  });

  // ============================================================
  //  🔗 서버 배정(assign) + 고객 업로드(upload) — TM(iframe) ↔ main(cp_customers)
  //  · 배정 요청/업로드는 모두 main IPC(window.api.crm.*)로 위임 — 토큰은 여기로도 안 넘어옴.
  //  · 실패 사유(reason)는 여기서 사람이 읽을 한국어 문구로 바꿔 업로드 결과에만 실어 보낸다.
  // ============================================================
  const UPLOAD_ERR_MSG = {
    offline: '인터넷 연결을 확인해 주세요',
    notmaster: '마스터 계정만 보낼 수 있어요',
    expired: '세션이 만료됐어요. 앱을 다시 시작해 주세요',
    nosession: '로그인이 필요해요. 앱을 다시 시작해 주세요',
    error: '업로드 중 오류가 발생했어요'
  };
  async function handleAssignReq(win) {
    if (!win) return;
    if (!window.api || !window.api.crm) { try { win.postMessage({ type: 'tmcrm:assign', ok: false, error: 'nosession' }, '*'); } catch (e) {} return; }
    let me = null;
    try { me = await window.api.crm.me(); } catch (e) {}
    if (!me || !me.ok) { try { win.postMessage({ type: 'tmcrm:assign', ok: false, error: 'nosession' }, '*'); } catch (e) {} return; }
    let r = null;
    try { r = await window.api.crm.assigned(); } catch (e) {}
    if (r && r.ok) { try { win.postMessage({ type: 'tmcrm:assign', ok: true, role: me.role, items: r.items }, '*'); } catch (e) {} }
    else { try { win.postMessage({ type: 'tmcrm:assign', ok: false, error: (r && r.reason) || 'error' }, '*'); } catch (e) {} }
  }
  async function handleUploadReq(win, items) {
    if (!win) return;
    if (!window.api || !window.api.crm || !window.api.crm.upload) {
      try { win.postMessage({ type: 'tmcrm:upload-done', ok: false, error: UPLOAD_ERR_MSG.error }, '*'); } catch (e) {}
      return;
    }
    let r = null;
    try { r = await window.api.crm.upload(Array.isArray(items) ? items : []); } catch (e) {}
    if (r && r.ok) { try { win.postMessage({ type: 'tmcrm:upload-done', ok: true, added: r.added, skipped: r.skipped }, '*'); } catch (e) {} }
    else {
      const reason = (r && r.reason) || 'error';
      try { win.postMessage({ type: 'tmcrm:upload-done', ok: false, error: UPLOAD_ERR_MSG[reason] || UPLOAD_ERR_MSG.error }, '*'); } catch (e) {}
    }
  }
  // iframe 로드 직후(ready) 푸시 — 역할/이름 + 대기 중인 배정 결과
  async function pushRoleAndAssign(win) {
    if (!win) return;
    let me = null;
    if (window.api && window.api.crm) { try { me = await window.api.crm.me(); } catch (e) {} }
    try { win.postMessage({ type: 'tmcrm:role', ok: !!(me && me.ok), role: me && me.role, name: me && me.name }, '*'); } catch (e) {}
    try {
      const pend = store ? await store.get(ASSIGN_PKEY) : null;
      if (pend && typeof pend === 'object') {
        try { win.postMessage(Object.assign({ type: 'tmcrm:assign' }, pend), '*'); } catch (e) {}
        try { if (store) store.delete(ASSIGN_PKEY); } catch (e) {}
      }
    } catch (e) {}
  }
  // 부팅 배정 동기화(앱 시작 1회, 지연 후 조용히) — 실패하면 기존 데이터는 절대 안 건드리고 그냥 스킵.
  async function bootAssignSync() {
    if (!window.api || !window.api.crm) return;
    let me = null;
    try { me = await window.api.crm.me(); } catch (e) {}
    if (!me || !me.ok) return;
    let r = null;
    try { r = await window.api.crm.assigned(); } catch (e) {}
    if (!r || !r.ok) return;
    const payload = { ok: true, role: me.role, items: r.items };
    if (frameReady && frameWin()) { try { frameWin().postMessage(Object.assign({ type: 'tmcrm:assign' }, payload), '*'); } catch (e) {} }
    else { try { if (store) store.set(ASSIGN_PKEY, payload); } catch (e) {} }
    // 부팅 회수 즉시 반영: 서버 배정에서 빠진(회수된) 건은 발신목록에서도 제거(상담사만).
    // 미러(tmcrm_customers)는 여기서 건드리지 않는다 — TM이 열리면 pending 적용 후 스스로 갱신.
    if (me.role === 'agent') {
      try {
        const custs = await customersFromStore();
        const serverIds = new Set((r.items || []).map(it => String(it.id)));
        const removedNumbers = custs.filter(c => c && c.crmId && !serverIds.has(String(c.crmId))).map(c => c.phone).filter(Boolean);
        if (removedNumbers.length) document.dispatchEvent(new CustomEvent('dialer:queue-remove', { detail: { numbers: removedNumbers } }));
      } catch (e) {}
    }
  }

  // iframe(집수호) → 부모
  window.addEventListener('message', (e) => {
    const m = (e && e.data) || {};
    if (m.type === 'tmcrm:ready') { frameReady = true; flush(); flushCust(); requestBackfill(); pushRoleAndAssign(e.source || frameWin()); pushOptoutMerge(e.source || frameWin()); }
    else if (m.type === 'tmcrm:drained') {
      // 보낸 묶음(inflight)만 큐에서 제거 → 전송~반영 사이에 새로 쌓인 결과는 보존
      if (inflight.length) { pending = pending.filter(x => inflight.indexOf(x) === -1); inflight = []; persist(); }
      if (pending.length) flush();   // 그 사이 새로 쌓였으면 이어서 전송
    }
    else if (m.type === 'tmcrm:dial') {
      // 집수호에서 전화걸기 → 콜파일럿 발신제어(ADB)로 위임
      try { document.dispatchEvent(new CustomEvent('dialer:external-dial', { detail: { number: m.number, name: m.name || '' } })); } catch (err) {}
    }
    // 🔗 TM 고객관리 고객 변경 → 고객 목록(CRM)에 반영
    else if (m.type === 'tmcrm:cust') {
      if (window.CRM && CRM.applyExternal) {
        CRM.applyExternal({ op: m.op || 'upsert', phone: m.phone, name: m.name || '',
          status: (m.op === 'remove') ? '' : canon2crm(m.status),
          grade: m.grade || '', nextCall: m.nextCall || '', memo: m.memo });
      }
    }
    // 🔗 백필 응답 (TM 전체 고객)
    else if (m.type === 'tmcrm:all') { onTmcrmAll(m); }
    // 🔗 내구화 미러: tmcrm 전체 고객 스냅샷 저장(디바운스)
    else if (m.type === 'tmcrm:persist') { schedulePersistCustomers(m.data); }
    // 🆕 P3) 수신거부 대장 미러 — 발신 잠금(dialer)·재설치 복원용
    else if (m.type === 'tmcrm:optout-persist') {
      try { if (store && Array.isArray(m.items)) store.set('tmcrm_optout', m.items); } catch (e) {}
      try { document.dispatchEvent(new CustomEvent('dialer:optout-update', { detail: { items: m.items || [] } })); } catch (e) {}
    }
    // ✅ P6) 수신동의 체크 목록 미러 — TM 저장 때마다 [{digits,at,via}] 로 옴 → store + 발신 패널 즉시 반영
    else if (m.type === 'tmcrm:consent-persist') {
      try { if (store && Array.isArray(m.items)) store.set('tmcrm_consent', m.items); } catch (e) {}
      try { document.dispatchEvent(new CustomEvent('dialer:consent-update', { detail: { items: m.items || [] } })); } catch (e) {}
    }
    // 🔗 내구화 복원: tmcrm localStorage가 비어있을 때 store 백업 회신
    else if (m.type === 'tmcrm:req-store') { replyTmRestore(e.source || frameWin()); }
    // 🔗 서버 배정 요청/완료 + 고객 업로드 (cp_customers 연동)
    else if (m.type === 'tmcrm:assign-req') { handleAssignReq(e.source || frameWin()); }
    else if (m.type === 'tmcrm:assign-done') {
      const nums = Array.isArray(m.removedNumbers) ? m.removedNumbers : [];
      if (nums.length) { try { document.dispatchEvent(new CustomEvent('dialer:queue-remove', { detail: { numbers: nums } })); } catch (err) {} }
    }
    else if (m.type === 'tmcrm:upload-req') { handleUploadReq(e.source || frameWin(), m.items); }
  });

  // ---------- 오버레이 / iframe ----------
  function injectStyle() {
    if (document.getElementById('tmcrm-style')) return;
    const s = document.createElement('style');
    s.id = 'tmcrm-style';
    s.textContent = `
      #tmcrm-overlay{position:fixed;inset:0;z-index:6000;display:none;flex-direction:column;background:var(--bg-0,#0f0d0a);}
      #tmcrm-overlay.on{display:flex;}
      #tmcrm-bar{flex:0 0 auto;display:flex;align-items:center;gap:12px;height:40px;padding:0 16px;
        background:var(--bg-1,#161310);border-bottom:1px solid var(--border,#3a352f);color:var(--text-2,#c9c1b6);font-weight:700;font-size:12.5px;}
      #tmcrm-bar .jb-title{display:flex;align-items:baseline;gap:8px;}
      #tmcrm-bar .jb-title .k{color:var(--text-1,#f0ece6);font-size:13px;font-weight:800;}
      #tmcrm-bar .jb-title .s{color:var(--text-3,#a29a8f);font-size:11.5px;font-weight:600;}
      #tmcrm-bar .jb-hint{color:var(--text-3,#a29a8f);font-size:12px;font-weight:600;}
      #tmcrm-bar .jb-spacer{flex:1;}
      #tmcrm-bar .jb-close{background:var(--bg-3,#2a251f);border:1px solid var(--border-strong,#4a453f);color:var(--text-1,#f0ece6);
        font-size:12.5px;font-weight:700;padding:6px 12px;border-radius:6px;cursor:pointer;}
      #tmcrm-bar .jb-close:hover{border-color:var(--accent,#c96442);color:#fff;}
      #tmcrm-frame{flex:1;width:100%;border:0;background:var(--bg-0,#0f0d0a);}
    `;
    document.head.appendChild(s);
  }

  function build() {
    if (overlay) return;
    injectStyle();
    overlay = document.createElement('div');
    overlay.id = 'tmcrm-overlay';
    overlay.innerHTML = `
      <div id="tmcrm-bar">
        <div class="jb-title"><span class="k">TM 고객관리</span><span class="s">콜 매니저</span></div>
        <span class="jb-hint">발신 결과·메모가 자동으로 이 고객 DB에 반영됩니다</span>
        <div class="jb-spacer"></div>
        <button class="jb-close" id="tmcrm-close">✕ 닫기 (Esc)</button>
      </div>
      <iframe id="tmcrm-frame" src="tmcrm.html" title="TM 고객관리 콜 매니저"></iframe>`;
    document.body.appendChild(overlay);
    frame = overlay.querySelector('#tmcrm-frame');
    overlay.querySelector('#tmcrm-close').onclick = close;
  }

  function open() {
    build();
    overlay.classList.add('on');
    // iframe 이 이미 준비돼 있으면 그동안 쌓인 pending 을 밀어줌
    flush(); flushCust(); requestBackfill();
  }
  function close() { if (overlay) overlay.classList.remove('on'); }
  function isOpen() { return !!(overlay && overlay.classList.contains('on')); }
  function toggle() { if (isOpen()) close(); else open(); }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); }
  });

  // 📖 TM 고객관리 내부 튜토리얼 시작 요청 (iframe 로딩을 기다려 재시도)
  function tutorial(tries) {
    tries = tries || 0;
    const w = frameWin();
    if (w) { try { w.postMessage({ type: 'tmcrm:tutorial' }, '*'); return; } catch (e) {} }
    if (tries < 20) setTimeout(() => tutorial(tries + 1), 300);
  }

  window.TMCRM = { open, close, toggle, isOpen, tutorial, getCustomers };

  loadPending();
  checkBackfill();
  loadCustPending();
  setTimeout(bootAssignSync, 4000);   // 🔗 앱 시작 몇 초 후 조용히 1회 — 서버 배정 최신화
})();
