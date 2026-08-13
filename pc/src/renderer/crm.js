/* ============================================================
   콜파일럿 — 관리(CRM) 모듈  v1
   메모(notes)를 전화번호로 묶어 "고객" 파이프라인으로 관리한다.
   - notes      = 통화/메모 로그 (불변, renderer.js가 관리)
   - crmMeta    = 고객별 편집 데이터(상태·등급·다음연락일·이름보정·메모)
   renderer.js 전역(state, notePhone, noteName, escapeHtml, showToast,
   renderNotes, window.api)을 같은 페이지에서 공유한다.
   ============================================================ */
(function () {
'use strict';

/* ---------- 상수 ---------- */
const STATUSES = ['신규','부재','나중연락','가망','방문예약','방문완료','계약','거부','차단요청'];
const STATUS_COLOR = { '신규':'#6b93c4','부재':'#9aa0a6','나중연락':'#cf9d52','가망':'#cf6b5c','방문예약':'#c96442','방문완료':'#5a9d6b','계약':'#3ec46d','거부':'#8a877d','차단요청':'#b23a48' };
const HOT = ['가망','방문예약','방문완료','계약'];
const DEAD = ['거부'];
const GRADES = ['','A','B','C','D'];
const GRADE_COLOR = { A:'#cf6b5c', B:'#cf9d52', C:'#6b93c4', D:'#8a877d' };
const GRADE_DESC = { A:'핫 · 즉시', B:'웜 · 관심', C:'쿨 · 잠재', D:'콜드 · 보류' };

/* ---------- 유틸 ---------- */
const pad = n => String(n).padStart(2,'0');
function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function daysDiff(s){ if(!s) return null; const a=new Date(todayStr()), b=new Date(String(s).slice(0,10)); if(isNaN(b)) return null; return Math.round((b-a)/86400000); }
function fmtMD(s){ if(!s) return ''; const d=new Date(String(s).slice(0,10)); if(isNaN(d)) return s; return `${d.getMonth()+1}/${d.getDate()}`; }
function fmtStamp(ts){ const d=new Date(ts); if(isNaN(d)) return ''; const h=d.getHours(), ap=h<12?'오전':'오후', h12=h%12||12; return `${d.getMonth()+1}/${d.getDate()} ${ap} ${h12}:${pad(d.getMinutes())}`; }
/* 메모가 실제로 바뀐 경우에만 '메모 전용 시각(memoAt)'을 남긴다.
   updatedAt 은 상태·등급·다음연락일만 바꿔도 갱신되므로 '메모 쓴 시각'으로 쓸 수 없다. */
function memoStamp(prev, patch){
  const extra = { updatedAt: Date.now() };
  if(patch && Object.prototype.hasOwnProperty.call(patch,'memo')){
    const a = String(patch.memo==null ? '' : patch.memo);
    const b = String((prev && prev.memo)==null ? '' : prev.memo);
    if(a !== b) extra.memoAt = Date.now();
  }
  return extra;
}
/* TM 메모 카드에 붙일 시각 문구 — 전용 시각이 있으면 그걸, 없으면(예전 메모) '마지막 수정'으로 대체 */
function memoStampText(c){
  if(c && c.crmMemoAt) return ' · ' + fmtStamp(c.crmMemoAt);
  if(c && c.crmUpdatedAt) return ' · 마지막 수정 ' + fmtStamp(c.crmUpdatedAt);
  return '';
}
const digits = s => String(s||'').replace(/\D/g,'');
function fmtPhoneD(d){ d=digits(d); return d.length===11 ? `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}` : (d||''); }
function esc(s){ return (typeof escapeHtml==='function') ? escapeHtml(s) : String(s==null?'':s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function toast(m){ if(typeof showToast==='function') showToast(m); }
function notesAll(){ return (typeof state!=='undefined' && state.notes) ? state.notes : []; }
function custList(){ return (typeof state!=='undefined' && state.customers) ? state.customers : []; }
function nPhone(n){ return (typeof notePhone==='function') ? notePhone(n) : (n.number||''); }
function nName(n){ return (typeof noteName==='function') ? noteName(n) : (n.name||''); }

/* 콜백 상태(다음연락일 기준) */
function cbInfo(c){
  const dd = daysDiff(c.nextCall);
  if(dd===null) return { key:'none', label:'', icon:'', sort:5 };
  if(dd<0)  return { key:'past',  label:`놓침 ${fmtMD(c.nextCall)}`, icon:'🔴', sort:0 };
  if(dd===0)return { key:'today', label:'오늘 콜백',                 icon:'🟡', sort:1 };
  return { key:'soon', label:`${fmtMD(c.nextCall)} 예정`,            icon:'🟢', sort:2 };
}
/* 놓친+오늘 콜백 고객(비보관·비거부) — 오늘 탭·FAB 배지·발신목록 올리기가 공유 */
function dueCustomers(){
  const live = buildCustomers().filter(c=>!DEAD.includes(c.status));
  return live.filter(c=>{ const k=cbInfo(c).key; return k==='past'||k==='today'; });
}

/* ============================================================
   고객 빌드 — notes를 번호로 묶고 crmMeta 병합
   ============================================================ */
function buildCustomers(){
  const map = {};
  notesAll().forEach(n => {
    const ph = digits(nPhone(n));
    if(!ph) return;
    if(!map[ph]) map[ph] = { phone:nPhone(n), phoneD:ph, name:'', notes:[], count:0, last:0, first:Infinity };
    const c = map[ph];
    c.notes.push(n); c.count++;
    const t = new Date(n.createdAt).getTime();
    if(t>c.last) c.last=t; if(t<c.first) c.first=t;
    if(!c.name && nName(n)) c.name = nName(n);
  });
  custList().forEach(cust => { const ph=digits(cust.phone); if(ph && map[ph] && !map[ph].name && cust.name) map[ph].name = cust.name; });
  // 🔗 노트가 없어도 crmMeta 로만 등록된 고객(예: TM 고객관리에서 넘어온 고객)도 목록에 표시
  Object.keys(CRM.meta||{}).forEach(ph => {
    if(!ph || map[ph]) return;
    const m = CRM.meta[ph];
    if(!m || m.archived) return;   // 보관된 건 아래 필터에서도 걸리지만 미리 스킵
    map[ph] = { phone: m.phone || fmtPhoneD(ph), phoneD:ph, name:'', notes:[], count:0, last:0, first:Infinity };
  });
  return Object.values(map).map(c => {
    const m = CRM.meta[c.phoneD] || {};
    c.notes.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    return Object.assign(c, {
      name: m.name || c.name,
      status: m.status || '신규',
      grade: m.grade || '',
      nextCall: m.nextCall || '',
      crmMemo: m.memo || '',
      crmMemoAt: m.memoAt || 0,
      crmUpdatedAt: m.updatedAt || 0
    });
  })
  // 🔗 TM 고객관리에서 보관(archive)된 고객은 목록·현황에서 제외 (비파괴 미러 — notes는 보존, 복구 가능)
  .filter(c => !(CRM.meta[c.phoneD] && CRM.meta[c.phoneD].archived));
}
function dispName(c){ return c.name || c.phone || '번호없음'; }
function initials(c){ const n=(c.name||'').trim(); if(n) return n.slice(-2); return (c.phoneD||'').slice(-2)||'·'; }
const AV=['#c96442','#6b93c4','#5a9d6b','#9b7cc4','#cf9d52','#cf6b5c','#5b8a8c','#a87c5a'];
function avColor(s){ let h=0; for(const ch of (s||'?')) h=(h*31+ch.charCodeAt(0))>>>0; return AV[h%AV.length]; }

/* ============================================================
   상태(저장소)
   ============================================================ */
const CRM = {
  meta:{}, calMemo:{}, loaded:false,
  view:'today', sel:null, search:'', statusFilter:'all', specialFilter:'all', sort:'recent',
  calCursor:null, calSel:null,

  async load(){
    if(this.loaded) return;
    try { this.meta   = (await window.api.store.get('crmMeta'))    || {}; } catch(e){ this.meta={}; }
    try { this.calMemo= (await window.api.store.get('crmCalMemo')) || {}; } catch(e){ this.calMemo={}; }
    this.loaded = true;
  },
  async setMeta(ph, patch){
    const _prev = this.meta[ph]||{};
    this.meta[ph] = Object.assign({}, _prev, patch, memoStamp(_prev, patch));
    try { await window.api.store.set('crmMeta', this.meta); } catch(e){}
    this.emitSync(ph, 'upsert');   // 🔗 상태·등급·이름·다음연락일 변경 → TM 고객관리 반영
  },
  /* ☎ 전화번호 변경 — 이 고객의 모든 메모(notes) 번호 + crmMeta 키를 새 번호로 이전 */
  async changePhone(c, newRaw){
    const newPhone = String(newRaw||'').trim();
    const newD = digits(newPhone);
    const oldD = c.phoneD;
    if(!newD){ toast('전화번호를 입력하세요'); return; }
    if(newD === oldD){ toast('번호가 그대로예요'); return; }
    const conflict = notesAll().some(n => digits(nPhone(n))===newD) || !!this.meta[newD];
    if(conflict){ if(!confirm(`이미 ${newPhone} 번호로 된 기록이 있어요.\n두 고객을 한 번호로 합칠까요?`)) return; }
    else { if(!confirm(`전화번호를 바꿀까요?\n${c.phone} → ${newPhone}\n(이 고객의 모든 메모·기록이 새 번호로 옮겨집니다)`)) return; }
    // 1) notes 번호 교체
    if(typeof state!=='undefined' && Array.isArray(state.notes)){
      state.notes.forEach(n => { if(digits(nPhone(n))===oldD) n.number = newPhone; });
      try { await window.api.store.set('notes', state.notes); } catch(e){}
    }
    // 2) crmMeta 키 이전 (합치면 기존 새번호 메타 위에 이 고객 메타를 덮어씀)
    this.meta[newD] = Object.assign({}, this.meta[newD]||{}, this.meta[oldD]||{}, { updatedAt:Date.now() });
    if(oldD !== newD) delete this.meta[oldD];
    try { await window.api.store.set('crmMeta', this.meta); } catch(e){}
    // 3) 선택 갱신 + 라이브 메모목록 + CRM 새로고침
    this.sel = newD;
    if(typeof renderNotes==='function'){ try{ renderNotes(); }catch(e){} }
    try { document.dispatchEvent(new CustomEvent('notes:changed')); } catch(e){}
    this.emitSync(oldD, 'remove', { phone:c.phone });   // 🔗 옛 번호 제거 + 새 번호 등록 → TM 고객관리 반영
    this.emitSync(newD, 'upsert');
    this.render();
    toast('번호 변경됨: ' + newPhone);
  },
  async saveCal(){ try { await window.api.store.set('crmCalMemo', this.calMemo); } catch(e){} },

  /* CRM에서 메모(로그) 추가 → state.notes에 반영 (라이브 화면과 공유) */
  async addNote(c, text, images){
    text=(text||'').trim();
    const imgs = Array.isArray(images) ? images : [];
    if(!text && !imgs.length) return;
    if(typeof state==='undefined') return;
    state.notes = state.notes || [];
    // 작성자·시각을 본문에 박아 둔다 — 나중에 누가 썼는지 다툼이 생기지 않게(기록은 덧붙이기만 가능)
    if(typeof window.npEnsureName==='function'){ try{ await window.npEnsureName(); }catch(e){} }
    const stamped = (typeof window.npAppendMemo==='function') ? window.npAppendMemo('', text) : text;
    state.notes.unshift({ id:'crm-'+Date.now(), content:stamped, by:(typeof window.npMemoAuthor==='function'?window.npMemoAuthor():''), createdAt:new Date().toISOString(), number:c.phone, name:c.name||'', result:'', images:imgs, fields:null });
    try { await window.api.store.set('notes', state.notes); } catch(e){}
    if(typeof renderNotes==='function'){ try{ renderNotes(); }catch(e){} }
    this.emitSync(digits(c.phone), 'upsert', { memo:stamped });   // 🔗 CRM 메모 추가 → TM 고객관리 메모에 반영(작성자 포함)
    toast('메모가 추가됐어요');
    this.render();
  },

  /* 발신 → 발신제어(콜파일럿)에 위임: 현재 통화 표시 + 타이머 + 결과/메모 연동까지 동일하게.
     콜관리 창은 닫지 않는다(바로 결과·메모 작업 가능). 실제 ADB 발신도 발신제어 쪽에서 수행. */
  async dial(c){
    const num = digits(c.phone);
    if(!num){ toast('전화번호가 없어요'); return; }
    document.dispatchEvent(new CustomEvent('dialer:external-dial', { detail:{ number:c.phone, name:c.name||'' } }));
    toast('📞 ' + (c.name||c.phone) + ' — 발신제어 현재 통화로 올렸어요');
  },

  /* 🗑 고객 삭제(=보관) — notes(통화기록)는 보존하고 crmMeta.archived 만 세워 목록/현황에서 제외.
     TM 고객관리 보관함에서 언제든 복구 가능(비파괴). */
  async deleteCustomer(c){
    if(!c) return;
    const ph = c.phoneD || digits(c.phone);
    if(!ph){ toast('번호가 없어 보관할 수 없어요'); return; }
    if(!confirm('보관함으로 이동합니다. 통화기록은 지워지지 않으며, TM 고객관리의 보관함에서 복구할 수 있어요.')) return;
    this.meta[ph] = Object.assign({}, this.meta[ph]||{}, { archived:true, updatedAt:Date.now() });
    try { await window.api.store.set('crmMeta', this.meta); } catch(e){}
    if(this.sel===ph) this.sel=null;
    if(typeof renderNotes==='function'){ try{ renderNotes(); }catch(e){} }
    try { document.dispatchEvent(new CustomEvent('notes:changed')); } catch(e){}
    this.emitSync(ph, 'remove', { phone:c.phone });   // 🔗 보관 처리 → TM 고객관리 보관함으로
    toast('고객을 보관함으로 옮겼어요');
    this.render();
  },
  /* 🗑💀 고객 완전삭제 — 이 번호의 메모(notes) 전체 + 관리 메타를 되돌릴 수 없이 제거.
     UI에서는 더 이상 연결하지 않음(정책: 삭제=보관). 필요 시에만 코드에서 직접 호출. */
  async deleteCustomerPermanent(c){
    if(!c) return;
    const ph = c.phoneD || digits(c.phone);
    if(!ph){ toast('번호가 없어 삭제할 수 없어요'); return; }
    if(!confirm(`${dispName(c)} 고객을 완전히 삭제할까요?\n이 번호의 메모 ${c.count||0}건과 관리 정보가 모두 지워집니다. (되돌릴 수 없어요)`)) return;
    if(typeof state!=='undefined' && Array.isArray(state.notes)){
      state.notes = state.notes.filter(n => digits(nPhone(n)) !== ph);
      try { await window.api.store.set('notes', state.notes); } catch(e){}
    }
    if(this.meta[ph]){ delete this.meta[ph]; try { await window.api.store.set('crmMeta', this.meta); } catch(e){} }
    if(this.sel===ph) this.sel=null;
    if(typeof renderNotes==='function'){ try{ renderNotes(); }catch(e){} }
    try { document.dispatchEvent(new CustomEvent('notes:changed')); } catch(e){}
    this.emitSync(ph, 'remove', { phone:c.phone });
    toast('고객을 완전삭제했어요');
    this.render();
  },

  open(){ const r=document.getElementById('crm-root'); if(!r) return; this.load().then(()=>{ if(window.__layout&&window.__layout.openCrmDock) window.__layout.openCrmDock(); else r.style.display='flex'; this.render(); }); },
  /* 저장된 메모(번호 있는 카드) 클릭 → 콜관리를 열고 그 번호의 고객 상세를 바로 띄움.
     고객 클릭한 것과 '같은 창'(상세 패널). 메모 추가 시 맨 아래 통화·메모 기록으로 쌓임. */
  openCustomerByPhone(phone){
    const ph=digits(phone); if(!ph) return;
    const r=document.getElementById('crm-root'); if(!r) return;
    this.load().then(()=>{
      if(window.__layout&&window.__layout.openCrmDock) window.__layout.openCrmDock(); else r.style.display='flex';
      this.view='db';            // 고객 DB 맥락에서 상세를 띄움
      this.specialFilter='all';  // 세부탭 필터는 초기화하고 상세를 띄움
      this.sel=ph;               // 이 번호를 선택 → renderDetail이 상세 패널을 연다
      this.render();
    });
  },
  close(){ if(window.__layout&&window.__layout.closeCrmDock) window.__layout.closeCrmDock(); else { const r=document.getElementById('crm-root'); if(r) r.style.display='none'; } this.sel=null; },
  go(view){ const [v,special]=String(view).split(':'); this.view=v; this.specialFilter=special||'all'; this.statusFilter='all'; this.sel=null; this.render(); },

  render(){
    const root=document.getElementById('crm-root'); if(!root) return;
    const tabs=[['today','오늘'],['db','고객 DB'],['calendar','캘린더'],['stats','현황']];
    root.innerHTML = `
      <div class="crm-topbar">
        <div class="crm-tabs">
          ${tabs.map(t=>`<button class="crm-tab${this.view===t[0]?' on':''}" data-crmtab="${t[0]}">${t[1]}</button>`).join('')}
          <button class="crm-tab" id="crm-open-tmcrm" title="TM 고객관리 콜 매니저 — 발신 결과·메모가 자동으로 반영되는 고객 DB">고객관리</button>
        </div>
      </div>
      <div class="crm-stage">
        <div class="crm-body" id="crm-body"></div>
        <div class="crm-detail" id="crm-detail"></div>
      </div>`;
    const body=document.getElementById('crm-body');
    if(this.view==='today')    body.innerHTML=renderToday();
    else if(this.view==='db')  body.innerHTML=renderDb();
    else if(this.view==='calendar') body.innerHTML=renderCalendar();
    else if(this.view==='stats')    body.innerHTML=renderStats();
    bindBody();
    renderDetail();
    root.querySelectorAll('[data-crmtab]').forEach(b=>b.onclick=()=>this.go(b.dataset.crmtab));
    const jipBtn=document.getElementById('crm-open-tmcrm');
    if(jipBtn) jipBtn.onclick=()=>{ if(window.TMCRM) window.TMCRM.open(); else toast('TM 고객관리를 불러오지 못했어요'); };
    if(typeof refocusApp==='function') refocusApp();   // 정보 수정/메모 추가 후 입력 포커스 복구
    updateFabBadge();   // 🔔 렌더될 때마다(=데이터 변경 반영 시점) FAB 배지도 최신화
  },

  /* ＋ 고객 추가 — 번호로 신규 고객 등록. 고객은 메모(notes)에서 파생되므로 최초 등록 로그 1건을 만든다. */
  async addCustomer(phoneRaw, nameRaw){
    const phone=String(phoneRaw||'').trim();
    const name =String(nameRaw||'').trim();
    const ph=digits(phone);
    if(!ph){ toast('전화번호를 입력하세요'); return false; }
    // 중복: 이미 그 번호의 기록이 있으면 새로 만들지 않고 그 고객을 연다
    if(notesAll().some(n=>digits(nPhone(n))===ph)){
      toast('이미 등록된 번호예요 — 그 고객을 엽니다');
      this.view='db'; this.specialFilter='all'; this.statusFilter='all'; this.search=''; this.sel=ph; this.render();
      return false;
    }
    if(typeof state==='undefined'){ toast('저장소를 찾을 수 없어요'); return false; }
    state.notes = state.notes || [];
    state.notes.unshift({ id:'crm-'+Date.now(), content:'🆕 신규 고객 등록', createdAt:new Date().toISOString(), number:phone, name:name, result:'', images:[], fields:null });
    try { await window.api.store.set('notes', state.notes); } catch(e){}
    const patch={ status:'신규' }; if(name) patch.name=name;
    await this.setMeta(ph, patch);
    if(typeof renderNotes==='function'){ try{ renderNotes(); }catch(e){} }
    try { document.dispatchEvent(new CustomEvent('notes:changed')); } catch(e){}
    toast('고객을 추가했어요: ' + (name||phone));
    this.view='db'; this.specialFilter='all'; this.statusFilter='all'; this.search=''; this.sel=ph; this.render();   // 새 고객 상세 열기
    return true;
  }
};
window.CRM = CRM;

/* ============================================================
   🔗 TM 고객관리 ↔ 고객 목록 양방향 미러
   - 고객 목록(CRM)에서 추가/수정/삭제가 일어나면 crm:sync 이벤트를 쏜다.
     tmcrm.bridge.js(같은 창)가 받아 상태값을 변환해 TM 고객관리(iframe)에 반영.
   - 반대로 TM 고객관리에서 온 변경은 CRM.applyExternal 로 반영(재발신 금지).
   상태는 CRM 어휘(9종)로 주고받고, 변환은 bridge 가 담당한다.
   ============================================================ */
CRM._inbound = false;   // 외부(TM)에서 받은 반영 중엔 crm:sync 재발신 금지 → 에코 루프 차단
CRM.emitSync = function(phoneD, op, extra){
  if(this._inbound) return;
  extra = extra || {};
  const detail = { op: op||'upsert', phone:'' };
  if(op==='remove'){
    detail.phone = extra.phone || phoneD;
  } else {
    const c = buildCustomers().find(x=>x.phoneD===phoneD);
    if(c){
      detail.phone = c.phone || phoneD;
      detail.name = c.name||''; detail.status = c.status||'신규';
      detail.grade = c.grade||''; detail.nextCall = c.nextCall||'';
    } else {
      // 아직 목록엔 없지만(예: 방금 archived 해제 직후) 알고 있는 값으로 최소 전송
      detail.phone = extra.phone || phoneD;
      detail.name = extra.name||''; detail.status = extra.status||'신규';
      detail.grade = extra.grade||''; detail.nextCall = extra.nextCall||'';
    }
    if(extra.memo!=null) detail.memo = extra.memo;
  }
  if(!digits(detail.phone)) return;
  try{ document.dispatchEvent(new CustomEvent('crm:sync',{detail})); }catch(e){}
};
/* TM 고객관리(또는 발신결과)에서 온 고객 변경을 CRM(notes+crmMeta)에 반영. status 는 이미 CRM 어휘. */
CRM.applyExternal = async function(patch){
  if(!patch || !patch.phone) return;
  await this.load();
  const ph = digits(patch.phone); if(!ph) return;
  this._inbound = true;
  try{
    if(patch.op==='remove'){
      // 비파괴: notes 는 그대로 두고 archived 플래그만 → 목록/현황에서 제외(복구 가능)
      this.meta[ph] = Object.assign({}, this.meta[ph]||{}, { archived:true, updatedAt:Date.now() });
      try{ await window.api.store.set('crmMeta', this.meta); }catch(e){}
    } else {
      // 고객은 crmMeta 만으로도 목록에 표시된다(buildCustomers meta-seed) → 합성 노트 불필요.
      const mpatch = { archived:false, phone:patch.phone };
      if(patch.name)                        mpatch.name    = patch.name;   // 빈 이름으로 기존 이름 덮지 않음
      if(patch.status)                      mpatch.status  = patch.status;
      if(patch.grade!=null)                 mpatch.grade   = patch.grade;
      if(patch.nextCall!=null)              mpatch.nextCall= patch.nextCall;
      if(patch.memo!=null && patch.memo!=='') mpatch.memo  = patch.memo;
      const _prev = this.meta[ph]||{};
      this.meta[ph] = Object.assign({}, _prev, mpatch, memoStamp(_prev, mpatch));
      try{ await window.api.store.set('crmMeta', this.meta); }catch(e){}
    }
    if(typeof renderNotes==='function'){ try{ renderNotes(); }catch(e){} }
    try{ document.dispatchEvent(new CustomEvent('notes:changed')); }catch(e){}
    const open = window.__layout && window.__layout.isCrmOpen && window.__layout.isCrmOpen();
    if(open){ try{ this.render(); }catch(e){} } else if(typeof updateFabBadge==='function'){ try{ updateFabBadge(); }catch(e){} }
  } finally { this._inbound = false; }
};
/* 백필용 — 여러 고객을 한 번에 반영(저장소 1회 쓰기). 대량(수백 명) 병합 성능용. */
CRM.applyExternalBulk = async function(patches){
  if(!Array.isArray(patches) || !patches.length) return;
  await this.load();
  this._inbound = true;
  try{
    patches.forEach((patch)=>{
      if(!patch || !patch.phone) return;
      const ph=digits(patch.phone); if(!ph) return;
      if(patch.op==='remove'){
        this.meta[ph]=Object.assign({}, this.meta[ph]||{}, { archived:true, updatedAt:Date.now() });
        return;
      }
      // crmMeta 만으로도 목록에 표시(buildCustomers meta-seed) → 합성 노트 불필요
      const mpatch={ archived:false, phone:patch.phone };
      if(patch.name)                        mpatch.name    = patch.name;
      if(patch.status)                      mpatch.status  = patch.status;
      if(patch.grade!=null)                 mpatch.grade   = patch.grade;
      if(patch.nextCall!=null)              mpatch.nextCall= patch.nextCall;
      if(patch.memo!=null && patch.memo!=='') mpatch.memo  = patch.memo;
      const _prev = this.meta[ph]||{};
      this.meta[ph]=Object.assign({}, _prev, mpatch, memoStamp(_prev, mpatch));
    });
    try{ await window.api.store.set('crmMeta', this.meta); }catch(e){}
    if(typeof renderNotes==='function'){ try{ renderNotes(); }catch(e){} }
    try{ document.dispatchEvent(new CustomEvent('notes:changed')); }catch(e){}
    const open = window.__layout && window.__layout.isCrmOpen && window.__layout.isCrmOpen();
    if(open){ try{ this.render(); }catch(e){} } else if(typeof updateFabBadge==='function'){ try{ updateFabBadge(); }catch(e){} }
  } finally { this._inbound = false; }
};
/* 백필용 — 현재 고객 목록(활성) 스냅샷 */
CRM.snapshotAll = function(){
  try{ return buildCustomers().map(c=>({ phone:c.phone, name:c.name||'', status:c.status||'신규', grade:c.grade||'', nextCall:c.nextCall||'' })); }
  catch(e){ return []; }
};

/* ＋ 고객 추가 입력 모달 (Electron 은 prompt() 미지원 → 자체 모달). 배경클릭으로 안 닫힘(취소/Esc만). */
function openAddCustomerModal(){
  if(document.getElementById('crm-add-modal')) return;
  const ov=document.createElement('div');
  ov.id='crm-add-modal';
  ov.style.cssText='position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
  ov.innerHTML=
    '<div style="width:min(360px,90vw);background:#211f1c;border:1px solid var(--accent,#c96442);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);padding:20px 20px 16px;">'+
      '<div style="font-size:16px;font-weight:800;color:var(--text-1,#f0ece6);margin-bottom:14px;">＋ 고객 추가</div>'+
      '<label style="display:block;font-size:12px;color:var(--text-3,#a29a8f);margin:0 0 5px;">전화번호 <span style="color:#cf6b5c">*</span></label>'+
      '<input type="tel" id="crm-add-phone" placeholder="010-1234-5678" autocomplete="off" '+
        'style="width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;border-radius:8px;border:1px solid #4a453f;background:#17150f;color:#f0ece6;outline:none;font-variant-numeric:tabular-nums;">'+
      '<label style="display:block;font-size:12px;color:var(--text-3,#a29a8f);margin:12px 0 5px;">이름 <span style="color:#8a877d">(선택)</span></label>'+
      '<input type="text" id="crm-add-name" placeholder="고객 이름" autocomplete="off" '+
        'style="width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;border-radius:8px;border:1px solid #4a453f;background:#17150f;color:#f0ece6;outline:none;">'+
      '<div style="display:flex;gap:8px;margin-top:18px;">'+
        '<button id="crm-add-cancel" style="flex:1;padding:10px;cursor:pointer;font-size:14px;font-weight:700;color:#d8d2c8;border:1px solid #4a453f;border-radius:8px;background:#2b2824;">취소</button>'+
        '<button id="crm-add-ok" style="flex:1;padding:10px;cursor:pointer;font-size:14px;font-weight:800;color:#eaf6ee;border:1px solid #34b56e;border-radius:8px;background:linear-gradient(180deg,#1f9d5b,#178048);">추가</button>'+
      '</div>'+
    '</div>';
  document.body.appendChild(ov);
  const phEl=document.getElementById('crm-add-phone'), nmEl=document.getElementById('crm-add-name');
  const close=()=>{ ov.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e){ if(e.key==='Escape'){ close(); } }
  const submit=()=>{ if(!digits(phEl.value)){ toast('전화번호를 입력하세요'); phEl.focus(); return; } CRM.addCustomer(phEl.value, nmEl.value); close(); };
  document.getElementById('crm-add-cancel').onclick=close;
  document.getElementById('crm-add-ok').onclick=submit;
  phEl.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); nmEl.focus(); } });
  nmEl.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
  document.addEventListener('keydown', onEsc);
  setTimeout(()=>{ try{ phEl.focus(); }catch(e){} }, 30);
}

