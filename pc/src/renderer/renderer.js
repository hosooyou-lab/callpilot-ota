// 🩹 [포커스 버그 픽스] 네이티브 confirm/alert/prompt 는 Windows에서 키보드 포커스를 물고 놓지 않는다.
//    (다이얼로그를 닫아도 다른 창을 갔다와야 타이핑이 됨) → 호출 직후 창 포커스를 강제로 되찾아 자동 해결.
//    흩어진 confirm 호출부는 그대로 두고, 여기서 한 번만 감싸서 전부 커버한다.
(function () {
  const _confirm = window.confirm.bind(window);
  const _alert   = window.alert.bind(window);
  const _prompt  = window.prompt.bind(window);
  function reclaimFocus() {
    const prev = document.activeElement;   // 다이얼로그 뜨기 전 커서가 있던 입력칸
    try { window.api && window.api.window && window.api.window.refocus && window.api.window.refocus(); } catch (e) {}
    // OS 포커스가 돌아온 뒤(살짝 늦게), 쓰던 입력칸으로 커서를 다시 꽂아 바로 타이핑되게
    setTimeout(function () {
      try {
        if (prev && prev !== document.body && typeof prev.focus === 'function') prev.focus();
        else if (window.focus) window.focus();
      } catch (e) {}
    }, 70);
  }
  window.confirm = function (message) { const r = _confirm(message); reclaimFocus(); return r; };
  window.alert   = function (message) { const r = _alert(message);   reclaimFocus(); return r; };
  window.prompt  = function (message, def) { const r = _prompt(message, def); reclaimFocus(); return r; };
})();

// ============ 공용 오버플로(⋯) 메뉴 ============
// 어디서든 window.cpMenu(anchorEl, items)로 작은 드롭다운 메뉴를 띄운다.
// items: [{label, icon, danger, disabled, onClick}] 또는 {sep:true}
(function () {
  let openMenuEl = null, openBackdrop = null;
  function closeMenu() {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
    if (openBackdrop) { openBackdrop.remove(); openBackdrop = null; }
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
  window.cpMenu = function (anchorEl, items) {
    closeMenu();
    const bd = document.createElement('div');
    bd.className = 'cp-menu-backdrop';
    bd.addEventListener('mousedown', closeMenu);
    document.body.appendChild(bd);
    const menu = document.createElement('div');
    menu.className = 'cp-menu';
    items.forEach(it => {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'cp-menu-sep';
        menu.appendChild(s);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      if (it.danger) b.classList.add('danger');
      if (it.disabled) b.disabled = true;
      b.innerHTML = (it.icon ? '<span class="cp-menu-ico">' + it.icon + '</span>' : '') + '<span>' + it.label + '</span>';
      b.addEventListener('click', () => { closeMenu(); try { it.onClick && it.onClick(); } catch (e) { console.error(e); } });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    // 앵커 아래 정렬 + 화면 밖으로 안 나가게 보정
    const r = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = Math.min(r.left, window.innerWidth - mw - 8);
    let y = r.bottom + 6;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = y + 'px';
    document.addEventListener('keydown', onKey, true);
    openMenuEl = menu; openBackdrop = bd;
  };
  window.cpMenuClose = closeMenu;
})();

// ============ 상태 ============
let state = {
  cards: [], callLogs: [], notes: [],
  quickKeywords: [], quickKeywordsEditing: false, editingQuickKeywordId: null, qkFilter: '',
  selectedPreviewCardId: null,  // ← 빠른대응 추가 시 사용자가 선택한 카드 ID
  nextEditing: false,
  currentCardId: null, currentCategory: 'all', searchQuery: '',
  isEditing: false, alwaysOnTop: false,
  navHistory: [], navIndex: -1,
  panelVisibility: { qk: true, np: true, next: true },   // 📌 panel 표시 상태 (탭처럼)
  noteTemplates: [], npTemplatesEditing: false,   // 📝 메모 양식
  noteSearch: '', noteSort: 'new', noteFilterCurrent: false,   // 🔎 메모 목록 검색/정렬/현재고객 필터
  customCategories: [], pendingNewCardId: null,   // 🏷️ 사용자 카테고리 / 미저장 새 카드 추적
  pendingPrevCardId: null,   // 새 카드 만들기 직전에 보던 카드 — 취소 시 복귀용 (시작 카드는 navHistory에 없어서 이력만으론 못 돌아감)
  startupCardId: null   // 🏠 앱 시작 시 먼저 띄울 스크립트 카드 ID (사용자 지정)
};

const CAT_LABELS = { opening:'오프닝', objection:'반론처리', closing:'클로징', info:'정보·세금' };

// ============ 🏷️ 카테고리 (기본 4종 + 사용자 추가) ============
const BUILTIN_CATS = [
  { id:'opening',   label:'오프닝',    color:'#4a9eff' },
  { id:'objection', label:'반론처리',  color:'#f5a623' },
  { id:'closing',   label:'클로징',    color:'#50c878' },
  { id:'info',      label:'정보·세금', color:'#9b8cff' }
];
const CAT_PALETTE = ['#e07a5f','#5b8a8c','#d4a574','#8a7cc4','#c4859b','#7c9e6b','#cf6b5c','#6b93c4'];
let __newCatColor = CAT_PALETTE[0];
function allCategories(){ return BUILTIN_CATS.concat(state.customCategories || []); }
function isBuiltinCat(id){ return BUILTIN_CATS.some(x => x.id === id); }
function catLabelOf(id){ const c = allCategories().find(x => x.id === id); return c ? c.label : id; }
function catColorOf(id){ const c = allCategories().find(x => x.id === id); return c ? c.color : '#888'; }

// 편집 폼의 카테고리 드롭다운을 (기본+커스텀+새로만들기) 로 다시 채움
function refreshCategorySelect(selectedId){
  const sel = document.getElementById('edit-category');
  if (!sel) return;
  const want = selectedId || sel.value || (allCategories()[0] && allCategories()[0].id) || 'objection';
  sel.innerHTML = allCategories().map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('')
    + '<option value="__new__">＋ 새 카테고리 만들기…</option>';
  sel.value = allCategories().some(c => c.id === want) ? want : (allCategories()[0] ? allCategories()[0].id : 'objection');
}

// 사이드바에 커스텀 카테고리 필터 버튼 렌더 (기본 버튼 아래)
function renderCategoryFilters(){
  const host = document.getElementById('custom-cat-filters');
  if (!host) return;
  const customs = state.customCategories || [];
  host.innerHTML = customs.map(c =>
    `<button class="filter-btn" data-category="${c.id}"><span class="cat-dot" style="background:${c.color}"></span>${escapeHtml(c.label)}<button class="cat-del" data-catdel="${c.id}" title="카테고리 삭제">✕</button></button>`
  ).join('');
  host.querySelectorAll('.filter-btn').forEach(b => b.addEventListener('click', (e) => {
    if (e.target.classList.contains('cat-del')) { e.stopPropagation(); deleteCustomCategory(e.target.dataset.catdel); return; }
    document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.currentCategory = b.dataset.category;
    renderCardList();
  }));
}

async function createCustomCategory(name){
  const label = (name || '').trim();
  if (!label){ showToast('카테고리 이름을 입력하세요'); return; }
  if (allCategories().some(c => c.label === label)){ showToast('이미 있는 카테고리예요'); return; }
  const cat = { id:'cat-'+Date.now(), label, color: __newCatColor || CAT_PALETTE[0] };
  state.customCategories = (state.customCategories || []).concat(cat);
  await window.api.store.set('customCategories', state.customCategories);
  refreshCategorySelect(cat.id);
  renderCategoryFilters();
  const row = document.getElementById('new-cat-row'); if (row) row.style.display = 'none';
  const nm = document.getElementById('new-cat-name'); if (nm) nm.value = '';
  showToast(`'${label}' 카테고리 추가됨`);
}

async function deleteCustomCategory(id){
  const cat = (state.customCategories || []).find(c => c.id === id);
  if (!cat) return;
  const used = state.cards.filter(c => c.category === id).length;
  if (!confirm(`'${cat.label}' 카테고리를 삭제할까요?` + (used ? `\n이 카테고리의 스크립트 ${used}개는 '반론처리'로 옮겨집니다.` : ''))) return;
  if (used) state.cards.forEach(c => { if (c.category === id) c.category = 'objection'; });
  state.customCategories = state.customCategories.filter(c => c.id !== id);
  if (state.currentCategory === id) state.currentCategory = 'all';
  await window.api.store.set('customCategories', state.customCategories);
  await window.api.store.set('cards', state.cards);
  renderCategoryFilters();
  renderCardList();
  document.querySelectorAll('.filter-btn').forEach(x => x.classList.toggle('active', x.dataset.category === state.currentCategory));
  showToast('카테고리 삭제됨');
}

function openNewCatRow(){
  const row = document.getElementById('new-cat-row');
  const colors = document.getElementById('new-cat-colors');
  if (!row || !colors) return;
  __newCatColor = CAT_PALETTE[0];
  colors.innerHTML = CAT_PALETTE.map((col,i) =>
    `<button type="button" class="cat-swatch${i===0?' sel':''}" data-color="${col}" style="background:${col}"></button>`
  ).join('');
  colors.querySelectorAll('.cat-swatch').forEach(sw => sw.addEventListener('click', () => {
    __newCatColor = sw.dataset.color;
    colors.querySelectorAll('.cat-swatch').forEach(x => x.classList.remove('sel'));
    sw.classList.add('sel');
  }));
  row.style.display = 'flex';
  const nm = document.getElementById('new-cat-name'); if (nm){ nm.value=''; nm.focus(); }
}

function setupCategoryControls(){
  const sel = document.getElementById('edit-category');
  if (sel){
    let prev = sel.value;
    sel.addEventListener('focus', () => { prev = sel.value; });
    sel.addEventListener('change', () => {
      if (sel.value === '__new__'){
        sel.value = (prev && prev !== '__new__') ? prev : (allCategories()[0] ? allCategories()[0].id : 'objection');
        openNewCatRow();
      } else { prev = sel.value; const r = document.getElementById('new-cat-row'); if (r) r.style.display = 'none'; }
    });
  }
  const addBtn = document.getElementById('new-cat-add');
  if (addBtn) addBtn.addEventListener('click', () => createCustomCategory((document.getElementById('new-cat-name')||{}).value));
  const nameInput = document.getElementById('new-cat-name');
  if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); createCustomCategory(nameInput.value); } });
  const cancelBtn = document.getElementById('new-cat-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { const r = document.getElementById('new-cat-row'); if (r) r.style.display = 'none'; });
}

// ============ 📌 퀵메모 상태 (통화 분류) ============
// order = 퀵메모 영역에서 위→아래 정렬 순서
const QUICK_STATUS = {
  yejeong: { label: '통화예정', icon: '📞', color: '#f5a623', order: 1 },
  bujae:   { label: '부재',     icon: '🔕', color: '#9aa0a6', order: 2 },
  wanryo:  { label: '통화완료', icon: '✅', color: '#3ec46d', order: 3 }
};
const QUICK_STATUS_ORDER = ['yejeong', 'bujae', 'wanryo'];
const DEFAULT_QUICK_STATUS = 'yejeong';  // 퀵메모 지정 시 기본 상태
function getQuickStatus(n) {
  return QUICK_STATUS[n && n.status] ? n.status : DEFAULT_QUICK_STATUS;
}

// ============ 검색 인덱스 ============
// 이전에는 SEMANTIC_MAP을 코드에 하드코딩했었으나,
// 카드 tags(키워드)와 따로 놀아서 "tags에서 빼도 검색에 잡힘" 문제가 있었습니다.
// 이제 검색은 100% 카드의 tags + title 기반으로 동작합니다 (단일 진실 소스).
// → tags에 단어를 넣으면 검색됨 / tags에서 빼면 검색 안 됨 / 빠른 대응도 자동 일관

// ============ 글씨 설정 기본값 ============
const DEFAULT_FONT_SETTINGS = {
  memoSize: 18,
  memoWeight: 400,
  qkSize: 14,
  nextSize: 15,
  cardSize: 12.5,
  sidebarSize: 12.5,
  npSize: 14,   // 📝 메모장 글씨 크기
  crmMemoSize: 13,    // 📞 통화 메모 입력칸 (CRM 상세)
  crmRecSize: 12.5    // 📜 통화·메모 기록 (CRM 상세)
  // (제거됨) dialerScale/crmPanelScale/mentScale — 패널 단위 CSS zoom 배율.
  //   '보기 메뉴 → 확대/축소'(창 전체 줌)와 기능이 중복돼 글씨 조정 시 혼란을 일으켜 제거.
  //   화면 전체 크기는 이제 Ctrl +/−/0(보기 메뉴) 한 곳에서만 조절한다.
};

// ============ 빠른 대응 기본 키워드 ============
// label = 버튼 표시 텍스트 / query = 검색창에 자동 입력될 검색어
// 클릭 → 검색창 자동 입력 + 첫 검색 결과 자동 오픈
const DEFAULT_QUICK_KEYWORDS = [
  { id: 'qk-money',        label: '돈 없어요',    query: '돈' },
  { id: 'qk-expensive',    label: '비싸요',       query: '비싸' },
  { id: 'qk-multi',        label: '다주택자',     query: '다주택' },
  { id: 'qk-cheongyak',    label: '청약 준비',    query: '청약' },
  { id: 'qk-how-knew',     label: '어떻게 알고',  query: '어떻게' },
  { id: 'qk-not-interest', label: '관심 없어',    query: '관심없' },
  { id: 'qk-far',          label: '직장 근처',    query: '직장' },
  { id: 'qk-price',        label: '분양가 얼마',  query: '분양가' },
  { id: 'qk-pyung',        label: '몇 평이에요',  query: '몇평' },
  { id: 'qk-tax',          label: '세금 부담',    query: '세금' }
];

