// ============================================================
//  layout.js — 패널 자유 배치 (#3 숨김 / #8 리사이즈·이동·미리보기)
//  4개 패널: 발신(dialer) · 사이드바(sidebar) · 메모(memo) · 카드(cards)
//  flex 기반으로 전환 → 폭 드래그 조절, 헤더 끌어 순서 이동(미리보기 선),
//  카드보드 숨김/소환, 기본 배치 복원. 위치/숨김 전부 저장.
// ============================================================
(function () {
  const SKEY = 'layoutV3';
  const SPLITTER_PX = 10;   // .lay-splitter 폭 (dialer.css) — 이관 계산에 사용
  const PANELS = [
    { id: 'dialer', sel: '.dialer-rail', label: '📞 발신+메모', w: 560, min: 300, grow: true },
    { id: 'sidebar', sel: '.sidebar', label: '📌 단지·고객', w: 220, min: 190, grow: false },
    { id: 'memo', sel: '.memo-area', label: '💬 멘트·빠른대응', w: 380, min: 300, grow: false },
    { id: 'cards', sel: '.card-panel', label: '📋 스크립트', w: 340, min: 280, grow: true },
    { id: 'crm', sel: '#crm-root', label: '🗂 콜 관리', w: 520, min: 260, grow: false },
  ];
  // 패널 최소폭 (이 밑으로는 못 줄임 → 서로 공간 침범/내용 잘림 방지)
  // 📐 콜 관리 260px 근거(2026-09-10 실측): 340/320/300/280/260/240 여섯 폭을 실제로 렌더해 확인.
  //    240px 에서 상단 탭 5개(오늘·고객DB·캘린더·현황·고객관리)가 전부 잘려 못 쓴다. 260px 까지는
  //    가로스크롤·요소겹침·탭잘림이 없다. 그래서 안전 하한 = 260. 화면이 좁은 PC(또는 화면배율을
  //    올려둔 PC)에서 이 패널이 320 에 닿아 드래그가 아예 안 먹던 문제 때문에 320 → 260 으로 내렸다.
  //    (min 은 '하한'일 뿐이라 넓게 쓰는 사람에겐 아무 영향이 없다.)
  function panelMin(id) { const p = PANELS.find(x => x.id === id); return (p && p.min) || 160; }
  // ============================================================
  //  📏 픽셀 고정 레이아웃 (cfg.widths = '비율'이 아니라 '실제 px')
  //  ------------------------------------------------------------
  //  ⚠ 예전엔 `flex: <가중치> 1 0px` (flex-basis:0 + grow 비율)이라
  //     각 패널 폭 = 창폭 × 내 가중치 ÷ 가중치합 → **창·모니터 크기가 바뀌면 모든 패널 폭이
  //     같이 변했다.** 그래서 ① 경계를 끌면 멀리 있는 발신창까지 따라 움직이고
  //     ② 쓰는 사람 모니터가 다르면 패널 폭이 달라져 버튼 모양·줄이 제각각이 됐다.
  //  ✅ 이제 고정 패널은 `flex: 0 1 <px>px` — 안 늘어나고(0), 기준은 내 px.
  //     → 모니터가 커지든 작아지든 패널은 자기 px를 그대로 지킨다(버튼 모양·줄 불변).
  //     → 경계 드래그는 두 이웃의 px만 주고받아(합 보존) 나머지 패널은 1px도 안 움직인다.
  //  · 남는/모자란 공간은 '맨 오른쪽 보이는 패널' 하나가 흡수 → 빈 검은 띠도, 다른 패널 흔들림도 없음.
  //    (목록형이라 넓어져도 버튼이 재배치되지 않는 패널이 마지막에 오게 되어 있음)
  //  ⚠ 흡수 패널의 flex-shrink 를 ABSORB_SHRINK(아주 큰 값)로 주는 게 핵심.
  //     flex-grow 만 1로 주면 '넓힐 때'만 흡수하고 '좁힐 때'는 shrink 가 모두 1이라
  //     고정 패널까지 basis 비율대로 같이 줄어든다(1400px 창에서 발신창 560→529 로 쭈그러들던 버그).
  //     shrink 는 (shrink계수 × basis) 비율로 배분되므로 계수를 크게 주면 흡수 패널이 사실상 혼자
  //     줄어든다(고정 패널 오차 0.02px 미만 = 화면상 동일). 흡수 패널이 자기 min-width 에 닿아
  //     더 못 줄면 그때서야 나머지가 min 까지 같이 압축된다 — 창이 아주 좁을 때의 최후 수단.
  // ============================================================
  const ABSORB_SHRINK = 10000;
  function panelPx(id) {
    const p = PANELS.find(x => x.id === id);
    let w = cfg && cfg.widths ? cfg.widths[id] : null;
    if (!(w > 0)) w = p ? p.w : 320;
    return Math.max(panelMin(id), Math.round(w));   // 저장된 값이 최소폭보다 작아도 보정
  }
  // 맨 오른쪽 보이는 패널 = 남는/모자란 공간 흡수 담당
  function lastVisibleId() { return cfg.order.filter(id => !cfg.hidden[id] && el(id)).pop(); }
  // 'flex: <grow> <shrink> ' 접두 — 흡수 패널만 늘고 줄고, 나머지는 자기 px 고정
  function flexFor(id) { return (id === lastVisibleId()) ? ('1 ' + ABSORB_SHRINK + ' ') : '0 1 '; }
  function setPx(id, px) {
    cfg.widths[id] = Math.max(panelMin(id), Math.round(px));
    const node = el(id); if (!node) return;
    // 드래그 중에도 흡수 패널의 grow/shrink 를 유지해야 함 — 안 그러면 끄는 동안 오른쪽에 빈 띠가 생겼다 사라진다
    node.style.flex = flexFor(id) + cfg.widths[id] + 'px'; node.style.width = ''; node.style.minWidth = panelMin(id) + 'px';
  }
  let cfg = null; // {order:[ids], widths:{id:weight}, hidden:{id:bool}}

  function defaultCfg() {
    return {
      order: PANELS.map(p => p.id),
      widths: PANELS.reduce((a, p) => (a[p.id] = p.w, a), {}),
      // 고정 3분할: 발신 + 멘트·빠른대응 + 콜관리. (카드목록/사이드바 패널은 항상 숨김 → 제거됨)
      hidden: { cards: true, sidebar: true, memo: false, crm: false },
      scriptHidden: true,
    };
  }
  function el(id) { const p = PANELS.find(x => x.id === id); return p ? document.querySelector(p.sel) : null; }

  // 이전 동작(드래그/리사이즈/구버전 레이아웃)에서 남았을 수 있는 '가로 어긋남' 인라인 스타일 제거.
  // 패널/본문이 엉뚱하게 밀리거나 잘리는 현상의 잔존 원인을 매 적용마다 청소 → CSS 기본값 복원.
  function clearStaleX(n) {
    if (!n) return;
    n.style.marginLeft = ''; n.style.marginRight = '';
    n.style.transform = ''; n.style.left = ''; n.style.right = '';
    n.style.paddingLeft = ''; n.style.paddingRight = '';
  }

  function apply() {
    document.body.classList.add('flex-layout');
    document.body.classList.remove('has-dialer'); // grid 규칙 무력화
    document.body.classList.toggle('script-hidden', !!cfg.scriptHidden);
    // 순서 + 폭(px) + 숨김 반영. 폭은 창 크기와 무관하게 각자 px를 지킨다(위 📏 주석 참고).
    cfg.order.forEach((id, i) => {
      const node = el(id); if (!node) return;
      clearStaleX(node);          // 패널에 남은 가로 어긋남 제거
      node.style.order = i * 2;
      node.dataset.panel = id;
      if (cfg.hidden[id]) { node.style.display = 'none'; return; }
      node.style.display = '';   // 숨김 해제 (CSS 기본 flex 복원)
      const px = panelPx(id);
      cfg.widths[id] = px;
      node.style.flex = flexFor(id) + px + 'px';   // 맨 오른쪽만 흡수, 나머지는 px 고정
      node.style.width = ''; node.style.minWidth = panelMin(id) + 'px';
    });
    // 🩹 스크립트(멘트) 본문이 오른쪽으로 밀려 왼쪽이 잘리던 현상 방지:
    //    멘트 패널 내부 요소들의 가로 어긋남 인라인 스타일을 정리해 항상 패널 왼쪽에 정렬되게.
    ['memo-view', 'memo-content', 'memo-bottom-grid'].forEach(eid => clearStaleX(document.getElementById(eid)));
    const mh = document.querySelector('.memo-area .memo-header'); clearStaleX(mh);
    placeSplitters();
    placeHandles();
    toggleScriptSections();
    reportLayoutWidth();
    save();
  }

  // 🖥 '내 배치 총폭'을 main 에 알려 창 폭에 맞춰 앱 전체를 확대/축소하게 한다(main.js applyFitZoom).
  //    → CSS 뷰포트 폭 ≈ 배치폭 이 되어 작은 모니터든 4K든 화면이 똑같이 보인다.
  //    폭은 창 크기와 무관한 cfg.widths(px) 로 계산하므로 줌이 바뀌어도 값이 흔들리지 않는다(되먹임 없음).
  function layoutWidth() {
    const vis = cfg.order.filter(id => !cfg.hidden[id] && el(id));
    if (!vis.length) return 0;
    return vis.reduce((a, id) => a + panelPx(id), 0) + (vis.length - 1) * SPLITTER_PX;
  }
  // 최소 배치폭 = 보이는 패널들의 min-width 합 + 스플리터 — 이보다 뷰포트가 좁아지면
  // 패널이 뭉개지거나 오른쪽이 잘린다. main.js가 확대(Ctrl+=) 상한으로 사용.
  function layoutMinWidth() {
    const vis = cfg.order.filter(id => !cfg.hidden[id] && el(id));
    if (!vis.length) return 0;
    return vis.reduce((a, id) => a + panelMin(id), 0) + (vis.length - 1) * SPLITTER_PX;
  }
  // 패널을 켜고 끄는 순간에만 true — 배치폭이 바뀌어도 화면 배율은 그대로 유지시킨다.
  let keepZoomOnce = false;
  function reportLayoutWidth() {
    const w = layoutWidth();
    // minW도 함께 보고 — 확대를 아무리 눌러도 '모든 패널이 최소폭'인 지점에서 멈추게(뭉개짐 방지)
    if (w > 0) { try { if (window.api && window.api.zoomFit) window.api.zoomFit(w, layoutMinWidth(), keepZoomOnce); } catch (e) {} }
    keepZoomOnce = false;   // 한 번만 적용 (창 크기 변경 등 다른 경로엔 영향 없음)
  }

  // 사이드바의 단지정보(pinned) + 카테고리 섹션만 숨김 (현재고객·백업은 유지)
  function toggleScriptSections() {
    const sb = document.querySelector('.sidebar'); if (!sb) return;
    const pinned = sb.querySelector('.pinned-section');
    if (pinned) pinned.style.display = cfg.scriptHidden ? 'none' : '';
    sb.querySelectorAll('.sidebar-section').forEach(sec => {
      if (sec.classList.contains('pinned-section')) return;
      if (sec.querySelector('.filter-btn')) sec.style.display = cfg.scriptHidden ? 'none' : '';
    });
  }

  // ---- 폭 조절 스플리터 ----
  function clearSplitters() { document.querySelectorAll('.lay-splitter').forEach(s => s.remove()); }
  function placeSplitters() {
    clearSplitters();
    const visible = cfg.order.filter(id => !cfg.hidden[id]);
    for (let i = 0; i < visible.length - 1; i++) {
      const leftId = visible[i];
      const sp = document.createElement('div');
      sp.className = 'lay-splitter';
      sp.style.order = (cfg.order.indexOf(leftId) * 2) + 1;
      sp.title = '드래그해서 폭 조절';
      sp.addEventListener('mousedown', (e) => startResize(e, leftId, visible[i + 1]));
      document.body.appendChild(sp);
    }
  }
  function startResize(e, leftId, rightId) {
    e.preventDefault();
    const leftNode = el(leftId), rightNode = el(rightId);
    if (!leftNode || !rightNode) return;
    const startX = e.clientX;
    // ⚠ 반드시 '저장된 px'(cfg.widths) 공간에서만 주고받는다 — 화면 실측폭(getBoundingClientRect) 금지.
    //    맨 오른쪽 '흡수' 패널은 화면폭 = 저장폭 + (뷰포트 남는 공간) 이라 실측 ≠ 저장값인데,
    //    실측폭으로 합(pairPx)을 잡으면 그 남는 공간이 저장 px에 섞여 들어가 배치 총폭(layoutWidth)이
    //    드래그할 때마다 눈덩이처럼 불어나고(랫칫), fit zoom(main.js)이 그만큼 앱 전체를 갑자기
    //    축소시켰다 — "스플리터만 건드리면 화면·글씨가 30%씩 널뛰던" 실사고의 근본 원인.
    //    저장 px 공간에서는 두 이웃의 합이 항상 보존돼 총폭 불변 → 줌도 절대 안 흔들린다.
    //    (마우스 추적도 정확: 고정 패널은 저장 px = 화면 px 이고, 흡수 패널 쪽 경계는 왼쪽 고정
    //     패널의 px만 바꾸므로 경계선이 마우스를 1:1로 따라온다)
    const startLW = panelPx(leftId);
    const startRW = panelPx(rightId);
    const minL = panelMin(leftId), minR = panelMin(rightId);
    const pairPx = startLW + startRW;        // 두 이웃의 '저장 px' 합 (이 경계에서 보존)
    if (pairPx <= 0) return;
    // 🩹 흡수 패널(맨 오른쪽)은 '저장 px'와 '화면 폭'이 다르다 — 남는 공간을 혼자 먹기 때문.
    //    저장값만 보고 상한을 잡으면, 화면에서는 이미 최소폭에 닿았는데도 왼쪽 패널이 계속 늘어난다.
    //    그러면 배치 총폭이 뷰포트를 넘겨 flex-shrink 가 발동하고, 고정 패널(발신창)까지 같이
    //    쭈그러들어 **반대편 경계선이 따라 움직이는** 현상이 났다.
    //    → 오른쪽 이웃이 흡수 패널일 때는 '화면에서 더 줄일 수 있는 여유'로 상한을 한 번 더 조인다.
    let maxL = pairPx - minR;
    if (rightId === lastVisibleId()) {
      const slack = Math.max(0, rightNode.getBoundingClientRect().width - minR);
      maxL = Math.min(maxL, startLW + slack);
    }
    document.body.style.cursor = 'col-resize';
    document.body.classList.add('lay-resizing');
    function move(ev) {
      const dx = ev.clientX - startX;
      // 경계를 dx만큼 이동 → 왼쪽 폭 결정 (최소폭 보장 범위 안에서)
      const newLpx = Math.max(minL, Math.min(startLW + dx, maxL));
      // 두 이웃의 px 합을 그대로 보존해서 주고받기 → 나머지 패널은 1px도 안 움직인다
      setPx(leftId, newLpx);
      setPx(rightId, pairPx - newLpx);
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.classList.remove('lay-resizing');
      apply();   // 리사이즈 끝 → 전체 재적용(스플리터·잔존스타일 정리). cfg.widths는 setPx가 갱신해둠
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ---- 순서 이동 핸들 (헤더 ⠿ 끌기 → 미리보기 선) ----
  function clearHandles() { document.querySelectorAll('.lay-handle').forEach(h => h.remove()); }
  function placeHandles() {
    clearHandles();
    cfg.order.forEach(id => {
      if (cfg.hidden[id]) return;
      // 🔒 발신(dialer)·콜관리(crm)는 위치 이동 잠금 — 이동 핸들을 만들지 않는다.
      //    (폭 조절 스플리터는 유지 → 크기는 변경 가능. 가운데 멘트만 이동/토글 가능)
      if (id === 'dialer' || id === 'crm') return;
      const node = el(id); if (!node) return;
      const h = document.createElement('div');
      h.className = 'lay-handle';
      h.title = '끌어서 패널 위치 이동';
      h.innerHTML = '⠿';
      h.addEventListener('mousedown', (e) => startDrag(e, id));
      node.style.position = node.style.position || 'relative';
      node.appendChild(h);
    });
  }
  let dropLine = null;
  function startDrag(e, id) {
    e.preventDefault();
    const ghost = document.createElement('div');
    ghost.className = 'lay-ghost';
    ghost.textContent = PANELS.find(p => p.id === id).label;
    document.body.appendChild(ghost);
    dropLine = document.createElement('div');
    dropLine.className = 'lay-dropline';
    document.body.appendChild(dropLine);

    function move(ev) {
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 12 + 'px';
      // 가장 가까운 삽입 위치 계산 (보이는 패널들의 중앙선 기준)
      const visible = cfg.order.filter(x => !cfg.hidden[x]);
      let bestX = null, bestIdx = visible.length;
      visible.forEach((vid, i) => {
        const r = el(vid).getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (ev.clientX < mid && bestX === null) { bestX = r.left; bestIdx = i; }
      });
      const lineX = bestX !== null ? bestX : (visible.length ? el(visible[visible.length - 1]).getBoundingClientRect().right : 0);
      dropLine.style.left = (lineX - 2) + 'px';
      dropLine._idx = bestIdx;
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      const visible = cfg.order.filter(x => !cfg.hidden[x]);
      const targetIdx = dropLine._idx != null ? dropLine._idx : visible.length;
      // visible 기준 위치를 전체 order로 변환
      reorder(id, visible, targetIdx);
      ghost.remove(); dropLine.remove(); dropLine = null;
      apply();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  function reorder(id, visible, targetIdx) {
    const newVisible = visible.filter(x => x !== id);
    newVisible.splice(Math.min(targetIdx, newVisible.length), 0, id);
    // hidden 패널은 뒤에 유지
    const hidden = cfg.order.filter(x => cfg.hidden[x]);
    cfg.order = [...newVisible, ...hidden.filter(h => !newVisible.includes(h))];
  }

  // ============================================================
  //  🚧 패널 동시 표시 최대 3개 제한
  //     4개를 띄우면 가로폭이 쪼그라들어 빠른대응 카드·가망 파이프라인 박스가 잘림.
  //     켜는 순간 3개를 넘기면 '맨 오른쪽' 보이는 패널을 숨겨 자리를 양보 →
  //     맨 오른쪽 자리가 새 패널로 교체되는 효과. 발신(dialer)은 앵커라 항상 유지.
  // ============================================================
  const MAX_VISIBLE_PANELS = 3;
  function visiblePanelsInOrder() {
    const ord = (cfg && cfg.order) ? cfg.order : [];
    return ord.filter(id => !cfg.hidden[id] && el(id));
  }
  // 패널 idToShow 를 켜기 직전 호출 — 3개를 넘기면 오른쪽 끝 패널을 숨김
  function evictForCap(idToShow) {
    if (!cfg) return;
    const vis = visiblePanelsInOrder();
    const willCount = vis.includes(idToShow) ? vis.length : vis.length + 1;
    if (willCount <= MAX_VISIBLE_PANELS) return;
    for (let i = vis.length - 1; i >= 0; i--) {
      const cand = vis[i];
      if (cand === idToShow || cand === 'dialer') continue;   // 켤 패널·발신 앵커 제외
      cfg.hidden[cand] = true;
      if (cand === 'crm') document.body.classList.remove('crm-docked');
      break;
    }
  }
  // 시작 시 저장된 레이아웃이 이미 4개 이상이면 오른쪽부터 잘라 3개로 맞춤
  function enforceCapOnLoad() {
    if (!cfg) return;
    let vis = visiblePanelsInOrder(), guard = 0;
    while (vis.length > MAX_VISIBLE_PANELS && guard++ < 10) {
      let removed = false;
      for (let i = vis.length - 1; i >= 0; i--) {
        if (vis[i] === 'dialer') continue;
        cfg.hidden[vis[i]] = true;
        if (vis[i] === 'crm') document.body.classList.remove('crm-docked');
        removed = true; break;
      }
      if (!removed) break;
      vis = visiblePanelsInOrder();
    }
  }

  // 편집 메뉴(상단) 동작 처리 — 하단 바 대신 메뉴로
  // 가운데(멘트·빠른대응)만 토글. 카드목록/사이드바 토글은 제거(고정 3분할).
  function toggleMemo() { const show = cfg.hidden.memo; if (show) evictForCap('memo'); cfg.hidden.memo = !show; keepZoomOnce = true; apply(); }
  function resetLayout() {
    cfg = defaultCfg();   // sized(수동 폭)도 함께 초기화됨
    apply();
    // 표준 화면 = 발신 + 콜관리(도킹). 복원 시에도 콜관리를 다시 열어 같은 모습으로.
    try { if (window.CRM && window.CRM.open) window.CRM.open(); } catch (e) {}
  }
  function clickById(id) { const b = document.getElementById(id); if (b) b.click(); }

  // ---- 🗂 콜 관리 도킹: 발신 옆에 CRM 표시. 멘트/카드는 건드리지 않음 → 독립 토글 ----
  function openCrmDock() {
    if (!cfg) return;
    if (cfg.hidden.crm) evictForCap('crm');   // 숨김→표시 전환 시에만 3개 제한 적용
    cfg.hidden.crm = false;
    document.body.classList.add('crm-docked');
    keepZoomOnce = true;
    apply();
  }
  function closeCrmDock() {
    if (!cfg) return;
    cfg.hidden.crm = true;
    document.body.classList.remove('crm-docked');
    keepZoomOnce = true;
    apply();
  }
  // Ctrl+4 등으로 콜관리 토글 (열림/닫힘에 따라). CRM.open/close 로 데이터 로딩까지 처리.
  function toggleCrm() {
    if (!cfg) return;
    if (!cfg.hidden.crm) { if (window.CRM && window.CRM.close) window.CRM.close(); else closeCrmDock(); }
    else { if (window.CRM && window.CRM.open) window.CRM.open(); else openCrmDock(); }
  }
  window.__layout = { openCrmDock, closeCrmDock, toggleCrm, isCrmOpen: () => !!(cfg && !cfg.hidden.crm) };

  function handleMenu(action) {
    switch (action) {
      case 'toggle-memo': toggleMemo(); break;
      case 'toggle-crm': toggleCrm(); break;
      case 'layout-reset': resetLayout(); break;
      case 'font-settings': clickById('open-font-settings-btn'); break;
      case 'json-import': clickById('open-json-import-btn'); break;
      case 'tutorial': try { if (window.Tutorial) window.Tutorial.start(true); } catch (e) {} break;
    }
  }

  function save() { try { window.api.store.set(SKEY, cfg); } catch (e) {} }

  // 🩹 레이아웃 재적용 도우미
  //  - requestApply: 창 리사이즈 등에서 디바운스로 재적용 (잦은 호출 흡수)
  //  - settleLayout: 창 최대화/자동줌이 '첫 페인트 뒤'에 적용돼 콜관리 패널이
  //    화면 밖으로 밀려 잘리던 문제 방지 → 창이 안정될 때까지 몇 번 더 재적용
  let _applyT = null;
  function requestApply() { clearTimeout(_applyT); _applyT = setTimeout(() => { if (cfg) apply(); }, 150); }
  function settleLayout() {
    const run = () => { if (cfg) apply(); };
    try { requestAnimationFrame(() => requestAnimationFrame(run)); } catch (e) { run(); }
    [120, 350, 700].forEach(ms => setTimeout(run, ms));
  }

  async function init() {
    // 패널 다 생길 때까지 대기 (dialer-rail 은 dialer.renderer.js 가 만든다)
    if (!document.querySelector('.dialer-rail') || !document.querySelector('.card-panel')) {
      return setTimeout(init, 200);
    }
    try { cfg = (await window.api.store.get(SKEY)) || null; } catch (e) { cfg = null; }
    if (!cfg || !cfg.order) cfg = defaultCfg();
    // 누락 패널 보정
    PANELS.forEach(p => { if (!cfg.order.includes(p.id)) cfg.order.push(p.id); if (cfg.widths[p.id] == null) cfg.widths[p.id] = p.w; });
    if (!cfg.hidden) cfg.hidden = {};
    // 🔒 고정 3분할 강제: 발신 + 멘트·빠른대응 + 콜관리. 카드목록/사이드바는 항상 숨김(제거된 패널).
    //    저장된 예전 배치가 어떻든 매 실행마다 이 배치로 정규화한다.
    cfg.hidden.cards = true;
    cfg.hidden.sidebar = true;
    cfg.hidden.memo = false;
    cfg.hidden.crm = false;
    cfg.scriptHidden = true;
    // 🔁 옛 '가중치' 배치는 따로 이관할 게 없다 — 가중치는 원래 px 값(560/380/520)에서 출발했고
    //    경계 드래그가 두 이웃의 합을 보존하므로 총합이 계속 ~1460 으로 유지된다. 즉 숫자 자체가
    //    이미 px 스케일이고 사용자가 맞춘 '비율'도 그대로 들어있다 → 그대로 px 로 쓰면 된다.
    //    (최소폭 미달만 panelPx 가 보정. 예전처럼 '현재 창폭'에 맞춰 늘리면 그 모니터 폭이 배치폭으로
    //     굳어져 다른 모니터에서 또 달라진다 — fit zoom 과 정면충돌하므로 절대 하면 안 됨.)
    try { window.api.on('menu:action', handleMenu); } catch (e) {}
    try { window.addEventListener('resize', requestApply); } catch (e) {}   // 창 크기 바뀌면 재적용
    enforceCapOnLoad();   // 🚧 저장된 레이아웃이 4개 이상이면 3개로 맞춤
    apply();
    // 🗂 시작 화면 = 콜관리. 검은 화면 대신 바로 콜관리가 뜨도록 자동 도킹.
    //    (스크립트/멘트는 사용자가 직접 켬) — layout 준비 후라 토글 타이밍 경합도 없음
    try { if (window.CRM && window.CRM.open) window.CRM.open(); } catch (e) {}
    // 🩹 창 최대화/자동줌이 늦게 적용돼 콜관리가 잘리던 문제 → 창 안정 후 다시 적용해 항상 보이게
    settleLayout();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