/* ============================================================
   뷰: 오늘
   ============================================================ */
function renderToday(){
  const cs = buildCustomers();
  const live = cs.filter(c=>!DEAD.includes(c.status));
  const due  = dueCustomers().sort((a,b)=> (daysDiff(a.nextCall)) - (daysDiff(b.nextCall)));
  const soon = live.filter(c=>cbInfo(c).key==='soon').sort((a,b)=>(daysDiff(a.nextCall))-(daysDiff(b.nextCall)));
  const hot  = live.filter(c=>HOT.includes(c.status));
  const noPlan = live.filter(c=>!c.nextCall && !HOT.includes(c.status));
  const tiles = [
    ['전체 고객', cs.length, '#6b93c4', 'db'],
    ['오늘·놓친 콜백', due.length, '#cf6b5c', 'db:due'],
    ['가망', hot.length, '#5a9d6b', 'db:hot'],
    ['예정된 콜백', soon.length, '#cf9d52', 'db:soon']
  ];
  return `
    <div class="crm-tiles">
      ${tiles.map(t=>`<div class="crm-tile" ${t[3]?`data-goto="${t[3]}"`:''} style="--tc:${t[2]}"><div class="crm-tile-n">${t[1]}</div><div class="crm-tile-l">${t[0]}</div></div>`).join('')}
    </div>
    <div class="crm-sec-title crm-sec-title-row">
      <span>🔔 오늘 연락할 고객 <span class="crm-muted">(놓친·오늘 콜백)</span></span>
      ${due.length ? `<button class="crm-queue-btn" id="crm-queue-due" title="놓친·오늘 콜백 고객을 발신목록에 올려요">📞 발신목록에 올리기</button>` : ''}
    </div>
    ${due.length ? `<div class="crm-list">${due.map(rowHtml).join('')}</div>` : `<div class="crm-empty sm">오늘 연락할 고객이 없어요 · 고객 DB에서 '다음 연락일'을 정하면 모여요</div>`}
    ${hot.length ? `<div class="crm-sec-title" style="margin-top:18px">🔥 가망·방문 파이프라인</div><div class="crm-list">${hot.slice(0,30).map(rowHtml).join('')}</div>`:''}
  `;
}