// ============ 초기화 ============
async function init() {
  // 검색 하이라이트 + 확장 미리보기 스타일 주입
  if (!document.getElementById('search-preview-style')) {
    const style = document.createElement('style');
    style.id = 'search-preview-style';
    style.textContent = `
      mark.search-highlight {
        background: rgba(201,100,66,.35);
        color: inherit;
        border-radius: 2px;
        padding: 0 1px;
      }
      .card-item-preview--search {
        font-size: 11px;
        line-height: 1.55;
        color: var(--text-muted, #aaa);
        white-space: normal;
        margin-top: 4px;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      /* 빠른대응 추가 — 카드 선택 UI (가로 배치) */
      .qk-preview-cards {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        padding: 6px 8px 8px;
      }
      .qk-preview-item {
        display: flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        transition: background 0.12s, box-shadow 0.12s;
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04);
        padding: 5px 10px;
        user-select: none;
        white-space: nowrap;
      }
      .qk-preview-item:hover {
        background: rgba(255,255,255,0.1);
        border-color: rgba(255,255,255,0.22);
      }
      .qk-preview-item.selected {
        background: rgba(201,100,66,0.25);
        border-color: #c96442;
        box-shadow: 0 0 0 1px #c96442;
      }
      .qk-preview-item.selected .qk-preview-name {
        color: #ffb89a;
        font-weight: 600;
      }
      .qk-preview-hint {
        font-size: 10.5px;
        color: var(--text-muted, #888);
        padding: 2px 8px 4px;
        font-style: italic;
      }
      /* 카드 검색 팝업 — 설명 미리보기 */
      .isp-card-btn {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
      .isp-card-main {
        display: flex;
        align-items: center;
        gap: 5px;
        width: 100%;
      }
      .isp-card-preview {
        font-size: 10.5px;
        color: var(--text-muted, #999);
        line-height: 1.45;
        padding-left: 14px;
        white-space: normal;
        text-align: left;
        opacity: 0.85;
      }
      /* ============ 📝 메모장 패널 ============ */
      .notepad-input {
        flex: 1 1 auto;
        width: 100%;
        min-height: 160px;
        max-height: none;
        resize: vertical;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.10);
        color: var(--text-1, #fff);
        border-radius: 6px;
        padding: 8px 10px;
        font-size: var(--fz-np, 14px);
        font-family: inherit;
        line-height: 1.55;
        box-sizing: border-box;
        transition: border-color 0.12s, background 0.12s;
      }
      .notepad-input:focus {
        outline: none;
        border-color: #c96442;
        background: rgba(255,255,255,0.07);
      }
      .notepad-save-btn {
        flex: 0 0 auto;
        align-self: stretch;
        background: linear-gradient(135deg, #d4a373, #c96442);
        color: #1a1a1a;
        border: none;
        border-radius: 6px;
        padding: 7px 14px;
        font-weight: 700;
        font-size: 12.5px;
        cursor: pointer;
        white-space: nowrap;
        transition: filter 0.12s, transform 0.06s;
      }
      .notepad-save-btn:hover { filter: brightness(1.08); }
      .notepad-save-btn:active { transform: translateY(1px); }
      .notepad-list {
        flex: 1 1 auto;
        min-height: 80px;
        max-height: 35vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-right: 2px;
        margin-top: 2px;
      }
      .notepad-empty {
        text-align: center;
        color: var(--text-muted, #888);
        font-size: 11.5px;
        padding: 18px 8px;
        font-style: italic;
        line-height: 1.65;
      }
      .notepad-item {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        padding: 7px 28px 7px 10px;
        position: relative;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
      }
      .notepad-item:hover {
        background: rgba(255,255,255,0.06);
        border-color: rgba(255,255,255,0.16);
      }
      .notepad-item-content {
        font-size: var(--fz-np, 14px);
        color: var(--text-1, #fff);
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .notepad-item-meta {
        font-size: 10px;
        color: var(--text-muted, #999);
        margin-top: 4px;
        opacity: 0.75;
      }
      .notepad-item-delete {
        position: absolute;
        top: 5px;
        right: 5px;
        width: 18px;
        height: 18px;
        background: transparent;
        border: none;
        color: var(--text-muted, #888);
        cursor: pointer;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        padding: 0;
        opacity: 0.45;
        transition: background 0.12s, opacity 0.12s, color 0.12s;
      }
      .notepad-item:hover .notepad-item-delete { opacity: 1; }
      .notepad-item-delete:hover {
        background: rgba(255,80,80,0.18);
        color: #ff9090;
      }
      /* ============ 📌 퀵메모 (고정) 영역 ============ */
      .np-quick-section {
        flex: 0 0 auto;
        margin-bottom: 6px;
      }
      .np-section-label {
        font-size: 10.5px;
        font-weight: 700;
        color: var(--text-muted, #888);
        letter-spacing: 0.2px;
        margin: 2px 2px 5px;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .np-quick-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      /* 상태별 그룹 */
      .np-quick-group { margin-bottom: 7px; }
      .np-quick-group:last-child { margin-bottom: 0; }
      .np-quick-group-label {
        font-size: 10px;
        font-weight: 700;
        color: var(--qs-color, var(--text-muted, #888));
        letter-spacing: 0.2px;
        margin: 0 2px 4px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .np-quick-group-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--qs-color, #888);
        flex-shrink: 0;
      }
      /* 상태 색이 입혀지는 칩 (--qs-color 인라인으로 주입) */
      .np-quick-chip {
        background: color-mix(in srgb, var(--qs-color, #f5a623) 14%, transparent);
        border: 1px solid color-mix(in srgb, var(--qs-color, #f5a623) 55%, transparent);
        color: var(--text-1, #fff);
        border-radius: 13px;
        padding: 4px 11px 4px 9px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        max-width: 100%;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        position: relative;
        transition: background 0.12s, border-color 0.12s, transform 0.06s;
      }
      .np-quick-chip:hover {
        background: color-mix(in srgb, var(--qs-color, #f5a623) 26%, transparent);
        border-color: color-mix(in srgb, var(--qs-color, #f5a623) 80%, transparent);
      }
      .np-quick-chip:active { transform: translateY(1px); }
      .np-quick-chip-icon { font-size: 11px; flex-shrink: 0; }
      .np-quick-chip-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 180px;
      }
      .np-quick-empty {
        font-size: 10.5px;
        color: var(--text-muted, #777);
        font-style: italic;
        padding: 2px 4px;
      }
      /* 일반 메모 리스트 구분선 + 카운트 */
      .np-normal-label {
        border-top: 1px dashed rgba(255,255,255,0.08);
        padding-top: 8px;
        margin-top: 2px;
      }
      .np-section-count {
        font-weight: 400;
        opacity: 0.7;
        font-size: 10px;
      }
      /* 퀵메모로 지정된 일반 항목 강조 (혹시 둘 다 보일 때 대비) */
      .notepad-item.is-quick {
        border-color: rgba(245, 166, 35, 0.35);
        background: rgba(245, 166, 35, 0.05);
      }
      /* 큰보기 모달 — 📌 퀵메모 토글 버튼 */
      .np-viewer-pin-btn {
        background: transparent;
        border: 1px solid rgba(255,255,255,0.16);
        color: var(--text-muted, #aaa);
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      .np-viewer-pin-btn:hover {
        background: rgba(245,166,35,0.12);
        border-color: rgba(245,166,35,0.4);
        color: var(--text-1, #fff);
      }
      .np-viewer-pin-btn.active {
        background: rgba(245,166,35,0.22);
        border-color: rgba(245,166,35,0.6);
        color: #ffd699;
      }
      /* ============ 📞 퀵메모 통화 상태 선택 행 ============ */
      .np-viewer-status-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 18px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.02);
      }
      .np-viewer-status-label {
        font-size: 11px;
        font-weight: 700;
        color: var(--text-muted, #999);
        flex-shrink: 0;
      }
      .np-status-btns { display: flex; gap: 6px; flex-wrap: wrap; }
      .np-status-btn {
        background: transparent;
        border: 1px solid color-mix(in srgb, var(--qs-color, #888) 40%, transparent);
        color: var(--text-2, #ccc);
        border-radius: 7px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      .np-status-btn:hover {
        background: color-mix(in srgb, var(--qs-color, #888) 14%, transparent);
        border-color: color-mix(in srgb, var(--qs-color, #888) 60%, transparent);
      }
      .np-status-btn.active {
        background: color-mix(in srgb, var(--qs-color, #888) 28%, transparent);
        border-color: var(--qs-color, #888);
        color: #fff;
      }
      /* ============ 📝 메모 큰 보기 모달 ============ */
      .np-viewer-modal {
        position: fixed;
        inset: 0;
        background: transparent;          /* 뒤 스크립트가 보이게 */
        pointer-events: none;             /* 배경 클릭/스크롤 통과 */
        z-index: 10000;
        display: flex;
        align-items: center;              /* 세로 중앙 */
        justify-content: flex-end;        /* 가로 오른쪽 → 오른쪽 중앙 배치 (스크립트 안 가림) */
        padding: 24px;
        animation: npFadeIn 0.15s ease-out;
      }
      .np-viewer-modal .np-viewer-content { pointer-events: auto; }   /* 모달 본체만 클릭 받음 */
      .np-viewer-modal .np-viewer-header { cursor: move; user-select: none; }
      @keyframes npFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .np-viewer-content {
        background: #1d1d1d;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 10px;
        max-width: 720px;
        width: 100%;
        max-height: 92vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        box-shadow: 0 24px 60px rgba(0,0,0,0.65);
      }
      .np-viewer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .np-viewer-date {
        font-size: 13px;
        color: var(--text-2, #ddd);
        font-weight: 600;
      }
      .np-viewer-close {
        width: 30px;
        height: 30px;
        background: transparent;
        border: none;
        color: var(--text-muted, #aaa);
        cursor: pointer;
        font-size: 16px;
        border-radius: 5px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .np-viewer-close:hover {
        background: rgba(255,255,255,0.1);
        color: #fff;
      }
      .np-viewer-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 20px 24px;
        font-size: calc(var(--fz-np, 14px) + 2px);
        line-height: 1.75;
        color: var(--text-1, #fff);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .np-viewer-edit-input {
        width: 100%;
        min-height: 260px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.14);
        color: var(--text-1, #fff);
        border-radius: 6px;
        padding: 12px 14px;
        font-size: calc(var(--fz-np, 14px) + 1px);
        font-family: inherit;
        line-height: 1.7;
        box-sizing: border-box;
        resize: none;
      }
      .np-viewer-edit-input:focus {
        outline: none;
        border-color: #c96442;
      }
      /* 📝 메모 편집 모달: 화면을 꽉 채우고 메모칸이 남는 공간을 모두 차지 — 스크롤 없이 전부 보이게 */
      .np-edit-modal .np-viewer-content { height: calc(100vh - 48px); max-height: calc(100vh - 48px); }
      .np-edit-modal .np-viewer-body { display: flex; flex-direction: column; overflow: hidden; }
      .np-edit-modal .np-viewer-edit-input { flex: 1 1 0; min-height: 120px; resize: none; overflow-y: auto; }
      .np-edit-modal .np-img-attach { flex: 0 0 auto; }
      .np-edit-modal .np-templates-row { flex: 0 0 auto; }
      .np-viewer-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid rgba(255,255,255,0.08);
      }
      .np-viewer-footer .np-viewer-actions {
        display: flex;
        gap: 8px;
      }
      .np-viewer-footer button {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.12);
        color: var(--text-1, #fff);
        padding: 7px 14px;
        border-radius: 5px;
        cursor: pointer;
        font-size: 12.5px;
        font-weight: 600;
        transition: background 0.12s, border-color 0.12s, filter 0.12s;
      }
      .np-viewer-footer button:hover {
        background: rgba(255,255,255,0.12);
      }
      .np-viewer-delete-btn {
        color: #ff8080 !important;
      }
      .np-viewer-delete-btn:hover {
        background: rgba(255,80,80,0.18) !important;
        border-color: rgba(255,80,80,0.32) !important;
      }
      .np-viewer-save-btn {
        background: linear-gradient(135deg, #d4a373, #c96442) !important;
        color: #1a1a1a !important;
        border: none !important;
        font-weight: 700 !important;
      }
      .np-viewer-save-btn:hover {
        filter: brightness(1.1);
      }
      /* ============ 📝 메모장 액션 행 (크게 작성 + 저장) ============ */
      .notepad-actions {
        display: flex;
        gap: 6px;
        align-items: stretch;
        flex: 0 0 auto;
      }
      .notepad-expand-btn {
        flex: 0 0 auto;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.14);
        color: var(--text-1, #fff);
        border-radius: 6px;
        padding: 7px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        transition: background 0.12s, border-color 0.12s;
      }
      .notepad-expand-btn:hover {
        background: rgba(255,255,255,0.12);
        border-color: rgba(255,255,255,0.25);
      }
      .notepad-actions .notepad-save-btn {
        flex: 1 1 auto;
        align-self: stretch;
      }
      /* ============ 📝 메모 양식 (템플릿) ============ */
      .np-templates-row {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        padding: 4px 0 4px;
        flex: 0 0 auto;
        align-items: center;
      }
      .np-template-btn {
        background: rgba(125, 211, 192, 0.10);
        border: 1px solid rgba(125, 211, 192, 0.28);
        color: var(--text-1, #fff);
        border-radius: 12px;
        padding: 4px 11px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        position: relative;
        transition: background 0.12s, border-color 0.12s;
      }
      .np-template-btn:hover {
        background: rgba(125, 211, 192, 0.20);
        border-color: rgba(125, 211, 192, 0.45);
      }
      .np-template-btn.editing {
        padding-right: 24px;
        border-style: dashed;
        background: rgba(255, 200, 100, 0.10);
        border-color: rgba(255, 200, 100, 0.30);
      }
      .np-template-btn.editing:hover {
        background: rgba(255, 200, 100, 0.18);
        border-color: rgba(255, 200, 100, 0.45);
      }
      .np-template-del {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        width: 16px;
        height: 16px;
        background: rgba(255, 80, 80, 0.20);
        border: none;
        color: #ff9090;
        border-radius: 50%;
        font-size: 10px;
        cursor: pointer;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      .np-template-del:hover {
        background: rgba(255, 80, 80, 0.45);
        color: #fff;
      }
      .np-template-add-btn {
        background: rgba(255, 255, 255, 0.04);
        border: 1px dashed rgba(255, 255, 255, 0.22);
        color: var(--text-muted, #aaa);
        border-radius: 12px;
        padding: 4px 10px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
      }
      .np-template-add-btn:hover {
        background: rgba(125, 211, 192, 0.12);
        border-color: rgba(125, 211, 192, 0.35);
        color: var(--text-1, #fff);
      }
      .np-template-edit-toggle {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: var(--text-muted, #999);
        border-radius: 4px;
        padding: 3px 9px;
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        margin-left: auto;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      .np-template-edit-toggle:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--text-1, #fff);
      }
      .np-template-edit-toggle.active {
        background: rgba(255, 200, 100, 0.18);
        color: #ffd699;
        border-color: rgba(255, 200, 100, 0.4);
      }
      .np-templates-empty {
        font-size: 11px;
        color: var(--text-muted, #888);
        font-style: italic;
        padding: 2px 4px;
      }
      /* 양식 편집 모달 - 라벨 input */
      .np-tpl-label-input {
        width: 100%;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.14);
        color: var(--text-1, #fff);
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 13.5px;
        font-family: inherit;
        box-sizing: border-box;
        transition: border-color 0.12s;
      }
      .np-tpl-label-input:focus {
        outline: none;
        border-color: #c96442;
      }
    `;
    document.head.appendChild(style);
  }

  let saved = await window.api.store.get('cards');
  if (!saved || saved.length === 0) {
    saved = JSON.parse(JSON.stringify(DEFAULT_CARDS));
    await window.api.store.set('cards', saved);
  } else {
    const defMap = new Map(DEFAULT_CARDS.map(c => [c.id, c]));
    saved.forEach(c => {
      if (!c.next && defMap.has(c.id)) c.next = defMap.get(c.id).next || [];
      if (c.pinned === undefined && defMap.has(c.id)) c.pinned = defMap.get(c.id).pinned || false;
    });
  }
  state.cards = saved;

  // 🔄 next 라벨 일괄 동기화 — 카드 제목과 다른 라벨을 현재 제목으로 전부 맞춤
  {
    const cardMap = new Map(state.cards.map(c => [c.id, c]));
    let fixed = 0;
    state.cards.forEach(c => {
      if (!c.next || c.next.length === 0) return;
      c.next.forEach(n => {
        const target = cardMap.get(n.id);
        if (!target) return;
        if (n.label !== target.title) {
          n.label = target.title;
          fixed++;
        }
      });
    });
    if (fixed > 0) await window.api.store.set('cards', state.cards);
  }

  state.callLogs = (await window.api.store.get('callLogs')) || [];
  state.notes = (await window.api.store.get('notes')) || [];
  // 🗂 콜관리(CRM)에 "메모 데이터 준비됨" 신호. CRM이 이 메모들을 늦게 받아도
  //    '전체 고객 0명'으로 굳지 않고 다시 그리도록 한다. (startup 레이스 컨디션 방지)
  try { document.dispatchEvent(new CustomEvent('notes:changed')); } catch (e) {}
  state.noteTemplates = (await window.api.store.get('noteTemplates')) || [];
  state.noteSort = (await window.api.store.get('noteSort')) || 'new';
  state.noteFilterCurrent = !!(await window.api.store.get('noteFilterCurrent'));
  state.customCategories = (await window.api.store.get('customCategories')) || [];
  const savedVis = await window.api.store.get('panelVisibility');
  if (savedVis && typeof savedVis === 'object') {
    state.panelVisibility = { qk: true, np: true, next: true, ...savedVis };
  }

  // 빠른 대응 키워드 로드 (처음 실행 시 기본값 주입)
  let qk = await window.api.store.get('quickKeywords');
  if (!qk || !Array.isArray(qk)) {
    qk = JSON.parse(JSON.stringify(DEFAULT_QUICK_KEYWORDS));
    await window.api.store.set('quickKeywords', qk);
  }
  state.quickKeywords = qk;

  state.alwaysOnTop = await window.api.window.getAlwaysOnTop();

  // 저장된 본문/하단 분할 비율 복원
  const savedRatio = await window.api.store.get('memoSplitRatio');
  if (typeof savedRatio === 'number' && savedRatio >= 0.15 && savedRatio <= 0.8) {
    applyMemoSplitRatio(savedRatio);
  }

  // 저장된 글씨 설정 복원
  const savedFont = await window.api.store.get('fontSettings');
  applyFontSettings(savedFont && typeof savedFont === 'object' ? savedFont : DEFAULT_FONT_SETTINGS);

  bindEvents();
  setupMemoSplitter();
  renderPinned();
  renderQuickKeywords();
  renderCardList();
  renderCategoryFilters();   // 🏷️ 사이드바 커스텀 카테고리 버튼
  setupCategoryControls();   // 🏷️ 편집 폼의 카테고리 추가/삭제 연결

  // 빠른대응 패널 크기 변경 시 레이아웃 재조정
  const qkPanel = document.getElementById('quick-keywords');
  if (qkPanel && window.ResizeObserver) {
    new ResizeObserver(() => autoAdjustQkLayout()).observe(qkPanel);
  }

  // 🔧 시작 시 하단 패널 명시적 표시 (이전 버그로 inline display:none 남아있을 수 있음)
  const splitter = document.getElementById('memo-splitter');
  const grid = document.getElementById('memo-bottom-grid');
  if (splitter) splitter.style.display = '';
  if (grid) grid.style.display = '';

  window.api.on('hotkey:focus-search', () => {
    document.getElementById('search-input').focus();
    document.getElementById('search-input').select();
  });
  window.api.on('data:imported', () => {
    // 복원 후 전체 재초기화. 예전엔 init()을 다시 불렀는데, 그러면 bindEvents()의
    // addEventListener가 한 번 더 쌓여서 버튼이 두 번씩 동작했음(중복 바인딩).
    // 창을 새로고침해 '단일 바인딩' 상태로 깨끗하게 다시 로드한다.
    try { showToast('데이터를 불러왔습니다 — 새로고침합니다'); } catch (e) {}
    setTimeout(() => { try { window.location.reload(); } catch (e) {} }, 600);
  });

  // 📝 카드 검색 패널 → 메모장으로 변환 + 현재 고객 패널 숨김
  transformSearchToNotepad();

  // 🟢 처음 켜면 시작 화면 스크립트를 바로 표시 — 빈 안내창 대신.
  //    우선순위: 사용자가 지정한 시작 카드 → 없으면 오프닝 카테고리 첫 카드 → 그것도 없으면 첫 카드.
  state.startupCardId = (await window.api.store.get('startupCardId')) || null;
  if (!state.currentCardId) {
    const start =
      (state.startupCardId && state.cards.find(c => c.id === state.startupCardId)) ||
      state.cards.find(c => c.category === 'opening') ||
      state.cards[0];
    if (start) { try { openCard(start.id, false); } catch (e) {} }
  }
}

// ============ 핀 카드 ============
function renderPinned() {
  const el = document.getElementById('pinned-cards');
  const pinned = state.cards.filter(c => c.pinned);
  el.innerHTML = pinned.map(c =>
    `<button class="pinned-card-btn" data-id="${c.id}">${escapeHtml(c.title)}</button>`).join('');
  el.querySelectorAll('.pinned-card-btn').forEach(b =>
    b.addEventListener('click', () => openCard(b.dataset.id)));
}

// ============ 빠른 대응 키워드 패널 ============
const QK_CAT_ORDER = ['opening', 'objection', 'closing', 'info', '_none'];
const QK_CAT_LABEL = { opening: '오프닝', objection: '반론처리', closing: '클로징', info: '정보·세금', _none: '기타' };
const QK_CAT_COLOR = { opening: 'cat-opening', objection: 'cat-objection', closing: 'cat-closing', info: 'cat-info', _none: '' };

function getQkCategory(k) {
  // 🆕 신규 방식: 등록 시 저장한 cardId가 있으면 그 카드의 실제 카테고리를 그대로 사용.
  //    (query 재검색은 같은 검색어에 다른 카테고리 카드가 더 높은 점수로 잡히면
  //     엉뚱한 컬럼으로 가버려서, 새로 추가한 커스텀 카테고리가 빠른대응에 안 뜨는 원인)
  if (k.cardId) {
    const c = state.cards.find(x => x.id === k.cardId);
    if (c) return c.category || '_none';
  }
  // 구버전(cardId 없음): 검색어로 첫 번째 매칭 카드의 카테고리를 찾아 반환
  if (!k.query) return '_none';
  const matched = state.cards
    .map(c => ({ card: c, s: scoreCard(c, k.query) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)[0];
  return matched ? matched.card.category : '_none';
}

// 🆕 빠른대응 컬럼 순서 — 기본 카테고리 → 커스텀 카테고리 → 기타(_none) 순.
//    항목이 있는 카테고리만, allCategories() 순서대로 컬럼 생성 (커스텀도 자동 포함).
function qkOrderedCats(groups) {
  const order = allCategories().map(c => c.id).concat('_none');
  const inOrder = order.filter(cat => groups[cat] && groups[cat].length > 0);
  // allCategories에 없는(삭제됐거나 가져온 데이터의) 카테고리도 누락 없이 뒤에 붙임
  const extras = Object.keys(groups).filter(cat => !order.includes(cat) && groups[cat] && groups[cat].length > 0);
  return inOrder.concat(extras);
}

// 🔎 검색어 하이라이트 (본문 발췌용)
function highlightQk(text, query) {
  const escaped = escapeHtml(text);
  const eq = escapeHtml((query || '').trim());
  if (!eq) return escaped;
  return escaped.replace(
    new RegExp(eq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
    m => `<mark class="search-highlight">${m}</mark>`
  );
}

// 🔎 "키워드로 찾기" — 검색어가 스크립트 본문(내용)에 들어있는 카드를 찾아
//    선택 목록으로 표시한다. searchCardsForQk가 제목·본문·태그·카테고리명까지 폭넓게 검색.
//    excludeCardIds: 이미 빠른대응 버튼으로 노출된 카드는 중복 제거.
function renderQkContentMatches(rawQuery, excludeCardIds) {
  const q = (rawQuery || '').trim();
  if (!q) return '';
  const nq = q.toLowerCase().replace(/\s+/g, '');
  const exclude = excludeCardIds || new Set();

  const matches = searchCardsForQk(q)
    .filter(c => !exclude.has(c.id))
    .slice(0, 12);

  if (matches.length === 0) return '';

  const items = matches.map(c => {
    // 본문에서 검색어가 들어있는 줄을 찾아 발췌 + 하이라이트
    const lines = (c.content || '').split('\n').map(l => l.trim()).filter(Boolean);
    const hitLine = lines.find(l => l.toLowerCase().replace(/\s+/g, '').includes(nq)) || lines[0] || '';
    const raw = hitLine.length > 68 ? hitLine.slice(0, 66) + '…' : hitLine;
    const excerptHtml = raw ? `<span class="qk-content-excerpt">${highlightQk(raw, q)}</span>` : '';
    const catL = catLabelOf(c.category);
    return `
      <button class="qk-list-item qk-content-item" data-qk-card-id="${c.id}" title="${escapeHtml(c.title)} 열기">
        <span class="qk-content-title">${escapeHtml(c.title)}<span class="qk-content-cat">${escapeHtml(catL)}</span></span>
        ${excerptHtml}
      </button>
    `;
  }).join('');

  return `
    <div class="qk-group qk-content-group">
      <div class="qk-group-header">📄 스크립트 본문 검색 · ${matches.length}건</div>
      <div class="qk-group-items">${items}</div>
    </div>
  `;
}

function renderQuickKeywords() {
  const list = document.getElementById('qk-list');
  const panel = document.getElementById('quick-keywords');
  if (!list || !panel) return;

  panel.classList.toggle('editing', state.quickKeywordsEditing);

  if (state.quickKeywords.length === 0) {
    list.innerHTML = '<div class="qk-empty">키워드가 없어요 — 편집(✎) 눌러 추가하세요</div>';
    return;
  }

  const editing  = state.quickKeywordsEditing;
  const editId   = state.editingQuickKeywordId;

  // 🔎 키워드 필터 (일반 모드에서만) — 버튼 이름·검색어·카테고리명 부분일치로 좁혀
  //    관련 버튼만 남기니, 넓게 펼쳐 스크립트를 가리던 문제를 즉시 줄여준다.
  const filter = (!editing && state.qkFilter) ? state.qkFilter.trim().toLowerCase().replace(/\s+/g, '') : '';
  const sourceKws = !filter ? state.quickKeywords : state.quickKeywords.filter(k => {
    const label = (k.label || '').toLowerCase().replace(/\s+/g, '');
    const query = (k.query || '').toLowerCase().replace(/\s+/g, '');
    const catL  = catLabelOf(getQkCategory(k)).toLowerCase().replace(/\s+/g, '');
    return label.includes(filter) || query.includes(filter) || catL.includes(filter);
  });


  // 일반/편집 모드 공통: 카테고리별 세로 그룹화
  const groups = {};
  sourceKws.forEach(k => {
    const cat = getQkCategory(k);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(k);
  });

  const html = qkOrderedCats(groups)
    .map(cat => {
      const dot   = (cat === '_none') ? '' : `<span class="card-item-dot" style="background:${catColorOf(cat)}"></span>`;
      const items = groups[cat].map(k => {
        // (편집 모드 + 현재 인라인 편집 중인 키워드) — 입력 폼 + 미리보기
        if (editing && editId === k.id) {
          return `
            <div class="qk-btn-editing" data-qk-id="${k.id}">
              <input type="text" class="qk-edit-label" data-qk-edit-id="${k.id}"
                     value="${escapeHtml(k.label)}" maxlength="20" placeholder="버튼 이름" />
              <input type="text" class="qk-edit-query" data-qk-edit-id="${k.id}"
                     value="${escapeHtml(k.query)}" maxlength="20" placeholder="검색어" />
              <button class="qk-edit-save"   data-qk-save="${k.id}"   title="저장 (Enter)">✓</button>
              <button class="qk-edit-cancel" data-qk-cancel="${k.id}" title="취소 (Esc)">✕</button>
            </div>
            <div class="qk-preview qk-inline-preview" id="qk-inline-preview-${k.id}"></div>
          `;
        }
        // 편집 모드: 삭제 ×버튼 표시 + 클릭하면 인라인 편집
        if (editing) {
          return `
            <button class="qk-list-item qk-list-item-edit" data-qk-id="${k.id}" title="클릭해서 편집">
              <span class="qk-list-item-name">${escapeHtml(k.label)}</span>
              <span class="qk-list-item-query">${escapeHtml(k.query)}</span>
              <span class="qk-btn-remove" data-qk-remove="${k.id}" title="삭제">×</span>
            </button>
          `;
        }
        // 일반 모드: 클릭하면 검색 트리거
        return `
          <button class="qk-list-item" data-qk-id="${k.id}" data-qk-query="${escapeHtml(k.query)}" data-qk-card-id="${k.cardId || ''}" title="${escapeHtml(k.label)} (검색: ${escapeHtml(k.query)})">
            <span class="qk-list-item-name">${escapeHtml(k.label)}</span>
            <span class="qk-list-item-query">${escapeHtml(k.query)}</span>
          </button>
        `;
      }).join('');
      return `
        <div class="qk-group" data-cat="${cat}">
          <div class="qk-group-header">${dot}${escapeHtml(cat === '_none' ? '기타' : catLabelOf(cat))}</div>
          <div class="qk-group-items" data-cat="${cat}">${items}</div>
        </div>
      `;
    }).join('');

  // 🔎 필터 입력 중(일반 모드)이면 스크립트 본문 검색 결과도 함께 표시.
  //    이미 버튼으로 뜬 카드는 중복 제거.
  let contentHtml = '';
  if (filter) {
    const shownCardIds = new Set(sourceKws.map(k => k.cardId).filter(Boolean));
    contentHtml = renderQkContentMatches(state.qkFilter, shownCardIds);
  }

  if (!html && !contentHtml) {
    list.innerHTML = filter
      ? `<div class="qk-empty">"${escapeHtml(state.qkFilter.trim())}" — 일치하는 키워드·스크립트 없음</div>`
      : '<div class="qk-empty">키워드가 없어요</div>';
    return;
  }

  list.innerHTML = html + contentHtml;

  if (editing) {
    // ---- 편집 모드 이벤트 ----
    list.querySelectorAll('.qk-list-item-edit').forEach(b => {
      b.addEventListener('click', e => {
        if (e.target.classList.contains('qk-btn-remove')) {
          e.stopPropagation();
          removeQuickKeyword(e.target.dataset.qkRemove);
          return;
        }
        startEditQuickKeyword(b.dataset.qkId);
      });
    });
    list.querySelectorAll('.qk-edit-save').forEach(b => b.addEventListener('click', () => saveEditQuickKeyword(b.dataset.qkSave)));
    list.querySelectorAll('.qk-edit-cancel').forEach(b => b.addEventListener('click', () => cancelEditQuickKeyword()));
    list.querySelectorAll('.qk-edit-label, .qk-edit-query').forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveEditQuickKeyword(inp.dataset.qkEditId); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEditQuickKeyword(); }
      });
    });
    list.querySelectorAll('.qk-edit-query').forEach(inp => {
      const previewEl = document.getElementById(`qk-inline-preview-${inp.dataset.qkEditId}`);
      if (previewEl) renderQkPreviewInEl(inp.value, previewEl);
      inp.addEventListener('input', e => { if (previewEl) renderQkPreviewInEl(e.target.value, previewEl); });
    });
    const focusInput = list.querySelector('.qk-edit-label');
    if (focusInput) { focusInput.focus(); focusInput.select(); }

    // 같은 카테고리 그룹 안에서만 드래그 순서 변경
    // (카테고리는 query 매칭으로 동적 결정되므로, 다른 그룹으로의 이동은 무의미)
    if (!editId) {
      list.querySelectorAll('.qk-group-items').forEach(groupEl => {
        const cat        = groupEl.dataset.cat;
        const groupItems = groups[cat];
        makeListDraggable(
          groupEl,
          () => groupItems,
          async newGroupItems => {
            // 전체 quickKeywords에서 이 카테고리가 차지하던 자리들에 newGroupItems를 순서대로 끼움
            const oldIds = new Set(groupItems.map(k => k.id));
            let pos = 0;
            const newOrder = state.quickKeywords.map(k => {
              if (oldIds.has(k.id)) return newGroupItems[pos++];
              return k;
            });
            state.quickKeywords = newOrder;
            await window.api.store.set('quickKeywords', state.quickKeywords);
            renderQuickKeywords();
            showToast('순서 변경됨');
          }
        );
      });
    }
  } else {
    // ---- 일반 모드 이벤트 ----
    list.querySelectorAll('.qk-list-item:not(.qk-content-item)').forEach(b => {
      b.addEventListener('click', () => triggerQuickKeyword(b.dataset.qkQuery, b.dataset.qkCardId || null));
    });
    // 📄 스크립트 본문 검색 결과 — 클릭하면 해당 카드 바로 열기
    list.querySelectorAll('.qk-content-item').forEach(b => {
      b.addEventListener('click', () => { if (b.dataset.qkCardId) openCard(b.dataset.qkCardId); });
    });

    // 아이템 수에 따라 컬럼 수 & 글씨 크기 자동 조정 (일반 모드만)
    autoAdjustQkLayout();
  }
}

function autoAdjustQkLayout() {
  const list = document.getElementById('qk-list');
  const panel = document.getElementById('quick-keywords');
  if (!list || !panel || state.quickKeywordsEditing) return;

  const n = state.quickKeywords.length;

  // 컬럼 배치는 CSS grid(grid-auto-flow:column)가 담당 — 카테고리마다 좌→우로 한 컬럼씩.
  // (예전엔 여기서 list.style.columns로 CSS 다단 수를 지정했으나, 다단은 높이를 맞추려
  //  짧은 카테고리를 앞 컬럼 밑에 끼워넣는 문제가 있어 grid로 교체함)

  // 글씨 크기 자동 조정
  const baseFz = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fz-qk-btn')) || 14;
  let fz = baseFz;
  if (n > 8)  fz = Math.max(10, baseFz - 1);
  if (n > 14) fz = Math.max(10, baseFz - 2);
  if (n > 20) fz = Math.max(10, baseFz - 3);

  list.querySelectorAll('.qk-list-item').forEach(b => { b.style.fontSize = fz + 'px'; });
  list.querySelectorAll('.qk-group-header').forEach(h => { h.style.fontSize = Math.max(9, fz - 2) + 'px'; });

  // 촘촘하게 — 세로 공간을 덜 차지해 스크립트를 덜 가리도록
  list.querySelectorAll('.qk-list-item').forEach(b => { b.style.padding = '3px 8px'; });
}

function startEditQuickKeyword(id) {
  state.editingQuickKeywordId = id;
  renderQuickKeywords();
}

function cancelEditQuickKeyword() {
  state.editingQuickKeywordId = null;
  renderQuickKeywords();
}

async function saveEditQuickKeyword(id) {
  const labelInput = document.querySelector(`.qk-edit-label[data-qk-edit-id="${id}"]`);
  const queryInput = document.querySelector(`.qk-edit-query[data-qk-edit-id="${id}"]`);
  if (!labelInput || !queryInput) return;

  const label = labelInput.value.trim();
  const query = queryInput.value.trim();
  if (!label || !query) {
    showToast('버튼 이름과 검색어 모두 입력하세요');
    return;
  }

  const idx = state.quickKeywords.findIndex(k => k.id === id);
  if (idx === -1) return;
  state.quickKeywords[idx] = { ...state.quickKeywords[idx], label, query };
  await window.api.store.set('quickKeywords', state.quickKeywords);
  state.editingQuickKeywordId = null;
  renderQuickKeywords();
  showToast(`"${label}" 저장됨`);
}