/* ============================================================
   뷰: 고객 DB
   ============================================================ */
/* 목록만 계산·렌더 (검색 입력 시 이 부분만 갱신해 검색창 DOM을 보존 → 한글 조합 안깨짐) */
function renderDbResults(){
  let cs = buildCustomers();
  const total = cs.length;
  const q = CRM.search.trim().toLowerCase();
  if(q) cs = cs.filter(c=>(c.name+' '+c.phone+' '+c.notes.map(n=>n.content).join(' ')).toLowerCase().includes(q));
  if(CRM.specialFilter==='due')  cs = cs.filter(c=>{ const k=cbInfo(c).key; return k==='past'||k==='today'; });
  else if(CRM.specialFilter==='soon') cs = cs.filter(c=>cbInfo(c).key==='soon');
  else if(CRM.specialFilter==='hot')  cs = cs.filter(c=>HOT.includes(c.status));
  else if(CRM.specialFilter==='new')  cs = cs.filter(c=>c.status==='신규');
  if(CRM.statusFilter!=='all') cs = cs.filter(c=>c.status===CRM.statusFilter);
  cs.sort((a,b)=>{
    if(CRM.sort==='name'){ if(a.name&&b.name) return a.name.localeCompare(b.name,'ko'); if(a.name) return -1; if(b.name) return 1; return b.last-a.last; }
    if(CRM.sort==='cb'){ return cbInfo(a).sort-cbInfo(b).sort || a.last-b.last; }
    return b.last-a.last; // recent
  });
  return `
    <div class="crm-count">${(q||CRM.statusFilter!=='all'||CRM.specialFilter!=='all') ? `${cs.length} / ${total}명` : `${total}명`}</div>
    ${cs.length ? `<div class="crm-list">${cs.map(rowHtml).join('')}</div>` : `<div class="crm-empty">조건에 맞는 고객이 없어요.</div>`}
  `;
}
function renderDb(){
  const statusOpts=['all'].concat(STATUSES);
  const special=[['all','⚡ 빠른보기: 전체'],['new','🆕 신규만'],['due','🔴 오늘·놓친 콜백'],['soon','🟢 예정된 콜백'],['hot','🔥 가망만']];
  return `
    <div class="crm-dbbar">
      <input type="text" id="crm-search" class="crm-search" placeholder="🔎 이름·번호·메모 검색" value="${esc(CRM.search)}" autocomplete="off">
      <button id="crm-add-customer" class="crm-add-mini" title="새 고객을 전화번호로 직접 등록">＋ 고객</button>
    </div>
    <div class="crm-dbbar">
      <select id="crm-special" class="crm-sort" style="flex:1" title="빠른 보기">
        ${special.map(o=>`<option value="${o[0]}"${CRM.specialFilter===o[0]?' selected':''}>${o[1]}</option>`).join('')}
      </select>
      <select id="crm-statusf" class="crm-sort" style="flex:1" title="상태 필터">
        ${statusOpts.map(s=>`<option value="${s}"${CRM.statusFilter===s?' selected':''}>${s==='all'?'상태: 전체':s}</option>`).join('')}
      </select>
      <select id="crm-sort" class="crm-sort" style="flex:1" title="정렬">
        <option value="recent"${CRM.sort==='recent'?' selected':''}>최근 연락순</option>
        <option value="cb"${CRM.sort==='cb'?' selected':''}>콜백 임박순</option>
        <option value="name"${CRM.sort==='name'?' selected':''}>이름순</option>
      </select>
    </div>
    <div id="crm-db-results">${renderDbResults()}</div>
  `;
}