function triggerQuickKeyword(query, cardId) {
  // (1) cardId가 지정된 빠른대응(신규 방식) — 검색창 건드리지 않고 그 카드만 직접 오픈
  if (cardId) {
    const card = state.cards.find(c => c.id === cardId);
    if (card) {
      openCard(cardId);
      return;
    }
    // cardId 있는데 카드 못 찾으면 query 기반 fallback (아래 로직)
  }

  // (2) cardId 없는 빠른대응(구버전) — 검색창은 건드리지 않고 내부적으로만 매칭 계산
  const matched = state.cards
    .map(c => ({ card: c, s: scoreCard(c, query) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (matched.length > 0) {
    openCard(matched[0].card.id);
  } else {
    showToast(`"${query}" 매칭 카드 없음 — 빠른대응을 다시 등록해주세요`);
  }
}

// 현재 검색/필터 조건에 맞는 카드 목록 반환 (renderCardList와 동일 로직)
function getFilteredCards() {
  let cards = state.cards.slice();
  if (state.currentCategory !== 'all') cards = cards.filter(c => c.category === state.currentCategory);
  if (state.searchQuery) {
    cards = cards.map(c => ({card:c, s:scoreCard(c, state.searchQuery)}))
      .filter(x => x.s > 0).sort((a,b) => b.s - a.s).map(x => x.card);
  }
  return cards;
}

function toggleQuickKeywordsEdit() {
  state.quickKeywordsEditing = !state.quickKeywordsEditing;
  if (!state.quickKeywordsEditing) {
    state.editingQuickKeywordId = null;
    const p = document.getElementById('qk-preview');
    if (p) { p.style.display = 'none'; p.innerHTML = ''; }
  }
  const btn = document.getElementById('qk-edit-btn');
  const form = document.getElementById('qk-add-form');
  btn.classList.toggle('active', state.quickKeywordsEditing);
  btn.textContent = state.quickKeywordsEditing ? '완료' : '✎';
  form.style.display = state.quickKeywordsEditing ? 'flex' : 'none';
  renderQuickKeywords();
}

// 🆕 빠른대응 등록용 카드 검색.
//   1순위: 정식 검색(scoreCard — tags/제목 기반).
//   2순위(폴백): 정식 검색이 0건이면 제목·본문·태그·카테고리명 부분일치로 넓게 찾음.
//   → 태그를 아직 안 붙인 새 카드나, 새로 만든 카테고리의 카드도 등록 화면에서 찾히게 함.
function searchCardsForQk(q) {
  const scored = state.cards
    .map(c => ({ card: c, s: scoreCard(c, q) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.card);
  if (scored.length) return scored;

  const nq = q.toLowerCase().replace(/\s+/g, '');
  if (!nq) return [];
  return state.cards.filter(c => {
    const title = (c.title || '').toLowerCase().replace(/\s+/g, '');
    const body  = (c.content || '').toLowerCase().replace(/\s+/g, '');
    const tags  = (c.tags || []).join(' ').toLowerCase().replace(/\s+/g, '');
    const catL  = catLabelOf(c.category).toLowerCase().replace(/\s+/g, '');
    return title.includes(nq) || body.includes(nq) || tags.includes(nq) || catL.includes(nq);
  });
}

function renderQkPreviewInEl(query, el) {
  if (!el) return;
  const q = query.trim();
  if (!q) {
    el.style.display = 'none';
    el.innerHTML = '';
    state.selectedPreviewCardId = null;  // 검색어 비면 선택 초기화
    return;
  }

  const matched = searchCardsForQk(q).slice(0, 8);

  if (matched.length === 0) {
    el.style.display = 'block';
    el.innerHTML = `<div class="qk-preview-empty">❌ "${escapeHtml(q)}" — 매칭 카드 없음</div>`;
    state.selectedPreviewCardId = null;
    return;
  }

  // 선택된 카드가 매칭 결과에 없으면 선택 초기화
  if (state.selectedPreviewCardId && !matched.find(c => c.id === state.selectedPreviewCardId)) {
    state.selectedPreviewCardId = null;
  }
  // 결과가 1개면 자동 선택 (편의)
  if (matched.length === 1 && !state.selectedPreviewCardId) {
    state.selectedPreviewCardId = matched[0].id;
  }

  el.style.display = 'block';
  el.innerHTML =
    `<div class="qk-preview-title">🔍 "${escapeHtml(q)}" — 등록할 카드를 선택하세요</div>` +
    `<div class="qk-preview-cards">` +
    matched.map((c, i) => {
      const isSelected = c.id === state.selectedPreviewCardId;
      const prefix = isSelected ? '✓ ' : '';
      // 커스텀 카테고리도 라벨·색이 제대로 나오도록 allCategories 기반 헬퍼 사용
      return `<div class="qk-preview-item${isSelected ? ' selected' : ''}" data-preview-card-id="${c.id}" data-preview-card-title="${escapeHtml(c.title)}">
        <span class="card-item-dot" style="background:${catColorOf(c.category)}"></span>
        <span class="qk-preview-name">${prefix}${escapeHtml(c.title)}</span>
        <span class="qk-preview-cat">${escapeHtml(catLabelOf(c.category))}</span>
      </div>`;
    }).join('') +
    `</div>`;

  // 카드 항목 클릭 → 선택
  el.querySelectorAll('.qk-preview-item').forEach(item => {
    item.addEventListener('click', () => {
      state.selectedPreviewCardId = item.dataset.previewCardId;
      // 라벨이 비어있으면 카드 제목으로 자동 채우기 (전역 추가 폼인 경우만)
      const labelInput = document.getElementById('qk-add-label');
      if (labelInput && !labelInput.value.trim() && el.id === 'qk-preview') {
        labelInput.value = item.dataset.previewCardTitle;
      }
      renderQkPreviewInEl(q, el);  // 선택 상태 반영해서 다시 그리기
    });
  });
}

function renderQkPreview(query) {
  renderQkPreviewInEl(query, document.getElementById('qk-preview'));
}

async function addQuickKeyword() {
  const labelInput = document.getElementById('qk-add-label');
  const queryInput = document.getElementById('qk-add-query');
  const label = labelInput.value.trim();
  const query = queryInput.value.trim();

  if (!query) {
    showToast('검색어를 입력하세요');
    queryInput.focus();
    return;
  }

  // 매칭 카드가 있는데 선택 안 했으면 → 카드 선택 강제 (폴백 검색 포함)
  const matched = searchCardsForQk(query);

  if (matched.length > 0 && !state.selectedPreviewCardId) {
    showToast('등록할 카드를 리스트에서 클릭해 선택하세요');
    return;
  }

  // 라벨이 비어있으면 선택한 카드 제목으로 자동 채우기
  let finalLabel = label;
  if (!finalLabel && state.selectedPreviewCardId) {
    const c = state.cards.find(x => x.id === state.selectedPreviewCardId);
    if (c) finalLabel = c.title;
  }
  if (!finalLabel) {
    showToast('라벨을 입력하세요');
    labelInput.focus();
    return;
  }

  const newKeyword = {
    id: 'qk-custom-' + Date.now(),
    label: finalLabel,
    query
  };
  // 선택한 카드 ID 저장 → 클릭 시 검색 1번이 아닌 이 카드를 바로 오픈
  if (state.selectedPreviewCardId) {
    newKeyword.cardId = state.selectedPreviewCardId;
  }

  state.quickKeywords.push(newKeyword);
  await window.api.store.set('quickKeywords', state.quickKeywords);

  // 폼 + 선택상태 초기화
  labelInput.value = '';
  queryInput.value = '';
  state.selectedPreviewCardId = null;
  document.getElementById('qk-preview').style.display = 'none';
  document.getElementById('qk-preview').innerHTML = '';

  renderQuickKeywords();
  showToast(`"${finalLabel}" 추가됨`);
  labelInput.focus();
}

async function removeQuickKeyword(id) {
  state.quickKeywords = state.quickKeywords.filter(k => k.id !== id);
  await window.api.store.set('quickKeywords', state.quickKeywords);
  renderQuickKeywords();
}

// ============ 검색 ============
// 검색 우선순위:
//   1) 카드의 tags(키워드)가 단일 진실 소스 — tags 매칭이 없으면 결과에서 제외
//   2) title 매칭은 보조 점수 (사용자가 제목 단어로도 찾을 수 있게)
//   3) content(멘트 본문)는 검색 대상에서 제외 — 본문에 우연히 들어있는 단어로 잡음 방지
// 공백 무시: "몇평" 검색이 "몇 평" tag 매칭, "왜전화" 검색이 "왜 전화" tag 매칭 등
function scoreCard(card, query) {
  if (!query) return 1;
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const hasTagsField = Array.isArray(card.tags) && card.tags.length > 0;
  let score = 0;
  let tagsHitCount = 0;

  tokens.forEach(t => {
    const nt = t.replace(/\s+/g, '');           // 검색어 공백 제거 정규화

    // (1) tags 매칭 — 검색의 단일 진실 소스
    if (hasTagsField) {
      let matched = false;
      card.tags.forEach(tag => {
        if (matched) return;                     // 같은 token이 여러 tag에 잡혀도 1회만 가산
        const tl = tag.toLowerCase();
        const ntag = tl.replace(/\s+/g, '');
        if (ntag === nt)                  { score += 30; matched = true; }   // 정확 일치
        else if (ntag.includes(nt))       { score += 20; matched = true; }   // tag가 검색어 포함
        else if (nt.length >= 2 && ntag.length >= 2 && nt.includes(ntag)) {
                                            score += 10; matched = true;     // 검색어가 tag 포함
        }
      });
      if (matched) tagsHitCount++;
    }

    // (2) title 매칭 — 보조 (공백 무시 부분일치)
    const ntitle = card.title.toLowerCase().replace(/\s+/g, '');
    if (ntitle.includes(nt) && nt.length >= 1) score += 5;
  });

  // tags가 정의된 카드는 tags 매칭 필수
  // → 사용자가 tags에서 키워드를 빼면 즉시 검색·빠른대응에서 빠짐
  if (hasTagsField && tagsHitCount === 0) return 0;

  return score;
}

// ============ 우측 카드 리스트 ============
function renderCardList() {
  const list = document.getElementById('card-list');
  const empty = document.getElementById('empty-state');
  const info = document.getElementById('card-count');

  let cards = state.cards.slice();
  if (state.currentCategory !== 'all') cards = cards.filter(c => c.category === state.currentCategory);

  if (state.searchQuery) {
    cards = cards.map(c => ({card:c, s:scoreCard(c, state.searchQuery)}))
      .filter(x => x.s > 0).sort((a,b) => b.s - a.s).map(x => x.card);
  }

  const catLabel = state.currentCategory === 'all' ? '전체' : catLabelOf(state.currentCategory);
  info.textContent = `${catLabel} · ${cards.length}개${state.searchQuery ? ' · 검색 중' : ''}`;

  if (cards.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  list.style.display = 'flex';
  empty.style.display = 'none';

  const isSearching = !!state.searchQuery;

  list.innerHTML = cards.map(c => {
    const active = c.id === state.currentCardId ? 'active' : '';

    let previewHtml = '';
    if (isSearching) {
      // 검색 중: 본문에서 검색어 주변 3줄 발췌 + 하이라이트
      const q = state.searchQuery.toLowerCase();
      const lines = c.content.split('\n').map(l => l.trim()).filter(Boolean);
      // 검색어가 포함된 줄 우선, 없으면 앞 3줄
      const hitLines = lines.filter(l => l.toLowerCase().includes(q));
      const showLines = (hitLines.length > 0 ? hitLines : lines).slice(0, 3);
      const excerptRaw = showLines.join(' · ');
      const excerpt = excerptRaw.length > 120 ? excerptRaw.slice(0, 118) + '…' : excerptRaw;
      // 검색어 하이라이트
      const escaped = escapeHtml(excerpt);
      const eq = escapeHtml(q);
      const highlighted = eq
        ? escaped.replace(new RegExp(eq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            m => `<mark class="search-highlight">${m}</mark>`)
        : escaped;
      previewHtml = `<div class="card-item-preview card-item-preview--search">${highlighted}</div>`;
    } else {
      // 일반: 첫 줄 1줄 요약
      const first = c.content.split('\n').filter(l => l.trim())[0] || '';
      const ps = first.length > 60 ? first.slice(0, 58) + '…' : first;
      previewHtml = `<div class="card-item-preview">${escapeHtml(ps)}</div>`;
    }

    return `<div class="card-item ${active}" data-id="${c.id}" tabindex="0">
      <div class="card-item-header">
        <span class="card-item-dot cat-${c.category}"${isBuiltinCat(c.category) ? '' : ` style="background:${catColorOf(c.category)}"`}></span>
        <span class="card-item-title">${escapeHtml(c.title)}</span>
        <span class="card-item-actions">
          <button class="card-item-action card-item-edit" data-edit-id="${c.id}" title="수정">✎</button>
          <button class="card-item-action card-item-delete" data-delete-id="${c.id}" title="삭제">🗑</button>
        </span>
      </div>
      ${previewHtml}
    </div>`;
  }).join('');

  list.querySelectorAll('.card-item').forEach(el => {
    el.addEventListener('click', (e) => {
      // 액션 버튼 클릭이면 카드 열지 않음
      if (e.target.classList.contains('card-item-edit')) {
        e.stopPropagation();
        openCardAndEdit(e.target.dataset.editId);
        return;
      }
      if (e.target.classList.contains('card-item-delete')) {
        e.stopPropagation();
        deleteCardById(e.target.dataset.deleteId);
        return;
      }
      openCard(el.dataset.id);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(el.dataset.id); }
    });
  });
}

// 사이드바에서 수정 버튼 → 카드 열고 바로 편집 모드
function openCardAndEdit(id) {
  openCard(id);
  setTimeout(() => enterEdit(), 50);
}

// 사이드바에서 삭제 버튼 → ID로 삭제
// 🆕 카드 삭제 후: 빈 화면 대신 '직전에 보던 카드'로 복귀. (없으면 첫 카드 → 그것도 없으면 빈 화면)
function openAfterDelete(deletedId) {
  // 시작 화면으로 지정된 카드를 삭제하면 지정도 해제
  if (state.startupCardId === deletedId) {
    state.startupCardId = null;
    try { window.api.store.set('startupCardId', null); } catch (e) {}
  }
  state.navHistory = state.navHistory.filter(id => id !== deletedId);
  if (state.navIndex >= state.navHistory.length) state.navIndex = state.navHistory.length - 1;
  let target = null;
  for (let i = state.navHistory.length - 1; i >= 0; i--) {
    if (state.cards.some(c => c.id === state.navHistory[i])) { target = state.navHistory[i]; break; }
  }
  if (!target && state.cards.length) target = state.cards[0].id;
  if (target) {
    openCard(target, false);
  } else {
    state.currentCardId = null;
    document.getElementById('memo-view').style.display = 'none';
    document.getElementById('memo-empty').style.display = 'flex';
    updateNavBtns();
  }
}

async function deleteCardById(id) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;
  if (!confirm(`"${c.title}" 카드를 삭제할까요?`)) return;
  state.cards = state.cards.filter(c => c.id !== id);

  // 🧹 다른 카드의 next 후보에서 이 카드를 참조하는 항목도 함께 제거 (잔여 스튜브 방지)
  let cleanedRefs = 0;
  state.cards.forEach(other => {
    if (!other.next || other.next.length === 0) return;
    const before = other.next.length;
    other.next = other.next.filter(n => n.id !== id);
    cleanedRefs += (before - other.next.length);
  });

  await window.api.store.set('cards', state.cards);
  renderCardList();
  renderPinned();
  // 현재 열려있는 카드를 삭제했으면 → 직전 카드로 복귀 (빈 화면 대신)
  if (state.currentCardId === id) openAfterDelete(id);
  showToast(cleanedRefs > 0
    ? `삭제됐어요 — 다른 카드 후보에서 ${cleanedRefs}개 참조도 정리됨`
    : '삭제됐어요');
}

// ============ 카드 열기 ============
// 📑 저장된 스크립트 카드 전체 목록(카테고리별) — 클릭하면 그 카드로 바로 이동
function openCardListModal() {
  const modal = document.getElementById('card-list-modal');
  if (!modal) return;
  const search = document.getElementById('card-list-search');
  if (search) search.value = '';
  renderCardListModal('');
  modal.style.display = 'flex';
  if (search) setTimeout(() => search.focus(), 30);
}
function closeCardListModal() {
  const modal = document.getElementById('card-list-modal');
  if (modal) modal.style.display = 'none';
}
function renderCardListModal(query) {
  const body = document.getElementById('card-list-body');
  if (!body) return;
  const q = (query || '').trim().toLowerCase();
  let html = '';
  let total = 0;
  allCategories().forEach(cat => {
    let cards = state.cards.filter(c => c.category === cat.id);
    if (q) cards = cards.filter(c =>
      (c.title || '').toLowerCase().includes(q) ||
      (c.content || '').toLowerCase().includes(q) ||
      (Array.isArray(c.tags) ? c.tags.join(' ') : '').toLowerCase().includes(q));
    if (!cards.length) return;
    total += cards.length;
    const color = catColorOf(cat.id);
    html += `<div class="cl-group"><div class="cl-group-h" style="color:${color}">${escapeHtml(cat.label)} <span class="cl-count">${cards.length}</span></div>`;
    cards.forEach(c => {
      const cur = c.id === state.currentCardId ? ' current' : '';
      const preview = (c.content || '').replace(/\s+/g, ' ').trim().slice(0, 46);
      html += `<button class="cl-item${cur}" data-id="${c.id}">` +
        `<span class="cl-dot" style="background:${color}"></span>` +
        `<span class="cl-title">${escapeHtml(c.title || '(제목 없음)')}</span>` +
        `<span class="cl-preview">${escapeHtml(preview)}</span></button>`;
    });
    html += `</div>`;
  });
  if (!total) html = `<div class="cl-empty">${q ? '검색 결과가 없어요.' : '저장된 카드가 없어요.'}</div>`;
  body.innerHTML = html;
  body.querySelectorAll('.cl-item').forEach(b => b.addEventListener('click', () => {
    closeCardListModal();
    openCard(b.dataset.id);
  }));
}

function openCard(id, addHistory = true) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;

  if (addHistory) {
    state.navHistory = state.navHistory.slice(0, state.navIndex + 1);
    state.navHistory.push(id);
    state.navIndex = state.navHistory.length - 1;
  }

  state.currentCardId = id;
  state.isEditing = false;
  state.nextEditing = false; // 카드 전환 시 다음멘트 편집 모드 자동 해제

  document.getElementById('memo-empty').style.display = 'none';
  document.getElementById('memo-view').style.display = 'flex';
  document.getElementById('memo-content').style.display = 'block';
  // 편집 영역도 명시적으로 숨김 (편집 중 다른 카드 클릭 시 안전장치)
  document.getElementById('memo-edit').style.display = 'none';

  // 🔧 하단 패널 강제 복원 — 이전 버그로 inline display:none이 남아있어도 항상 보이도록
  const splitter = document.getElementById('memo-splitter');
  const grid = document.getElementById('memo-bottom-grid');
  if (splitter) splitter.style.display = '';
  if (grid) grid.style.display = '';

  document.getElementById('memo-title').textContent = c.title;
  document.getElementById('memo-content').textContent = c.content;

  const badge = document.getElementById('memo-cat-badge');
  const isB = isBuiltinCat(c.category);
  badge.className = 'memo-cat-badge' + (isB ? ' ' + c.category : '');
  badge.textContent = catLabelOf(c.category);
  badge.style.background = isB ? '' : (catColorOf(c.category) + '26');
  badge.style.color = isB ? '' : catColorOf(c.category);

  // 🏠 시작 화면 지정 상태는 ⋯ 메뉴 항목 라벨로 표시(더보기 버튼 자체엔 표시 안 함)

  renderNext(c);
  updateNavBtns();
  logCardOpen(c);
  renderCardList();
}

function goBack() {
  if (state.navIndex > 0) {
    state.navIndex--;
    openCard(state.navHistory[state.navIndex], false);
  }
}
function goForward() {
  if (state.navIndex < state.navHistory.length - 1) {
    state.navIndex++;
    openCard(state.navHistory[state.navIndex], false);
  }
}
function updateNavBtns() {
  document.getElementById('back-btn').disabled = state.navIndex <= 0;
  document.getElementById('forward-btn').disabled = state.navIndex >= state.navHistory.length - 1;
}

function renderNext(card) {
  const el = document.getElementById('memo-next-buttons');
  const wrap = document.getElementById('memo-next');
  // 🚫 '다음 멘트 후보' 패널 제거됨 — 요소 없으면 조용히 종료
  if (!el || !wrap) return;
  const editBtn = document.getElementById('mn-edit-btn');
  const addForm = document.getElementById('mn-add-form');
  const next = card.next || [];

  // 편집 모드 상태 반영
  wrap.classList.toggle('editing', state.nextEditing);
  if (editBtn) {
    editBtn.classList.toggle('active', state.nextEditing);
    editBtn.textContent = state.nextEditing ? '완료' : '✎';
  }
  if (addForm) addForm.style.display = state.nextEditing ? 'flex' : 'none';
  if (state.nextEditing) renderNextAddSelect();

  if (next.length === 0) {
    el.innerHTML = state.nextEditing
      ? '<span class="next-empty">아직 후보 없음 — 아래에서 카드 골라 추가하세요</span>'
      : '<span class="next-empty">자연스럽게 이어질 멘트 후보 없음 — 오른쪽에서 다른 카드 선택하세요</span>';
    return;
  }

  el.innerHTML = next.map(n => {
    const t = state.cards.find(c => c.id === n.id);
    if (!t) return '';
    return `<button class="next-btn" data-next-id="${n.id}" title="${escapeHtml(t.title)}">
      <span>${escapeHtml(n.label || t.title)}</span><span class="next-btn-arrow">→</span>
      <span class="next-btn-remove" data-remove-id="${n.id}" title="이 후보 제거">×</span>
    </button>`;
  }).join('');

  el.querySelectorAll('.next-btn').forEach(b => {
    b.addEventListener('click', e => {
      if (e.target.classList.contains('next-btn-remove')) {
        e.stopPropagation();
        removeNextItemInline(e.target.dataset.removeId);
        return;
      }
      // 일반 모드: 카드 전환
      openCard(b.dataset.nextId);
    });
  });

  // 편집 모드일 때 드래그앤드롭으로 순서 변경 (인라인 편집 중에는 일시 정지)
  if (state.nextEditing && next.length > 1) {
    makeListDraggable(
      el,
      () => {
        const c = state.cards.find(x => x.id === state.currentCardId);
        return c ? (c.next || []) : [];
      },
      async newItems => {
        const c = state.cards.find(x => x.id === state.currentCardId);
        if (!c) return;
        c.next = newItems;
        await window.api.store.set('cards', state.cards);
        renderNext(c);
        showToast('순서 변경됨');
      }
    );
  }
}



// 추가용 드롭다운 채우기 (현재 카드 + 이미 후보로 있는 카드 제외)
function renderNextAddSelect() {
  const select = document.getElementById('mn-add-select');
  if (!select) return;
  const current = state.cards.find(c => c.id === state.currentCardId);
  if (!current) return;
  const usedIds = new Set((current.next || []).map(n => n.id));
  const available = state.cards.filter(c => c.id !== state.currentCardId && !usedIds.has(c.id));
  select.innerHTML = '<option value="">-- 추가할 카드 선택 --</option>' + available.map(c => {
    const cat = CAT_LABELS[c.category] || c.category;
    return `<option value="${c.id}">[${cat}] ${escapeHtml(c.title)}</option>`;
  }).join('');
}

// 인라인 편집 토글
function toggleNextEdit() {
  if (!state.currentCardId) {
    showToast('먼저 카드를 선택하세요');
    return;
  }
  state.nextEditing = !state.nextEditing;
  const current = state.cards.find(c => c.id === state.currentCardId);
  if (current) renderNext(current);
}

// 인라인 추가
async function addNextItemInline() {
  const select = document.getElementById('mn-add-select');
  const id = select.value;
  if (!id) { showToast('카드를 선택하세요'); return; }
  const target = state.cards.find(c => c.id === id);
  if (!target) return;
  const current = state.cards.find(c => c.id === state.currentCardId);
  if (!current) return;
  const label = target.title;
  current.next = current.next || [];
  current.next.push({ id, label });
  await window.api.store.set('cards', state.cards);

  // ── UI 정상화 (편집 안 되는 문제 방지) ──
  select.value = '';              // 다음 등록 위해 select 초기화
  renderNext(current);            // next 영역 + add-form + select 옵션 다시 그리기
  renderCardList();               // 카드 리스트 메타 동기화

  showToast(`"${label}" 추가됨`);
}

// 모든 카드에 일괄 추가 (중간중간 꼭 들어가야 하는 멘트용)
async function addNextItemToAllCards() {
  const select = document.getElementById('mn-add-select');
  const id = select.value;
  if (!id) { showToast('카드를 선택하세요'); return; }
  const target = state.cards.find(c => c.id === id);
  if (!target) return;
  const label = target.title;

  // 광범위한 변경이라 확인 다이얼로그
  const totalCards = state.cards.length - 1; // 자기 자신 제외
  if (!confirm(`"${label}"을(를) 모든 카드(${totalCards}개)의 다음 멘트 후보로 추가할까요?\n\n• 자기 자신은 제외됩니다\n• 이미 후보로 있는 카드는 스킵됩니다`)) return;

  let added = 0, skipped = 0;
  state.cards.forEach(c => {
    if (c.id === id) return; // 자기 자신 제외 (대상 카드)
    c.next = c.next || [];
    if (c.next.some(n => n.id === id)) {
      skipped++;
    } else {
      c.next.push({ id, label });
      added++;
    }
  });

  await window.api.store.set('cards', state.cards);

  // ── UI 완전 정상화 (일괄등록 후 편집 안 되는 버그 수정) ──
  // 원인: select.value가 옛 카드 ID를 그대로 들고 있는데 그 카드는 옵션에서 빠짐
  //       → 다음 등록 시도 시 select 값이 무효 상태 / 카드 리스트는 stale
  // 해결: select 초기화 + 현재 카드 재렌더 + 카드 리스트 동기화 + 편집모드 유지 보장
  select.value = '';
  // 편집 모드는 명시적으로 유지 (혹시라도 어떤 경로로 false가 됐으면 복원)
  // — 사용자가 [완료]를 누르기 전엔 끄지 않음
  // state.nextEditing은 그대로 둠 (이미 true여야 함)
  const current = state.cards.find(c => c.id === state.currentCardId);
  if (current) {
    renderNext(current);  // next + add-form + select 옵션 모두 재렌더
  }
  renderCardList();       // 사이드바 카드 리스트도 갱신

  showToast(`${added}개 카드에 추가됨${skipped > 0 ? ` (${skipped}개 이미 있어 스킵)` : ''}`);
}

// 모든 카드에서 일괄 제거 (특정 카드를 모든 next에서 빼고 싶을 때)
async function removeNextItemFromAllCards() {
  const select = document.getElementById('mn-add-select');
  const id = select.value;
  if (!id) { showToast('제거할 카드를 선택하세요'); return; }
  const target = state.cards.find(c => c.id === id);
  if (!target) return;

  if (!confirm(`"${target.title}"을(를) 모든 카드의 다음 멘트 후보에서 제거할까요?\n\n• 어느 카드에서든 이 카드를 next 목록에서 빼냅니다`)) return;

  let removed = 0;
  state.cards.forEach(c => {
    if (!c.next || c.next.length === 0) return;
    const before = c.next.length;
    c.next = c.next.filter(n => n.id !== id);
    removed += (before - c.next.length);
  });

  await window.api.store.set('cards', state.cards);

  // ── UI 완전 정상화 (일괄제거 후에도 동일 패치 적용) ──
  select.value = '';
  const current = state.cards.find(c => c.id === state.currentCardId);
  if (current) {
    renderNext(current);
  }
  renderCardList();

  if (removed === 0) showToast(`"${target.title}"은(는) 어디에도 없었어요`);
  else showToast(`${removed}곳에서 제거됨`);
}

// ============ 다음 멘트 후보 등록 현황 모달 ============
function openNextMapModal() {
  const select = document.getElementById('nm-card-select');
  select.innerHTML = '<option value="">-- 조회할 카드 선택 --</option>' +
    state.cards.map(c => {
      const cat = CAT_LABELS[c.category] || c.category;
      // 이 카드가 등록된 곳 개수
      const count = state.cards.filter(other => other.next && other.next.some(n => n.id === c.id)).length;
      return `<option value="${c.id}">[${cat}] ${escapeHtml(c.title)} — ${count}곳에 등록됨</option>`;
    }).join('');

  document.getElementById('nm-result').innerHTML = '';
  document.getElementById('nm-remove-checked-btn').style.display = 'none';
  document.getElementById('nm-remove-all-btn').style.display = 'none';
  document.getElementById('next-map-modal').style.display = 'flex';
}

function closeNextMapModal() {
  document.getElementById('next-map-modal').style.display = 'none';
}

function renderNextMapResult(targetId) {
  const result = document.getElementById('nm-result');
  const removeCheckedBtn = document.getElementById('nm-remove-checked-btn');
  const removeAllBtn = document.getElementById('nm-remove-all-btn');

  if (!targetId) {
    result.innerHTML = '';
    removeCheckedBtn.style.display = 'none';
    removeAllBtn.style.display = 'none';
    return;
  }

  const target = state.cards.find(c => c.id === targetId);
  if (!target) return;

  // 이 카드를 next에 가진 카드 목록
  const registered = state.cards.filter(c => c.next && c.next.some(n => n.id === targetId));

  if (registered.length === 0) {
    result.innerHTML = `<div class="nm-empty">📭 "<b>${escapeHtml(target.title)}</b>"은(는) 어느 카드의 다음 멘트 후보에도 등록되지 않았어요.</div>`;
    removeCheckedBtn.style.display = 'none';
    removeAllBtn.style.display = 'none';
    return;
  }

  const CAT_COLORS = { opening: 'cat-opening', objection: 'cat-objection', closing: 'cat-closing', info: 'cat-info' };
  result.innerHTML =
    `<div class="nm-count"><b>"${escapeHtml(target.title)}"</b>이(가) 다음 멘트 후보로 등록된 카드 ${registered.length}개</div>` +
    `<div class="nm-list">` +
    registered.map(c =>
      `<label class="nm-item">
        <input type="checkbox" class="nm-check" data-card-id="${c.id}" checked>
        <span class="card-item-dot ${CAT_COLORS[c.category] || ''}"></span>
        <span class="nm-item-title">${escapeHtml(c.title)}</span>
        <span class="nm-item-cat">${CAT_LABELS[c.category] || c.category}</span>
      </label>`
    ).join('') +
    `</div>`;

  removeCheckedBtn.style.display = 'inline-block';
  removeAllBtn.style.display = 'inline-block';
}

async function removeCheckedNextItems() {
  const targetId = document.getElementById('nm-card-select').value;
  if (!targetId) return;
  const target = state.cards.find(c => c.id === targetId);
  if (!target) return;

  const checked = [...document.querySelectorAll('.nm-check:checked')].map(el => el.dataset.cardId);
  if (checked.length === 0) { showToast('제거할 항목을 선택하세요'); return; }

  let removed = 0;
  state.cards.forEach(c => {
    if (!checked.includes(c.id)) return;
    const before = c.next ? c.next.length : 0;
    c.next = (c.next || []).filter(n => n.id !== targetId);
    removed += before - c.next.length;
  });

  await window.api.store.set('cards', state.cards);
  const current = state.cards.find(c => c.id === state.currentCardId);
  if (current) renderNext(current);

  showToast(`${removed}곳에서 제거됨`);
  renderNextMapResult(targetId); // 목록 갱신

  // select 옵션도 갱신
  const select = document.getElementById('nm-card-select');
  const count = state.cards.filter(other => other.next && other.next.some(n => n.id === targetId)).length;
  const opt = select.querySelector(`option[value="${targetId}"]`);
  if (opt) {
    const cat = CAT_LABELS[target.category] || target.category;
    opt.textContent = `[${cat}] ${target.title} — ${count}곳에 등록됨`;
  }
}

// 인라인 제거
async function removeNextItemInline(id) {
  const current = state.cards.find(c => c.id === state.currentCardId);
  if (!current || !current.next) return;
  current.next = current.next.filter(n => n.id !== id);
  await window.api.store.set('cards', state.cards);
  renderNext(current);
}

// ============ 본문 ↔ 하단 그리드 분할 핸들 ============
function applyMemoSplitRatio(ratio) {
  const grid = document.getElementById('memo-bottom-grid');
  if (!grid) return;
  const pct = (ratio * 100).toFixed(2);
  grid.style.height = pct + '%';
  grid.style.flexBasis = pct + '%';
}

function setupMemoSplitter() {
  const splitter = document.getElementById('memo-splitter');
  const memoView = document.getElementById('memo-view');
  const grid = document.getElementById('memo-bottom-grid');
  if (!splitter || !memoView || !grid) return;

  let isDragging = false;
  let saveTimer = null;

  splitter.addEventListener('mousedown', e => {
    isDragging = true;
    splitter.classList.add('dragging');
    document.body.classList.add('splitter-dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const rect = memoView.getBoundingClientRect();
    // 마우스 Y 위치 → 그리드 높이 비율 계산
    const newGridHeight = rect.bottom - e.clientY;
    let ratio = newGridHeight / rect.height;
    if (ratio < 0.15) ratio = 0.15;
    if (ratio > 0.8) ratio = 0.8;
    applyMemoSplitRatio(ratio);

    // 드래그 중에는 자주 저장하지 않고, 멈춘 직후에 저장
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await window.api.store.set('memoSplitRatio', ratio);
    }, 200);
  });

  document.addEventListener('mouseup', async () => {
    if (!isDragging) return;
    isDragging = false;
    splitter.classList.remove('dragging');
    document.body.classList.remove('splitter-dragging');

    // 최종 비율 저장 (debounce 마지막 호출 보장)
    clearTimeout(saveTimer);
    const rect = memoView.getBoundingClientRect();
    const ratio = grid.offsetHeight / rect.height;
    if (ratio >= 0.15 && ratio <= 0.8) {
      await window.api.store.set('memoSplitRatio', ratio);
    }
  });
}

// ============ 글씨 설정 ============
let currentFontSettings = { ...DEFAULT_FONT_SETTINGS };

function applyFontSettings(s) {
  if (!s) s = DEFAULT_FONT_SETTINGS;
  // 누락된 값은 기본값으로 보충
  currentFontSettings = { ...DEFAULT_FONT_SETTINGS, ...s };
  const root = document.documentElement;
  root.style.setProperty('--fz-memo', currentFontSettings.memoSize + 'px');
  root.style.setProperty('--fw-memo', String(currentFontSettings.memoWeight));
  root.style.setProperty('--fz-qk-btn', currentFontSettings.qkSize + 'px');
  root.style.setProperty('--fz-next-btn', currentFontSettings.nextSize + 'px');
  root.style.setProperty('--fz-card', currentFontSettings.cardSize + 'px');
  root.style.setProperty('--fz-sidebar', currentFontSettings.sidebarSize + 'px');
  root.style.setProperty('--fz-np', currentFontSettings.npSize + 'px');
  root.style.setProperty('--fz-crm-memo', currentFontSettings.crmMemoSize + 'px');
  root.style.setProperty('--fz-crm-rec', currentFontSettings.crmRecSize + 'px');

  // 📞/🗂/🗣 패널 단위 배율(--fs-*-scale)은 제거됨 — '보기 메뉴 → 확대/축소'(창 전체 줌)로 통일.
  //   CSS 소비 측은 var(--fs-*-scale, 1) 폴백이라 변수를 아예 안 세팅하면 항상 1(=원래 크기)로 동작한다.
  //   과거 저장값에 배율이 남아 있어도 여기서 변수를 세팅하지 않으므로 자동으로 무력화된다.
  root.style.removeProperty('--fs-dialer-scale');
  root.style.removeProperty('--fs-crmpanel-scale');
  root.style.removeProperty('--fs-ment-scale');

  // 빠른 대응 버튼은 autoAdjustQkLayout이 .qk-list-item에 인라인 font-size를
  // 직접 박아넣기 때문에, CSS 변수만 바뀌어도 화면에 반영되지 않는다.
  // 인라인 값을 새 변수 기준으로 다시 계산해서 즉시 적용.
  if (typeof autoAdjustQkLayout === 'function') {
    autoAdjustQkLayout();
  }

  // 🆕 다른 창/iframe(TM 고객관리 등)이 최신 글씨 설정을 읽을 수 있게 전역 + 이벤트로 공유.
  // 복원(부팅) 시점과 슬라이더 변경 시점이 모두 이 함수를 거치므로, 여기 한 곳에서만 쏘면 양쪽 다 커버됨.
  window.__cpFontSettings = { ...currentFontSettings };
  document.dispatchEvent(new CustomEvent('cp:fontsettings', { detail: { ...currentFontSettings } }));
}

function openFontSettings() {
  const setV = (sid, vid, val) => {
    const s = document.getElementById(sid), v = document.getElementById(vid);
    if (s) s.value = val;
    if (v) v.textContent = val + 'px';
  };
  setV('fs-memo-slider', 'fs-memo-val', currentFontSettings.memoSize);
  setV('fs-qk-slider',   'fs-qk-val',   currentFontSettings.qkSize);
  setV('fs-np-slider',   'fs-np-val',   currentFontSettings.npSize);
  // 🗂 콜관리 글씨 — 통화 메모 입력칸+기록을 하나로 합침(대표값: crmMemoSize)
  setV('fs-crm-slider',  'fs-crm-val',  currentFontSettings.crmMemoSize);
  // (제거됨) 패널 전체 배율 슬라이더 — 보기 메뉴 확대/축소로 통일

  // 굵기 버튼 활성화
  document.querySelectorAll('.fs-weight-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.weight) === currentFontSettings.memoWeight);
  });

  document.getElementById('font-settings-modal').style.display = 'flex';
}

// (제거됨) ensureNotepadFontSlider / ensureCrmFontSliders — 카드리스트 슬라이더를 복제해
//   메모장·통화메모·통화기록 슬라이더를 동적 주입하던 복잡한 로직. 이제 슬라이더는 모두
//   HTML에 정적으로 있고(메모장/콜관리), 카드리스트·사이드바 슬라이더는 패널 제거로 함께 삭제함.

function closeFontSettings() {
  document.getElementById('font-settings-modal').style.display = 'none';
}

async function saveFontSettings() {
  await window.api.store.set('fontSettings', currentFontSettings);
}

function bindFontSettingsEvents() {
  const sliderMap = [
    ['fs-memo-slider', 'fs-memo-val', 'memoSize'],
    ['fs-qk-slider',   'fs-qk-val',   'qkSize'],
    ['fs-np-slider',   'fs-np-val',   'npSize'],
  ];

  sliderMap.forEach(([sliderId, valId, key]) => {
    const slider = document.getElementById(sliderId);
    const val = document.getElementById(valId);
    if (!slider || !val) return;
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      val.textContent = v + 'px';
      currentFontSettings[key] = v;
      applyFontSettings(currentFontSettings);
    });
    slider.addEventListener('change', saveFontSettings); // 드래그 멈춘 후 저장
  });

  // (제거됨) 섹션별 패널 전체 배율 슬라이더 바인딩 — 보기 메뉴 확대/축소(창 전체 줌)로 통일

  // 🗂 콜관리 글씨 — 통화 메모 입력칸+기록을 하나의 슬라이더로 함께 조절
  const crmSlider = document.getElementById('fs-crm-slider');
  const crmVal = document.getElementById('fs-crm-val');
  if (crmSlider && crmVal) {
    crmSlider.addEventListener('input', () => {
      const v = parseFloat(crmSlider.value);
      crmVal.textContent = v + 'px';
      currentFontSettings.crmMemoSize = v;
      currentFontSettings.crmRecSize = v;
      applyFontSettings(currentFontSettings);
    });
    crmSlider.addEventListener('change', saveFontSettings);
  }

  // 굵기 버튼
  document.querySelectorAll('.fs-weight-btn').forEach(b => {
    b.addEventListener('click', async () => {
      document.querySelectorAll('.fs-weight-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      currentFontSettings.memoWeight = parseInt(b.dataset.weight);
      applyFontSettings(currentFontSettings);
      await saveFontSettings();
    });
  });

  // 기본값 복원
  document.getElementById('fs-reset-btn').addEventListener('click', async () => {
    if (!confirm('모든 글씨 설정을 기본값으로 되돌릴까요?')) return;
    currentFontSettings = { ...DEFAULT_FONT_SETTINGS };
    applyFontSettings(currentFontSettings);
    await saveFontSettings();
    openFontSettings(); // 슬라이더 값 갱신
    showToast('기본값으로 복원됨');
  });

  // 열기/닫기
  document.getElementById('open-font-settings-btn').addEventListener('click', openFontSettings);
  document.getElementById('close-font-settings-modal').addEventListener('click', closeFontSettings);
  document.getElementById('fs-close-btn').addEventListener('click', closeFontSettings);
  // 바깥(배경) 클릭으로는 닫지 않음 — 실수 방지. 닫기 버튼(✕)/완료로만 닫는다.
  document.getElementById('font-settings-modal').addEventListener('click', e => {});
}

// ============ ✍ 의견 보내기 (Supabase 온라인 피드백, 오프라인이어도 안전) ============
function openFeedbackModal() {
  const ta = document.getElementById('feedback-textarea');
  const st = document.getElementById('feedback-status');
  if (ta) ta.value = '';
  if (st) st.textContent = '';
  document.getElementById('feedback-modal').style.display = 'flex';
  if (ta) ta.focus();
}
function closeFeedbackModal() {
  document.getElementById('feedback-modal').style.display = 'none';
}
async function sendFeedback() {
  const ta = document.getElementById('feedback-textarea');
  const st = document.getElementById('feedback-status');
  const btn = document.getElementById('send-feedback-btn');
  const text = (ta && ta.value || '').trim();
  if (!text) { if (st) st.textContent = '내용을 입력해주세요'; return; }
  if (btn) btn.disabled = true;
  if (st) st.textContent = '보내는 중…';
  try {
    const r = await window.api.feedback(text);
    if (r && r.ok) {
      showToast('의견을 보냈습니다. 감사합니다!');
      setTimeout(closeFeedbackModal, 600);
    } else {
      if (st) st.textContent = '전송 실패 — 인터넷 연결을 확인해주세요';
    }
  } catch (e) {
    if (st) st.textContent = '전송 실패 — 인터넷 연결을 확인해주세요';
  } finally {
    if (btn) btn.disabled = false;
  }
}
function bindFeedbackEvents() {
  const openBtn = document.getElementById('open-feedback-btn');
  if (openBtn) openBtn.addEventListener('click', openFeedbackModal);
  const closeBtn = document.getElementById('close-feedback-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeFeedbackModal);
  const sendBtn = document.getElementById('send-feedback-btn');
  if (sendBtn) sendBtn.addEventListener('click', sendFeedback);
}

// ============ 공통 드래그앤드롭 정렬 ============
// listEl: 항목들의 부모 컨테이너
// getItems: 현재 항목 배열 반환
// onReorder: 새 순서 배열 받아서 저장+렌더링
function makeListDraggable(listEl, getItems, onReorder) {
  let dragSrcIdx = null;

  Array.from(listEl.children).forEach((el, idx) => {
    // 빈 상태 메시지는 드래그 대상 아님
    if (el.classList.contains('qk-empty') || el.classList.contains('next-empty')) return;

    el.draggable = true;

    el.addEventListener('dragstart', e => {
      dragSrcIdx = idx;
      el.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx)); // Firefox 호환
      }
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      Array.from(listEl.children).forEach(c => c.classList.remove('drag-over'));
      dragSrcIdx = null;
    });

    el.addEventListener('dragover', e => {
      e.preventDefault();
      if (dragSrcIdx === null || dragSrcIdx === idx) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // 모든 drag-over 제거 후 현재 요소만 표시 (깜빡임 방지)
      Array.from(listEl.children).forEach(c => {
        if (c !== el) c.classList.remove('drag-over');
      });
      el.classList.add('drag-over');
    });

    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (dragSrcIdx === null || dragSrcIdx === idx) return;
      const items = getItems();
      const newItems = [...items];
      const [moved] = newItems.splice(dragSrcIdx, 1);
      newItems.splice(idx, 0, moved);
      onReorder(newItems);
    });
  });
}

// ============ 편집 ============
function enterEdit() {
  const c = state.cards.find(x => x.id === state.currentCardId);
  if (!c) return;
  state.isEditing = true;
  state.nextEditing = false; // 다음멘트 인라인 편집은 닫기
  document.getElementById('edit-title').value = c.title;
  refreshCategorySelect(c.category);
  document.getElementById('edit-tags').value = (c.tags || []).join(', ');
  document.getElementById('edit-content').value = c.content;
  document.getElementById('memo-content').style.display = 'none';
  document.getElementById('memo-edit').style.display = 'flex';
}
async function saveEdit() {
  const c = state.cards.find(x => x.id === state.currentCardId);
  if (!c) return;
  c.title = document.getElementById('edit-title').value.trim() || '제목 없음';
  c.category = document.getElementById('edit-category').value;
  c.tags = document.getElementById('edit-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  c.content = document.getElementById('edit-content').value;

  // 🔄 제목 변경 시 다른 카드의 next 후보 라벨 전부 자동 갱신 (커스텀 라벨 포함)
  let totalSynced = 0;
  const cardMap = new Map(state.cards.map(x => [x.id, x]));
  state.cards.forEach(other => {
    if (!other.next || other.next.length === 0) return;
    other.next.forEach(n => {
      const ref = cardMap.get(n.id);
      if (!ref) return;
      if (n.label !== ref.title) {
        n.label = ref.title;
        totalSynced++;
      }
    });
  });

  await window.api.store.set('cards', state.cards);

  state.isEditing = false;
  state.pendingNewCardId = null;   // 저장됨 → 미저장 추적 해제
  openCard(c.id, false);
  renderPinned();

  showToast(totalSynced > 0
    ? `저장됐어요 — 다른 카드의 후보 라벨 ${totalSynced}개도 같이 갱신됨`
    : '저장됐어요');
}
function cancelEdit() {
  state.isEditing = false;
  document.getElementById('memo-content').style.display = 'block';
  document.getElementById('memo-edit').style.display = 'none';
  const ncr = document.getElementById('new-cat-row'); if (ncr) ncr.style.display = 'none';

  // 🆕 방금 만든 '미저장 새 카드'를 취소한 경우 → 그 카드 삭제 + 이전에 보던 카드로 복귀
  if (state.pendingNewCardId && state.currentCardId === state.pendingNewCardId) {
    const newId = state.pendingNewCardId;
    state.pendingNewCardId = null;
    state.cards = state.cards.filter(x => x.id !== newId);
    window.api.store.set('cards', state.cards);
    // 네비 기록에서 새 카드 흔적 제거
    state.navHistory = state.navHistory.filter(id => id !== newId);
    if (state.navIndex >= state.navHistory.length) state.navIndex = state.navHistory.length - 1;
    renderCardList();
    // 직전 카드로 복귀 — ①만들기 직전에 보던 카드 ②네비 기록 ③시작/오프닝/첫 카드.
    // 카드가 하나도 없을 때만 빈 화면 (시작 카드는 navHistory에 안 쌓여서 이력만 보면 빈 화면으로 떨어짐)
    const histId = state.navIndex >= 0 ? state.navHistory[state.navIndex] : null;
    const back =
      state.cards.find(c => c.id === state.pendingPrevCardId) ||
      state.cards.find(c => c.id === histId) ||
      state.cards.find(c => c.id === state.startupCardId) ||
      state.cards.find(c => c.category === 'opening') ||
      state.cards[0];
    state.pendingPrevCardId = null;
    if (back) {
      openCard(back.id, false);
    } else {
      state.currentCardId = null;
      document.getElementById('memo-view').style.display = 'none';
      document.getElementById('memo-empty').style.display = 'flex';
      updateNavBtns();
    }
  }
}

// ============ CRUD ============
async function addNewCard() {
  // 새 스크립트는 현재 보고 있는 카드와 같은 카테고리로 시작 (없으면 반론처리) — 편집 폼에서 변경 가능
  const cur = state.cards.find(x => x.id === state.currentCardId);
  const cat = (cur && cur.category) ? cur.category : 'objection';
  const nc = { id:'custom-'+Date.now(), category:cat, title:'새 카드', tags:[], content:'여기에 멘트를 입력하세요.', next:[] };
  state.cards.push(nc);
  state.pendingNewCardId = nc.id;   // 취소 시 되돌릴 수 있도록 '미저장 새 카드' 표시
  state.pendingPrevCardId = state.currentCardId;   // 취소 시 이 카드로 복귀 (시작 카드는 navHistory에 없음)
  await window.api.store.set('cards', state.cards);
  renderCardList();
  openCard(nc.id);
  enterEdit();
  document.getElementById('edit-title').focus();
  document.getElementById('edit-title').select();
}
async function deleteCurrent() {
  if (!state.currentCardId) return;
  if (!confirm('이 카드를 삭제할까요?')) return;
  const deletedId = state.currentCardId;
  state.cards = state.cards.filter(c => c.id !== deletedId);

  // 🧹 다른 카드의 next 후보에서 이 카드를 참조하는 항목도 함께 제거 (잔여 스튜브 방지)
  let cleanedRefs = 0;
  state.cards.forEach(other => {
    if (!other.next || other.next.length === 0) return;
    const before = other.next.length;
    other.next = other.next.filter(n => n.id !== deletedId);
    cleanedRefs += (before - other.next.length);
  });

  await window.api.store.set('cards', state.cards);
  renderCardList();
  renderPinned();
  openAfterDelete(deletedId);   // 빈 화면 대신 직전 카드로 복귀
  showToast(cleanedRefs > 0
    ? `삭제됐어요 — 다른 카드 후보에서 ${cleanedRefs}개 참조도 정리됨`
    : '삭제됐어요');
}
async function copyCurrent() {
  const c = state.cards.find(x => x.id === state.currentCardId);
  if (!c) return;
  try { await navigator.clipboard.writeText(c.content); showToast('복사됨'); }
  catch (e) { showToast('복사 실패'); }
}
// 🏠 현재 카드를 '앱 시작 시 먼저 띄울 스크립트'로 지정/해제
async function toggleStartupCard() {
  const c = state.cards.find(x => x.id === state.currentCardId);
  if (!c) { showToast('먼저 스크립트를 선택하세요'); return; }
  const on = state.startupCardId !== c.id;
  state.startupCardId = on ? c.id : null;
  await window.api.store.set('startupCardId', state.startupCardId);
  showToast(on ? `🏠 시작 화면 스크립트로 지정됨 — "${c.title}"` : '시작 화면 지정 해제됨');
}

// 멘트 헤더 ⋯ 더보기 메뉴 — 사이드바가 숨겨져 도달 불가능해진 저빈도 기능 모음
function openMemoMoreMenu(anchorEl) {
  const c = state.cards.find(x => x.id === state.currentCardId);
  const isStart = !!c && state.startupCardId === c.id;
  window.cpMenu(anchorEl, [
    { label: isStart ? '시작 화면 고정 해제' : '시작 화면으로 고정', icon: '🏠', onClick: toggleStartupCard },
    { sep: true },
    { label: '글씨 설정', icon: '⚙', onClick: openFontSettings },
    { sep: true },
    { label: '백업 복원', icon: '↑', onClick: () => window.api.app.importData() },
    { sep: true },
    { label: '튜토리얼 다시 보기', icon: '🎓', onClick: () => { try { window.Tutorial && window.Tutorial.start(true); } catch (e) {} } },
  ]);
}

// ============ 콜 로그 ============
async function logCardOpen(c) {
  const name = (window.__dialerCurrentCall && window.__dialerCurrentCall.name) || null;
  state.callLogs.unshift({ id:'log-'+Date.now(), cardId:c.id, cardTitle:c.title, category:c.category, customerName:name||null, timestamp:new Date().toISOString() });
  if (state.callLogs.length > 500) state.callLogs = state.callLogs.slice(0, 500);
  await window.api.store.set('callLogs', state.callLogs);
}

// (제거됨) 고객 저장/목록 기능 — 고객 관리는 콜관리(CRM)에서 하므로 삭제함.

// ============ JSON 가져오기 ============
function openJsonImport() {
  document.getElementById('json-import-textarea').value = '';
  document.getElementById('json-import-status').textContent = '';
  document.getElementById('json-import-status').className = 'json-status';
  document.getElementById('json-import-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('json-import-textarea').focus(), 50);
}
function closeJsonImport() { document.getElementById('json-import-modal').style.display = 'none'; }
async function pickJsonFile() {
  const text = await window.api.app.pickJsonFile();
  if (text) {
    document.getElementById('json-import-textarea').value = text;
    const st = document.getElementById('json-import-status');
    st.textContent = '파일을 읽었어요. "적용" 버튼을 누르세요.';
    st.className = 'json-status success';
  }
}
async function applyJsonImport() {
  const text = document.getElementById('json-import-textarea').value.trim();
  const st = document.getElementById('json-import-status');
  if (!text) { st.textContent = '내용이 비어 있어요'; st.className = 'json-status error'; return; }
  let data;
  try { data = JSON.parse(text); }
  catch (e) { st.textContent = 'JSON 오류: ' + e.message; st.className = 'json-status error'; return; }
  let cards = Array.isArray(data) ? data : data.cards;
  if (!Array.isArray(cards)) { st.textContent = '{"cards":[...]} 형식이어야 해요'; st.className = 'json-status error'; return; }
  for (const c of cards) {
    if (!c.id || !c.title || typeof c.content !== 'string') {
      st.textContent = 'id/title/content 빠짐'; st.className = 'json-status error'; return;
    }
    c.category = c.category || 'info';
    c.tags = c.tags || [];
    c.next = c.next || [];
  }
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  if (mode === 'replace') {
    if (!confirm(`교체 모드 — 기존 ${state.cards.length}개 삭제하고 새 ${cards.length}개로 바꿀까요?`)) return;
    state.cards = cards;
  } else {
    const map = new Map(state.cards.map(c => [c.id, c]));
    let added = 0, updated = 0;
    cards.forEach(nc => { if (map.has(nc.id)) updated++; else added++; map.set(nc.id, nc); });
    state.cards = Array.from(map.values());
    st.textContent = `추가 ${added}, 업데이트 ${updated}`;
    st.className = 'json-status success';   // 이전 에러 스타일(빨강) 초기화
  }
  await window.api.store.set('cards', state.cards);
  renderCardList(); renderPinned();
  showToast(mode === 'replace' ? `${cards.length}개로 교체됨` : `${cards.length}개 적용됨`);
  setTimeout(closeJsonImport, 800);
}

// ============ 유틸 ============
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// 🩹 재렌더(innerHTML 교체)로 포커스됐던 요소가 사라지면 Electron webContents가 입력 포커스를
//    잃어 클릭해도 커서가 안 생기던 문제 → 저장/수정 직후 webContents 포커스를 되돌린다.
function refocusApp() {
  const go = () => { try { window.api && window.api.window && window.api.window.refocus && window.api.window.refocus(); } catch (e) {} };
  try { requestAnimationFrame(go); } catch (e) { go(); }
  setTimeout(go, 60);   // 포커스 상실이 살짝 늦게 일어나는 경우까지 커버
}
window.refocusApp = refocusApp;

// ============================================================
//  📷 메모 캡처/이미지 첨부 — 모든 메모 입력칸에서 붙여넣기(Ctrl+V)·드래그드롭·📷버튼으로
//     이미지를 첨부. 다운스케일(최대 1280px) 후 note.images(data URL 배열)로 저장.
//     카드/통화기록/뷰어에 썸네일, 클릭 시 확대(라이트박스).
// ============================================================
const NP_IMG_MAX = 1280;
function npFileToDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function npDownscaleDataUrl(dataUrl) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const m = Math.max(w, h);
      if (m > NP_IMG_MAX) { const s = NP_IMG_MAX / m; w = Math.round(w * s); h = Math.round(h * s); }
      try { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); res(c.toDataURL('image/png')); }
      catch (e) { res(dataUrl); }
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}
async function npProcessImageFile(file) {
  try { const d = await npFileToDataUrl(file); return await npDownscaleDataUrl(d); } catch (e) { return null; }
}
// 표시용 썸네일 행 (카드/기록/뷰어)
function npThumbsHtml(images, opts) {
  if (!Array.isArray(images) || !images.length) return '';
  opts = opts || {};
  const cls = 'np-thumbs' + (opts.small ? ' np-thumbs-sm' : '');
  return `<div class="${cls}">` + images.map(src => `<img class="np-img-thumb" src="${src}" data-np-img="1" loading="lazy" alt="첨부 이미지">`).join('') + `</div>`;
}
// 확대 보기(라이트박스)
function npOpenLightbox(src) {
  document.querySelectorAll('.np-lightbox').forEach(m => m.remove());
  const ov = document.createElement('div');
  ov.className = 'np-lightbox';
  const im = document.createElement('img'); im.src = src; im.alt = '이미지';
  const cb = document.createElement('button'); cb.className = 'np-lightbox-close'; cb.title = '닫기 (Esc)'; cb.textContent = '✕';
  ov.appendChild(im); ov.appendChild(cb);
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target === cb) close(); });
  document.addEventListener('keydown', esc);
  document.body.appendChild(ov);
}
// 어떤 썸네일이든 클릭하면 확대 (캡처 단계에서 위임)
document.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('.np-img-thumb[data-np-img]');
  if (t && t.src && !e.target.closest('.np-img-del')) { e.stopPropagation(); npOpenLightbox(t.src); }
}, true);

// textarea에 캡처 첨부 부착. seedImages로 기존 이미지를 미리 채움(편집 모드).
function npEnableImageAttach(textarea, seedImages) {
  if (!textarea) return null;
  if (textarea.__imgAttach) {
    if (Array.isArray(seedImages)) { textarea.__pendingImages = seedImages.slice(); textarea.__renderImgStrip && textarea.__renderImgStrip(); }
    return textarea.__pendingImages;
  }
  textarea.__imgAttach = true;
  textarea.__pendingImages = Array.isArray(seedImages) ? seedImages.slice() : [];

  const wrap = document.createElement('div');
  wrap.className = 'np-img-attach';
  wrap.innerHTML = `<div class="np-img-strip"></div><button type="button" class="np-img-add" title="캡처/이미지 첨부 · 붙여넣기(Ctrl+V)·드래그도 됩니다">📷 캡처 첨부</button><input type="file" accept="image/*,.png,.jpg,.jpeg,.jfif,.gif,.webp,.bmp,.svg,.heic,.heif,.avif,.tif,.tiff,.ico" multiple class="np-img-file" style="display:none">`;
  if (textarea.parentNode) textarea.parentNode.insertBefore(wrap, textarea.nextSibling);
  const strip = wrap.querySelector('.np-img-strip');
  const fileInput = wrap.querySelector('.np-img-file');
  const addBtn = wrap.querySelector('.np-img-add');

  const renderStrip = () => {
    const imgs = textarea.__pendingImages || [];
    strip.innerHTML = imgs.map((src, i) => `<div class="np-img-cell"><img class="np-img-thumb" src="${src}" data-np-img="1" alt="첨부"><button type="button" class="np-img-del" data-i="${i}" title="삭제">✕</button></div>`).join('');
  };
  textarea.__renderImgStrip = renderStrip;
  strip.addEventListener('click', (e) => { const del = e.target.closest('.np-img-del'); if (del) { e.stopPropagation(); textarea.__pendingImages.splice(+del.dataset.i, 1); renderStrip(); } });

  const NP_IMG_EXT_RE = /\.(png|jpe?g|jfif|gif|webp|bmp|svg|heic|heif|avif|tiff?|ico)$/i;
  const addFiles = async (files) => {
    const arr = [...files].filter(f => f && ((f.type && f.type.startsWith('image/')) || (f.name && NP_IMG_EXT_RE.test(f.name))));
    if (!arr.length) return;
    for (const f of arr) { const d = await npProcessImageFile(f); if (d) textarea.__pendingImages.push(d); }
    renderStrip();
    if (typeof showToast === 'function') showToast('📷 캡처 첨부됨');
  };
  textarea.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const imgItems = [...items].filter(it => it.type && it.type.startsWith('image/'));
    if (!imgItems.length) return;
    e.preventDefault();
    addFiles(imgItems.map(it => it.getAsFile()).filter(Boolean));
  });
  textarea.addEventListener('dragover', (e) => { if (e.dataTransfer && [...(e.dataTransfer.items || [])].some(it => it.type && it.type.startsWith('image/'))) { e.preventDefault(); textarea.classList.add('np-img-dragover'); } });
  textarea.addEventListener('dragleave', () => textarea.classList.remove('np-img-dragover'));
  textarea.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files; if (f && f.length) { e.preventDefault(); textarea.classList.remove('np-img-dragover'); addFiles(f); } });
  addBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files && fileInput.files.length) { addFiles(fileInput.files); fileInput.value = ''; } });

  renderStrip();
  return textarea.__pendingImages;
}
// 첨부된 이미지를 꺼내고 입력칸 비우기 (저장 시 호출)
function npTakePending(textarea) {
  const imgs = (textarea && Array.isArray(textarea.__pendingImages)) ? textarea.__pendingImages.slice() : [];
  if (textarea) { textarea.__pendingImages = []; textarea.__renderImgStrip && textarea.__renderImgStrip(); }
  return imgs;
}
window.npEnableImageAttach = npEnableImageAttach;
window.npTakePending = npTakePending;
window.npThumbsHtml = npThumbsHtml;
window.npOpenLightbox = npOpenLightbox;