/* 고객 한 줄 */
function rowHtml(c){
  const cb=cbInfo(c);
  const gradeTag = c.grade ? `<span class="crm-grade" style="background:${GRADE_COLOR[c.grade]}33;color:${GRADE_COLOR[c.grade]}">${c.grade}</span>` : '';
  return `
    <div class="crm-row" data-ph="${c.phoneD}">
      <div class="crm-av" style="background:${avColor(c.name||c.phoneD)}">${esc(initials(c))}</div>
      <div class="crm-row-main">
        <div class="crm-row-top">
          <span class="crm-row-name">${esc(dispName(c))}</span>
          ${gradeTag}
          <span class="crm-badge" style="background:${STATUS_COLOR[c.status]}2e;color:${STATUS_COLOR[c.status]}">${esc(c.status)}</span>
          ${cb.key!=='none'&&cb.key!=='soon' ? `<span class="crm-cb crm-cb-${cb.key}">${cb.icon} ${esc(cb.label)}</span>` : (cb.key==='soon'?`<span class="crm-cb crm-cb-soon">${cb.icon} ${esc(cb.label)}</span>`:'')}
        </div>
        <div class="crm-row-sub">${c.name?`<span class="crm-row-ph">${esc(c.phone)}</span> · `:''}메모 ${c.count}건${c.last?` · 최근 ${fmtMD(new Date(c.last).toISOString())}`:''}</div>
      </div>
      <button class="crm-row-dial" data-dial="${c.phoneD}" title="전화 걸기">📞</button>
      <button class="crm-row-del" data-del="${c.phoneD}" title="고객 삭제 (이 번호 메모 전체 삭제)">🗑</button>
    </div>`;
}