// ============ 이벤트 ============
function bindEvents() {
  const search = document.getElementById('search-input');
  const clear = document.getElementById('clear-search');

  search.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    clear.style.display = e.target.value ? 'block' : 'none';
    renderCardList();
  });
  clear.addEventListener('click', () => {
    search.value = ''; state.searchQuery = ''; clear.style.display = 'none';
    renderCardList(); search.focus();
  });

  document.querySelectorAll('.filter-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.currentCategory = b.dataset.category;
    renderCardList();
  }));

  document.getElementById('back-btn').addEventListener('click', goBack);
  document.getElementById('forward-btn').addEventListener('click', goForward);
  document.getElementById('copy-btn').addEventListener('click', copyCurrent);
  document.getElementById('edit-btn').addEventListener('click', enterEdit);
  document.getElementById('delete-btn').addEventListener('click', deleteCurrent);
  document.getElementById('save-edit-btn').addEventListener('click', saveEdit);
  document.getElementById('cancel-edit-btn').addEventListener('click', cancelEdit);
  { const mb = document.getElementById('memo-more-btn'); if (mb) mb.addEventListener('click', () => openMemoMoreMenu(mb)); }

  document.getElementById('add-card-btn').addEventListener('click', addNewCard);
  // 🆕 이 화면 안에서 바로 새 스크립트 추가 (카드 패널 토글 없이) — 헤더 + 빈 화면 양쪽
  const newScriptBtn = document.getElementById('new-script-btn');
  if (newScriptBtn) newScriptBtn.addEventListener('click', addNewCard);
  const emptyNewBtn = document.getElementById('empty-new-script-btn');
  if (emptyNewBtn) emptyNewBtn.addEventListener('click', addNewCard);
  // 📑 저장된 카드 목록
  { const clBtn = document.getElementById('card-list-btn'); if (clBtn) clBtn.addEventListener('click', openCardListModal); }
  { const clClose = document.getElementById('close-card-list-modal'); if (clClose) clClose.addEventListener('click', closeCardListModal); }
  { const clSearch = document.getElementById('card-list-search'); if (clSearch) clSearch.addEventListener('input', (e) => renderCardListModal(e.target.value)); }
  { const clModal = document.getElementById('card-list-modal'); if (clModal) clModal.addEventListener('click', (e) => { if (e.target === clModal) closeCardListModal(); }); }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const m = document.getElementById('card-list-modal'); if (m && m.style.display === 'flex') { e.stopPropagation(); closeCardListModal(); } }
  });
  document.getElementById('import-btn').addEventListener('click', () => window.api.app.importData());

  // 진입 버튼(open-json-import-btn)은 UI에서 제거됨(⋯메뉴 항목도 제거) — 함수·모달은 남겨두되
  // 없는 요소 참조로 bindEvents() 전체가 죽지 않게 널가드만 유지.
  { const ojBtn = document.getElementById('open-json-import-btn'); if (ojBtn) ojBtn.addEventListener('click', openJsonImport); }
  document.getElementById('close-json-import-modal').addEventListener('click', closeJsonImport);
  document.getElementById('apply-json-import-btn').addEventListener('click', applyJsonImport);
  document.getElementById('json-pick-file-btn').addEventListener('click', pickJsonFile);
  // 바깥(배경) 클릭으로는 닫지 않음 — 실수 방지. 닫기 버튼(✕)으로만 닫는다.
  document.getElementById('json-import-modal').addEventListener('click', e => {});

  // 빠른 대응 키워드 패널
  document.getElementById('qk-edit-btn').addEventListener('click', toggleQuickKeywordsEdit);
  // 🔎 빠른대응 키워드 필터 — 타이핑하면 관련 버튼만 표시
  {
    const qkf = document.getElementById('qk-filter');
    if (qkf) qkf.addEventListener('input', e => { state.qkFilter = e.target.value; renderQuickKeywords(); });
  }
  // + 버튼을 [확인] 버튼으로 변경 (HTML 안 건드리고 textContent만)
  {
    const confirmBtn = document.getElementById('qk-add-confirm');
    if (confirmBtn) {
      confirmBtn.textContent = '추가';
      confirmBtn.title = '선택한 카드를 빠른대응에 등록';
      confirmBtn.style.minWidth = '46px';
      confirmBtn.style.padding = '0 10px';
    }
  }
  document.getElementById('qk-add-confirm').addEventListener('click', addQuickKeyword);
  document.getElementById('qk-add-label').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('qk-add-query').focus(); }
  });
  document.getElementById('qk-add-query').addEventListener('input', e => {
    // 검색어가 바뀌면 이전 선택은 무효 — renderQkPreviewInEl 안에서도 검증하지만 input 시점에도 한번 더
    state.selectedPreviewCardId = null;
    renderQkPreview(e.target.value);
  });
  document.getElementById('qk-add-query').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addQuickKeyword(); }
  });

  // 다음 멘트 후보 인라인 편집 (패널 제거 시 자동 스킵)
  const mnEditBtn = document.getElementById('mn-edit-btn');
  if (mnEditBtn) {
    mnEditBtn.addEventListener('click', toggleNextEdit);
    document.getElementById('mn-add-confirm').addEventListener('click', addNextItemInline);
    document.getElementById('mn-add-all').addEventListener('click', addNextItemToAllCards);
    document.getElementById('mn-remove-all').addEventListener('click', removeNextItemFromAllCards);
    document.getElementById('mn-dedupe').addEventListener('click', openNextMapModal);
  }

  // 등록 현황 모달 (패널 제거 시 자동 스킵)
  const nextMapModal = document.getElementById('next-map-modal');
  if (nextMapModal) {
    document.getElementById('close-next-map-modal').addEventListener('click', closeNextMapModal);
    // 바깥(배경) 클릭으로는 닫지 않음 — 실수 방지. 닫기 버튼(✕)으로만 닫는다.
    nextMapModal.addEventListener('click', e => {});
    document.getElementById('nm-card-select').addEventListener('change', e => {
      renderNextMapResult(e.target.value);
    });
    document.getElementById('nm-remove-checked-btn').addEventListener('click', removeCheckedNextItems);
    document.getElementById('nm-remove-all-btn').addEventListener('click', async () => {
      const targetId = document.getElementById('nm-card-select').value;
      if (!targetId) return;
      // 모든 체크박스 체크 후 제거
      document.querySelectorAll('.nm-check').forEach(el => { el.checked = true; });
      await removeCheckedNextItems();
    });
  }

  // 글씨 설정 (모달 + 슬라이더)
  bindFontSettingsEvents();
  // ✍ 의견 보내기
  bindFeedbackEvents();

  document.addEventListener('keydown', e => {
    // ★ Ctrl+S(저장) — IME 조합 중이든, 입력란 안/밖이든 어디서든 작동
    //   • e.code === 'KeyS' 사용 → 한글 입력 모드에서 e.key가 'ㄴ'으로 잡혀도 정상 인식
    //   • IME 조합 중 가드(아래)보다 먼저 처리해서 한글 입력 직후 Ctrl+S도 통과
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      if (state.isEditing) {
        e.preventDefault();
        saveEdit();
      }
      return;
    }

    // 🔒 한글(IME) 조합 중에는 나머지 단축키 무시 — 입력 보호
    if (e.isComposing || e.keyCode === 229) return;

    // F5: 어디서든(입력란 포함) 새로고침 — Ctrl+R과 동일
    if (e.key === 'F5') {
      e.preventDefault();
      window.location.reload();
      return;
    }

    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const inputFocus = ['INPUT','TEXTAREA','SELECT'].includes(tag);

    // Escape는 어디서든 작동
    if (e.key === 'Escape') {
      const nextMap = document.getElementById('next-map-modal');
      if (document.getElementById('json-import-modal').style.display === 'flex') closeJsonImport();
      else if (nextMap && nextMap.style.display === 'flex') closeNextMapModal();
      else if (document.getElementById('font-settings-modal').style.display === 'flex')
        closeFontSettings();
      else if (state.isEditing) cancelEdit();
      return;
    }

    // 🔒 입력란(INPUT/TEXTAREA/SELECT)에 포커스가 있으면 나머지 단축키 무시
    // → 한글 입력·텍스트 편집을 방해하는 모든 가능성 차단
    if (inputFocus) return;

    // 입력란 밖에서만 작동하는 단축키
    if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); addNewCard(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); search.focus(); search.select(); return; }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }
  });

  // 마우스 옆 버튼 (뒤로/앞으로) — 입력란에서는 무시
  document.addEventListener('mouseup', e => {
    const t = e.target;
    if (t && ['INPUT','TEXTAREA','SELECT'].includes(t.tagName)) return;
    if (e.button === 3) { e.preventDefault(); goBack(); }
    if (e.button === 4) { e.preventDefault(); goForward(); }
  });

}

// ============ 📐 메모장 ↔ 양식 높이 연동 (자유 리사이즈 + 기억) ============
// 메모장(#np-input)과 양식(#np-form)이 같은 높이를 공유한다.
// 둘 중 하나를 드래그로 리사이즈하면 다른 쪽도 같은 높이가 되고, 그 높이를 저장해 다음에도 유지한다.
let __padH = null;             // 현재 공유 높이(px)
let __padHApplying = false;    // 프로그램이 높이를 적용하는 중 (옵저버 되먹임 방지)
let __padHReady = false;       // 최초 높이 적용 완료 전에는 옵저버 무시
let __padHTimer = null;
function applyPadHeight(px, persist) {
  px = Math.max(140, Math.round(px || 0));
  __padH = px;
  __padHApplying = true;
  const inp = document.getElementById('np-input');
  const frm = document.getElementById('np-form');
  if (inp) inp.style.height = px + 'px';
  if (frm) frm.style.height = px + 'px';
  requestAnimationFrame(() => { __padHApplying = false; });
  if (persist) {
    clearTimeout(__padHTimer);
    __padHTimer = setTimeout(() => { try { window.api.store.set('memoPadHeight', __padH); } catch (e) {} }, 300);
  }
}
function watchPadResize(el) {
  if (!el || !window.ResizeObserver || el.__padWatched) return;
  el.__padWatched = true;
  const ro = new ResizeObserver(() => {
    if (!__padHReady || __padHApplying) return;
    if (el.offsetParent === null) return;                     // 숨김 상태 무시
    const h = el.offsetHeight;
    if (h < 120) return;                                      // 비정상/숨김 무시
    if (__padH != null && Math.abs(h - __padH) < 2) return;   // 변화 없음
    applyPadHeight(h, true);                                   // 사용자 드래그 → 양쪽 동기화 + 저장
  });
  ro.observe(el);
}
function setupMemoPadResize() {
  const inp = document.getElementById('np-input');
  const frm = document.getElementById('np-form');
  if (!inp && !frm) return;
  watchPadResize(inp);
  watchPadResize(frm);
  const finish = () => requestAnimationFrame(() => { __padHReady = true; });
  window.api.store.get('memoPadHeight').then(h => {
    applyPadHeight((typeof h === 'number' && h >= 140) ? h : 380, false);
    finish();
  }).catch(() => { applyPadHeight(380, false); finish(); });
}

// ============ 📝 메모장 + 카드 검색 패널 변환 ============
function transformSearchToNotepad() {
  // 1) 카드 검색 패널을 메모장으로 변환
  const ispInput   = document.getElementById('isp-input');
  const ispClear   = document.getElementById('isp-clear');
  const ispResults = document.getElementById('isp-results');
  if (!ispInput || !ispResults) {
    // 카드 검색 요소가 없으면 현재 고객 패널만 처리하고 종료
    hideCustomerPanel();
    return;
  }

  // 2) panelBody 찾기 (isp-input과 isp-results의 가장 가까운 공통 조상)
  let panelBody = ispInput.parentElement;
  while (panelBody && !panelBody.contains(ispResults)) {
    panelBody = panelBody.parentElement;
  }
  if (!panelBody) {
    hideCustomerPanel();
    return;
  }

  // 3) 헤더 텍스트 변경 (body 전체에서 적극 검색 — 메모장 영역과 모달은 제외)
  let headerChanged = false;
  let headerInside = null;

  // 헤더로 보이는 짧고 "카드 검색" 키워드를 포함하는 element 판정
  function isCardSearchHeader(el) {
    if (!el || !el.textContent) return false;
    const t = el.textContent.trim();
    if (t.length === 0 || t.length > 60) return false;
    return t.includes('카드 검색') || t.includes('카드검색') || t.includes('🔍 카드') || /🔍\s*카/.test(t);
  }

  // body 전체에서 매치되는 가장 좁은(텍스트 길이 최소) element 찾기
  // 메모장 자체(np-wrapper)와 토글 바, 모달 안은 제외
  const excludeSel = '#np-wrapper, #panel-toggles-bar, .np-viewer-modal, [class*="modal"]';
  const allEls = document.body.querySelectorAll('*');
  let bestMatch = null;
  let bestLen = Infinity;
  for (const el of allEls) {
    if (el.closest && el.closest(excludeSel)) continue;
    if (!isCardSearchHeader(el)) continue;
    const len = (el.textContent || '').trim().length;
    if (len < bestLen) {
      bestMatch = el;
      bestLen = len;
    }
  }
  if (bestMatch) {
    bestMatch.textContent = '📝 메모장';
    headerInside = bestMatch;
    headerChanged = true;
  }

  // 4) 메모장 UI 요소 생성 + wrapper로 묶음
  const npInput = document.createElement('textarea');
  npInput.id = 'np-input';
  npInput.className = 'notepad-input';
  npInput.placeholder = '메모를 입력하세요... (Ctrl+Enter로 저장)';

  // 📋 양식 입력칸 컨테이너 (양식 버튼 누르면 실제 입력칸 생성)
  const npForm = document.createElement('div');
  npForm.id = 'np-form';
  npForm.className = 'np-form';
  npForm.style.display = 'none';

  const npSave = document.createElement('button');
  npSave.id = 'np-save';
  npSave.className = 'notepad-save-btn';
  npSave.textContent = '💾 저장';

  // 📖 크게 작성 버튼 (큰 모달로 전체 화면 작성)
  const npExpand = document.createElement('button');
  npExpand.id = 'np-expand';
  npExpand.type = 'button';
  npExpand.className = 'notepad-expand-btn';
  npExpand.title = '큰 화면에서 작성 (전체 화면 모달)';
  npExpand.textContent = '📖 크게';

  // 📞 (제거됨) 이름/전화번호 입력 줄 — 번호는 '현재 통화'에 표시되고 저장 시 자동 집계되므로 불필요.
  //    saveNote()가 window.__dialerCurrentCall(현재 통화 번호/이름)로 자동 채움.

  // 💾 저장 (결과는 발신 패널의 결과 버튼을 사용 — 결과 일원화 #9)
  const npStatusSave = document.createElement('div');
  npStatusSave.className = 'np-statussave-row';
  const npSaveBtn = document.createElement('button');
  npSaveBtn.type = 'button';
  npSaveBtn.className = 'np-ss-btn ss-plain';
  npSaveBtn.textContent = '💾 저장';
  npSaveBtn.addEventListener('click', () => saveNote());
  npStatusSave.appendChild(npSaveBtn);
  // 💡 저장 동작 안내: 무엇이 함께 묶여 저장되는지 한 줄로 쉽게 설명
  const npSaveHint = document.createElement('div');
  npSaveHint.className = 'np-ss-hint';
  npSaveHint.innerHTML = '📞 <b>현재 번호</b> · ✅ <b>선택한 통화 결과</b> · 📝 <b>메모</b> 를 묶어 <b>기록 1건</b>으로 저장돼요';
  npStatusSave.appendChild(npSaveHint);

  // 📖 크게 작성 버튼 행
  const npExportRow = document.createElement('div');
  npExportRow.className = 'np-export-row';
  npExportRow.appendChild(npExpand);

  // 저장 행 묶음
  const npActions = document.createElement('div');
  npActions.className = 'notepad-actions';
  npActions.appendChild(npStatusSave);

  // 📝 메모 양식 행 (textarea 바로 아래)
  const npTemplatesRow = document.createElement('div');
  npTemplatesRow.id = 'np-templates-row';
  npTemplatesRow.className = 'np-templates-row';

  const npList = document.createElement('div');
  npList.id = 'np-list';
  npList.className = 'notepad-list';

  // 🔎 저장된 메모: 검색 / 정렬 / 현재고객 필터 바
  const npNotesBar = document.createElement('div');
  npNotesBar.id = 'np-notes-bar';
  npNotesBar.className = 'np-notes-bar';
  npNotesBar.innerHTML = `
    <input type="text" id="np-notes-search" class="np-notes-search" placeholder="🔎 저장된 메모 검색 (이름·번호·내용)" autocomplete="off">
    <select id="np-notes-sort" class="np-notes-sort" title="정렬 기준">
      <option value="new">최신순</option>
      <option value="old">오래된순</option>
      <option value="name">이름순</option>
    </select>
    <span id="np-notes-count" class="np-notes-count"></span>`;

  const wrapper = document.createElement('div');
  wrapper.id = 'np-wrapper';
  wrapper.style.cssText = 'display:flex; flex-direction:column; gap:8px; flex:1 1 auto; min-height:500px; width:100%; padding-top:4px;';
  wrapper.appendChild(npForm);           // 📋 양식 입력칸 (필요 시 표시)
  wrapper.appendChild(npInput);
  wrapper.appendChild(npTemplatesRow);   // 📝 양식 행 (textarea 바로 아래)
  wrapper.appendChild(npActions);        // 💾 상태 선택 저장 행
  wrapper.appendChild(npExportRow);      // 📖 크게 버튼
  wrapper.appendChild(npNotesBar);       // 🔎 메모 검색/정렬/필터
  wrapper.appendChild(npList);
  // 만약 외부 헤더("🔍 카드 검색")를 못 찾았으면 wrapper에 자체 헤더 추가
  if (!headerChanged) {
    const builtinHeader = document.createElement('div');
    builtinHeader.style.cssText = 'font-size:13px; font-weight:700; color:#7dd3c0; margin-bottom:2px;';
    builtinHeader.textContent = '📝 메모장';
    wrapper.insertBefore(builtinHeader, npInput);
  }

  // 5) panelBody 안의 isp 관련 요소만 정확히 제거 (panelBody.innerHTML 통째 교체 X)
  //    → 빠른응대 등 다른 panel은 절대 건드리지 않음
  const ispInputWrap = ispInput.parentNode;  // isp-input을 감싸는 wrapper (input-wrap 등)
  if (ispInput.parentNode) ispInput.parentNode.removeChild(ispInput);
  if (ispClear && ispClear.parentNode) ispClear.parentNode.removeChild(ispClear);
  if (ispResults.parentNode) ispResults.parentNode.removeChild(ispResults);
  // isp-input을 감쌌던 wrapper가 panelBody와 다르고 비었으면 함께 제거
  if (ispInputWrap && ispInputWrap !== panelBody
      && ispInputWrap.children.length === 0
      && !(ispInputWrap.textContent || '').trim()
      && ispInputWrap.parentNode) {
    ispInputWrap.parentNode.removeChild(ispInputWrap);
  }

  // 6) panelBody에 메모장 wrapper 추가
  panelBody.appendChild(wrapper);

  // 7) panelBody를 flex 컬럼으로 설정 (minHeight 부여 X — 메모장 끔 시 panel 자동 축소)
  //    메모장 크기는 wrapper의 min-height로 보장 (wrapper 자체에 min-height:500px 있음)
  panelBody.style.display = 'flex';
  panelBody.style.flexDirection = 'column';
  panelBody.style.flex = '1 1 auto';

  // panel(=panelBody의 부모)이 panelBody와 다르면 flex 컬럼 구조만 부여 (크기는 강제 안 함)
  const cardSearchPanel = panelBody.parentElement;
  if (cardSearchPanel && cardSearchPanel !== panelBody) {
    const safeToExpand = !cardSearchPanel.querySelector('#quick-keywords, #qk-list, #card-list, #pinned-cards');
    if (safeToExpand) {
      if (!cardSearchPanel.style.display) cardSearchPanel.style.display = 'flex';
      if (!cardSearchPanel.style.flexDirection) cardSearchPanel.style.flexDirection = 'column';
    }
  }

  // 8) 메모장 이벤트 리스너
  npExpand.addEventListener('click', openNoteComposer);
  try { npEnableImageAttach(npInput); } catch (e) {}   // 📷 캡처 첨부(붙여넣기/드래그/버튼)

  // 입력 즉시 자동저장(드래프트) — 닫아도 안 날아감
  let npDraftTimer = null;
  npInput.addEventListener('input', () => {
    clearTimeout(npDraftTimer);
    npDraftTimer = setTimeout(() => { window.api.store.set('noteDraft', npInput.value); }, 300);
  });
  // 드래프트 복원
  window.api.store.get('noteDraft').then(d => { if (d && !npInput.value) npInput.value = d; }).catch(() => {});

  // Ctrl+Enter = 기본 저장(상태 없음)
  npInput.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveNote(null); }
  });

  // 📞 발신 패널이 통화 시작하면 번호 헤더 표시
  document.addEventListener('dialer:call', () => {
    // 새 통화 시작 → [📞 이 고객만] 필터가 켜져 있으면 그 고객 메모로 자동 갱신
    try { renderNotes(); } catch (e) {}
  });
  // 📴 통화 종료 신호 → '통화중' 배지가 사라지도록 메모 목록 다시 그림
  document.addEventListener('dialer:callend', () => {
    try { renderNotes(); } catch (e) {}
  });
  // 이름/번호도 입력 즉시 드래프트 저장
  ['np-name', 'np-phone'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.addEventListener('input', () => {
      clearTimeout(npDraftTimer);
      npDraftTimer = setTimeout(() => {
        window.api.store.set('noteDraft', npInput.value);
        window.api.store.set('noteInfoDraft', { name: (document.getElementById('np-name')||{}).value || '', phone: (document.getElementById('np-phone')||{}).value || '' });
      }, 300);
    });
  });
  window.api.store.get('noteInfoDraft').then(d => {
    if (!d) return;
    const nEl = document.getElementById('np-name'), pEl = document.getElementById('np-phone');
    if (nEl && !nEl.value && d.name) nEl.value = d.name;
    if (pEl && !pEl.value && d.phone) pEl.value = d.phone;
  }).catch(() => {});

  setupNotesBar();        // 🔎 메모 바 이벤트 연결
  renderNotes();
  renderNoteTemplates();
  setupMemoPadResize();   // 📐 메모장↔양식 높이 연동 시작 (저장된 높이 복원)

  // 9) 현재 고객 패널 숨김
  hideCustomerPanel();

  // 10) 헤더 ☰ (고객 목록 버튼) 보조 숨김
  const custListBtn = document.getElementById('customer-list-btn');
  if (custListBtn) custListBtn.style.display = 'none';
}

// ============ 현재 고객 패널 안전 숨김 ============
function hideCustomerPanel() {
  const custName = document.getElementById('customer-name');
  const custSave = document.getElementById('customer-save');
  if (!custName || !custSave) return;

  // custBody = customer 입력 요소들의 공통 조상
  let custBody = custName.parentElement;
  while (custBody && !custBody.contains(custSave)) {
    custBody = custBody.parentElement;
  }
  if (!custBody) return;

  // 안전 검증: 다른 알려진 패널(빠른응대/카드 리스트/메모장)을 포함하지 않는지
  const conflictSel = '#quick-keywords, #qk-list, #pinned-cards, #card-list, #np-wrapper, #np-input, #np-list';

  // 부모 panel을 숨길 수 있으면 숨기고, 안 되면 custBody만 숨김
  const custPanel = custBody.parentElement;
  if (custPanel && !custPanel.querySelector(conflictSel)) {
    custPanel.style.display = 'none';
    return;
  }
  if (!custBody.querySelector(conflictSel)) {
    custBody.style.display = 'none';
  }
}

// ============ 📝 메모장 데이터 처리 ============
// 메모에서 이름/번호/요약 추출 (양식 필드까지 들춰봄 → 옛 메모도 번호 표시)
function noteName(n) {
  if (n.name) return n.name;
  if (Array.isArray(n.fields)) { const f = n.fields.find(f => f && /성함|이름/.test(f.label||'') && (f.value||'').trim()); if (f) return f.value.trim(); }
  return '';
}
function notePhone(n) {
  if (n.number) return n.number;
  if (Array.isArray(n.fields)) { const f = n.fields.find(f => f && /연락처|전화|휴대|번호/.test(f.label||'') && (f.value||'').trim()); if (f) return f.value.trim(); }
  return '';
}
function noteSummary(n) {
  // 이름/번호 빼고 채워진 항목만 한 줄 요약 (양식 아니면 자유 메모 내용)
  if (Array.isArray(n.fields) && n.fields.length) {
    const parts = n.fields
      .filter(f => f && (f.value||'').trim() && !/성함|이름|연락처|전화|휴대|번호/.test(f.label||''))
      .map(f => `${f.label} ${f.value.trim()}`);
    if (parts.length) return parts.join(' · ');
  }
  return (n.content||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).join(' · ');
}
function __digits(s){ return String(s||'').replace(/\D/g,''); }

// 이력 보기용: 빈 칸 + 머리글(성함·연락처=제목에 이미 있음) 빼고 깔끔한 줄만
function noteCleanText(n) {
  const strip = lbl => String(lbl||'').replace(/^\s*\d+[.)]\s*/, '').trim();   // "4. 나이대" → "나이대"
  const isHead = lbl => /성함|이름|연락처|전화|휴대|번호/.test(lbl||'');
  if (Array.isArray(n.fields) && n.fields.length) {
    return n.fields
      .filter(f => f && (f.value||'').trim() && !isHead(f.label))
      .map(f => `${strip(f.label)} : ${f.value.trim()}`)
      .join('\n');
  }
  // 자유 메모 등: 줄 단위로 빈 값/머리글 제거
  return String(n.content||'')
    .split(/\r?\n/)
    .map(line => {
      const ci = line.indexOf(':');
      if (ci === -1) return line.trim() || null;
      const label = line.slice(0, ci), val = line.slice(ci + 1).trim();
      if (!val || isHead(label)) return null;
      return `${strip(label)} : ${val}`;
    })
    .filter(Boolean)
    .join('\n');
}

// 메모 바(검색/정렬/필터) 이벤트 연결 — transform 에서 1회 호출
function setupNotesBar() {
  const s = document.getElementById('np-notes-search');
  if (s) { s.value = state.noteSearch || ''; s.addEventListener('input', () => { state.noteSearch = s.value; renderNotes(); }); }
  const so = document.getElementById('np-notes-sort');
  if (so) { so.value = state.noteSort || 'new'; so.addEventListener('change', () => { state.noteSort = so.value; try { window.api.store.set('noteSort', so.value); } catch(e){} renderNotes(); }); }
}

function renderNotes() {
  const list = document.getElementById('np-list');
  if (!list) return;
  const all = (state.notes || []).slice();
  const total = all.length;

  // 🔎 검색 (이름·번호·내용)
  const q = (state.noteSearch || '').trim().toLowerCase();
  const notes = q ? all.filter(n => (noteName(n)+' '+notePhone(n)+' '+(n.content||'')).toLowerCase().includes(q)) : [];   // 🔎 검색어 없으면 비움 (전체 안 띄움)

  // 📞 같은 번호 = 한 카드로 통합 (이력 누적). 번호 없는 메모는 개별 카드.
  const groups = {};
  const cards = [];
  notes.forEach(n => {
    const ph = notePhone(n);
    const key = __digits(ph);
    if (key) {
      if (!groups[key]) { const g = { type:'group', key, phone: ph, name:'', items:[], last:0 }; groups[key] = g; cards.push(g); }
      const g = groups[key];
      g.items.push(n);
      const t = new Date(n.createdAt).getTime();
      if (t > g.last) g.last = t;
      if (!g.name && noteName(n)) g.name = noteName(n);
      if (!g.phone && ph) g.phone = ph;
    } else {
      cards.push({ type:'single', key:n.id, phone:'', name: noteName(n), items:[n], last: new Date(n.createdAt).getTime() });
    }
  });
  // 각 그룹 이력은 시간순(오래된→최신)으로 정렬해 두기
  cards.forEach(c => { if (c.items.length > 1) c.items.sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt)); });

  // ↕ 정렬 + 📞 '통화중' 배지/맨위는 실제 활성 통화일 때만 (선택만 한 경우는 제외 → 통화 끝나면 배지 사라짐)
  const call = window.__dialerCurrentCall || null;
  const curKey = call ? __digits(call.number) : '';
  const sort = state.noteSort || 'new';
  cards.sort((a, b) => {
    if (curKey) { if (a.key === curKey && b.key !== curKey) return -1; if (b.key === curKey && a.key !== curKey) return 1; }
    if (sort === 'name') {
      const an=a.name, bn=b.name;
      if (an && bn && an !== bn) return an.localeCompare(bn,'ko');
      if (an && !bn) return -1; if (!an && bn) return 1;
      return b.last - a.last;
    }
    return sort === 'old' ? a.last - b.last : b.last - a.last;
  });

  const countEl = document.getElementById('np-notes-count');
  if (countEl) countEl.textContent = q ? `${cards.length}명 / ${total}건` : `총 ${total}건`;

  if (!cards.length) {
    list.innerHTML = !q
      ? (total === 0
          ? '<div class="notepad-empty">저장된 메모가 없어요.<br>위 입력칸에 작성해 보세요.</div>'
          : '<div class="notepad-empty">🔎 위에서 이름·번호·내용으로 검색하면<br>해당하는 메모만 여기 표시됩니다.</div>')
      : '<div class="notepad-empty">검색 결과가 없어요.</div>';
    return;
  }

  const fmtShort = ts => new Date(ts).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });

  // 카드: [이름 번호 (이력 N건)] / 최신 한 줄 요약 / 결과·날짜. 클릭하면 그 번호 이력 전체.
  list.innerHTML = cards.map(c => {
    const latest = c.items[c.items.length - 1];
    const sm = noteSummary(latest);
    const cnt = c.items.length;
    const isCur = curKey && c.key === curKey;
    const imgs = c.items.reduce((a, n) => a.concat(Array.isArray(n.images) ? n.images : []), []);   // 📷 그룹 내 캡처
    const meta = [];
    if (latest.result) meta.push(`<span class="np-meta-result">${escapeHtml(latest.result)}</span>`);
    meta.push(fmtShort(latest.createdAt));
    return `
      <div class="notepad-item np-compact${isCur ? ' np-cur' : ''}" data-group-key="${c.key}" data-type="${c.type}" title="클릭하면 이 번호의 이력 전체 보기">
        <div class="np-item-head">
          <span class="np-item-name">${c.name ? escapeHtml(c.name) : '메모'}</span>
          ${c.phone ? `<span class="np-item-phone">${escapeHtml(c.phone)}</span>` : ''}
          ${cnt > 1 ? `<span class="np-item-count">이력 ${cnt}건</span>` : ''}
          ${isCur ? '<span class="np-cur-badge">📞 통화중</span>' : ''}
        </div>
        ${sm ? `<div class="np-item-summary">${escapeHtml(sm)}</div>` : ''}
        ${imgs.length ? (typeof npThumbsHtml === 'function' ? npThumbsHtml(imgs.slice(0, 6), { small: true }) : '') : ''}
        <div class="notepad-item-meta">${meta.join(' · ')}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.notepad-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const del = e.target.closest('.np-item-del');
      if (del) { e.stopPropagation(); deleteNoteCard(del.dataset.delKey, del.dataset.delType); return; }
      if (item.dataset.type === 'single') {
        // 번호 없는 메모 → 편집 모달 (콜관리 고객으로 연결할 번호가 없음)
        openNoteViewer(item.dataset.groupKey);
      } else {
        // 번호 있는 메모 → 콜관리에서 고객 클릭한 것과 '같은 창'(상세 패널)으로 연동
        const phone = item.dataset.groupKey;
        if (window.CRM && typeof window.CRM.openCustomerByPhone === 'function') window.CRM.openCustomerByPhone(phone);
        else openGroupViewer(phone);   // 폴백
      }
    });
  });

  // 현재 통화 카드가 화면에 보이도록
  if (curKey) { const cur = list.querySelector('.np-cur'); if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block:'nearest' }); } catch(e){} } }
}

// 통화·메모 기록은 고객 응대 기록이자 개인정보 처리 기록이라 임의로 지울 수 없다.
// 지워야 할 때의 정상 경로 = 수신거부(차단요청) 처리로 그 고객 정보를 파기하거나,
// 위탁 종료 시 관리자가 정리하는 것. 어느 쪽이든 '누가 왜 지웠는지'가 남는다.
// (삭제 버튼은 화면에서 제거했고, 이 함수는 다른 경로로 호출될 때를 막는 방어선이다)
async function deleteNoteCard(key, type) {
  showToast('통화·메모 기록은 지울 수 없습니다 — 수신거부는 [차단요청]으로 처리하세요');
}

// 🪟 메모 뷰어 모달을 헤더로 끌어서 이동 — 배경(스크립트 등)은 그대로 조작 가능(클릭/스크롤 통과)
function makeNoteModalDraggable(box, handle) {
  if (!box || !handle) return;
  handle.style.cursor = 'move';
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;   // 닫기 등 버튼 클릭은 드래그 제외
    const r = box.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.margin = '0';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    const sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
    const move = (ev) => {
      let nx = ox + (ev.clientX - sx), ny = oy + (ev.clientY - sy);
      nx = Math.max(60 - box.offsetWidth, Math.min(window.innerWidth - 60, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 44, ny));
      box.style.left = nx + 'px';
      box.style.top = ny + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
}

// 🗂 한 번호의 통화 이력 전체를 시간순으로 보여주는 창
function openGroupViewer(phoneKey) {
  const items = (state.notes || [])
    .filter(n => __digits(notePhone(n)) === phoneKey)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));   // 최신 → 오래된 (최신이 맨 위)
  if (!items.length) return;
  document.querySelectorAll('.np-reader-modal').forEach(m => m.remove());
  const name = items.map(noteName).find(Boolean) || '';
  const phone = items.map(notePhone).find(Boolean) || '';
  const fmt = ts => new Date(ts).toLocaleString('ko-KR', { year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });

  const modal = document.createElement('div');
  modal.className = 'np-viewer-modal np-reader-modal';
  const rows = items.map((n) => {
    const r = n.result ? `<span class="np-tl-result">${escapeHtml(n.result)}</span>` : '';
    return `<div class="np-tl-entry" data-note-id="${n.id}"><div class="np-tl-when"><span class="np-tl-date">📞 ${fmt(n.createdAt)}</span>${r}<button class="np-tl-del" data-del-id="${n.id}" title="이 통화기록 1건 삭제">✕</button></div><div class="np-tl-text"></div></div>`;
  }).join('');
  modal.innerHTML = `
    <div class="np-viewer-content np-group-content">
      <div class="np-viewer-header">
        <span class="np-viewer-date">🗂 ${name ? escapeHtml(name)+' · ' : ''}${escapeHtml(phone)} · 이력 ${items.length}건</span>
        <button class="np-viewer-close" title="닫기 (Esc)">✕</button>
      </div>
      <div class="np-viewer-body np-group-body">${rows}</div>
    </div>`;
  // 본문은 textContent로 안전하게 주입 (빈 칸/머리글 제거한 깔끔한 줄)
  modal.querySelectorAll('.np-tl-entry').forEach((el, i) => {
    const txt = noteCleanText(items[i]);
    el.querySelector('.np-tl-text').textContent = txt || '(추가 메모 없음)';
  });

  document.body.appendChild(modal);
  makeNoteModalDraggable(modal.querySelector('.np-viewer-content'), modal.querySelector('.np-viewer-header'));
  const close = () => { modal.remove(); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc);
  modal.querySelector('.np-viewer-close').addEventListener('click', close);

  // 항목 본문 클릭 → 그 1건 편집(기존 단일 뷰어)
  modal.querySelectorAll('.np-tl-entry').forEach(el => {
    el.querySelector('.np-tl-text').addEventListener('click', () => { close(); openNoteViewer(el.dataset.noteId, () => openGroupViewer(phoneKey)); });
  });
  // 개별 기록 삭제
  modal.querySelectorAll('.np-tl-del').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('이 통화 기록 1건을 삭제할까요?')) return;
    state.notes = (state.notes || []).filter(n => n.id !== b.dataset.delId);
    try { await window.api.store.set('notes', state.notes); } catch(err){}
    renderNotes();
    const remain = (state.notes || []).filter(n => __digits(notePhone(n)) === phoneKey);
    close();
    if (remain.length) openGroupViewer(phoneKey);   // 남은 이력 다시 표시
    showToast('기록 1건 삭제됨');
  }));
}

async function saveNote() {
  const input = document.getElementById('np-input');
  if (!input) return;
  // 📋 양식 입력칸이 열려 있으면 입력값을 본문/필드로 합침 (이름/번호 자동 매핑)
  let formFields = null;
  try { formFields = assembleNoteForm(); } catch (e) { console.error('[저장] 양식 합치기 오류', e); }

  // 메모 내용 확보: np-input(양식이 열렸으면 위에서 합쳐 넣음).
  // 혹시 비어 있으면 → 열린 양식의 칸/메모를 직접 긁어서 마지막 방어 (조용한 실패 방지)
  let content = input.value.trim();
  if (!content) {
    try {
      const fm = document.getElementById('np-form-memo');
      const memoVal = fm ? fm.value.trim() : '';
      const rows = [];
      const direct = [];
      document.querySelectorAll('#np-form .np-form-row').forEach(r => {
        const l = r.querySelector('label')?.textContent || '';
        const v = r.querySelector('input')?.value.trim() || '';
        direct.push({ label: l, value: v });
        if (v) rows.push(`${l} : ${v}`);
      });
      if (memoVal) { direct.push({ label: '메모', value: memoVal }); rows.push(`메모 : ${memoVal}`); }
      if ((!formFields || !formFields.length) && direct.length) formFields = direct;
      content = rows.join('\n').trim();
    } catch (e) { console.error('[저장] 양식 직접 읽기 오류', e); }
  }
  // 📷 첨부된 캡처/이미지 (있으면 텍스트 없이도 저장 가능)
  const pendingImgs = (input && Array.isArray(input.__pendingImages)) ? input.__pendingImages.slice() : [];
  if (!content && !pendingImgs.length) {
    showToast('메모 내용을 입력하세요');
    input.focus();
    return;
  }

  // 이름/번호: 현재 통화 → 선택 번호 → 고객 패널 → 양식의 성함/연락처 (통화 없이 작성해도 번호가 잡히게)
  const call = window.__dialerCurrentCall || window.__dialerSelected || null;
  const fFromForm = (re) => {
    if (!Array.isArray(formFields)) return '';
    const f = formFields.find(f => f && re.test(f.label || '') && (f.value || '').trim());
    return f ? f.value.trim() : '';
  };
  const nameVal = (call && call.name) || fFromForm(/성함|이름/);
  const phoneVal = (call && call.number) || fFromForm(/연락처|전화|휴대|번호/);
  // ✅ 결과 일원화: 발신 패널에서 선택한 통화 결과
  const result = window.__dialerResult || null;

  await npEnsureName();                       // 저장 직전에 이름 확보 — '(이름없음)' 방지
  const stampedContent = npAppendMemo('', content);
  const note = {
    id: 'note-' + Date.now(),
    content: stampedContent,                  // 작성자·시각을 본문에 박아 둔다
    by: npMemoAuthor(),
    createdAt: new Date().toISOString(),
    number: phoneVal,
    name: nameVal,
    result: result,
    images: pendingImgs,                                          // 📷 첨부 캡처
    fields: formFields && formFields.length ? formFields : null   // 항목별 컬럼용
  };

  state.notes.unshift(note);
  // 🔗 TM 고객관리에도 반영 — 두 화면의 기록이 어긋나지 않게
  try {
    if (typeof CRM !== 'undefined' && CRM.emitSync && phoneVal) {
      CRM.emitSync(String(phoneVal).replace(/\D/g, ''), 'upsert', { phone: phoneVal, memo: stampedContent });
    }
  } catch (e) {}
  // ⚡ 화면부터 즉시 갱신 — 저장소 쓰기(await)가 굼떠도 카드가 바로 뜨게. (저장 눌렀는데 안 뜨던 문제)
  try { renderNotes(); } catch (e) { console.error('[저장] 즉시 목록 갱신 오류', e); }
  try {
    await window.api.store.set('notes', state.notes);
  } catch (e) {
    console.error('[저장] 저장소 기록 오류', e);
    showToast('⚠ 저장 중 문제가 있었지만 메모는 화면에 남겨둘게요');
  }
  // 아래 UI 갱신은 저장소 성공/실패와 무관하게 항상 실행 (조용한 실패 방지)
  input.value = '';
  try { if (typeof npTakePending === 'function') npTakePending(input); } catch (e) {}   // 📷 첨부 미리보기 비우기
  try { closeNoteForm(); } catch (e) {}     // 양식 입력칸 닫기/초기화 → 메모장 초기상태로
  try { window.api.store.set('noteDraft', ''); } catch (e) {}
  try { window.api.store.set('noteInfoDraft', { name: '', phone: '' }); } catch (e) {}
  try { renderNotes(); } catch (e) { console.error('[저장] 목록 갱신 오류', e); }

  // 발신 패널에 알려 통화기록 1건 확정 (결과 일원화)
  document.dispatchEvent(new CustomEvent('memo:save', { detail: { content: stampedContent } }));

  showToast(result ? `저장됨 · ${result}` : '저장됨');
  input.focus();
  // 저장 직후 기록 갱신 등으로 레이아웃이 바뀌어도 커서가 입력창에 확실히 돌아오게
  requestAnimationFrame(() => { try { input.focus(); } catch (e) {} });
  if (typeof refocusApp === 'function') refocusApp();   // webContents 포커스까지 복구 (타이핑 막힘 방지)
}

// (제거됨) deleteNote — 호출하는 곳이 없는 죽은 함수. 삭제는 deleteNoteCard로 처리됨.

// ============ 📝 메모 큰 보기 / 편집 모달 ============
// 📐 메모 뷰어 textarea 자동 높이: 내용 길이만큼(최소) ~ 모달이 화면 밖으로 안 나가는 선(최대).
//    → footer(삭제/뒤로/저장)가 항상 보이도록 textarea 높이를 제한한다.
function npAutoGrowViewer(ta) {
  if (!ta || !ta.isConnected) return;
  if (ta.closest('.np-edit-modal')) return;   // 편집 모달은 flex로 공간을 꽉 채움 (자동높이 제외)
  const content = ta.closest('.np-viewer-content'); if (!content) return;
  const header = content.querySelector('.np-viewer-header');
  const footer = content.querySelector('.np-viewer-footer');
  const body = ta.closest('.np-viewer-body');
  let reserved = 0;
  if (header) reserved += header.offsetHeight;
  if (footer) reserved += footer.offsetHeight;
  if (body) { const bs = getComputedStyle(body); reserved += (parseFloat(bs.paddingTop)||0) + (parseFloat(bs.paddingBottom)||0); }
  if (body) { body.childNodes.forEach(ch => { if (ch.nodeType === 1 && ch !== ta) reserved += ch.offsetHeight || 0; }); }
  reserved += 24;   // 테두리/여백 여유
  const maxTa = Math.max(150, Math.round(window.innerHeight * 0.92 - reserved));
  ta.style.height = 'auto';
  const need = ta.scrollHeight;
  ta.style.height = Math.min(need, maxTa) + 'px';
  ta.style.overflowY = (need > maxTa + 1) ? 'auto' : 'hidden';
}
// 입력 시 + 창 크기 변경 시 자동 높이 (모든 뷰어 textarea 공통, 1회만 등록)
if (!window.__npViewerAutoGrowBound) {
  window.__npViewerAutoGrowBound = true;
  document.addEventListener('input', e => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('np-viewer-edit-input')) npAutoGrowViewer(t);
  });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.np-viewer-edit-input').forEach(npAutoGrowViewer);
  });
}

/* ── 메모 작성자 기록 ────────────────────────────────────────────
   메모는 고객 응대 기록이자 개인정보 처리 기록이라 "누가 언제 썼는지"가 남아야 한다.
   한 번 남긴 메모는 앱에서 지우거나 고칠 수 없고, 새 메모를 덧붙이는 것만 된다.
   (고객이 개인정보 삭제를 요구하면 수신거부 대장 경로로 파기한다 — 임의 삭제와는 다르다) */
let __npMyName = '';
// 이름은 로그인 세션에서 가져온다. 앱 시작 직후엔 세션이 아직 준비 안 됐을 수 있어
// 저장 직전에 한 번 더 확인한다(npEnsureName). 캐시되면 그 뒤로는 바로 쓴다.
async function npEnsureName() {
  if (__npMyName) return __npMyName;
  try {
    const me = (window.api && window.api.crm) ? await window.api.crm.me() : null;
    if (me && me.ok && me.name) __npMyName = String(me.name);
  } catch (e) {}
  return __npMyName;
}
npEnsureName();
function npMemoAuthor() { return __npMyName || '(이름없음)'; }
function npMemoStamp(when) {
  const t = when ? new Date(when) : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}/${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}
// 기존 메모는 건드리지 않고 뒤에 덧붙인다.
function npAppendMemo(prev, text, when) {
  const body = String(text || '').trim();
  if (!body) return String(prev || '');
  const entry = `[${npMemoAuthor()} · ${npMemoStamp(when)}] ${body}`;
  const old = String(prev || '').trim();
  return old ? (old + '\n' + entry) : entry;
}
window.npAppendMemo = npAppendMemo;
window.npMemoAuthor = npMemoAuthor;
window.npEnsureName = npEnsureName;

function openNoteViewer(noteId, onBack) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return;

  // 기존 큰 보기 모달만 제거 (작성 모달/양식 모달은 별도 클래스이므로 영향 없음)
  document.querySelectorAll('.np-reader-modal').forEach(m => m.remove());

  const dt = new Date(note.createdAt);
  const dateStr = dt.toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const updatedStr = note.updatedAt
    ? ' (수정: ' + new Date(note.updatedAt).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) + ')'
    : '';
  const resultStr = note.result ? ` · ${escapeHtml(note.result)}` : '';

  const modal = document.createElement('div');
  modal.className = 'np-viewer-modal np-reader-modal np-edit-modal';
  // 📝 클릭하면 바로 '편집' 상태로 — 읽기 단계 없이 textarea + 양식 + 뒤로/저장
  modal.innerHTML = `
    <div class="np-viewer-content">
      <div class="np-viewer-header">
        <span class="np-viewer-date">📝 ${dateStr}${updatedStr}${resultStr}</span>
        <button class="np-viewer-close" title="닫기 (Esc)">✕</button>
      </div>
      <div class="np-viewer-body">
        <div style="font-size:12px;color:var(--text-2,#8a8172);margin:0 0 6px">기존 메모 — 기록이라 수정·삭제할 수 없습니다</div>
        <div id="np-reader-old" style="white-space:pre-wrap;font-size:13px;line-height:1.6;background:rgba(0,0,0,.14);border-radius:9px;padding:10px 12px;max-height:240px;overflow:auto"></div>
        <div style="font-size:12px;color:var(--text-2,#8a8172);margin:12px 0 6px">메모 추가 — 내 이름과 시각이 자동으로 붙습니다</div>
        <textarea id="np-reader-edit-input" class="np-viewer-edit-input" placeholder="덧붙일 내용... (Ctrl+Enter로 저장)"></textarea>
        <div id="np-reader-templates-row" class="np-templates-row" style="margin-top:10px;"></div>
      </div>
      <div class="np-viewer-footer">
        <div class="np-viewer-actions" style="margin-left:auto">
          <button class="np-viewer-back-btn">← 뒤로</button>
          <button class="np-viewer-save-btn">💾 저장</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  makeNoteModalDraggable(modal.querySelector('.np-viewer-content'), modal.querySelector('.np-viewer-header'));

  const oldBox = modal.querySelector('#np-reader-old');
  if (oldBox) oldBox.textContent = note.content || '(내용 없음)';
  const textarea = modal.querySelector('#np-reader-edit-input');
  textarea.value = '';
  try { renderNoteTemplates(); } catch (e) {}   // 양식 버튼 (이 textarea에 삽입)
  try { npEnableImageAttach(textarea, Array.isArray(note.images) ? note.images : []); } catch (e) {}   // 📷 기존 캡처 + 추가
  requestAnimationFrame(() => npAutoGrowViewer(textarea));   // 📐 내용 길이에 맞춰 자동 높이 (footer 안 잘리게)

  const closeModal = () => { modal.remove(); document.removeEventListener('keydown', escHandler); };
  const goBack = () => { closeModal(); if (typeof onBack === 'function') { try { onBack(); } catch (e) {} } };
  const escHandler = e => { if (e.key === 'Escape') { e.stopPropagation(); goBack(); } };
  document.addEventListener('keydown', escHandler);
  modal.querySelector('.np-viewer-close').addEventListener('click', goBack);
  modal.querySelector('.np-viewer-back-btn').addEventListener('click', goBack);

  // 메모는 고객 응대 기록이자 개인정보 처리 기록이라 덧붙이기만 되고 지울 수 없다.
  // 지워야 할 때의 정상 경로 = 수신거부 대장(고객 정보 파기) 또는 위탁 종료 시 관리자 정리.
  const saveEdit = async () => {
    const added = textarea.value.trim();
    const imgs = (typeof npTakePending === 'function') ? npTakePending(textarea) : (note.images || []);
    if (!added && !imgs.length) { showToast('덧붙일 내용을 적어주세요'); textarea.focus(); return; }
    await npEnsureName();                              // 저장 직전에 이름 확보 — '(이름없음)' 방지
    const entry = npAppendMemo('', added);             // 이번에 덧붙이는 한 줄(이름·시각 포함)
    note.content = npAppendMemo(note.content, added);  // 기존 내용은 그대로 두고 뒤에 붙인다
    if (imgs.length) note.images = (note.images || []).concat(imgs.filter(x => !(note.images || []).includes(x)));
    note.updatedAt = new Date().toISOString();
    try { await window.api.store.set('notes', state.notes); } catch (e) {}
    try { renderNotes(); } catch (e) {}
    // 🔗 TM 고객관리에도 같은 메모를 반영한다 — 두 화면의 기록이 어긋나지 않게
    try {
      if (typeof CRM !== 'undefined' && CRM.emitSync && note.number) {
        CRM.emitSync(String(note.number).replace(/\D/g, ''), 'upsert', { phone: note.number, memo: entry });
      }
    } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('notes:changed')); } catch (e) {}
    closeModal();
    if (typeof onBack === 'function') { try { onBack(); } catch (e) {} }   // 저장 후 원래 화면(그룹 이력)으로
    showToast('메모가 추가됐어요');
    if (typeof refocusApp === 'function') refocusApp();
  };
  textarea.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveEdit(); }
  });
  modal.querySelector('.np-viewer-save-btn').addEventListener('click', saveEdit);

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// (제거됨) enableNoteEdit — 메모 뷰어가 인라인 편집(openNoteViewer)으로 재작성되면서
//   호출부가 사라진 죽은 함수였음.