/* ============================================================
   상세 패널 (선택된 고객)
   ============================================================ */
function renderDetail(){
  const panel=document.getElementById('crm-detail'); if(!panel) return;
  if(!CRM.sel){ panel.className='crm-detail'; panel.innerHTML=''; return; }
  const c = buildCustomers().find(x=>x.phoneD===CRM.sel);
  if(!c){ panel.className='crm-detail'; panel.innerHTML=''; CRM.sel=null; return; }
  panel.className='crm-detail open';
  const dd=daysDiff(c.nextCall);
  panel.innerHTML = `
    <div class="crm-d-head">
      <div class="crm-av lg" style="background:${avColor(c.name||c.phoneD)}">${esc(initials(c))}</div>
      <div class="crm-d-id">
        <input type="text" id="crm-d-name" class="crm-d-name" value="${esc(c.name)}" placeholder="이름 (미입력)">
        <div class="crm-d-phone-row">
          <input type="tel" id="crm-d-phone" class="crm-d-phone-input" value="${esc(c.phone)}" placeholder="전화번호" autocomplete="off">
          <button class="crm-d-phone-save" id="crm-d-phone-save" title="번호 변경 저장">✓ 저장</button>
        </div>
      </div>
      <button class="crm-d-close" id="crm-d-close">✕</button>
    </div>
    <div class="crm-d-actions">
      <button class="crm-d-call" id="crm-d-call">📞 전화 걸기</button>
      <button class="crm-d-del" id="crm-d-del">🗑 고객 삭제</button>
    </div>
    <div class="crm-d-fields">
      <label>상태</label>
      <select id="crm-d-status" class="crm-d-sel">${STATUSES.map(s=>`<option ${c.status===s?'selected':''}>${s}</option>`).join('')}</select>
      <label>등급</label>
      <select id="crm-d-grade" class="crm-d-sel">${GRADES.map(g=>`<option value="${g}" ${c.grade===g?'selected':''}>${g?g+' ('+GRADE_DESC[g]+')':'— 미지정'}</option>`).join('')}</select>
      <label>다음 연락일</label>
      <div class="crm-d-next">
        <input type="date" id="crm-d-next" value="${c.nextCall?String(c.nextCall).slice(0,10):''}">
        ${c.nextCall?`<span class="crm-d-nextlbl">${dd<0?'🔴 '+(-dd)+'일 지남':dd===0?'🟡 오늘':'🟢 '+dd+'일 후'}</span>`:''}
        ${c.nextCall?`<button class="crm-d-clear" id="crm-d-nextclear">지우기</button>`:''}
      </div>
      <div class="crm-d-quick">${[['+1','내일',1],['+3','3일 후',3],['+7','1주 후',7]].map(q=>`<button class="crm-qd" data-qd="${q[2]}">${q[1]}</button>`).join('')}</div>
    </div>
    ${c.crmMemo?`<div style="margin:2px 0 8px;padding:9px 11px;background:rgba(195,154,78,.12);border:1px solid rgba(195,154,78,.35);border-radius:9px;font-size:12.5px;line-height:1.55;color:var(--text-2,#d8d2c8);"><div style="font-size:11px;font-weight:800;color:#c39a4e;margin-bottom:3px;">📇 TM 메모 <span style="font-weight:600;color:var(--text-3,#a29a8f)">· TM 고객관리와 동기화${memoStampText(c)}</span></div>${esc(c.crmMemo).replace(/\n/g,'<br>')}</div>`:''}
    <div class="crm-d-memoadd">
      <textarea id="crm-d-memo" rows="2" placeholder="통화 메모 추가 (저장하면 아래 기록과 통화화면에 함께 남아요)"></textarea>
      <button class="crm-d-memobtn" id="crm-d-memobtn">메모 추가</button>
    </div>
    <div class="crm-d-tl-title">📜 통화·메모 기록 <span class="crm-muted">${c.count}건</span></div>
    <div class="crm-d-tl">
      ${c.notes.map(n=>`
        <div class="crm-tl-item" data-edit-note="${esc(n.id)}" title="클릭해서 이 기록 보기 · 메모 덧붙이기 (기존 내용은 수정·삭제할 수 없습니다)">
          <div class="crm-tl-meta">${n.result?`<span class="crm-tl-res">${esc(n.result)}</span> · `:''}${fmtStamp(n.createdAt)}<span class="crm-tl-edit">📄 열기 · 메모 추가</span></div>
          ${n.content?`<div class="crm-tl-body">${esc(n.content).replace(/\n/g,'<br>')}</div>`:''}
          ${(window.npThumbsHtml && Array.isArray(n.images) && n.images.length) ? window.npThumbsHtml(n.images, {small:true}) : ''}
        </div>`).join('') || '<div class="crm-empty sm">기록이 없어요.</div>'}
    </div>`;
  bindDetail(c);
}

/* ============================================================
   뷰: 캘린더
   ============================================================ */
function renderCalendar(){
  if(!CRM.calCursor){ const d=new Date(); CRM.calCursor={y:d.getFullYear(),m:d.getMonth()}; }
  const {y,m}=CRM.calCursor;
  const cs=buildCustomers();
  // 날짜별 집계: 메모 작성 수 / 다음연락일 수
  const memoByDay={}, cbByDay={};
  notesAll().forEach(n=>{ const d=new Date(n.createdAt); if(d.getFullYear()===y&&d.getMonth()===m){ const k=pad(d.getDate()); memoByDay[k]=(memoByDay[k]||0)+1; } });
  cs.forEach(c=>{ if(!c.nextCall) return; const d=new Date(String(c.nextCall).slice(0,10)); if(d.getFullYear()===y&&d.getMonth()===m){ const k=pad(d.getDate()); (cbByDay[k]=cbByDay[k]||[]).push(c); } });
  const first=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate();
  const monthLabel=`${y}년 ${m+1}월`;
  let cells='';
  for(let i=0;i<first;i++) cells+='<div class="crm-cal-cell empty"></div>';
  const todayK = (new Date().getFullYear()===y && new Date().getMonth()===m) ? pad(new Date().getDate()) : '';
  for(let d=1;d<=days;d++){
    const k=pad(d); const dateStr=`${y}-${pad(m+1)}-${k}`;
    const mc=memoByDay[k]||0, cc=(cbByDay[k]||[]).length, pm=(CRM.calMemo[dateStr]||[]).length;
    const sel = CRM.calSel===dateStr ? ' sel':'';
    cells+=`<div class="crm-cal-cell${sel}${k===todayK?' today':''}" data-cald="${dateStr}">
      <span class="crm-cal-d">${d}</span>
      <span class="crm-cal-tags">${mc?`<span class="crm-cal-tag memo">📝${mc}</span>`:''}${cc?`<span class="crm-cal-tag cb">🔔${cc}</span>`:''}${pm?`<span class="crm-cal-tag pm">●</span>`:''}</span>
    </div>`;
  }
  // 선택일 상세
  let detail='';
  if(CRM.calSel){
    const ds=CRM.calSel;
    const memos=notesAll().filter(n=>String(n.createdAt).slice(0,10)===ds).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    const cbs=(cbByDay[ds.slice(8,10)]||[]).filter(c=>String(c.nextCall).slice(0,10)===ds);
    const pmList=CRM.calMemo[ds]||[];
    const dlabel=(()=>{ const d=new Date(ds); const w=['일','월','화','수','목','금','토'][d.getDay()]; return `${d.getMonth()+1}월 ${d.getDate()}일 (${w})`; })();
    detail=`
      <div class="crm-cal-detail">
        <div class="crm-cal-dtitle">${dlabel}</div>
        ${cbs.length?`<div class="crm-cal-grp">🔔 이 날 연락 예정</div><div class="crm-list sm">${cbs.map(rowHtml).join('')}</div>`:''}
        ${memos.length?`<div class="crm-cal-grp">📝 이 날 작성한 메모</div>${memos.map(n=>`<div class="crm-cal-memo" data-noteph="${digits(nPhone(n))}"><b>${esc(nName(n)||nPhone(n)||'메모')}</b> · ${fmtStamp(n.createdAt)}<div class="crm-cal-memo-c">${esc((n.content||'').split('\n').filter(Boolean).join(' · ')).slice(0,90)}</div></div>`).join('')}`:''}
        ${(!cbs.length&&!memos.length)?'<div class="crm-empty sm">이 날엔 메모·예정이 없어요.</div>':''}
        <div class="crm-cal-grp">🗒️ 개인 메모/일정</div>
        <div class="crm-cal-pm">
          <div class="crm-cal-pm-add"><input type="text" id="crm-cal-pm-input" placeholder="이 날짜에 메모/일정 추가"><button id="crm-cal-pm-add">추가</button></div>
          ${pmList.length?pmList.map((x,i)=>`<div class="crm-cal-pm-item"><span>${esc(x)}</span><button class="crm-cal-pm-del" data-pmdel="${i}">✕</button></div>`).join(''):'<div class="crm-empty sm">개인 메모가 없어요.</div>'}
        </div>
      </div>`;
  }
  return `
    <div class="crm-cal-head">
      <button class="crm-cal-nav" data-calmove="-1">‹</button>
      <span class="crm-cal-month">${monthLabel}</span>
      <button class="crm-cal-nav" data-calmove="1">›</button>
      <span class="crm-cal-legend">📝 메모 · 🔔 연락예정 · ● 개인메모</span>
    </div>
    <div class="crm-cal-grid">
      ${['일','월','화','수','목','금','토'].map(w=>`<div class="crm-cal-dow">${w}</div>`).join('')}
      ${cells}
    </div>
    ${detail}`;
}