// ============ 📖 새 메모 큰 화면 작성 (전체 화면 모달) ============
// 패널 textarea가 작아서 답답할 때 → 큰 모달로 자유롭게 작성
function openNoteComposer() {
  // 기존 작성 모달만 제거 (양식 편집 모달은 별도 클래스이므로 영향 없음)
  document.querySelectorAll('.np-composer-modal').forEach(m => m.remove());

  // 패널 textarea — 모달과 양방향 동기화 대상
  const panelInput = document.getElementById('np-input');
  const draftText = panelInput ? panelInput.value : '';

  const modal = document.createElement('div');
  modal.className = 'np-viewer-modal np-composer-modal';
  modal.innerHTML = `
    <div class="np-viewer-content">
      <div class="np-viewer-header">
        <span class="np-viewer-date">📖 메모장 (큰 화면)</span>
        <button class="np-viewer-close" title="닫기 (Esc) · 내용은 메모장에 그대로 남아요">✕</button>
      </div>
      <div class="np-viewer-body">
        <textarea id="np-modal-input" class="np-viewer-edit-input" placeholder="메모를 입력하세요... (Ctrl+Enter로 저장)"></textarea>
        <div id="np-modal-templates-row" class="np-templates-row" style="margin-top:10px;"></div>
      </div>
      <div class="np-viewer-footer">
        <span style="font-size:11px; color:var(--text-muted,#888);">💡 메모장과 자동 연동 · Ctrl+Enter 저장 · 외부 클릭으로는 안 닫힙니다</span>
        <div class="np-viewer-actions">
          <button class="np-viewer-cancel-btn">닫기</button>
          <button class="np-viewer-save-btn">💾 저장</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  makeNoteModalDraggable(modal.querySelector('.np-viewer-content'), modal.querySelector('.np-viewer-header'));

  const textarea = modal.querySelector('#np-modal-input');
  textarea.style.minHeight = '50vh';
  textarea.value = draftText;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  // 📌 모달 → 패널 실시간 동기화 (타이핑할 때마다 패널 textarea도 같이 업데이트)
  textarea.addEventListener('input', () => {
    if (panelInput) panelInput.value = textarea.value;
  });

  // 📌 모달 안 양식 row 렌더링 (패널과 동일한 로직 사용)
  renderNoteTemplates();

  // 📷 캡처 첨부 — 패널 메모(np-input)와 같은 첨부 목록을 공유 (저장은 패널에서 됨)
  try {
    if (panelInput) { panelInput.__pendingImages = panelInput.__pendingImages || []; }
    npEnableImageAttach(textarea, panelInput ? panelInput.__pendingImages : []);
    if (panelInput) { textarea.__pendingImages = panelInput.__pendingImages; textarea.__renderImgStrip && textarea.__renderImgStrip(); }
  } catch (e) {}

  const closeModal = (justClose = true) => {
    // 닫을 때 마지막 동기화 (작성 중 내용은 메모장에 유지)
    if (justClose && panelInput) panelInput.value = textarea.value;
    try { if (panelInput && panelInput.__renderImgStrip) panelInput.__renderImgStrip(); } catch (e) {}   // 📷 첨부 동기화
    modal.remove();
    document.removeEventListener('keydown', escHandler);
  };

  const escHandler = e => {
    if (e.key === 'Escape') {
      // 양식 편집 모달이 위에 떠있으면 그것이 먼저 닫혀야 함 → 작성 모달은 무시
      if (document.querySelector('.np-tpl-modal')) return;
      e.stopPropagation();
      closeModal();
    }
  };
  document.addEventListener('keydown', escHandler);

  const save = async () => {
    const content = textarea.value.trim();
    const imgs = (textarea.__pendingImages && textarea.__pendingImages.length) ? textarea.__pendingImages : [];
    if (!content && !imgs.length) {
      showToast('메모 내용을 입력하세요');
      textarea.focus();
      return;
    }
    // 🔗 패널 입력칸과 동기화한 뒤, 패널과 '완전히 동일한' 저장 로직(saveNote)에 위임한다.
    //    (이전엔 여기서 {id,content,createdAt}만 저장해서 번호·이름·통화결과·첨부 이미지·
    //     양식 필드가 모두 누락되고, 고객별로 묶이지도 않았음 — 이미지가 조용히 사라지는 버그)
    if (panelInput) panelInput.value = textarea.value;
    await saveNote();   // saveNote가 패널 input 비우기·목록 갱신·토스트까지 처리
    closeModal(false);  // justClose = false (saveNote가 이미 패널 input 비움 → 재동기화 X)
  };

  // Ctrl+Enter로 저장
  textarea.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });

  modal.querySelector('.np-viewer-close').addEventListener('click', () => closeModal());
  modal.querySelector('.np-viewer-cancel-btn').addEventListener('click', () => closeModal());
  modal.querySelector('.np-viewer-save-btn').addEventListener('click', save);
  // 외부 클릭으로는 닫히지 않음 (실수로 닫혀서 내용 유실 방지)
  // → ✕ 버튼 / 닫기 버튼 / Esc 키로만 닫힘
}

// ============ 📝 메모 양식 (템플릿) 시스템 ============
// 자주 쓰는 메모 형식을 저장하고, 클릭으로 textarea에 삽입

function renderNoteTemplates() {
  // 패널의 row(textarea 아래 / 저장된메모 위) 2개 + (열려있다면) 모달의 row들 모두 렌더링
  const rows = [];
  const panelRow = document.getElementById('np-templates-row');
  if (panelRow) rows.push(panelRow);
  const modalRow = document.getElementById('np-modal-templates-row');
  if (modalRow) rows.push(modalRow);
  // 📝 저장된 메모 편집 모드의 양식 행
  const readerRow = document.getElementById('np-reader-templates-row');
  if (readerRow) rows.push(readerRow);
  rows.forEach(renderTemplatesIntoRow);
}

function renderTemplatesIntoRow(row) {
  if (!row) return;
  const editing = !!state.npTemplatesEditing;
  const templates = state.noteTemplates || [];
  const isModalRow = row.id === 'np-modal-templates-row';

  // ID 충돌 방지 — 모달의 row는 다른 ID 접미사 사용
  const sfx = isModalRow ? '-m' : '';

  // 비어있을 때 안내 메시지 + 추가 버튼만
  if (templates.length === 0) {
    row.innerHTML = `
      <span class="np-templates-empty">자주 쓰는 양식을 등록해 보세요 →</span>
      <button type="button" class="np-template-add-btn" data-add-tpl title="새 양식 추가">＋ 양식 추가</button>
    `;
  } else {
    let html = '';
    templates.forEach(t => {
      const preview = (t.content || '').replace(/\s+/g, ' ').slice(0, 80);
      const cls = editing ? 'np-template-btn editing' : 'np-template-btn';
      html += `<button type="button" class="${cls}" data-tpl-id="${t.id}" title="${escapeHtml(preview)}${preview.length >= 80 ? '…' : ''}">`;
      html += escapeHtml(t.label);
      if (editing) {
        html += `<span class="np-template-del" data-del-id="${t.id}" title="삭제">✕</span>`;
      }
      html += `</button>`;
    });
    // 추가 버튼
    html += `<button type="button" class="np-template-add-btn" data-add-tpl title="새 양식 추가">＋</button>`;
    // 편집 토글 버튼
    html += `<button type="button" class="np-template-edit-toggle${editing ? ' active' : ''}" data-edit-tpl title="${editing ? '편집 완료' : '양식 편집/삭제'}">${editing ? '✓ 완료' : '✎ 편집'}</button>`;
    row.innerHTML = html;
  }

  // 이벤트 리스너 바인딩 (data 속성으로 → 다중 row에서도 ID 충돌 없음)
  row.querySelectorAll('.np-template-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      // 삭제 ✕ 버튼은 별도 처리
      const delEl = e.target.closest('.np-template-del');
      if (delEl) {
        e.stopPropagation();
        deleteNoteTemplate(delEl.dataset.delId);
        return;
      }
      if (state.npTemplatesEditing) {
        // 편집 모드: 편집 모달
        openTemplateEditModal(btn.dataset.tplId);
      } else if (row.id === 'np-templates-row') {
        // 패널(도킹 메모장): 텍스트 붙여넣기 대신 실제 입력칸 생성
        buildNoteForm(btn.dataset.tplId);
      } else {
        // 모달/저장메모 편집: 기존처럼 textarea에 삽입
        applyNoteTemplate(btn.dataset.tplId);
      }
    });
  });

  const addBtn = row.querySelector('[data-add-tpl]');
  if (addBtn) addBtn.addEventListener('click', () => openTemplateEditModal(null));
  const editBtn = row.querySelector('[data-edit-tpl]');
  if (editBtn) editBtn.addEventListener('click', toggleTemplatesEditing);
}

// ============ 📋 양식 → 실제 입력칸 (도킹 메모장 전용) ============
// 양식 줄을 파싱해서 입력칸을 만든다. 'label : 기본값' 형태면 입력칸,
// ':' 없으면 섹션 제목(입력칸 없음). 저장 시 입력값을 다시 텍스트로 합치고
// 성함/이름 → 이름칸, 연락처/전화/번호 → 번호칸으로 매핑한다.
let __npFormFields = null;  // [{label, value, key}]  현재 폼 활성 여부 표시도 겸함

function buildNoteForm(id) {
  const tpl = (state.noteTemplates || []).find(t => t.id === id);
  const form = document.getElementById('np-form');
  const input = document.getElementById('np-input');
  if (!tpl || !form) return;

  const lines = (tpl.content || '').split(/\r?\n/);
  __npFormFields = [];
  let html = `<div class="np-form-head"><span>📋 ${escapeHtml(tpl.label)}</span><button type="button" id="np-form-close" title="양식 닫고 자유 메모로">✕ 양식 닫기</button></div>`;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    // 모든 줄을 입력칸으로 (':' 있으면 그 뒤가 기본값) — '보셨던 단지?' 같은 줄도 입력칸
    const ci = line.indexOf(':');
    const label = ci === -1 ? line : line.slice(0, ci).trim();
    const def = ci === -1 ? '' : line.slice(ci + 1).trim();
    const key = 'npf-' + i;
    __npFormFields.push({ label, key });
    html += `<div class="np-form-row"><label title="${escapeHtml(label)}">${escapeHtml(label)}</label><input type="text" data-npf="${key}" value="${escapeHtml(def)}"></div>`;
  });
  // 맨 밑 자유 메모칸 (#6)
  html += `<div class="np-form-memo-wrap"><label>📝 메모</label><textarea id="np-form-memo" placeholder="추가 메모…"></textarea></div>`;
  form.innerHTML = html;
  form.style.display = '';
  if (input) input.style.display = 'none';

  form.querySelectorAll('input[data-npf]').forEach(el => el.addEventListener('input', syncFormToInfo));
  const closeBtn = document.getElementById('np-form-close');
  if (closeBtn) closeBtn.addEventListener('click', closeNoteForm);
  syncFormToInfo();
}

function syncFormToInfo() {
  const form = document.getElementById('np-form');
  if (!form) return;
  const nameEl = document.getElementById('np-name');
  const phoneEl = document.getElementById('np-phone');
  form.querySelectorAll('.np-form-row').forEach(row => {
    const label = row.querySelector('label')?.textContent || '';
    const v = row.querySelector('input')?.value.trim() || '';
    if (!v) return;
    if (/성함|이름/.test(label) && nameEl) nameEl.value = v;
    if (/연락처|전화|휴대|번호/.test(label) && phoneEl) phoneEl.value = v;
  });
}

// 폼이 활성이면: #np-input 에 합친 텍스트를 넣고, 항목별 fields 배열을 반환
function assembleNoteForm() {
  const form = document.getElementById('np-form');
  const input = document.getElementById('np-input');
  if (!form || form.style.display === 'none' || !__npFormFields) return null;
  const fields = [];
  const parts = [];
  form.querySelectorAll('.np-form-row').forEach(row => {
    const label = row.querySelector('label')?.textContent || '';
    const val = row.querySelector('input')?.value.trim() || '';
    fields.push({ label, value: val });
    parts.push(`${label} : ${val}`);
  });
  const memoEl = document.getElementById('np-form-memo');
  const memoVal = memoEl ? memoEl.value.trim() : '';
  if (memoVal) { fields.push({ label: '메모', value: memoVal }); parts.push(`메모 : ${memoVal}`); }
  syncFormToInfo();
  if (input) input.value = parts.join('\n');
  return fields;
}

function closeNoteForm() {
  const form = document.getElementById('np-form');
  const input = document.getElementById('np-input');
  __npFormFields = null;
  if (form) { form.style.display = 'none'; form.innerHTML = ''; }
  if (input) { input.style.display = ''; input.focus(); }   // #8: 양식 닫으면 메모장 다시
}
// 발신 패널이 [다음 번호] 시 열린 양식을 본문으로 합쳐 기록에 담을 수 있게 노출
window.__assembleNoteForm = assembleNoteForm;

// 양식 내용을 textarea의 커서 위치에 삽입
// 우선순위: 저장된메모 편집 textarea → 큰화면 작성 모달 → 패널
// 큰화면 작성 모달일 때만 패널과 양방향 동기화 (편집 모달은 독립적)
function applyNoteTemplate(id) {
  const tpl = (state.noteTemplates || []).find(t => t.id === id);
  if (!tpl) return;

  const readerInput = document.getElementById('np-reader-edit-input');
  const modalInput = document.getElementById('np-modal-input');
  const panelInput = document.getElementById('np-input');
  // 📝 저장된 메모 편집 중이면 그 textarea가 최우선
  const target = readerInput || modalInput || panelInput;
  if (!target) return;

  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  const before = target.value.substring(0, start);
  const after = target.value.substring(end);
  // 앞에 내용이 있고 줄바꿈으로 안 끝나면 줄바꿈 추가
  const sep = (before.length > 0 && !before.endsWith('\n')) ? '\n' : '';
  const insertion = sep + tpl.content;
  target.value = before + insertion + after;

  const newPos = start + insertion.length;
  target.focus();
  target.setSelectionRange(newPos, newPos);

  // 📌 큰화면 작성 모달 ↔ 패널 양방향 동기화 (편집 모달은 독립 → 동기화 안 함)
  if (!readerInput && modalInput && panelInput && modalInput !== panelInput) {
    if (target === modalInput) {
      panelInput.value = modalInput.value;
    } else {
      modalInput.value = panelInput.value;
    }
  }
}

// 편집 모드 토글
function toggleTemplatesEditing() {
  state.npTemplatesEditing = !state.npTemplatesEditing;
  renderNoteTemplates();
}

// 양식 삭제
async function deleteNoteTemplate(id) {
  const tpl = (state.noteTemplates || []).find(t => t.id === id);
  if (!tpl) return;
  if (!confirm(`"${tpl.label}" 양식을 삭제할까요?`)) return;
  state.noteTemplates = state.noteTemplates.filter(t => t.id !== id);
  await window.api.store.set('noteTemplates', state.noteTemplates);
  renderNoteTemplates();
  showToast('양식 삭제됨');
}

// 양식 추가/수정 모달
function openTemplateEditModal(id) {
  const isNew = !id;
  let tpl;
  if (isNew) {
    tpl = { id: 'tpl-' + Date.now(), label: '', content: '' };
  } else {
    tpl = (state.noteTemplates || []).find(t => t.id === id);
    if (!tpl) return;
  }

  // 기존 양식 편집 모달만 제거 (작성 모달은 그대로 유지 — 그 위에 겹쳐 띄움)
  document.querySelectorAll('.np-tpl-modal').forEach(m => m.remove());

  const modal = document.createElement('div');
  modal.className = 'np-viewer-modal np-tpl-modal';
  modal.style.zIndex = '10001';  // 작성 모달(10000) 위에
  modal.innerHTML = `
    <div class="np-viewer-content">
      <div class="np-viewer-header">
        <span class="np-viewer-date">${isNew ? '➕ 새 양식 추가' : '✏️ 양식 편집'}</span>
        <button class="np-viewer-close" title="닫기 (Esc)">✕</button>
      </div>
      <div class="np-viewer-body">
        <div style="display:flex; flex-direction:column; gap:14px;">
          <div>
            <label style="display:block; font-size:12px; color:var(--text-muted,#999); margin-bottom:6px; font-weight:600;">양식 이름 (버튼에 표시될 짧은 라벨)</label>
            <input type="text" class="np-tpl-label-input" maxlength="20" placeholder="예: 첫 통화, 부재중, 후속 안내">
          </div>
          <div>
            <label style="display:block; font-size:12px; color:var(--text-muted,#999); margin-bottom:6px; font-weight:600;">양식 내용 (메모장에 삽입될 텍스트)</label>
            <textarea class="np-viewer-edit-input np-tpl-content-input" placeholder="예:&#10;[일시] &#10;[성함] &#10;[관심사항]&#10;- &#10;- &#10;[다음 연락]"></textarea>
          </div>
        </div>
      </div>
      <div class="np-viewer-footer">
        <span style="font-size:11px; color:var(--text-muted,#888);">Ctrl+Enter 저장 · Esc 닫기</span>
        <div class="np-viewer-actions">
          <button class="np-viewer-cancel-btn">취소</button>
          <button class="np-viewer-save-btn">💾 저장</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  makeNoteModalDraggable(modal.querySelector('.np-viewer-content'), modal.querySelector('.np-viewer-header'));

  const labelInput = modal.querySelector('.np-tpl-label-input');
  const contentInput = modal.querySelector('.np-tpl-content-input');
  labelInput.value = tpl.label;
  contentInput.value = tpl.content;
  // 새 양식은 라벨 입력칸 포커스, 편집은 내용 포커스
  if (isNew) {
    labelInput.focus();
  } else {
    contentInput.focus();
    contentInput.setSelectionRange(contentInput.value.length, contentInput.value.length);
  }

  const closeModal = () => {
    modal.remove();
    document.removeEventListener('keydown', escHandler);
  };
  const escHandler = e => {
    if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
  };
  document.addEventListener('keydown', escHandler);

  const saveTpl = async () => {
    const label = labelInput.value.trim();
    const content = contentInput.value;
    if (!label) {
      showToast('양식 이름을 입력하세요');
      labelInput.focus();
      return;
    }
    if (!content.trim()) {
      showToast('양식 내용을 입력하세요');
      contentInput.focus();
      return;
    }
    tpl.label = label;
    tpl.content = content;
    if (isNew) {
      if (!Array.isArray(state.noteTemplates)) state.noteTemplates = [];
      state.noteTemplates.push(tpl);
    }
    await window.api.store.set('noteTemplates', state.noteTemplates);
    renderNoteTemplates();
    closeModal();
    showToast(isNew ? '양식 추가됨' : '양식 수정됨');
  };

  // Ctrl+Enter로 저장
  const ctrlEnterHandler = e => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveTpl();
    }
  };
  labelInput.addEventListener('keydown', ctrlEnterHandler);
  contentInput.addEventListener('keydown', ctrlEnterHandler);
  // 라벨에서 Enter → 내용으로 포커스 이동
  labelInput.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      contentInput.focus();
    }
  });

  modal.querySelector('.np-viewer-close').addEventListener('click', closeModal);
  modal.querySelector('.np-viewer-cancel-btn').addEventListener('click', closeModal);
  modal.querySelector('.np-viewer-save-btn').addEventListener('click', saveTpl);
  // 외부 클릭으로는 닫히지 않음 (✕ 버튼 / 취소 / Esc로만 닫힘)
}


document.addEventListener('DOMContentLoaded', init);

// (제거됨) 현재 고객 입력 드래프트 자동저장 — 고객 관리는 콜관리(CRM)로 일원화하며 함께 삭제.