/* ============================================================
   뷰: 현황 (KPI)
   ============================================================ */
function renderStats(){
  const cs=buildCustomers();
  const n=cs.length||1;
  const byStatus={}; STATUSES.forEach(s=>byStatus[s]=0);
  const byGrade={A:0,B:0,C:0,D:0,'':0};
  cs.forEach(c=>{ byStatus[c.status]=(byStatus[c.status]||0)+1; byGrade[c.grade]=(byGrade[c.grade]||0)+1; });
  const contacted=cs.length;
  const hot=cs.filter(c=>HOT.includes(c.status)).length;
  const visited=cs.filter(c=>['방문완료','계약'].includes(c.status)).length;
  const contract=byStatus['계약']||0;
  const rate=(a,b)=> b? Math.round(a/b*100):0;
  const funnel=[
    ['전체 고객', contacted, '#6b93c4'],
    ['가망 이상', hot, '#cf9d52'],
    ['방문/계약', visited, '#5a9d6b'],
    ['계약', contract, '#3ec46d']
  ];
  const maxS=Math.max(1,...STATUSES.map(s=>byStatus[s]));
  // ☎️ 콜 품질 KPI — 결과가 있는 통화기록(notes) 기준. 연결 = 결과가 '부재'가 아닌 로그.
  const resultLogs = notesAll().filter(nt=>nt.result);
  const totalCalls = resultLogs.length;
  const connectedCalls = resultLogs.filter(nt=>nt.result!=='부재').length;
  const apptCalls = resultLogs.filter(nt=>nt.result==='방문예약').length;
  const connRate = rate(connectedCalls, totalCalls);
  const apptRate = rate(apptCalls, connectedCalls);
  return `
    <div class="crm-tiles">
      <div class="crm-tile" style="--tc:#6b93c4"><div class="crm-tile-n">${contacted}</div><div class="crm-tile-l">전체 고객</div></div>
      <div class="crm-tile" style="--tc:#cf9d52"><div class="crm-tile-n">${hot}</div><div class="crm-tile-l">가망 이상</div></div>
      <div class="crm-tile" style="--tc:#5a9d6b"><div class="crm-tile-n">${rate(hot,contacted)}%</div><div class="crm-tile-l">가망 전환율</div></div>
      <div class="crm-tile" style="--tc:#3ec46d"><div class="crm-tile-n">${contract}</div><div class="crm-tile-l">계약</div></div>
      <div class="crm-tile crm-tile-kpi" style="--tc:#5b8a8c" title="연결률 = 연결콜 ÷ 전체콜"><div class="crm-tile-n">${connRate}%</div><div class="crm-tile-l">연결률</div><div class="crm-tile-kpi-desc">${connectedCalls}/${totalCalls}콜</div></div>
      <div class="crm-tile crm-tile-kpi" style="--tc:#9b7cc4" title="예약전환율 = 방문예약 ÷ 연결콜"><div class="crm-tile-n">${apptRate}%</div><div class="crm-tile-l">예약전환율</div><div class="crm-tile-kpi-desc">${apptCalls}/${connectedCalls}콜</div></div>
    </div>
    <div class="crm-sec-title">🔻 전환 퍼널</div>
    <div class="crm-funnel">
      ${funnel.map((f,i)=>`<div class="crm-fn-row"><span class="crm-fn-l">${f[0]}</span><div class="crm-fn-bar"><div class="crm-fn-fill" style="width:${rate(f[1],contacted)}%;background:${f[2]}"></div></div><span class="crm-fn-v">${f[1]}명 · ${rate(f[1],contacted)}%</span></div>`).join('')}
    </div>
    <div class="crm-sec-title" style="margin-top:18px">📊 상태 분포</div>
    <div class="crm-dist">
      ${STATUSES.map(s=>byStatus[s]?`<div class="crm-dist-row"><span class="crm-dist-l"><span class="crm-dot" style="background:${STATUS_COLOR[s]}"></span>${s}</span><div class="crm-dist-bar"><div style="width:${byStatus[s]/maxS*100}%;background:${STATUS_COLOR[s]}"></div></div><span class="crm-dist-v">${byStatus[s]}</span></div>`:'').join('')}
    </div>
    <div class="crm-sec-title" style="margin-top:18px">⭐ 등급 분포</div>
    <div class="crm-dist">
      ${['A','B','C','D'].map(g=>byGrade[g]?`<div class="crm-dist-row"><span class="crm-dist-l"><span class="crm-grade" style="background:${GRADE_COLOR[g]}33;color:${GRADE_COLOR[g]}">${g}</span>${GRADE_DESC[g]}</span><div class="crm-dist-bar"><div style="width:${byGrade[g]/n*100}%;background:${GRADE_COLOR[g]}"></div></div><span class="crm-dist-v">${byGrade[g]}</span></div>`:'').join('')||'<div class="crm-empty sm">등급을 지정한 고객이 없어요.</div>'}
    </div>`;
}

/* ============================================================
   이벤트 바인딩
   ============================================================ */
/* 고객 행 클릭 바인딩 (검색 부분갱신 후에도 재바인딩) */
function bindDbRows(scope){
  (scope||document).querySelectorAll('.crm-row').forEach(r=>r.addEventListener('click',e=>{
    if(e.target.closest('[data-del]')){ e.stopPropagation(); const ph=e.target.closest('[data-del]').dataset.del; const c=buildCustomers().find(x=>x.phoneD===ph); if(c) CRM.deleteCustomer(c); return; }
    if(e.target.closest('[data-dial]')){ e.stopPropagation(); const ph=e.target.closest('[data-dial]').dataset.dial; const c=buildCustomers().find(x=>x.phoneD===ph); if(c) CRM.dial(c); return; }
    CRM.sel=r.dataset.ph; renderDetail();
  }));
}
function bindBody(){
  const body=document.getElementById('crm-body'); if(!body) return;
  // 고객 행 클릭 → 상세
  bindDbRows(body);
  // 타일 → 탭 이동
  body.querySelectorAll('[data-goto]').forEach(t=>t.addEventListener('click',()=>CRM.go(t.dataset.goto)));
  // DB 검색/정렬/필터 — 목록(결과)만 갱신해 검색창·드롭다운 DOM 보존(한글 조합 유지)
  const updateResults=()=>{ const r=document.getElementById('crm-db-results'); if(r){ r.innerHTML=renderDbResults(); bindDbRows(r); } };
  const s=document.getElementById('crm-search');
  if(s) s.addEventListener('input',()=>{ CRM.search=s.value; updateResults(); });
  const so=document.getElementById('crm-sort');
  if(so) so.addEventListener('change',()=>{ CRM.sort=so.value; updateResults(); });
  const sp=document.getElementById('crm-special');
  if(sp) sp.addEventListener('change',()=>{ CRM.specialFilter=sp.value; updateResults(); });
  const stf=document.getElementById('crm-statusf');
  if(stf) stf.addEventListener('change',()=>{ CRM.statusFilter=stf.value; updateResults(); });
  const addBtn=document.getElementById('crm-add-customer');
  if(addBtn) addBtn.onclick=()=>openAddCustomerModal();
  // 🔔 오늘 탭 — 놓친·오늘 콜백 고객을 발신목록에 올리기 (다이얼러가 dialer:queue-add 를 받아 처리)
  const queueBtn=document.getElementById('crm-queue-due');
  if(queueBtn) queueBtn.onclick=()=>{
    const items = dueCustomers().map(c=>({ number:c.phone, name:c.name||'' }));
    if(!items.length) return;
    document.dispatchEvent(new CustomEvent('dialer:queue-add', { detail:{ items } }));
  };
  // 캘린더
  body.querySelectorAll('[data-calmove]').forEach(b=>b.addEventListener('click',()=>{
    const dir=+b.dataset.calmove; let {y,m}=CRM.calCursor; m+=dir; if(m<0){m=11;y--;} if(m>11){m=0;y++;} CRM.calCursor={y,m}; CRM.render();
  }));
  body.querySelectorAll('[data-cald]').forEach(c=>c.addEventListener('click',()=>{ CRM.calSel = (CRM.calSel===c.dataset.cald)?null:c.dataset.cald; CRM.render(); }));
  body.querySelectorAll('[data-noteph]').forEach(el=>el.addEventListener('click',()=>{ const ph=el.dataset.noteph; if(ph){ CRM.sel=ph; renderDetail(); } }));
  // 캘린더 개인 메모
  const pmAdd=document.getElementById('crm-cal-pm-add');
  if(pmAdd) pmAdd.addEventListener('click',async()=>{ const inp=document.getElementById('crm-cal-pm-input'); const v=(inp.value||'').trim(); if(!v||!CRM.calSel) return; (CRM.calMemo[CRM.calSel]=CRM.calMemo[CRM.calSel]||[]).push(v); await CRM.saveCal(); CRM.render(); });
  const pmInput=document.getElementById('crm-cal-pm-input');
  if(pmInput) pmInput.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('crm-cal-pm-add').click(); } });
  body.querySelectorAll('[data-pmdel]').forEach(b=>b.addEventListener('click',async()=>{ const i=+b.dataset.pmdel; if(CRM.calMemo[CRM.calSel]){ CRM.calMemo[CRM.calSel].splice(i,1); if(!CRM.calMemo[CRM.calSel].length) delete CRM.calMemo[CRM.calSel]; await CRM.saveCal(); CRM.render(); } }));
}

function bindDetail(c){
  const close=document.getElementById('crm-d-close'); if(close) close.onclick=()=>{ CRM.sel=null; renderDetail(); };
  const call=document.getElementById('crm-d-call'); if(call) call.onclick=()=>CRM.dial(c);
  const del=document.getElementById('crm-d-del'); if(del) del.onclick=()=>CRM.deleteCustomer(c);
  const nm=document.getElementById('crm-d-name'); if(nm) nm.addEventListener('change',async()=>{ await CRM.setMeta(c.phoneD,{name:nm.value.trim()}); CRM.render(); });
  const ph=document.getElementById('crm-d-phone'); const phSave=document.getElementById('crm-d-phone-save');
  const doPhoneSave=()=>{ if(ph) CRM.changePhone(c, ph.value); };
  if(phSave) phSave.onclick=doPhoneSave;
  if(ph) ph.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); doPhoneSave(); } });
  const st=document.getElementById('crm-d-status'); if(st) st.addEventListener('change',async()=>{ await CRM.setMeta(c.phoneD,{status:st.value}); CRM.render(); });
  const gr=document.getElementById('crm-d-grade'); if(gr) gr.addEventListener('change',async()=>{ await CRM.setMeta(c.phoneD,{grade:gr.value}); CRM.render(); });
  const nx=document.getElementById('crm-d-next'); if(nx) nx.addEventListener('change',async()=>{ await CRM.setMeta(c.phoneD,{nextCall:nx.value}); CRM.render(); });
  const nxc=document.getElementById('crm-d-nextclear'); if(nxc) nxc.onclick=async()=>{ await CRM.setMeta(c.phoneD,{nextCall:''}); CRM.render(); };
  document.querySelectorAll('[data-qd]').forEach(b=>b.addEventListener('click',async()=>{ const d=new Date(); d.setDate(d.getDate()+(+b.dataset.qd)); const v=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; await CRM.setMeta(c.phoneD,{nextCall:v}); CRM.render(); }));
  const memoTa=document.getElementById('crm-d-memo');
  if(memoTa && window.npEnableImageAttach){ try{ window.npEnableImageAttach(memoTa); }catch(e){} }
  const mb=document.getElementById('crm-d-memobtn'); if(mb) mb.onclick=()=>{ const imgs = (window.npTakePending? window.npTakePending(memoTa): []); CRM.addNote(c, memoTa? memoTa.value : '', imgs); };
  // 📜 통화·메모 기록 항목 클릭 → 그 메모를 바로 편집 (저장하면 상세가 새로고침됨)
  document.querySelectorAll('[data-edit-note]').forEach(el=>el.addEventListener('click',()=>{
    const id=el.dataset.editNote;
    if(window.openNoteViewer) window.openNoteViewer(id, ()=>{ try{ CRM.render(); }catch(e){} });
  }));
}

/* ============================================================
   🔔 FAB 콜백 배지 — 놓친+오늘 콜백(비보관) 고객 수를 #crm-open-btn 위에 표시(0이면 숨김)
   ============================================================ */
async function updateFabBadge(){
  const btn=document.getElementById('crm-open-btn'); if(!btn) return;
  try{ await CRM.load(); }catch(e){}
  let n=0;
  try{ n = dueCustomers().length; }catch(e){ n=0; }
  let badge=btn.querySelector('.cp-badge');
  if(n>0){
    if(!badge){ badge=document.createElement('span'); badge.className='cp-badge'; btn.appendChild(badge); }
    badge.textContent = n>99 ? '99+' : String(n);
  } else if(badge){
    badge.remove();
  }
}

/* ============================================================
   진입점 — 헤더 [관리] 버튼 연결
   ============================================================ */
function wire(){
  const btn=document.getElementById('crm-open-btn');
  if(btn) btn.addEventListener('click',()=>{
    const open = window.__layout && window.__layout.isCrmOpen && window.__layout.isCrmOpen();
    if(open) CRM.close(); else CRM.open();
  });
  // 🔄 메모 데이터가 (늦게) 로드되거나 바뀌면, 콜관리가 열려있을 때 자동으로 다시 그린다.
  //    renderer.js가 state.notes 로드 직후 쏘는 'notes:changed' 신호를 듣는다.
  //    어느 쪽(메모 로드 vs CRM 첫 렌더)이 먼저 끝나든 항상 최신 고객 수로 수렴.
  document.addEventListener('notes:changed', () => {
    const open = window.__layout && window.__layout.isCrmOpen && window.__layout.isCrmOpen();
    if (CRM.loaded && open) { try { CRM.render(); } catch (e) {} }
    updateFabBadge();   // 콜관리가 닫혀있어도 배지는 항상 최신 유지
  });
  updateFabBadge();                        // 초기 로드
  setInterval(updateFabBadge, 60000);      // 60초마다 갱신(날짜가 바뀌며 놓침/오늘 상태가 바뀌는 것 포함)
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire);
else wire();

})();
