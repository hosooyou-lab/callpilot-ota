// ============================================================
//  dialer.renderer.js  (v2)
//  - 작은 메모 제거, 결과태그 토글, 큰 메모장 연동, 통화시간 계산
//  - 진짜 .xlsx 내보내기. renderer.js 와는 CustomEvent 로만 연결.
// ============================================================
(function () {
  if (!window.api || !window.api.dialer) { console.warn('dialer API 없음'); return; }
  const D = window.api.dialer;
  const $ = (id) => document.getElementById(id);

  // 🆕 P3/P5(2026-07-18) 콜백·방문예약은 「가망」 팝업에서 고른다.
  //    ⚠ '관심없음'은 반드시 필요 — "지금은 관심 없다"는 고객을 담을 곳이 없으면 상담사가 어쩔 수 없이
  //      ⛔수신거부를 눌러 **DB가 파기**된다(회사 자산 손실 + 잘못된 옵트아웃). 수신거부는 법적 거부 전용.
  //    ⚠ '결번'도 필수 — 없는 번호를 담을 곳이 없으면 '부재'로 눌려 2일 뒤 큐에 다시 올라오고,
  //      부재 4차까지 한 번호에 헛걸이 4번을 하게 된다. 결번은 재발신 대상에서 영구 제외(파기는 안 함 →
  //      출처별 결번율로 DB 품질을 잰다).
  const RESULT_TAGS = ['가망', '부재', '관심없음', '결번'];
  // 고객정보창(openContact)에서는 통화 후에도 세부 결과를 고칠 수 있어야 하므로 더 넓은 집합을 쓴다.
  const CONTACT_TAGS = ['가망', '부재', '관심없음', '결번', '나중연락', '방문예약'];
  let queue = [];          // [{number, tag, memo, done}]
  let curIdx = -1;
  let looping = false;
  let connected = false;
  let records = [];
  let pendingTag = null;
  // 📞 콜백/수신감지 상태
  let callbackActive = false;       // 콜백(과거 연락처 재호출) 처리 중인가
  let lastCallState = 'IDLE';       // 직전 통화상태 (전환 감지용)
  let dialGuardUntil = 0;           // 우리가 방금 발신한 직후의 RINGING을 '수신'으로 오인 방지
  let outgoingBaselineDate = 0;     // 📲 직접 발신 감지 순간의 '최신 통화기록 date'(=직전 통화). 이보다 새 기록만 '현재 통화'로 채택 → 이전 번호 오검출 차단
  let incomingBaselineDate = 0;     // 📞 수신 울림 감지 순간의 '최신 통화기록 date'. 위와 동일 원리로 이전 수신번호 오검출 차단
  let callLogCache = {};            // 📞 폰 통화기록 캐시 {번호숫자: {count,out,lastDate}} — 발신 전 '이미 통화한 번호?' 확인용
  let blockedSet = new Set();        // 🚫 차단요청 번호(숫자) — 앱 폴더 blocklist.json에 저장(앱 공유 시 함께 전달)
  let countdownTimer = null;
  let callTimer = null;    // ⏱ 현재 통화 경과시간 라이브 카운터 (발신~다음/정지까지)
  let dialStart = 0;       // 통화시간 계산용
  const selQueue = new Set();   // 발신목록 선택삭제(체크) 대상
  let selMode = false;          // '선택 삭제' 모드일 때만 체크박스 표시
  let queueScrollIdx = -1;      // 마지막으로 스크롤 맞춘 현재번호 인덱스(바뀔 때만 따라가 깜빡임 방지)
  let queueAnchor = null;       // 발신목록 shift 범위선택 기준

  function toast(msg, ms) {
    const t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), ms || 1800);
  }

  function buildPanel() {
    const rail = document.createElement('aside');
    rail.className = 'dialer-rail';
    rail.innerHTML = `
      <div class="dialer-head dialer-head-conn">
        <div class="dl-conn-line">
          <div class="dl-conn-controls">
            <span class="dl-section-title" style="margin:0;white-space:nowrap;">ADB 연결</span>
            <span class="dl-ip-wrap" title="오른쪽 아래 모서리를 드래그하면 입력칸 너비를 조절할 수 있어요 (설정은 저장됩니다)"><input type="text" id="dl-ip" placeholder="폰 IP (예: 192.168.0.15)" autocomplete="off"></span>
            <button class="dl-btn accent" id="dl-connect" title="폰에 연결합니다. 안 되면 자동으로 재연결 → 같은 와이파이에서 폰 찾기까지 한 번에 시도하고, 그래도 안 되면 어떻게 할지 안내해줍니다.">🔍 연결</button>
          </div>
          <span class="dl-status"><span class="dl-dot" id="dl-dot"></span><span id="dl-status-text">연결 안 됨</span></span>
        </div>
        <button class="dialer-collapse-btn" id="dl-collapse" title="접기/펼치기">‹</button>
      </div>
      <div class="dialer-body dialer-grid">

        <div class="dl-section dl-sec-queue">
          <div class="dl-section-title"><span>발신 번호 목록</span><span style="display:flex;align-items:center;gap:8px;min-width:0;"><button class="dl-btn accent dl-hbtn" id="dl-tmload" title="TM 고객관리에 저장된 고객을 상태(신규·부재·가망 등)·부재 횟수로 골라 발신목록에 올립니다">👥<span class="dl-btn-tx"> 고객 불러오기</span></button><button class="dl-btn accent dl-hbtn" id="dl-calllog" title="폰 통화기록에서 번호별 통화 횟수를 보고 바로 걸기">📋<span class="dl-btn-tx"> 통화기록</span></button><button class="dl-btn dl-hbtn" id="dl-records-btn" title="통화 기록 검색·수정">📂<span class="dl-btn-tx"> 기록</span></button><button class="dl-btn dl-hbtn" id="dl-clear-btn" title="발신목록을 통화 전/후/전체 중 골라 비웁니다">🧹<span class="dl-btn-tx"> 초기화</span></button><span id="dl-queue-count" style="color:var(--text-3)"></span></span></div>
          <div id="dl-sel-bar" style="display:none;grid-template-columns:1.4fr 1fr;gap:6px;margin-top:6px;">
            <button class="dl-btn red" id="dl-sel-del">선택 삭제 (0)</button>
            <button class="dl-btn" id="dl-sel-cancel">취소</button>
          </div>
          <div class="dl-list" id="dl-list"></div>
        </div>

        <div class="dl-section dl-sec-control">
          <div class="dl-section-title">발신 제어</div>
          <div class="dl-wait">통화 후 대기 <input type="number" id="dl-wait" min="0" max="30" value="5"> 초</div>
          <div class="dl-controls">
            <button class="dl-btn green span2" id="dl-start">▶  시작</button>
            <button class="dl-btn" id="dl-stop">■ 정지</button>
            <button class="dl-btn red" id="dl-end">✂ 종료</button>
            <button class="dl-btn blue span2" id="dl-next">▶▶  다음 번호  <span style="opacity:.7;font-size:11px;">(Ctrl+Enter)</span></button>
          </div>
          <!-- 현재통화 + 통화결과 를 발신제어에 통합 (#3) -->
          <div class="dl-section-title" style="margin-top:14px;">현재 통화</div>
          <div class="dl-current-num idle" id="dl-current">번호를 선택하세요</div>
          <div class="dl-call-timer idle" id="dl-call-timer" title="이번 통화/처리 경과 시간 — 다음 발신 또는 정지 누르면 리셋">⏱ 00:00</div>
          <div class="dl-section-title" style="margin-top:8px;">통화 결과</div>
          <div class="dl-results" id="dl-results"></div>
          <!-- 💬 P8) 통화 직후 문자 — 끊고 30초가 골든타임. 결과 버튼과 줄을 분리(결과가 아니라 '행동') -->
          <button class="dl-btn" id="dl-sms-btn" style="width:100%;margin-top:8px;border-color:rgba(107,147,196,.5);color:#9fc0e8;">💬 통화 후 문자 보내기</button>
        </div>

        <div class="dl-section dl-sec-memo">
          <div class="dl-section-title">📝 메모</div>
          <div id="dl-memo-slot" class="dl-memo-slot"></div>
        </div>

        <div class="dl-section dl-sec-records">
          <div class="dl-rec-head">
            <span class="dl-rec-count" id="dl-rec-count">기록 0건</span>
            <div class="dl-rec-actions">
              <button class="dl-btn" id="dl-rec-clear">초기화</button>
            </div>
          </div>
          <div class="dl-rec-tablewrap">
            <table class="dl-rec-table" id="dl-rec-table">
              <thead><tr><th class="rc-num-col">#</th><th>번호</th><th>결과</th><th>시각</th><th>통화</th></tr></thead>
              <tbody id="dl-rec-tbody"></tbody>
            </table>
          </div>
        </div>

        <div class="dl-section dl-sec-notes">
          <div class="dl-section-title">저장된 메모</div>
          <div id="dl-notes-slot" class="dl-notes-slot"></div>
        </div>

      </div>`;
    document.body.insertBefore(rail, document.body.firstChild);
    document.body.classList.add('has-dialer');

    // 📐 패널 폭에 맞춰 촘촘하게 — 좁히면 .dl-w-sm/.dl-w-xs 를 붙여 CSS가 버튼·글씨만 줄인다.
    //    (줄바꿈으로 칸이 아래로 내려가는 걸 막는 게 목적. 폭 규칙은 dialer.css 맨 아래)
    //    ⚠ 글씨 배율(--fs-dialer-scale, zoom) 확대 시 같은 px 폭이라도 담기는 내용은 1/배율로 줄어든다
    //      → '체감 폭 = 실제 폭 ÷ 배율'로 판정해야 확대했을 때 버튼이 옆으로 삐져나가지 않는다(실사고 수정).
    try {
      const dlScale = () => {
        const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-dialer-scale'));
        return v > 0 ? v : 1;
      };

      // 🩹 헤더 버튼줄(고객 불러오기·통화기록·기록·초기화)이 두 줄로 넘치는 걸 막는다.
      //   기존엔 폭 구간(dl-w-sm/xs) 2단계뿐이라, 폭이 애매하면 버튼이 통째로 아랫줄로 내려갔다.
      //   → 여기선 '실제 줄바꿈이 났는지'를 측정(그룹 높이 > 버튼 한 개의 1.6배)해서,
      //     한 줄에 들어갈 때까지 dlh1→dlh6 단계를 하나씩 누적으로 붙인다(픽셀 추정 없음).
      //     각 단계는 CSS(dialer.css 맨 아래)에서 배지숨김→간격↓→글씨↓→보조버튼 글자숨김→…
      //     순으로 '조금씩만' 줄이므로, 좁아질수록 한 줄을 유지하며 촘촘해진다.
      const HDR_MAX = 6;
      const hdrTitle = rail.querySelector('.dl-sec-queue > .dl-section-title');
      const hdrGroup = hdrTitle && hdrTitle.querySelector('span:last-child');
      const fitHeader = () => {
        if (!hdrGroup) return;
        for (let i = 1; i <= HDR_MAX; i++) rail.classList.remove('dlh' + i);
        const btn = hdrGroup.querySelector('.dl-hbtn');
        if (!btn) return;
        // 단계를 하나씩 올리며 매번 다시 측정 → 한 줄이 되는 최소 단계에서 멈춘다.
        for (let lvl = 1; lvl <= HDR_MAX; lvl++) {
          if (hdrGroup.offsetHeight <= btn.offsetHeight * 1.6) break;   // 이미 한 줄
          rail.classList.add('dlh' + lvl);
        }
      };

      const applyW = (w) => {
        const ew = w / dlScale();   // 체감 폭(확대를 감안한 CSS px)
        rail.classList.toggle('dl-w-sm', ew < 400);
        rail.classList.toggle('dl-w-xs', ew < 340);
        fitHeader();                // 몸통 크기 조정 후, 헤더는 줄바꿈 측정으로 미세 단계 결정
      };
      const reW = () => applyW(rail.getBoundingClientRect().width);
      new ResizeObserver(entries => {
        for (const en of entries) applyW(en.contentRect.width);
      }).observe(rail);
      reW();
      // 🩹 첫 화면에서 헤더 버튼줄이 2줄로 굳는 것 방지 (F5 하면 풀리던 문제).
      //    원인: 폰트가 늦게 실려 버튼이 넓어지는데 rail 폭은 그대로라 위 ResizeObserver가 안 울림.
      //    → ① 버튼 그룹 자체의 크기 변화를 직접 감시(원인 불문 — 폰트 로드·배율 적용 등 그 순간)해 바로 다시 맞춘다.
      //       ② 폰트 준비 이벤트 + 지연 백업(느린 콜드 로드 대비).
      requestAnimationFrame(reW);
      setTimeout(reW, 250); setTimeout(reW, 800); setTimeout(reW, 1600);
      try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(reW); } catch (e) {}
      if (hdrGroup) {
        let _fitting = false;
        try {
          new ResizeObserver(() => {
            if (_fitting) return;                 // fitHeader가 그룹 크기를 바꿔 다시 울리는 재귀 방지
            _fitting = true; reW();
            requestAnimationFrame(() => { _fitting = false; });
          }).observe(hdrGroup);
        } catch (e) {}
      }
      // 배율 변경은 rail 크기를 안 바꿔 ResizeObserver가 안 울린다 → 글씨 설정 변경 이벤트로 재판정
      document.addEventListener('cp:fontsettings', reW);
    } catch (e) { console.warn('발신 패널 폭 감지 실패', e); }

    // #2 요청: 발신 제어 + 현재 통화(통화 결과 포함)를 '발신 번호 목록' 위로 이동
    try {
      const ctrlSec = rail.querySelector('.dl-sec-control');
      const queueSec = rail.querySelector('.dl-sec-queue');
      if (ctrlSec && queueSec && ctrlSec.parentElement === queueSec.parentElement) {
        queueSec.parentElement.insertBefore(ctrlSec, queueSec);
      }
    } catch (e) { console.warn('섹션 순서 변경 실패', e); }

    const rb = $('dl-results');
    RESULT_TAGS.forEach(tag => {
      const b = document.createElement('button');
      b.className = 'dl-result-btn'; b.textContent = tag; b.dataset.tag = tag;
      // 🆕 P3) 가망은 유형 팝업(가망/콜백 날짜·시간/방문예약)으로 — 저장 방식까지 한 번에 결정
      b.onclick = (e) => { if (tag === '가망') openGamangPicker(e.currentTarget, null); else selectTag(tag, e.currentTarget); };
      rb.appendChild(b);
    });
    // 🆕 P2) 수신동의 원클릭 — 통화 중 구두 동의를 받은 순간 기록(일시·전화 동의·상담사) + 녹음 증빙 자동 보관
    const cb = document.createElement('button');
    cb.id = 'dl-consent-btn';   // ✅ P6) 토글 체크 — 현재 번호의 동의 상태에 따라 라벨/색이 바뀐다(refreshConsentBtn)
    cb.className = 'dl-result-btn'; cb.textContent = '✅ 수신동의';
    cb.style.cssText = 'border-color:rgba(52,181,110,.55);color:#7fd8a4;';
    cb.onclick = () => consentOneClick();
    rb.appendChild(cb);
    // 🆕 P4) 법정 기록 원클릭 — 수신거부 하나로 일원화(출처민원 버튼 폐지, 사유에 '출처 문의 항의' 선택지로 흡수).
    //    누르면 "고객이 뭐라고 했는지" 사유 입력이 필수 → 무단 클릭 억제 + 관리자 감사 근거.
    const ob = document.createElement('button');
    ob.className = 'dl-result-btn danger'; ob.textContent = '⛔ 수신거부';
    ob.title = '고객이 수신거부 의사를 밝히면 누르세요 — 사유(고객 발언) 입력 후 DB 파기 + 재발신 방지 등록. 모든 클릭은 상담사·통화시간과 함께 기록됩니다';
    ob.onclick = () => legalOneClick('수신거부');
    rb.appendChild(ob);
  }

  // ============ 🖱 드래그 다중선택 (발신목록·기록 공통) ============
  //  컨테이너에서 좌클릭을 누른 채 끌면 지나간 행들이 선택됨. 재렌더 없이 .sel 클래스만
  //  토글해 드래그 중 끊김을 막고, 드래그 직후의 click(단일선택/수정)은 억제한다.
  function setupDragSelect(container, rowSel, selSet, opts) {
    if (!container || container.__dragBound) return;   // 컨테이너당 1회만 바인딩
    container.__dragBound = true;
    opts = opts || {};
    let dragging = false, startIdx = -1, moved = false;
    const idxOf = (t) => { const r = (t && t.closest) ? t.closest(rowSel) : null; return (r && r.dataset.idx != null) ? parseInt(r.dataset.idx, 10) : -1; };
    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;                          // 좌클릭만
      if (opts.exclude && opts.exclude(e.target)) return;  // 삭제아이콘/체크박스/버튼 제외
      const i = idxOf(e.target);
      if (i < 0) return;
      dragging = true; startIdx = i; moved = false;
    });
    container.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const i = idxOf(e.target);
      if (i < 0) return;
      if (i !== startIdx) moved = true;
      selSet.clear();
      const a = Math.min(startIdx, i), b = Math.max(startIdx, i);
      for (let k = a; k <= b; k++) selSet.add(k);
      if (opts.setAnchor) opts.setAnchor(startIdx);
      container.querySelectorAll(rowSel).forEach(r => {
        if (r.dataset.idx == null) return;
        const on = selSet.has(parseInt(r.dataset.idx, 10));
        r.classList.toggle('sel', on);
        const cb = r.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = on;   // 기록 체크박스도 드래그 중 실시간 동기화
      });
      e.preventDefault();   // 드래그 중 텍스트 선택 방지
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) container.__dragMoved = true;   // 진짜 드래그였음 → 직후 click 억제
    });
  }
  function consumedDragClick(container) {
    if (container && container.__dragMoved) { container.__dragMoved = false; return true; }
    return false;
  }

  // ============================================================
  //  🩹 발신목록 증분(diff) 렌더 — '다음 번호' 등으로 매번 list.innerHTML 통째로
  //     비우고 다시 그리면 화면 전체가 깜빡인다(새로고침처럼 보임). 그래서 큐 항목(객체
  //     참조)마다 실제 <div class="dl-num"> 행 DOM을 WeakMap에 붙잡아 두고 재사용하며,
  //     '내용이 실제로 바뀐 행'만 다시 그리고, 그 외에는 손도 대지 않는다.
  //     (그룹 이동이 필요하면 그 행 하나만 다른 열로 옮긴다 — 리스트 전체 재구축 없음)
  // ============================================================
  const queueRowMap = new WeakMap();   // 큐 항목(item) → 그 항목의 <div class="dl-num"> 행 요소
  // 이 행의 '겉모습'을 결정하는 값들의 서명. 다음 렌더에서 서명이 같으면 다시 그리지 않는다.
  function rowSignature(item, i) {
    return i + '|' + (i === curIdx ? 1 : 0) + '|' + (item.done ? 1 : 0) + '|' + (item.tag || '') + '|' +
      (selMode ? 1 : 0) + '|' + (selMode && selQueue.has(i) ? 1 : 0) + '|' + (item.callbackAt || '') + '|' +
      (consentOf(item.number) ? 1 : 0) + '|' + (item.smsAt ? 1 : 0);   // ✅ P6) 동의 체크 / 💬 P8) 문자 작성 표시
  }
  // 👆 번호 한 번 클릭 = '선택' — 이 번호를 현재 통화 대상으로 지정만 한다(발신 안 함).
  //    ⚠ 통화 중에는 막는다: 메모·통화결과는 commitCurrent 가 queue[curIdx] 에 붙이므로,
  //      통화 중에 curIdx 를 옮기면 지금 쓰던 메모가 엉뚱한 번호에 저장된다.
  function selectQueueIdx(i) {
    if (!(i >= 0) || !queue[i]) return;
    if (i === curIdx) return;                       // 이미 선택된 행 → 다시 그릴 필요 없음
    if (dialStart) { toast('통화 중에는 다른 번호를 선택할 수 없어요 — [정지] 후에 눌러주세요'); return; }
    curIdx = i;
    renderQueue(); showCurrent();
  }
  // 행 하나의 내부 HTML·클래스·이벤트를 (다시) 그린다. 새로 만들 때 + 서명이 바뀌었을 때만 호출됨.
  //   ⚠ 클릭 핸들러는 캡처한 i를 쓰지 않고 매번 row.dataset.idx(방금 세팅한 최신 인덱스)를 읽는다
  //     → 이 함수가 최신 i로 다시 불릴 때마다 정확한 인덱스로 안전하게 갱신된다.
  function paintRow(row, item, i) {
    row.className = 'dl-num' + (i === curIdx ? ' current' : '') + (item.done ? ' done' : '') + (selMode && selQueue.has(i) ? ' sel' : '');
    row.dataset.idx = i;
    // 안 건 그룹은 '결과 선택' 칩을 미리 띄우지 않는다(통화 후 결과가 생기면 표시).
    // 폰에서 통화(done)했지만 PC엔 결과태그가 없으면 '통화함'으로만 표시(재발신 방지 상태).
    const chip = item.tag
      ? `<span class="tag tag-pick" title="클릭해서 통화결과 바로 선택/변경">${item.tag}</span>`
      : (item.done ? `<span class="tag tag-pick" title="폰에서 통화함 · 클릭해 결과 지정">통화함</span>` : '');
    // 📅 콜백 예정일 칩 — 통화 후(결과/done 있음) 항목에 callbackAt 있으면 표시. 지난 날짜=danger, 오늘=warn.
    let cbChip = '';
    if (item.callbackAt && (item.tag || item.done)) {
      const cbCls = item.callbackAt < todayIso() ? ' cb-past' : (item.callbackAt === todayIso() ? ' cb-today' : '');
      const cbParts = String(item.callbackAt).split('-');
      cbChip = `<span class="dl-cb-chip${cbCls}" title="콜백 예정일 ${item.callbackAt}">📅 ${parseInt(cbParts[1], 10)}/${parseInt(cbParts[2], 10)}</span>`;
    }
    // 선택 삭제 모드일 때만 체크박스 표시
    const chk = selMode ? `<input type="checkbox" class="dl-num-chk"${selQueue.has(i) ? ' checked' : ''}>` : '';
    // ✏️ 수정 버튼 — 더블클릭만으로는 발견이 어려워 명시 진입점을 되살림(고객정보·메모·결과 수정창)
    const editBtn = selMode ? '' :
      `<span class="dl-num-edit" title="고객 정보·메모·통화결과 수정" style="padding:1px 5px;border-radius:5px;opacity:.55;cursor:pointer;font-size:11px;flex-shrink:0;">✏️</span>`;
    // ✅ P6) 수신동의 체크 — 번호 옆에 항상 보이는 표시(메모를 열어보지 않아도 한눈에)
    const cs = consentOf(item.number);
    const consentChip = cs
      ? `<span class="tag" style="background:rgba(52,181,110,.18);border:1px solid rgba(52,181,110,.5);color:#7fd8a4;padding:0 5px;" title="수신동의 받은 번호${cs.at ? ' · ' + String(cs.at).slice(0, 10) : ''}">✅</span>`
      : '';
    // 💬 P8) 통화 후 문자를 작성한 번호 표시 (폰 메시지앱을 연 시점 기록)
    const smsChip = item.smsAt
      ? `<span class="tag" style="background:rgba(107,147,196,.18);border:1px solid rgba(107,147,196,.5);color:#9fc0e8;padding:0 5px;" title="문자 작성함 · ${String(item.smsAt).slice(0, 10)}">💬</span>`
      : '';
    // 번호(.ph>.ph-t)+결과칩(chip)+✏️ 는 .dl-main 으로 묶어 '한 줄' 유지 — 좁으면 번호 글씨가 줄어든다.
    // 부가칩(수신동의·문자·콜백)은 .dl-main 밖 → 정말 좁을 때만 아랫줄로 내려간다(dialer.css @container).
    row.innerHTML = chk + `<span class="idx">${i + 1}</span>` +
      `<span class="dl-main"><span class="ph"><span class="ph-t">${fmtPhone(item.number)}</span></span>` + chip + editBtn + `</span>` +
      consentChip + smsChip + cbChip;   // 🗑 휴지통 제거 → 번호+결과칩 한 줄. 단건 삭제는 행 우클릭(아래).
    if (selMode) {
      const toggle = () => {
        const ci = parseInt(row.dataset.idx, 10);
        if (selQueue.has(ci)) selQueue.delete(ci); else selQueue.add(ci);
        const on = selQueue.has(ci);
        row.classList.toggle('sel', on);
        const cb = row.querySelector('.dl-num-chk'); if (cb) cb.checked = on;
        updateSelBar();
      };
      row.querySelector('.dl-num-chk').onclick = (e) => { e.stopPropagation(); toggle(); };
      row.onclick = () => toggle();   // 행 아무 곳이나 눌러도 체크 토글
    } else {
      const pick = row.querySelector('.tag-pick');
      if (pick) pick.onclick = (e) => { e.stopPropagation(); openTagPicker(parseInt(row.dataset.idx, 10), e.currentTarget); };
      // ✏️ 클릭 = 고객 정보창 (선택 동작과 겹치지 않게 전파 중단)
      const ed = row.querySelector('.dl-num-edit');
      if (ed) {
        ed.onclick = (e) => { e.stopPropagation(); const it = queue[parseInt(row.dataset.idx, 10)]; if (it) openContact(it.number); };
        ed.onmouseenter = () => { ed.style.opacity = '1'; };
        ed.onmouseleave = () => { ed.style.opacity = '.55'; };
      }
      // 👆 한 번 클릭 = 선택(이 번호를 '현재 통화'로 지정, 발신은 안 함)
      //    👆👆 두 번 클릭 = 고객 정보창(정보·메모·전화·메시지)
      //    선택은 여러 번 눌러도 결과가 같아(멱등) 지연 타이머 없이 바로 반응시킨다.
      //    (더블클릭이면 onclick 이 두 번 먼저 뛰지만 같은 행을 두 번 선택할 뿐 → 부작용 없음)
      row.onclick = () => selectQueueIdx(parseInt(row.dataset.idx, 10));
      row.ondblclick = () => openContact(item.number);
      // 🗑 단건 삭제 = 행 우클릭 (기록 테이블과 동일 방식). 휴지통 아이콘 없앤 대체 경로.
      row.oncontextmenu = (e) => { e.preventDefault(); delNumbers([parseInt(row.dataset.idx, 10)]); };
    }
  }
  // 이 큐 항목의 행 DOM을 재사용(없으면 생성). 서명이 이전과 같으면 다시 그리지 않고 그대로 반환.
  function getOrCreateRow(item, i) {
    let row = queueRowMap.get(item);
    const sig = rowSignature(item, i);
    if (!row) {
      row = document.createElement('div');
      queueRowMap.set(item, row);
      paintRow(row, item, i);
      row.__sig = sig;
    } else if (row.__sig !== sig) {
      paintRow(row, item, i);
      row.__sig = sig;
    }
    return row;
  }
  // 한 열(통화 전 / 통화 후)의 내용을 목표 배열(arr)에 맞춰 최소한으로만 갱신한다.
  //   - 제목(개수)은 텍스트만 갱신
  //   - 사라진 행(삭제됐거나 다른 열로 옮겨간 행)만 제거
  //   - 순서가 실제로 어긋난 위치만 insertBefore로 옮김(그 외엔 DOM을 건드리지 않음)
  function reconcileGroup(colEl, arr, label) {
    const header = colEl.firstElementChild;
    const headText = `${label} (${arr.length})`;
    if (header.textContent !== headText) header.textContent = headText;
    if (!arr.length) {
      Array.from(colEl.children).forEach(c => { if (c !== header && !c.classList.contains('dl-list-empty')) c.remove(); });
      if (!colEl.querySelector(':scope > .dl-list-empty')) {
        const e = document.createElement('div');
        e.className = 'dl-list-empty';
        e.textContent = '없음';
        colEl.appendChild(e);
      }
      return;
    }
    const emptyEl = colEl.querySelector(':scope > .dl-list-empty'); if (emptyEl) emptyEl.remove();
    const rows = arr.map(x => getOrCreateRow(x.item, x.i));
    const wanted = new Set(rows);
    // 이 열에서 사라진 행만 제거(다른 열로 옮겨갈 행은 그쪽 reconcileGroup이 insertBefore로 가져감)
    Array.from(colEl.children).forEach(c => { if (c !== header && !wanted.has(c)) c.remove(); });
    rows.forEach((row, idx) => {
      const wantedPos = idx + 1;   // +1 = 제목(header)만큼 오프셋
      if (colEl.children[wantedPos] !== row) colEl.insertBefore(row, colEl.children[wantedPos] || null);
    });
  }
  function renderQueue() {
    const list = $('dl-list');
    const _scrollTop = list.scrollTop;   // 🩹 재구축 시 스크롤 맨 위로 튀어 '새로고침'처럼 보이던 현상 방지 → 위치 보존
    $('dl-queue-count').textContent = queue.length ? `${queue.length}개` : '';
    if (!queue.length) {
      const already = list.children.length === 1 && list.firstElementChild && list.firstElementChild.classList.contains('dl-list-empty');
      if (!already) list.innerHTML = '<div class="dl-list-empty">위에 번호를 추가하세요</div>';
      selQueue.clear();
      return;
    }
    // 좌우 2열(.dl-cols > .dl-col × 2) 컨테이너는 한 번만 만들고 계속 재사용 — 목록이 있는 한
    // list.innerHTML 을 다시 건드리지 않아 전체 재구축(깜빡임)이 사라진다.
    let cols = list.querySelector(':scope > .dl-cols');
    if (!cols) {
      list.innerHTML = '';
      cols = document.createElement('div');
      cols.className = 'dl-cols';
      const colU = document.createElement('div'); colU.className = 'dl-col';
      const hU = document.createElement('div'); hU.className = 'dl-grp'; colU.appendChild(hU);
      const colD = document.createElement('div'); colD.className = 'dl-col';
      const hD = document.createElement('div'); hD.className = 'dl-grp'; colD.appendChild(hD);
      cols.appendChild(colU); cols.appendChild(colD);
      list.appendChild(cols);
    }
    const colU = cols.children[0], colD = cols.children[1];
    // 2그룹: 아직 안 건(결과 없음) / 통화 끝난(결과 있음). 원래 인덱스(i) 보존.
    const indexed = queue.map((item, i) => ({ item, i }));
    const uncalled = indexed.filter(x => !x.item.tag && !x.item.done);
    const done = indexed.filter(x => x.item.tag || x.item.done);
    reconcileGroup(colU, uncalled, '📞 통화 전');
    reconcileGroup(colD, done, '✅ 통화 후');
    updateSelBar();
    list.scrollTop = _scrollTop;   // 🩹 스크롤 위치 복원(맨 위로 튐 방지)
    // 📍 현재 번호가 '바뀌었을 때만'(다음 번호 등) 그 번호로 스크롤 — 동기화 등 단순 재렌더 때는 스크롤 안 건드림(깜빡임 방지)
    if (curIdx !== queueScrollIdx) {
      queueScrollIdx = curIdx;
      const curEl = list.querySelector('.dl-num.current');
      if (curEl) { try { curEl.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    }
  }
  // 선택 삭제 모드: 진입/종료/개수 갱신
  function updateSelBar() {
    const b = $('dl-sel-del'); if (b) b.textContent = `선택 삭제 (${selQueue.size})`;
  }
  function enterQueueSelMode() {
    if (looping) { toast('발신 중에는 삭제 불가 — 정지 먼저'); return; }
    if (!queue.length) { toast('목록이 비어 있습니다'); return; }
    selMode = true; selQueue.clear();
    const bar = $('dl-sel-bar'); if (bar) bar.style.display = 'grid';
    renderQueue();
    toast('지울 번호를 체크하세요');
  }
  function exitQueueSelMode() {
    selMode = false; selQueue.clear();
    const bar = $('dl-sel-bar'); if (bar) bar.style.display = 'none';
    renderQueue();
  }
  // 🏷 큐 목록에서 통화 없이도 결과만 바로 선택/변경 (칩 클릭 → 작은 메뉴)
  function findRecordFor(number) {
    const dnum = String(number).replace(/\D/g, '');
    for (let i = records.length - 1; i >= 0; i--) { if (String(records[i].number).replace(/\D/g, '') === dnum) return records[i]; }
    return null;
  }
  function closeTagPicker() {
    const m = document.getElementById('dl-tagmenu'); if (m) m.remove();
    document.removeEventListener('mousedown', onTagPickerOutside, true);
  }
  function onTagPickerOutside(e) {
    const m = document.getElementById('dl-tagmenu');
    if (m && !m.contains(e.target)) closeTagPicker();
  }
  function openTagPicker(i, anchorEl) {
    closeTagPicker();
    const item = queue[i]; if (!item) return;
    const menu = document.createElement('div');
    menu.id = 'dl-tagmenu';
    menu.className = 'dl-tagmenu';
    menu.innerHTML = RESULT_TAGS.map(tag =>
      `<button class="dl-tagmenu-item${tag === item.tag ? ' sel' : ''}" data-tag="${tag}">${tag}</button>`
    ).join('') + (item.tag ? `<button class="dl-tagmenu-item clear" data-tag="">결과 해제</button>` : '');
    document.body.appendChild(menu);
    const r = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth || 96;
    let left = r.right - mw; if (left < 4) left = 4;
    let top = r.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 4) top = r.top - menu.offsetHeight - 4;
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    menu.querySelectorAll('.dl-tagmenu-item').forEach(btn => {
      btn.onclick = () => {
        const t = btn.dataset.tag || null;
        closeTagPicker();
        if (t === '가망') { openGamangPicker(anchorEl, i); return; }   // 🆕 P3) 가망은 유형 팝업(콜백 날짜·시간 포함)으로
        setQueueResultDirect(i, t);
      };
    });
    setTimeout(() => document.addEventListener('mousedown', onTagPickerOutside, true), 0);
  }
  // 통화 없이(또는 통화 중이 아닌 다른 번호에) 결과만 바로 지정/변경 — 기존 기록 있으면 갱신, 없으면 결과만 담은 기록 생성
  function setQueueResultDirect(i, tag) {
    const item = queue[i]; if (!item) return;
    if (i === curIdx && dialStart) { selectTag(tag); return; }   // 지금 통화 중인 번호면 기존 방식대로(정지 시 저장)
    item.tag = tag || null;
    touchQ(item); dialSyncSoon();   // 📱 결과 변경 → 폰에 통화됨 전파
    const existing = (item._recRef && records.indexOf(item._recRef) !== -1) ? item._recRef : findRecordFor(item.number);
    if (existing) {
      existing.tag = item.tag;
      existing.cbDate = item.callbackAt || null; existing.cbTime = item.callbackTime || null;   // 🆕 P3) 콜백 날짜·시간 동봉
      item._recRef = existing; item._saved = true;
      persistRecords(); renderRecords();
      emitJipSync(existing);
    } else if (item.tag) {
      const now = new Date();
      const rec = {
        number: item.number, name: null, tag: item.tag, memo: '',
        dialAt: now.toLocaleString('ko-KR'),
        time: now.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        duration: null, ts: now.toISOString(),
        cbDate: item.callbackAt || null, cbTime: item.callbackTime || null,   // 🆕 P3) 콜백 날짜·시간 동봉
      };
      records.push(rec);
      // ⚠ 작업4: 저장 상한(2000건) 제거 — 기록은 전부 영구 보존. 화면 렌더만 아래 renderRecords()에서 제한.
      item._recRef = rec; item._saved = true;
      persistRecords(); renderRecords();
      emitJipSync(rec);
    }
    persistQueue(); renderQueue();
    toast(`${fmtPhone(item.number)} → ${item.tag || '결과 해제'}`);
  }

  async function delNumbers(idxs, forceConfirm) {
    if (!idxs || !idxs.length) { toast('선택된 번호가 없습니다'); return; }
    const uniq = [...new Set(idxs)].sort((a, b) => b - a);  // 뒤에서부터 제거
    if (forceConfirm || uniq.length > 1) {
      const msg = uniq.length > 1
        ? `${uniq.length}개 번호를 삭제할까요?\n(해당 번호의 기록도 함께 삭제됩니다)`
        : `이 번호를 삭제할까요?\n(해당 번호의 기록도 함께 삭제됩니다)`;
      if (!(await appConfirm(msg, { okText: '삭제', danger: true }))) return;
    }
    const delNums = new Set(uniq.map(idx => queue[idx] && queue[idx].number).filter(Boolean));
    uniq.forEach(idx => {
      queue.splice(idx, 1);
      if (idx === curIdx) curIdx = -1;
      else if (idx < curIdx) curIdx--;
    });
    // 🔗 같은 번호의 통화 기록도 함께 제거 (같은 번호·같은 내용이라 동기화)
    if (delNums.size) {
      records = records.filter(r => !delNums.has(r.number));
      persistRecords(); renderRecords();
    }
    if (delNums.size) { addDialTombstones([...delNums]); }   // 📱 폰에도 삭제 전파
    selQueue.clear(); queueAnchor = null;
    clearCallback();   // 번호 삭제 → 콜백 처리중 배지 해제
    persistQueue(); renderQueue(); showCurrent();
    dialSyncSoon();
  }
  // 기록표 '시각' 짧게 (예: 6/25 16:41) — 좁은 패널에서 표가 가로로 안 넘치게. 전체 시각은 title로.
  function fmtRecTime(r) {
    if (r && r.ts) {
      const d = new Date(r.ts);
      if (!isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
      }
    }
    return (r && r.time) || '';
  }
  // 📜 작업4: 저장은 전량 보존하되, 화면에는 최신 N건만 먼저 그려서 수천 건에도 렌더가 느려지지 않게 한다.
  //    "더 보기"를 누르면 창 크기(recRenderLimit)를 늘려 오래된 기록을 이어서 보여준다.
  let recRenderLimit = 500;
  function renderRecords() {
    const total = records.length;
    const shown = Math.min(recRenderLimit, total);
    $('dl-rec-count').textContent = shown < total ? `기록 ${total}건 (최근 ${shown}건 표시)` : `기록 ${total}건`;
    const tb = $('dl-rec-tbody'); if (!tb) return;
    tb.innerHTML = '';
    const startIdx = Math.max(0, total - recRenderLimit);
    if (startIdx > 0) {
      const moreTr = document.createElement('tr');
      moreTr.className = 'dl-rec-more-row';
      const moreTd = document.createElement('td');
      moreTd.colSpan = 5;
      moreTd.className = 'rc-more-cell';
      moreTd.textContent = `▲ 더 보기 (오래된 기록 ${startIdx}건 더 있음)`;
      moreTd.style.textAlign = 'center';
      moreTd.style.cursor = 'pointer';
      moreTd.style.opacity = '0.75';
      moreTd.onclick = () => { recRenderLimit += 500; renderRecords(); };
      moreTr.appendChild(moreTd);
      tb.appendChild(moreTr);
    }
    records.slice(startIdx).forEach((r, i0) => {
      const idx = startIdx + i0;
      const tr = document.createElement('tr');
      tr.dataset.idx = idx;
      // 순번 칸 (1, 2, 3 …) — 예전 선택 체크박스 자리
      const tdNum = document.createElement('td');
      tdNum.className = 'rc-num-col';
      tdNum.textContent = String(idx + 1);
      tr.appendChild(tdNum);
      const cells = [
        // ✅ P6) 이 통화에서 수신동의를 받았으면 번호 앞에 체크 표시 (기록 테이블에서도 바로 보이게)
        (r.consentAt ? '✅ ' : '') + fmtPhone(r.number), r.tag || '', fmtRecTime(r),
        (r.duration != null ? r.duration + '초' : '')
      ];
      cells.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i === 0) td.className = 'rc-ph';     // 번호
        if (i === 1) td.className = 'rc-tag';    // 결과
        if (i === 2) td.title = r.time || '';    // 시각칸: 전체 시각은 마우스 올리면 보임
        tr.appendChild(td);
      });
      tr.onclick = () => { openContact(r.number); };            // 행 클릭 = 통합 상세창
      tr.oncontextmenu = (e) => { e.preventDefault(); delRecords([idx], true); };  // 우클릭 = 이 기록 삭제
      tb.appendChild(tr);
      // 📝 메모는 기록 바로 아래 '전체폭 줄'로 — 좁은 기록 패널에서도 잘리지 않고 다 보이게
      if (r.memo && String(r.memo).trim()) {
        tr.classList.add('rc-has-memo');     // 위 데이터행 밑줄 제거 → 메모줄과 한 블록
        const mtr = document.createElement('tr');
        mtr.dataset.idx = idx;
        mtr.className = 'dl-rec-memo-row';
        const mNum = document.createElement('td'); mNum.className = 'rc-num-col';   // 빈 순번칸(정렬용)
        mtr.appendChild(mNum);
        const mtd = document.createElement('td'); mtd.colSpan = 4; mtd.className = 'rc-memo-full';
        mtd.textContent = '📝 ' + r.memo;
        mtr.appendChild(mtd);
        mtr.onclick = () => { openRecordEdit(idx); };
        tb.appendChild(mtr);
      }
    });
    const wrap = document.querySelector('.dl-rec-tablewrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
    // 📂 통화기록 모달이 열려 있으면 함께 갱신 (검색/필터 상태는 모달 쪽에서 보존)
    const rm = document.getElementById('dl-records-modal');
    if (rm && typeof rm.__refresh === 'function') { try { rm.__refresh(); } catch (e) {} }
  }
  // 기록 삭제 (우클릭으로 1건). idxs 배열을 받아 뒤에서부터 splice.
  async function delRecords(idxs, forceConfirm) {
    if (!idxs || !idxs.length) { toast('삭제할 기록이 없습니다'); return; }
    const uniq = [...new Set(idxs)].sort((a, b) => b - a);
    if (forceConfirm || uniq.length > 1) {
      if (!(await appConfirm(uniq.length > 1 ? `${uniq.length}건 기록을 삭제할까요?` : `이 기록을 삭제할까요?`, { okText: '삭제', danger: true }))) return;
    }
    uniq.forEach(idx => records.splice(idx, 1));
    persistRecords(); renderRecords();
  }
  // (제거됨) 기록 선택(체크박스·드래그선택·전체선택) 기능 — 요청에 따라 없앰.
  //   첫 칸은 이제 순번(1,2,3) 표시. 개별 삭제는 행 우클릭, 전체는 '초기화' 버튼.
  // 기록 내용 수정 (중간에 걸려온 전화 등 관리)
  function openRecordEdit(idx) {
    const r = records[idx]; if (!r) return;
    // 🩹 중복 방지 — 이미 열린 수정창이 있으면 제거(연타 시 오버레이가 쌓여 화면이 검게 되던 현상 차단)
    document.querySelectorAll('.dl-edit-overlay').forEach(el => el.remove());
    const ov = document.createElement('div');
    ov.className = 'dl-edit-overlay';
    ov.innerHTML = `
      <div class="dl-edit-modal">
        <div class="dl-edit-title"><span>기록 수정</span><button class="dl-edit-x" id="re-x" title="닫기" aria-label="닫기">✕</button></div>
        <label>이름<input id="re-name" type="text" value="${escapeHtml(r.name || '')}"></label>
        <label>전화번호<input id="re-phone" type="text" value="${escapeHtml(r.number || '')}"></label>
        <label>결과<input id="re-tag" type="text" value="${escapeHtml(r.tag || '')}"></label>
        <label>통화(초)<input id="re-dur" type="number" min="0" value="${r.duration != null ? r.duration : ''}"></label>
        <label>메모<textarea id="re-memo" rows="4">${escapeHtml(r.memo || '')}</textarea></label>
        <div class="dl-edit-btns">
          <button class="dl-btn" id="re-cancel">취소</button>
          <button class="dl-btn accent" id="re-save">저장</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    // ⛔ 바깥(배경) 클릭으로는 닫지 않음 — 실수로 편집 내용이 날아가지 않게. X·취소·저장만 닫는다.
    // ⌫ 입력칸 밖에서 백스페이스 → (브라우저 뒤로가기성 동작) 차단 + 모달 키 이벤트가 밖으로 안 새게 stop.
    ov.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const t = (e.target && e.target.tagName) || '';
      const editable = (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT');
      if (e.key === 'Backspace' && !editable) e.preventDefault();
    });
    ov.querySelector('#re-x').onclick = close;
    ov.querySelector('#re-cancel').onclick = close;
    ov.querySelector('#re-save').onclick = () => {
      r.name = ov.querySelector('#re-name').value.trim() || null;
      r.number = ov.querySelector('#re-phone').value.trim() || r.number;
      r.tag = ov.querySelector('#re-tag').value.trim() || null;
      const d = parseInt(ov.querySelector('#re-dur').value, 10);
      r.duration = isNaN(d) ? null : d;
      r.memo = ov.querySelector('#re-memo').value;
      persistRecords(); renderRecords(); close(); toast('기록 수정됨');
    };
    setTimeout(() => ov.querySelector('#re-name')?.focus(), 30);
  }

  // ============================================================
  //  📂 통화기록 모달 — 숨겨진 dl-sec-records(엑셀·복사·초기화·기록수정) 진입점 부활.
  //     검색/태그필터는 목록(#dlrec-list)만 갱신 → 검색창 DOM은 그대로 둬 한글 조합이 안 깨짐.
  // ============================================================
  function isTodayRecord(r) {
    const d = r && r.ts ? new Date(r.ts) : null;
    if (!d || isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }
  function fmtMinSecKor(totalSec) {
    const sec = Math.max(0, Math.round(totalSec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}분 ${s}초`;
  }
  function recordsKpis() {
    const today = records.filter(isTodayRecord);
    const total = today.length;
    // '연결' = duration>0 이고 tag !== '부재'
    const connected = today.filter(r => (r.duration || 0) > 0 && r.tag !== '부재');
    const connCount = connected.length;
    const rate = total ? Math.round((connCount / total) * 100) : 0;
    const avgSec = connCount ? connected.reduce((s, r) => s + (r.duration || 0), 0) / connCount : 0;
    return { total, connCount, rate, avgSec };
  }
  function openRecordsModal() {
    const old = document.getElementById('dl-records-modal'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'dl-records-modal';
    ov.className = 'dlrec-overlay';
    let filterText = '', filterTag = '';   // filterTag='' = 전체
    let modalRenderLimit = 500;            // 📜 작업4: 모달도 최신 N건 먼저, 나머지는 '더 보기'로
    const tagChipsHtml = ['전체', ...RESULT_TAGS].map(t => {
      const v = (t === '전체') ? '' : t;
      return `<button class="dlrec-chip${v === '' ? ' sel' : ''}" data-t="${escapeHtml(v)}">${escapeHtml(t)}</button>`;
    }).join('');
    ov.innerHTML =
      '<div class="dlrec-modal">' +
        '<div class="dlrec-head">' +
          '<b class="dlrec-title">📂 통화기록</b>' +
          '<span class="dlrec-count" id="dlrec-count"></span>' +
          '<div class="dlrec-head-actions">' +
            '<button class="cp-kebab" id="dlrec-more" title="더보기">⋯</button>' +
            '<button class="dlrec-x" id="dlrec-x" title="닫기">✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="dlrec-kpis" id="dlrec-kpis"></div>' +
        '<div class="dlrec-searchrow"><input type="text" id="dlrec-search" class="dlrec-search" placeholder="🔎 이름·번호·메모 검색" autocomplete="off"></div>' +
        '<div class="dlrec-tags" id="dlrec-tags">' + tagChipsHtml + '</div>' +
        '<div class="dlrec-list" id="dlrec-list"></div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc); };
    function onEsc(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onEsc);
    ov.querySelector('#dlrec-x').onclick = close;
    ov.querySelector('#dlrec-more').onclick = (e) => {
      window.cpMenu(e.currentTarget, [
        { label: '🗑 기록 초기화', icon: '🗑', danger: true, onClick: clearRecords },
      ]);
    };
    ov.querySelectorAll('.dlrec-chip').forEach(chip => {
      chip.onclick = () => {
        filterTag = chip.dataset.t || '';
        modalRenderLimit = 500;   // 필터 바꾸면 표시 범위 초기화
        ov.querySelectorAll('.dlrec-chip').forEach(c => c.classList.toggle('sel', c === chip));
        renderList();
      };
    });
    const searchEl = ov.querySelector('#dlrec-search');
    searchEl.addEventListener('input', () => { filterText = searchEl.value; modalRenderLimit = 500; renderList(); });
    function renderKpis() {
      const k = recordsKpis();
      ov.querySelector('#dlrec-kpis').textContent =
        `오늘 콜 ${k.total} · 연결 ${k.connCount}(연결률 ${k.rate}%) · 평균 통화 ${fmtMinSecKor(k.avgSec)}`;
    }
    function renderList() {
      const listEl = ov.querySelector('#dlrec-list');
      const q = filterText.trim().toLowerCase();
      const qd = q.replace(/\D/g, '');
      const filtered = records.map((r, i) => ({ r, i })).reverse().filter(({ r }) => {
        if (filterTag && r.tag !== filterTag) return false;
        if (!q) return true;
        const nameHit = !!(r.name && r.name.toLowerCase().includes(q));
        const numHit = !!(qd && String(r.number).replace(/\D/g, '').includes(qd));
        const memoHit = !!(r.memo && r.memo.toLowerCase().includes(q));
        return nameHit || numHit || memoHit;
      });
      const cnt = ov.querySelector('#dlrec-count'); if (cnt) cnt.textContent = `${filtered.length}건`;
      if (!filtered.length) { listEl.innerHTML = '<div class="dlrec-empty">일치하는 기록이 없어요</div>'; return; }
      // 📜 작업4: filtered는 최신순(reverse됨) — 앞에서부터 modalRenderLimit개만 그리고 나머지는 '더 보기'
      const visible = filtered.slice(0, modalRenderLimit);
      const restCount = filtered.length - visible.length;
      listEl.innerHTML = visible.map(({ r, i }) => {
        const when = escapeHtml(fmtRecTime(r));
        const nm = r.name ? '<span class="dlrec-name">' + escapeHtml(r.name) + '</span>' : '';
        const ph = '<span class="dlrec-ph">' + escapeHtml(fmtPhone(r.number)) + '</span>';
        const tagChip = r.tag ? '<span class="dlrec-tag">' + escapeHtml(r.tag) + '</span>' : '';
        const dur = r.duration != null ? '<span class="dlrec-dur">' + r.duration + '초</span>' : '<span class="dlrec-dur"></span>';
        const memo = r.memo ? escapeHtml(r.memo) : '';
        return '<div class="dlrec-row" data-idx="' + i + '">' +
          '<span class="dlrec-when">' + when + '</span>' + nm + ph + tagChip + dur +
          '<span class="dlrec-memo" title="' + memo + '">' + memo + '</span>' +
        '</div>';
      }).join('') + (restCount > 0
        ? '<div class="dlrec-row dlrec-more" id="dlrec-loadmore" style="text-align:center;cursor:pointer;opacity:.75">▼ 더 보기 (오래된 기록 ' + restCount + '건 더 있음)</div>'
        : '');
      listEl.querySelectorAll('.dlrec-row:not(.dlrec-more)').forEach(row => {
        row.onclick = () => openRecordEdit(parseInt(row.dataset.idx, 10));
      });
      const moreEl = listEl.querySelector('#dlrec-loadmore');
      if (moreEl) moreEl.onclick = () => { modalRenderLimit += 500; renderList(); };
    }
    ov.__refresh = () => { renderKpis(); renderList(); };
    renderKpis(); renderList();
    setTimeout(() => { try { searchEl.focus(); } catch (e) {} }, 30);
  }

  function showCurrent() {
    const c = $('dl-current');
    if (curIdx >= 0 && queue[curIdx]) {
      const num = queue[curIdx].number;
      c.textContent = fmtPhone(num); c.classList.remove('idle');
      // 🔧 선택한 번호를 '저장 대상'으로 등록 → 메모가 이 번호로 묶임 (번호별 저장 복구)
      window.__dialerSelected = { number: num, name: '' };
      syncSelectedIdentity(num);
      updateSrcInfo(num);   // 🆕 P1) 현재 번호의 출처("○○를 통해 문의")·발신금지 표시
      refreshConsentBtn();  // ✅ P6) 이 번호의 동의 체크 상태를 버튼에 반영
    } else {
      c.textContent = '번호를 선택하세요'; c.classList.add('idle');
      window.__dialerSelected = null;
      updateSrcInfo(null);
    }
    pendingTag = null;
    window.__dialerResult = null;
    document.querySelectorAll('.dl-result-btn').forEach(b => b.classList.remove('sel'));
    resetGamangBtn();   // 🆕 P3) 가망 버튼 라벨(가망·콜백 등) 원복
    // 통화 진행/콜백 중이 아니면: 타이머 0:00 + 직전 통화 신원 비움 → 현재통화=선택번호로 확정
    if (!looping && !callbackActive) { dialStart = 0; window.__dialerCurrentCall = null; }
    updateCallTimer();
  }

  function fmtPhone(n) {
    const raw = String(n).trim();
    // ☎ 발신 접두코드(* 또는 #)가 들어간 번호는 변형 없이 그대로 표시한다.
    //    예) *281055558888 (투넘버/세컨드넘버 호출) — 여기서 * 가 사라지면 안 됨.
    if (/[*#]/.test(raw)) return raw;
    const s = raw.replace(/[^\d]/g, '');
    if (s.length === 11) return s.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    if (s.length === 10) return s.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    return raw;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ⏱ 통화 경과 타이머 — 발신 시작 시 0:00부터 카운트업, 다음 발신/정지 누르면 리셋.
  //    (종료로 끊어도 같은 번호 처리 중이면 계속 → "이 번호에 쓴 시간" 파악용)
  function fmtElapsed(sec) {
    sec = Math.max(0, sec | 0);
    const m = (sec / 60) | 0, s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function updateCallTimer() {
    const el = $('dl-call-timer'); if (!el) return;
    if (dialStart) {
      el.textContent = '⏱ ' + fmtElapsed(Math.round((Date.now() - dialStart) / 1000));
      el.classList.remove('idle'); el.classList.add('running');
    } else {
      el.textContent = '⏱ 00:00';
      el.classList.add('idle'); el.classList.remove('running');
    }
  }
  function startCallTimer() { stopCallTimer(); updateCallTimer(); callTimer = setInterval(updateCallTimer, 1000); }
  function stopCallTimer() { if (callTimer) { clearInterval(callTimer); callTimer = null; } }

  // ---- 큰 메모장 연동 (CustomEvent) ----
  async function announceCall(number, knownName) {
    let name = await lookupName(number);
    if (!name && knownName) name = knownName;   // 저장된 고객명이 없으면 호출자가 준 이름 사용 (콜관리 발신 등)
    window.__dialerCurrentCall = { number, name };
    document.dispatchEvent(new CustomEvent('dialer:call', { detail: { number: fmtPhone(number), name } }));
    const phoneInput = $('customer-phone'), nameInput = $('customer-name');
    if (phoneInput) { phoneInput.value = fmtPhone(number); phoneInput.dispatchEvent(new Event('input', { bubbles: true })); }
    // 이름을 못 찾으면 이전 이름이 남지 않도록 비운다 (다른 번호 발신 시 이름 눌어붙음 방지)
    if (nameInput) { nameInput.value = name || ''; nameInput.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  // 📌 선택(발신 아님)만 해도 메모가 그 번호로 저장되도록 선택 번호의 신원을 동기화.
  //    - window.__dialerSelected 에 선택 번호를 싣고 이름 자동조회(없으면 비움)
  //    - 라이브 통화가 아닐 때만 고객 패널(전화/이름) 칸도 맞춰줌 (announceCall 값과 충돌 방지)
  async function syncSelectedIdentity(number) {
    const dig = (s) => String(s || '').replace(/\D/g, '');
    const name = await lookupName(number);
    if (window.__dialerSelected && dig(window.__dialerSelected.number) === dig(number)) {
      window.__dialerSelected.name = name || '';
    }
    if (!window.__dialerCurrentCall) {
      const phoneInput = $('customer-phone'), nameInput = $('customer-name');
      if (phoneInput) { phoneInput.value = fmtPhone(number); phoneInput.dispatchEvent(new Event('input', { bubbles: true })); }
      if (nameInput) { nameInput.value = name || ''; nameInput.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  }
  async function lookupName(number) {
    try {
      const customers = (await window.api.store.get('customers')) || [];
      const digits = String(number).replace(/\D/g, '');
      const hit = customers.find(c => (c.phone || '').replace(/\D/g, '') === digits);
      return hit ? (hit.name || '') : '';
    } catch (e) { return ''; }
  }
  // 📴 '통화중' 상태 해제 — 통화 끝나면 __dialerCurrentCall 비우고 메모 목록에 알림(배지 제거)
  function clearCurrentCallFlag() {
    if (!window.__dialerCurrentCall) return;
    window.__dialerCurrentCall = null;
    stopCallTimer(); dialStart = 0; updateCallTimer();   // ⏱ 통화 끝 → 타이머 멈추고 00:00로 (배지도 함께 사라짐)
    try { document.dispatchEvent(new CustomEvent('dialer:callend')); } catch (e) {}
  }
  function currentCustomerName() { const n = $('customer-name'); return n ? n.value.trim() : ''; }

  // ============================================================
  //  📞 외부(콜관리 등)에서 들어온 발신 요청 → 발신제어에서 직접 건 것과 동일하게 처리.
  //     번호를 큐/현재통화에 올리고 타이머·결과·메모 연동을 모두 켠 뒤 ADB 발신.
  //     → 이렇게 해야 결과 버튼/메모 저장이 그 번호로 새로 쌓인다.
  // ============================================================
  async function dialNumberFromExternal(number, name) {
    if (!number) return;
    clearCallback();
    clearCountdown();
    const dnum = String(number).replace(/\D/g, '');
    // 🆕 P3) 수신거부 대장·TM 발신금지 번호는 외부 위임 발신(콜관리·TM·통화기록)도 차단
    if (optOutSet.has(dnum)) {
      appAlert('수신거부 이력이 있는 번호입니다.\n재발신 방지 목록에 등록되어 발신할 수 없어요.', { title: '⛔ 수신거부 번호', danger: true });
      return;
    }
    const tmcx = await getTmInfo(number);
    if (tmNoCall(tmcx)) {
      appAlert('이 고객에게는 전화하면 안 됩니다.\n\n' + srcLineFor(tmcx) + '\n\n(해제는 TM 고객관리 → 출처 상세에서)', { title: '⛔ 발신금지 고객', danger: true });
      return;
    }
    let idx = queue.findIndex(q => String(q.number).replace(/\D/g, '') === dnum);
    if (idx < 0) { queue.push({ number, tag: '', memo: '', done: false }); idx = queue.length - 1; }
    curIdx = idx;
    looping = false;                      // 단발 발신(자동 다음번호 X) → 통화 끝(IDLE) 감지 시 '통화중' 자동 해제됨
    queue[idx]._saved = false;            // 새 통화 → 기록 가능
    queue[idx]._recRef = null;            // 새 통화 → 새 기록
    // 현재 통화 표시 + 결과버튼 초기화를 직접 처리 (showCurrent는 !looping일 때 현재콜을 비워버리므로 호출 안 함)
    const curEl = $('dl-current');
    if (curEl) { curEl.textContent = fmtPhone(number); curEl.classList.remove('idle'); }
    pendingTag = null;
    window.__dialerResult = null;
    document.querySelectorAll('.dl-result-btn').forEach(b => b.classList.remove('sel'));
    window.__dialerSelected = { number, name: name || '' };   // 통화 끝나 현재콜이 비어도 메모는 이 번호로 저장
    dialStart = Date.now();               // ⏱ 통화시간 시작
    startCallTimer();
    dialGuardUntil = Date.now() + 9000;   // 발신 직후 RINGING 수신 오인 방지
    persistQueue();
    renderQueue();
    await announceCall(number, name);     // __dialerCurrentCall(이름 보존) + 고객패널 + 메모 연동
    if (!connected) {
      toast('기기 미연결 — 번호를 현재 통화로 올렸어요. 연결 후 [시작]을 누르세요 (메모·결과는 지금도 저장됨)');
      return;
    }
    const r = await D.dial(number);
    if (r && r.ok) toast('📞 발신: ' + fmtPhone(number) + (name ? ' · ' + name : ''));
    else if (r) toast('발신 실패: ' + (r.message || ''));
  }
  // 콜관리(#crm-root)에서 📞 누르면 이 이벤트로 발신제어에 위임됨
  document.addEventListener('dialer:external-dial', (e) => {
    const d = (e && e.detail) || {};
    dialNumberFromExternal(d.number, d.name || '');
  });
  // 📥 콜관리(오늘 탭 '콜백 예정' 등)에서 특정 고객들을 발신목록에 올릴 때 발생. detail.items=[{number,name}]
  //    큐에 없으면 통화 전으로 새로 추가, 있으면(통화 후/콜백 대기 등) done=false로 되살리고 callbackAt 제거.
  document.addEventListener('dialer:queue-add', (e) => {
    const items = (e && e.detail && e.detail.items) || [];
    if (!items.length) return;
    let count = 0;
    items.forEach(it => {
      if (!it || !it.number) return;
      const n = dNorm(it.number);
      if (!n) return;
      count++;
      const idx = queue.findIndex(q => dNorm(q.number) === n);
      if (idx < 0) {
        queue.push({ number: it.number, name: it.name || '', tag: null, memo: '', done: false, id: qRid(), updatedAt: qNowIso() });
      } else {
        const q = queue[idx];
        q.done = false;
        if (q.callbackAt) delete q.callbackAt;
        if (it.name && !q.name) q.name = it.name;
        touchQ(q);
      }
    });
    if (!count) return;
    persistQueue(); renderQueue(); dialSyncSoon();
    toast(`${count}건을 발신목록에 올렸어요`);
  });
  // 🗑 TM 고객관리에서 서버 회수(배정 해제)된 번호를 발신목록에서도 제거. detail.numbers=['010...', ...]
  //    폰 LAN 동기화에서 되살아나지 않도록 tombstone도 함께 남긴다. 확인창 없이 조용히 처리(서버 권위 동작).
  document.addEventListener('dialer:queue-remove', (e) => {
    const numbers = (e && e.detail && e.detail.numbers) || [];
    if (!numbers.length) return;
    if (looping) { toast('자동발신 중에는 목록을 정리할 수 없어요. 정지 후 다시 시도해 주세요'); return; }
    const delSet = new Set(numbers.map(n => dNorm(n)).filter(Boolean));
    if (!delSet.size) return;
    const curNumber = (curIdx >= 0 && queue[curIdx]) ? dNorm(queue[curIdx].number) : null;
    const removed = queue.filter(it => delSet.has(dNorm(it.number)));
    if (!removed.length) return;
    queue = queue.filter(it => !delSet.has(dNorm(it.number)));
    curIdx = (curNumber && !delSet.has(curNumber)) ? queue.findIndex(it => dNorm(it.number) === curNumber) : -1;
    addDialTombstones(removed.map(it => it.number));
    persistQueue(); renderQueue(); showCurrent(); dialSyncSoon();
  });

  // ✅ 결과 일원화(#9): 큰 메모장에서 [저장] 누르면 현재 번호의 통화기록을 1건 생성.
  // 결과는 발신 패널의 결과 버튼(pendingTag)을 그대로 사용. 중복 방지로 _saved 표시.
  document.addEventListener('memo:save', (e) => {
    const { content } = e.detail || {};
    if (curIdx < 0 || !queue[curIdx]) return;
    const item = queue[curIdx];
    item._memoFromPad = content || '';
    commitCurrent(true);   // 메모 저장 시 기록 확정 (+ 큐 항목에 결과 tag 기록)
    renderQueue();         // ✅ 발신번호목록에 결과(가망 등) 즉시 표시
    // 🛑 메모 저장은 '저장'만 한다 — 다음 번호 발신/커서 이동은 [다음 번호] 버튼(Ctrl+Enter)이 담당.
    //    (예전엔 발신 중 메모 저장 시 곧바로 다음 번호로 전화가 걸렸음 → 분리)
  });
  function memoPadContent() {
    const inp = $('np-input');
    return inp ? inp.value.trim() : '';
  }

  // ---- 동작 ----
  function onConnected(ip, statusText, toastText) {
    connected = true; __guidedOnce = false;
    if (ip) $('dl-ip').value = ip;
    setStatus('on', statusText);
    toast(toastText);
    refreshCallLogCache();
  }

  // 🔗 통합 '연결' — 버튼 하나로 연결→재연결→폰찾기(대역스캔)까지 자동 단계별 시도.
  //    (옛 연결/재연결/폰찾기 3버튼을 하나로 묶음)
  let __smartBusy = false;
  async function smartConnect() {
    if (__smartBusy) return;
    __smartBusy = true;
    try {
      const ip = ($('dl-ip').value || '').trim();
      // 1) 박스 IP 로 바로 연결
      if (ip) {
        setStatus('connecting', '연결 중…');
        let r = await D.connect(ip);
        if (r && r.ok) { onConnected(ip, '연결됨', '✓ 연결됨'); return; }
        // 2) 실패 → adb 서버 리셋 후 재연결
        setStatus('connecting', '재연결 중…');
        r = await D.reconnect(ip);
        if (r && r.ok) { onConnected(ip, '재연결됨', '✓ 재연결됨'); return; }
      }
      // 3) 그래도 안 되면 → 같은 와이파이에서 폰 자동 탐색 (IP 바뀐 경우까지 커버)
      setStatus('connecting', '폰 찾는 중…');
      toast('🔍 같은 와이파이에서 폰을 찾는 중…');
      let f;
      try { f = await D.autoFind(); } catch (e) { f = { ok: false }; }
      if (f && f.ok && f.ip) { onConnected(f.ip, '폰 찾음 — 연결됨', '✓ 폰 찾음! 새 IP: ' + f.ip); return; }
      // 4) 최종 실패 → 상황별 경고창 + 지침
      connected = false;
      setStatus('off', '연결 실패');
      await guideFindFailure(f);
    } finally { __smartBusy = false; }
  }
  function setStatus(stt, text) {
    const dot = $('dl-dot'), t = $('dl-status-text');
    dot.className = 'dl-dot' + (stt === 'on' ? ' on' : stt === 'off' ? ' off' : '');
    if (text) t.textContent = text; else if (stt === 'connecting') t.textContent = '연결 중…';
  }

  function delNumber(i) {
    const num = queue[i] && queue[i].number;
    queue.splice(i, 1);
    if (curIdx >= queue.length) curIdx = queue.length - 1;
    if (num) { records = records.filter(r => r.number !== num); persistRecords(); renderRecords(); addDialTombstones([num]); }  // 🔗 기록도 함께 제거 + 폰 삭제 전파
    clearCallback();   // 번호 삭제 → 콜백 처리중 배지 해제
    persistQueue(); renderQueue(); showCurrent();
    dialSyncSoon();
  }
  // 🎯 '목록 초기화' — 발신 번호 목록만 비운다(통화 기록은 유지). 통화 전/후/전체 중 골라서.
  async function clearQueueBy(pred, confirmMsg) {
    if (looping) { toast('발신 중에는 초기화 불가 — 정지 먼저'); return; }
    const targets = queue.filter(pred);
    if (!targets.length) { toast('비울 항목이 없습니다'); return; }
    if (!(await appConfirm(confirmMsg.replace('{n}', targets.length), { okText: '비우기', danger: true }))) return;
    clearCallback();   // 목록 초기화 → 콜백 처리중 배지 해제
    const nums = targets.map(q => q.number).filter(Boolean);
    queue = queue.filter(q => !pred(q));
    curIdx = -1; persistQueue(); renderQueue(); showCurrent();
    if (nums.length) { addDialTombstones(nums); }   // 📱 폰에도 삭제 전파
    dialSyncSoon();
  }
  // 통화 전(결과 없음) / 통화 후(결과 있음) 판정 — renderQueue 그룹 기준과 동일
  const isUncalled = (q) => !q.tag && !q.done;
  const isCalled = (q) => !!(q.tag || q.done);
  // '목록 초기화' 클릭 → 통화 전 / 통화 후 / 전체 중 선택
  function openQueueClearMenu() {
    if (looping) { toast('발신 중에는 초기화 불가 — 정지 먼저'); return; }
    if (!queue.length) { toast('목록이 비어 있습니다'); return; }
    const pre = queue.filter(isUncalled).length;
    const done = queue.filter(isCalled).length;
    const old = document.getElementById('dl-clearmenu-modal'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'dl-clearmenu-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100003;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML =
      '<div style="width:min(340px,92vw);background:#1c1b18;border:1px solid var(--accent);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
        '<div style="padding:18px 20px 4px;font-size:15px;font-weight:800;color:var(--text-1);">목록 초기화</div>' +
        '<div style="padding:0 20px 12px;font-size:12.5px;color:var(--text-4);">무엇을 비울지 고르세요. (통화 기록은 유지됩니다)</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;padding:0 18px 18px;">' +
          '<button id="dl-cm-pre" class="dl-btn red" style="padding:11px;font-size:14px;font-weight:700;">📞 통화 전 전부 비우기 (' + pre + ')</button>' +
          '<button id="dl-cm-done" class="dl-btn red" style="padding:11px;font-size:14px;font-weight:700;">✅ 통화 후 전부 비우기 (' + done + ')</button>' +
          '<button id="dl-cm-all" class="dl-btn" style="padding:11px;font-size:14px;">전체 비우기 (' + queue.length + ')</button>' +
          '<button id="dl-cm-sel" class="dl-btn" style="padding:11px;font-size:14px;">☑️ 하나씩 선택해서 삭제</button>' +
          '<button id="dl-cm-cancel" class="dl-btn" style="padding:10px;font-size:13px;">취소</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    ov.querySelector('#dl-cm-pre').onclick = () => { close(); clearQueueBy(isUncalled, '통화 전 {n}개를 비울까요?\n(통화 기록은 유지됩니다)'); };
    ov.querySelector('#dl-cm-done').onclick = () => { close(); clearQueueBy(isCalled, '통화 후 {n}개를 비울까요?\n(통화 기록은 유지됩니다)'); };
    ov.querySelector('#dl-cm-all').onclick = () => { close(); clearQueueBy(() => true, '발신 번호 전체 {n}개를 비울까요?\n(통화 기록은 유지됩니다)'); };
    ov.querySelector('#dl-cm-sel').onclick = () => { close(); enterQueueSelMode(); };
    ov.querySelector('#dl-cm-cancel').onclick = close;
  }

  // 📇 통합 고객 상세창 — 번호를 한 번 누르면 열림(정보·메모·통화결과 + 전화/메시지/추가·삭제). 모바일과 동일 컨셉.
  // 📝 새 메모 한 줄에 [상담사 · 시각] 스탬프 — renderer.js 의 전역 npAppendMemo 사용(없으면 원문 유지).
  //    기록은 '덧붙이기'만 — 누가 언제 썼는지 본문에 박아 두어야 나중에 다툼이 안 생긴다(무결성).
  function npStampMemo(text) {
    const t = (text || '').trim(); if (!t) return '';
    try { if (typeof window.npAppendMemo === 'function') return window.npAppendMemo('', t); } catch (e) {}
    return t;
  }
  // 🔗 고객정보창에서 바꾼 '이름·새 메모'를 고객관리로 전파 → 한 번호는 어디서 입력하든 한 데이터로 합쳐진다.
  //   · TM 고객관리(iframe): CRM.emitSync → crm:sync → cust-apply. 메모는 기존 메모 '앞에 덧붙임', 통화기록은 안 늘림.
  //   · 콜관리(고객 목록, CRM): CRM.applyExternal 로 crmMeta 에 반영(이름·메모).
  //   ⚠ emitJipSync(발신결과 확정)가 아니라 이 경로를 쓰는 이유 = 메모 저장이 통화수(callLog)를 부풀리면 안 되기 때문.
  function syncContactToCrm(number, name, stampedMemo) {
    const pd = String(number || '').replace(/\D/g, ''); if (!pd) return;
    const extra = { phone: number, name: name || '' };
    if (stampedMemo) extra.memo = stampedMemo;
    (async () => {
      try {
        if (window.CRM && CRM.applyExternal) {
          const patch = { op: 'upsert', phone: number, name: name || '' };
          if (stampedMemo) patch.memo = stampedMemo;
          await CRM.applyExternal(patch);          // 콜관리(CRM) crmMeta 반영 (이 사이 _inbound=true 라 crm:sync 재발신 안 됨)
        }
      } catch (e) {}
      try { if (window.CRM && CRM.emitSync) CRM.emitSync(pd, 'upsert', extra); } catch (e) {}   // TM 고객관리(iframe) 반영
    })();
  }

  function openContact(number) {
    const n = dNorm(number); if (!n) return;
    try { if (window.npEnsureName) window.npEnsureName(); } catch (e) {}   // 저장 시 작성자 이름 확보('(이름없음)' 방지)
    const qi = queue.findIndex(x => dNorm(x.number) === n);
    const cust = qi >= 0 ? queue[qi] : null;
    const recs = records.filter(r => dNorm(r.number) === n);
    const lastRec = recs.length ? recs[recs.length - 1] : null;
    const inList = !!cust;
    const name0 = (cust && cust.name) || (lastRec && lastRec.name) || '';
    let memo0 = (cust && cust.memo) || (lastRec && lastRec.memo) || '';
    const tag0 = (cust && cust.tag) || (lastRec && lastRec.tag) || '';
    const bits = [];
    if (tag0) bits.push('최근 결과 <b>' + escapeHtml(tag0) + '</b>');
    if (recs.length) bits.push('통화 ' + recs.length + '회');
    const info = bits.length ? bits.join(' · ') : '통화 기록 없음';
    // ✅ P6) 수신동의 체크 — 이 번호의 상태를 정보창에서도 보고 켜고 끌 수 있게
    const cs0 = consentOf(n);
    const consentRow =
      '<div class="ct-lbl">수신동의</div>' +
      '<div id="ct-consent" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;cursor:pointer;' +
        'border:1px solid ' + (cs0 ? 'rgba(52,181,110,.55)' : 'var(--border)') + ';' +
        'background:' + (cs0 ? 'rgba(52,181,110,.14)' : 'transparent') + ';">' +
        '<span style="font-size:15px;">' + (cs0 ? '☑' : '☐') + '</span>' +
        '<span style="font-size:12.5px;font-weight:700;color:' + (cs0 ? '#7fd8a4' : 'var(--text-3)') + ';">' +
          (cs0 ? '수신동의 받음' + (cs0.at ? ' · ' + new Date(cs0.at).toLocaleString('ko-KR') : '') + ' · ' + (cs0.via || '전화 동의')
               : '아직 동의 표시 없음 (눌러서 체크)') +
        '</span>' +
      '</div>';
    const tagBtns = CONTACT_TAGS.map(t => '<button class="ct-tag' + (t === tag0 ? ' sel' : '') + '" data-t="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>').join('');
    const old = document.getElementById('dl-contact-modal'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'dl-contact-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100003;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML =
      '<div class="ct-box">' +
        '<div class="ct-h">고객 <span class="ct-sub">' + fmtPhone(n) + '</span></div>' +
        '<div class="ct-info">' + info + '</div>' +
        '<div class="ct-body">' +
          '<input id="ct-name" class="ct-field" placeholder="이름" value="' + escapeHtml(name0).replace(/"/g, '&quot;') + '">' +
          '<div class="ct-lbl">통화 결과</div>' +
          '<div id="ct-tags" class="ct-tags">' + tagBtns + '</div>' +
          consentRow +
          '<div class="ct-lbl" id="ct-memo-lbl">메모</div>' +
          (memo0 ? '<div id="ct-memo-hist" class="ct-memo-ro">' + escapeHtml(memo0) + '</div>' : '') +
          '<textarea id="ct-memo" class="ct-field" rows="2" placeholder="메모 추가 — 저장하면 작성자·시각이 기록되고 고객관리에 함께 저장돼요"></textarea>' +
          '<div class="ct-row">' +
            '<button id="ct-call" class="dl-btn green">📞 전화</button>' +
            '<button id="ct-msg" class="dl-btn">✉️ 메시지</button>' +
          '</div>' +
          '<div class="ct-row">' +
            '<button id="ct-adddel" class="dl-btn ' + (inList ? 'red' : '') + '">' + (inList ? '🗑 고객 삭제' : '＋ 고객 추가') + '</button>' +
            '<button id="ct-save" class="dl-btn accent">저장</button>' +
          '</div>' +
          '<button id="ct-close" class="dl-btn ct-close">닫기</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    // ✅ P6) 정보창에서 동의 체크 토글 — 큐에 없던 번호도 반영되게 먼저 persist() 로 큐 항목을 만든다
    const consentEl = ov.querySelector('#ct-consent');
    if (consentEl) consentEl.onclick = async () => {
      const c = persist();
      const i2 = queue.indexOf(c);
      if (i2 < 0) { toast('먼저 이 번호를 발신목록에 추가해 주세요'); return; }
      const keepIdx = curIdx;
      curIdx = i2;                    // consentOneClick 은 현재 번호 기준 → 잠시 이 번호로
      try { await consentOneClick(); } finally { curIdx = keepIdx; renderQueue(); showCurrent(); }
      close(); openContact(n);        // 갱신된 상태로 다시 그림
    };
    let selTag = tag0;
    ov.querySelectorAll('#ct-tags .ct-tag').forEach(b => b.onclick = () => {
      selTag = (selTag === b.dataset.t) ? '' : b.dataset.t;
      ov.querySelectorAll('#ct-tags .ct-tag').forEach(x => x.classList.toggle('sel', x.dataset.t === selTag));
      // 📅 '나중연락' 선택 직후 콜백 날짜 팝오버 (큐에 없으면 먼저 반영 후 지정)
      if (selTag === '나중연락') { const c = persist(); openCallbackPicker(b, (d) => setCallbackAt(c, d)); }
    });
    function persist() {
      const nm = (ov.querySelector('#ct-name').value || '').trim();
      // 📝 메모칸 = '새 메모 추가' 전용(덧붙이기). 기존 메모는 위 읽기전용 이력에 있고, 저장 시 새 글만 스탬프해 앞에 붙인다.
      const addRaw = (ov.querySelector('#ct-memo').value || '').trim();
      const stamped = npStampMemo(addRaw);
      const pre = (old) => stamped ? (old ? stamped + '\n' + old : stamped) : old;   // 새 메모를 기존 앞에 붙임(TM과 동일 규칙)
      let c = queue.find(x => dNorm(x.number) === n);
      if (!c) { c = { number: n, name: nm, tag: selTag || null, memo: pre(memo0), done: false, id: qRid(), updatedAt: qNowIso() }; queue.push(c); }
      else { if (nm) c.name = nm; if (stamped) c.memo = pre(c.memo); c.tag = selTag || null; touchQ(c); }
      if (lastRec) { lastRec.tag = selTag; if (stamped) lastRec.memo = pre(lastRec.memo); if (nm) lastRec.name = nm; }
      persistQueue(); try { persistRecords(); } catch (e) {}
      renderQueue(); renderRecords(); dialSyncSoon();
      // 🔗 이름·새 메모를 고객관리(TM 고객관리 + 콜관리)에 전파 — 어느 화면에서 입력하든 한 고객 데이터로 합쳐지게
      syncContactToCrm(n, (nm || (c && c.name) || ''), stamped);
      // 같은 새 메모가 다시 저장돼도 중복 전파되지 않게: 입력칸 비우고 이력 박스를 갱신/생성
      if (stamped) {
        memo0 = c.memo;
        try {
          const ta = ov.querySelector('#ct-memo'); if (ta) ta.value = '';
          let hist = ov.querySelector('#ct-memo-hist');
          if (!hist) {
            hist = document.createElement('div'); hist.id = 'ct-memo-hist'; hist.className = 'ct-memo-ro';
            const lbl = ov.querySelector('#ct-memo-lbl');
            if (lbl && lbl.parentNode) lbl.parentNode.insertBefore(hist, lbl.nextSibling);
          }
          hist.textContent = memo0; hist.style.display = '';
        } catch (e) {}
      }
      return c;
    }
    ov.querySelector('#ct-call').onclick = () => {
      persist(); close();
      const i2 = queue.findIndex(x => dNorm(x.number) === n);
      if (i2 >= 0) startFrom(i2);
      else if (connected) { announceCall(n); D.dial(n); }
      else toast('먼저 폰에 연결하세요');
    };
    ov.querySelector('#ct-msg').onclick = async () => {
      persist();
      // 💬 P8) 빈 문자 대신 템플릿 모달로 — 발신 화면과 같은 법 가드가 걸린다
      try { close(); openSmsModal(n); }
      catch (e) { toast('메시지 실패'); }
    };
    ov.querySelector('#ct-save').onclick = () => { persist(); close(); toast('저장했어요'); };
    ov.querySelector('#ct-adddel').onclick = async () => {
      const i2 = queue.findIndex(x => dNorm(x.number) === n);
      if (i2 >= 0) { await delNumbers([i2], true); close(); }
      else { persist(); close(); toast('고객 추가됨'); }
    };
    ov.querySelector('#ct-close').onclick = close;
    setTimeout(() => { try { ov.querySelector('#ct-name').focus(); } catch (e) {} }, 30);
  }

  // 결과 태그: 같은 걸 다시 누르면 해제 (toggle)
  function selectTag(tag, anchorEl) {
    pendingTag = (pendingTag === tag) ? null : tag;
    window.__dialerResult = pendingTag;
    resetGamangBtn();   // 🆕 P3) 가망 팝업으로 바뀐 버튼 라벨 원복
    document.querySelectorAll('.dl-result-btn').forEach(b => b.classList.toggle('sel', b.dataset.tag === pendingTag));
  }

  // ============================================================
  //  🆕 P3) 가망 유형 팝업 — "어떤 가망인가?"를 저장 방식까지 한 번에 결정
  //  · 가망(일반) / 콜백("이따 전화 주세요" — 날짜+시간 지정, TM 오늘 콜에 즉시 반영) / 방문예약
  //  · rowIdx 없으면 현재 통화(pendingTag, [정지]/[다음] 때 저장), 있으면 큐 행에 바로 기록
  // ============================================================
  function resetGamangBtn() { const gb = document.querySelector('.dl-result-btn[data-tag="가망"]'); if (gb) gb.textContent = '가망'; }
  function openGamangPicker(anchorEl, rowIdx) {
    const forRow = (rowIdx != null && rowIdx >= 0);
    if (!forRow && (curIdx < 0 || !queue[curIdx])) { toast('먼저 번호를 선택하세요'); return; }
    const old = document.getElementById('dl-gamang-pick'); if (old) old.remove();
    const p2 = n => String(n).padStart(2, '0');
    const dstr = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    const today = new Date(), tomorrow = new Date(Date.now() + 86400000);
    const inp = 'padding:8px 10px;font-size:13px;border-radius:8px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);outline:none;';
    const chip = (label, d, t) => '<button class="dl-btn dl-gp-chip" data-d="' + d + '" data-t="' + t + '" style="font-size:12px;padding:7px 10px;">' + label + '</button>';
    const ov = document.createElement('div');
    ov.id = 'dl-gamang-pick';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100003;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML =
      '<div style="width:min(390px,94vw);background:#1c1b18;border:1px solid var(--accent);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
        '<div style="padding:14px 18px 10px;border-bottom:1px solid var(--border);font-size:15px;font-weight:800;color:var(--accent);">💬 가망 — 어떤 가망인가요?</div>' +
        '<div style="padding:14px 18px;display:flex;flex-direction:column;gap:10px;">' +
          '<button id="dl-gp-plain" class="dl-btn green" style="padding:11px;font-size:14px;font-weight:800;">💬 가망 — 대화 잘 됨 (다음 연락은 자동 일정)</button>' +
          '<button id="dl-gp-visit" class="dl-btn accent" style="padding:11px;font-size:14px;font-weight:800;">🏠 방문예약 잡힘</button>' +
          '<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;">' +
            '<div style="font-size:13px;font-weight:800;color:var(--text-1);margin-bottom:8px;">📞 콜백 — "조금 이따/나중에 전화 주세요"</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">' +
              chip('오늘 17:00', dstr(today), '17:00') + chip('오늘 19:00', dstr(today), '19:00') +
              chip('내일 10:00', dstr(tomorrow), '10:00') + chip('내일 14:00', dstr(tomorrow), '14:00') +
            '</div>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
              '<input type="date" id="dl-gp-date" value="' + dstr(today) + '" style="' + inp + 'flex:1;">' +
              '<input type="time" id="dl-gp-time" style="' + inp + 'width:108px;">' +
              '<button id="dl-gp-cbgo" class="dl-btn blue" style="padding:8px 12px;font-size:13px;font-weight:800;">지정</button>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-3);margin-top:6px;">지정한 날짜·시간이 TM 고객관리 「오늘 콜」에 바로 올라가 놓치지 않아요.</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button id="dl-gp-clear" class="dl-btn" style="flex:1;padding:9px;font-size:12.5px;">결과 해제</button>' +
            '<button id="dl-gp-x" class="dl-btn" style="flex:1;padding:9px;font-size:12.5px;">취소</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const done = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(); } }
    document.addEventListener('keydown', onKey);
    const apply = (tag, cbDate, cbTime) => {
      done();
      if (forRow) {
        const item = queue[rowIdx]; if (!item) return;
        if (tag === '나중연락' && cbDate) { item.callbackAt = cbDate; item.callbackTime = cbTime || ''; }
        setQueueResultDirect(rowIdx, tag);
      } else {
        applyGamangCurrent(tag, cbDate, cbTime);
      }
    };
    ov.querySelector('#dl-gp-plain').onclick = () => apply('가망');
    ov.querySelector('#dl-gp-visit').onclick = () => apply('방문예약');
    ov.querySelectorAll('.dl-gp-chip').forEach(b => b.onclick = () => apply('나중연락', b.dataset.d, b.dataset.t));
    ov.querySelector('#dl-gp-cbgo').onclick = () => {
      const d = ov.querySelector('#dl-gp-date').value;
      if (!d) { toast('콜백 날짜를 선택하세요'); return; }
      apply('나중연락', d, ov.querySelector('#dl-gp-time').value || '');
    };
    ov.querySelector('#dl-gp-clear').onclick = () => {
      done();
      if (forRow) { setQueueResultDirect(rowIdx, null); }
      else { pendingTag = null; window.__dialerResult = null; document.querySelectorAll('.dl-result-btn').forEach(b => b.classList.remove('sel')); resetGamangBtn(); }
    };
    ov.querySelector('#dl-gp-x').onclick = done;
    ov.onclick = (e) => { if (e.target === ov) done(); };
  }
  // 현재 통화 대상에 가망 유형 적용 — pendingTag + (콜백이면 큐 항목에 날짜·시간)
  function applyGamangCurrent(tag, cbDate, cbTime) {
    pendingTag = tag; window.__dialerResult = pendingTag;
    const item = (curIdx >= 0 && queue[curIdx]) ? queue[curIdx] : null;
    if (item && tag === '나중연락' && cbDate) { item.callbackAt = cbDate; item.callbackTime = cbTime || ''; touchQ(item); persistQueue(); renderQueue(); }
    document.querySelectorAll('.dl-result-btn').forEach(b => b.classList.remove('sel'));
    const gb = document.querySelector('.dl-result-btn[data-tag="가망"]');
    if (gb) {
      gb.classList.add('sel');
      gb.textContent = tag === '가망' ? '가망' : (tag === '방문예약' ? '가망·방문예약' : ('가망·콜백' + (cbTime ? ' ' + cbTime : '')));
    }
    toast('결과 선택: ' + (tag === '나중연락' ? ('콜백 ' + (cbDate || '') + (cbTime ? ' ' + cbTime : '')) : tag) + ' — [정지]/[다음 번호] 때 저장돼요');
  }

  // 📞 폰 통화기록을 캐시에 담아둔다(발신 전 '이미 통화한 번호?' 즉시 확인용). 연결/통화종료 시 갱신.
  async function refreshCallLogCache() {
    if (!connected) return;
    try {
      const rows = (await D.callLogList(500)) || [];
      const m = {};
      rows.forEach(r => {
        const d = String(r.number).replace(/\D/g, ''); if (!d) return;
        if (!m[d]) m[d] = { count: 0, out: 0, lastDate: 0 };
        m[d].count++; if (r.type === '2') m[d].out++;
        if (r.date > m[d].lastDate) m[d].lastDate = r.date;
      });
      callLogCache = m;
    } catch (e) {}
  }
  // 이 번호의 과거 통화이력(폰 통화기록 캐시 + 앱 기록) → 있으면 확인창용 설명, 없으면 null
  function callHistoryFor(number) {
    const d = String(number).replace(/\D/g, ''); if (!d) return null;
    const fmtWhen = (ms) => { const dt = new Date(ms); if (isNaN(dt) || !ms) return ''; const h = dt.getHours(), ap = h < 12 ? '오전' : '오후', h12 = h % 12 || 12; return `${dt.getMonth() + 1}/${dt.getDate()} ${ap} ${h12}:${String(dt.getMinutes()).padStart(2, '0')}`; };
    const c = callLogCache[d];
    // 앱 기록에서 마지막 결과/시각 보강
    let appHit = false, appLast = 0, appTag = '';
    for (const r of records) { if (r && String(r.number).replace(/\D/g, '') === d) { appHit = true; const t = r.ts || Date.parse(r.time) || 0; if (t >= appLast) { appLast = t; appTag = r.tag || ''; } } }
    if (!c && !appHit) return null;   // 통화한 적 없음 → 확인창 없이 바로 발신
    const lines = [];
    if (c) { lines.push(`최근 통화: ${fmtWhen(c.lastDate)}`); lines.push(`총 ${c.count}회` + (c.out ? ` · 발신 ${c.out}회` : '')); }
    else if (appLast) { lines.push(`최근 통화: ${fmtWhen(appLast)}`); }
    if (appTag) lines.push(`지난 결과: ${appTag}`);
    return lines.length ? lines.join('\n') : '전에 통화한 기록이 있어요';
  }
  // 🚫 차단요청한 번호인지 (앱 폴더 차단목록 또는 앱 기록에 '차단요청' 결과가 있으면 발신 금지)
  function isBlocked(number) {
    const d = String(number).replace(/\D/g, ''); if (!d) return false;
    if (blockedSet.has(d)) return true;
    for (const r of records) { if (r && String(r.number).replace(/\D/g, '') === d && r.tag === '차단요청') return true; }
    return false;
  }

  // 앱 디자인 확인창 (기본 confirm() 대체, 재사용) → Promise<boolean>
  function appConfirm(message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const old = document.getElementById('dl-confirm-modal'); if (old) old.remove();
      const ov = document.createElement('div');
      ov.id = 'dl-confirm-modal';
      // ⚠ 고객정보창(100003) 등 다른 모달 위에서 떠야 한다 — 같은 z면 뒤에 가려 "눌러도 반응 없음"으로 보인다
      ov.style.cssText = 'position:fixed;inset:0;z-index:100020;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
      const okClass = opts.danger ? 'red' : 'green';
      ov.innerHTML =
        '<div style="width:min(340px,92vw);background:#1c1b18;border:1px solid var(--accent);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
          '<div style="padding:20px;font-size:15px;color:var(--text-1);line-height:1.65;white-space:pre-line;">' + escapeHtml(message) + '</div>' +
          '<div style="display:flex;gap:8px;padding:0 18px 18px;">' +
            '<button id="dl-cf-cancel" class="dl-btn" style="flex:1;padding:11px;font-size:14px;">취소</button>' +
            '<button id="dl-cf-ok" class="dl-btn ' + okClass + '" style="flex:1.2;padding:11px;font-size:14px;font-weight:800;">' + escapeHtml(opts.okText || '확인') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter') { e.preventDefault(); done(true); } }
      ov.querySelector('#dl-cf-cancel').onclick = () => done(false);
      ov.querySelector('#dl-cf-ok').onclick = () => done(true);
      document.addEventListener('keydown', onKey);
      setTimeout(() => { try { ov.querySelector('#dl-cf-ok').focus(); } catch (e) {} }, 30);
    });
  }

  // 🔔 단순 알림(경고) 모달 — 확인 버튼 하나. opts:{title, danger, okText} → Promise<true>
  function appAlert(message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const old = document.getElementById('dl-alert-modal'); if (old) old.remove();
      const ov = document.createElement('div');
      ov.id = 'dl-alert-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:100021;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
      const bc = opts.danger ? '#e8564a' : 'var(--accent)';
      ov.innerHTML =
        '<div style="width:min(410px,93vw);background:#1c1b18;border:1px solid ' + bc + ';border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
          (opts.title ? '<div style="padding:16px 20px 0;font-size:16px;font-weight:800;color:' + bc + ';">' + escapeHtml(opts.title) + '</div>' : '') +
          '<div style="padding:14px 20px 18px;font-size:14px;color:var(--text-1);line-height:1.7;white-space:pre-line;">' + escapeHtml(message) + '</div>' +
          '<div style="display:flex;padding:0 18px 18px;"><button id="dl-al-ok" class="dl-btn accent" style="flex:1;padding:11px;font-size:14px;font-weight:800;">' + escapeHtml(opts.okText || '확인') + '</button></div>' +
        '</div>';
      document.body.appendChild(ov);
      const done = () => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(true); };
      function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); } }
      ov.querySelector('#dl-al-ok').onclick = done;
      document.addEventListener('keydown', onKey);
      setTimeout(() => { try { ov.querySelector('#dl-al-ok').focus(); } catch (e) {} }, 30);
    });
  }

  // 🔍 폰 자동 탐색 실패 시 → 상황을 구분해 경고창 + 정확한 지침을 띄운다.
  //   r: D.autoFind() 반환값 { reason, bases, lastIp } (bases=이 PC가 붙은 Wi-Fi 대역들)
  function guideFindFailure(r) {
    r = r || {};
    const bases = r.bases || [];
    const lastIp = r.lastIp || '';
    const lastBase = lastIp ? (lastIp.split('.').slice(0, 3).join('.') + '.') : '';
    const laptopNet = bases.length ? bases.map(b => b + 'x').join(', ') : '(연결 없음)';
    if (r.reason === 'no-lan') {
      return appAlert('이 노트북이 Wi-Fi에 연결돼 있지 않아요.\n\n▶ 노트북 Wi-Fi를 먼저 연결한 뒤\n다시 [🔍 연결]를 눌러주세요.', { title: '⚠️ 노트북 Wi-Fi 없음', danger: true });
    }
    if (r.reason === 'not-authorized') {
      return appAlert('폰은 찾았는데 아직 연결 허용이 안 됐어요.\n\n▶ 폰 화면에 뜨는 [이 컴퓨터에서 항상 허용]을\n체크하고 [허용]을 눌러주세요.\n그다음 다시 [🔍 연결]를 누르면 됩니다.', { title: '⚠️ 폰에서 허용 필요', danger: true });
    }
    // none-open: 폰이 이 대역에 없음 → 다른 Wi-Fi인지 / 폰이 꺼졌는지 구분
    const differentNet = lastBase && bases.length && !bases.includes(lastBase);
    if (differentNet) {
      return appAlert(
        '노트북과 폰이 서로 다른 Wi-Fi에 있는 것 같아요.\n' +
        '(다른 대역이라 노트북이 폰에 닿질 못해요)\n\n' +
        '· 노트북 지금 Wi-Fi 대역: ' + laptopNet + '\n' +
        '· 폰 예전 IP: ' + lastIp + '\n\n' +
        '▶ 폰을 노트북과 같은 Wi-Fi에 연결한 뒤\n다시 [🔍 연결]를 눌러주세요.',
        { title: '⚠️ 폰이 다른 Wi-Fi에 있어요', danger: true });
    }
    return appAlert(
      '같은 Wi-Fi에서 폰을 찾지 못했어요.\n' +
      '폰이 껐다 켜졌거나 배터리가 빠졌으면\n무선 연결통로(5555)가 꺼집니다.\n\n' +
      '▶ USB 케이블로 폰을 연결하고\n"1_무선연결_초기설정_자동IP.bat"을\n한 번 실행해 주세요. (끝나면 USB 빼도 됩니다)',
      { title: '⚠️ 폰을 못 찾음', danger: true });
  }

  // 🔔 재발신 확인 모달 — 통화이력 + 녹음(재생) + 문자 를 함께 보고 걸지 결정. 차단요청 번호면 발신 금지. → Promise<boolean>
  function confirmRedial(number, histText, blocked) {
    return new Promise(resolve => {
      const old = document.getElementById('dl-redial-modal'); if (old) old.remove();
      const ov = document.createElement('div');
      ov.id = 'dl-redial-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
      const borderCol = blocked ? '#b0392e' : 'var(--accent)';
      const header = blocked
        ? '<div style="padding:15px 18px 12px;border-bottom:1px solid var(--border);font-size:16px;font-weight:800;color:#e8564a;">🚫 차단요청한 번호예요</div>'
        : '<div style="padding:15px 18px 12px;border-bottom:1px solid var(--border);font-size:15px;font-weight:800;color:var(--accent);">📞 전에 통화한 번호예요</div>';
      const midMsg = blocked
        ? '<div style="margin-top:12px;padding:11px 13px;border-radius:9px;background:rgba(176,57,46,.18);border:1px solid #b0392e;font-size:14.5px;font-weight:700;color:#ffb3ab;line-height:1.6;">⛔ 이 고객은 <b>차단요청</b>했습니다. 전화하면 안 됩니다.</div>'
        : '<div style="margin-top:14px;font-size:15px;font-weight:700;color:var(--accent);">전화를 거시겠습니까?</div>';
      const footer = blocked
        ? '<div style="display:flex;padding:0 18px 18px;"><button id="dl-redial-cancel" class="dl-btn" style="flex:1;padding:12px;font-size:14px;font-weight:800;">닫기</button></div>'
        : '<div style="display:flex;gap:8px;padding:0 18px 18px;"><button id="dl-redial-cancel" class="dl-btn" style="flex:1;padding:11px;font-size:14px;">취소</button><button id="dl-redial-ok" class="dl-btn green" style="flex:1.4;padding:11px;font-size:14px;font-weight:800;">📞 전화 걸기</button></div>';
      ov.innerHTML =
        '<div style="width:min(460px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#1c1b18;border:1px solid ' + borderCol + ';border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
          header +
          '<div style="overflow-y:auto;padding:16px 18px;">' +
            '<div style="font-size:23px;font-weight:800;color:var(--text-1);letter-spacing:.3px;font-variant-numeric:tabular-nums;">' + escapeHtml(fmtPhone(number)) + '</div>' +
            (histText ? '<div style="margin-top:11px;font-size:15.5px;font-weight:600;color:var(--text-1);white-space:pre-line;line-height:1.75;">' + escapeHtml(histText) + '</div>' : '') +
            midMsg +
            '<div style="font-size:13px;font-weight:800;color:var(--accent);margin:18px 0 6px;">🎙 통화 녹음</div>' +
            '<div id="dl-rd-rec"><span style="color:var(--text-3);font-size:12px;">불러오는 중…</span></div>' +
            '<div style="font-size:13px;font-weight:800;color:var(--accent);margin:16px 0 6px;">💬 문자</div>' +
            '<div id="dl-rd-sms"><span style="color:var(--text-3);font-size:12px;">불러오는 중…</span></div>' +
          '</div>' +
          footer +
        '</div>';
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter' && !blocked) { e.preventDefault(); done(true); } }
      ov.querySelector('#dl-redial-cancel').onclick = () => done(false);
      const okb = ov.querySelector('#dl-redial-ok'); if (okb) okb.onclick = () => done(true);
      document.addEventListener('keydown', onKey);
      if (connected) { loadRecordingsInto(ov.querySelector('#dl-rd-rec'), number); loadSmsInto(ov.querySelector('#dl-rd-sms'), number); }
      else { ov.querySelector('#dl-rd-rec').innerHTML = '<span style="color:var(--text-3);font-size:12px;">폰 미연결</span>'; ov.querySelector('#dl-rd-sms').innerHTML = ''; }
      setTimeout(() => { try { (okb || ov.querySelector('#dl-redial-cancel')).focus(); } catch (e) {} }, 30);
    });
  }

  async function dialCurrent() {
    if (curIdx < 0 || !queue[curIdx]) return;
    if (!connected) { toast('먼저 연결하세요'); return; }
    const number0 = queue[curIdx].number;
    // 🆕 P3) 수신거부 대장 번호 → 발신 자체를 차단 (고객 DB는 이미 파기됨)
    if (optOutSet.has(dNorm(number0))) {
      looping = false; clearCountdown();
      await appAlert('수신거부 이력이 있는 번호입니다.\n재발신 방지 목록에 등록되어 발신할 수 없어요.', { title: '⛔ 수신거부 번호', danger: true });
      return;
    }
    // 🆕 P1) TM 발신금지(출처불명 격리·수신거부·민원) 고객 → 발신 자체를 차단
    const tmc = await getTmInfo(number0);
    if (tmNoCall(tmc)) {
      looping = false; clearCountdown();
      await appAlert('이 고객에게는 전화하면 안 됩니다.\n\n' + srcLineFor(tmc) + '\n\n(해제는 TM 고객관리 → 출처 상세에서)', { title: '⛔ 발신금지 고객', danger: true });
      return;
    }
    const srcLine = srcLineFor(tmc);   // 🆕 P1) 발신 확인창에 출처 표시 — "○○를 통해 문의 주셨던 번호입니다"
    // 🔔 이미 통화했던 번호(또는 차단요청 번호)면 확인창 — 녹음·문자 같이 보고 걸지 결정. 차단요청이면 발신 금지.
    const blocked = isBlocked(number0);
    const hist = callHistoryFor(number0);
    if (blocked || hist) {
      const ok = await confirmRedial(number0, (srcLine ? srcLine + '\n' : '') + (hist || ''), blocked);
      if (!ok) {
        looping = false;              // 자동 다음번호로 안 넘어가게
        clearCountdown();
        toast(blocked ? '🚫 차단요청 번호 — 발신 취소' : '발신 취소했어요');
        return;
      }
    }
    clearCallback();                // 콜백 상태였으면 해제 (정상 발신으로 전환)
    clearCountdown();               // 대기 카운트다운이 남아 있으면 제거 (경합 방지)
    const number = queue[curIdx].number;
    queue[curIdx]._saved = false;   // 새 통화 → 기록 가능 상태로
    queue[curIdx]._recRef = null;   // 새 통화 → 새 기록 (이전 기록 참조 끊기)
    dialStart = Date.now();
    startCallTimer();                     // ⏱ 경과시간 0:00부터 카운트업 시작
    dialGuardUntil = Date.now() + 9000;   // 발신 직후 RINGING은 우리 것 → 수신 오인 방지
    await announceCall(number);
    const r = await D.dial(number);
    if (r.ok) toast(`📞 발신: ${fmtPhone(number)} — 통화 후 결과+메모, [다음 번호]`);
    else toast('발신 실패: ' + (r.message || ''));
  }
  // 더블클릭/시작 공통 경로 — 항상 같은 방식으로 발신 (꼬임 방지)
  function startFrom(i) {
    if (!queue.length) { toast('번호 목록을 먼저 추가하세요'); return; }
    clearCountdown();
    // ⏹ 이전 통화가 아직 돌고 있으면(사용자가 정지 안 누른 상태) 강제 정지 → 새 번호로 이동
    if (dialStart) { try { stopCallTimer(); } catch (e) {} dialStart = 0; updateCallTimer(); clearCurrentCallFlag(); }
    if (callbackActive) clearCallback();
    curIdx = i; looping = true; renderQueue(); showCurrent(); dialCurrent();
  }
  // 통화결과(tag)가 이미 있는 번호는 건너뛰고, from 이후 첫 '미통화' 번호 인덱스 반환 (-1 = 없음)
  function nextUncalledIndex(from) {
    let i = Math.max(0, from || 0);
    while (i < queue.length && queue[i] && (queue[i].tag || queue[i].done)) i++;   // 폰에서 통화한 번호(done)도 건너뜀
    return i < queue.length ? i : -1;
  }
  function start() {
    if (!queue.length) { toast('번호 목록을 먼저 추가하세요'); return; }
    if (curIdx < 0) curIdx = 0;
    // 결과가 이미 있는 번호는 [시작] 시 건너뛰고 첫 '미통화' 번호로.
    // (특정 번호로 강제 발신하려면 그 번호를 더블클릭 → startFrom)
    const t = nextUncalledIndex(curIdx);
    if (t < 0) { toast('남은 번호가 모두 결과 있음 — 다시 걸려면 번호를 더블클릭하세요'); return; }
    if (t !== curIdx) { curIdx = t; toast(`결과 있는 번호는 건너뜀 → ${fmtPhone(queue[curIdx].number)}부터 시작`); }
    looping = true; renderQueue(); showCurrent(); dialCurrent();
  }

  // 🔗 발신 결과/메모를 집수호 TM 콜매니저로 전달 (tmcrm.bridge.js 가 받아 iframe에 반영)
  //    번호로 고객을 찾아 상태·최근통화·다음연락일·메모 갱신(없으면 신규 생성). ts로 중복 방지.
  function emitJipSync(rec) {
    if (!rec || !rec.number) return;
    // 🚫 결과가 '차단요청'이면 차단목록(앱 폴더) 등록 + 폰 연락처에 "차단요청N"으로 저장
    if (rec.tag === '차단요청') {
      const d = String(rec.number).replace(/\D/g, '');
      if (d && !blockedSet.has(d)) {
        blockedSet.add(d);
        try { D.addBlocked(rec.number); } catch (e) {}
        try { D.addBlockedContact(rec.number).then(r => { if (r && r.ok && !r.already && r.name) toast('📵 폰에 저장: ' + r.name); }); } catch (e) {}
      }
    }
    try {
      document.dispatchEvent(new CustomEvent('dialer:jipsync', { detail: {
        number: rec.number, name: rec.name || '', tag: rec.tag || '',
        memo: rec.memo || '', ts: rec.ts || null, dur: (rec.duration == null ? null : rec.duration),
        legal: rec.legal || null,      // 🆕 P1/P2) 수신거부/수신동의/증빙 녹음 → TM 법정 로그
        evidence: rec.evidence || null, // 🆕 P2) 증빙 녹음 파일의 PC 보관 경로
        evidenceMiss: rec.evidenceMiss || null, // ⚠️ 증빙 확보 실패 사유(폰 미연결·녹음 없음·보관 실패) — 없으면 없다고 남긴다
        cbDate: rec.cbDate || null, cbTime: rec.cbTime || null, // 🆕 P3) 가망 팝업 콜백 날짜·시각 → TM 다음연락일에 그대로
        said: rec.said || null, callSec: (rec.callSec == null ? null : rec.callSec), // 🆕 P4) 수신거부 사유(고객 발언)·통화시간 = 감사 근거
        consentAt: rec.consentAt || null, consentVia: rec.consentVia || null // ✅ P6) 동의 체크 일시·방식 → TM 고객 레코드에 저장
      } }));
    } catch (e) {}
  }

  // ============================================================
  //  🆕 P1) 개인정보보호법 대응 — 출처 표시 + 발신금지(격리·수신거부) 잠금
  //  · TM 고객관리의 출처 필드(srcPath/srcConsent/srcState/optOutAt)를 TMCRM.getCustomers()로
  //    받아 15초 캐시 → 현재 통화 아래 출처 표시("○○를 통해 문의 주셨던 번호입니다"용) + 발신 전 잠금 확인.
  // ============================================================
  // ⛔ P3) 수신거부 대장(재발신 방지) — TM이 store 'tmcrm_optout'에 미러. 통화기록에서 걸기 등 모든 발신 경로 하드블록.
  let optOutSet = new Set();
  async function loadOptOutSet() {
    try {
      const ol = (window.api && window.api.store) ? ((await window.api.store.get('tmcrm_optout')) || []) : [];
      if (Array.isArray(ol)) ol.forEach(o => { if (o && o.digits) optOutSet.add(String(o.digits)); });
    } catch (e) {}
  }
  document.addEventListener('dialer:optout-update', (e) => {
    const items = (e && e.detail && e.detail.items) || [];
    optOutSet = new Set(items.map(o => o && o.digits).filter(Boolean));
  });

  // ============================================================
  // ✅ P6) 수신동의 = 메모 텍스트가 아니라 **번호에 붙는 체크 상태**.
  //   저장 3중화 — ①TM 고객 레코드(consentAt/srcConsent, 진짜 원장) ②store 미러 'tmcrm_consent'(TM 저장 때 브리지가 갱신)
  //   ③이 PC 통화기록 rec.consentAt (TM을 한 번도 안 열어도 남고, 재시작 시 부팅 스캔으로 복구)
  //   → 어디서 보든 같은 상태가 보이고, 중복 클릭해도 기록이 겹쳐 쌓이지 않는다(토글).
  // ============================================================
  let consentMap = new Map();   // digits → {at, via}
  //  ⏱ 방금 이 화면에서 켜고 끈 번호 — TM 미러가 한 박자 늦게 도착해 내 조작을 되돌리는 걸 막는다
  //     (TM 반영 → 저장 → 미러 왕복에 몇 초 걸리므로 그 사이 창은 로컬 값을 신뢰한다)
  const consentRecent = new Map();   // digits → 마지막 로컬 변경 시각(ms)
  const CONSENT_LOCAL_HOLD_MS = 20000;
  function consentOf(number) { const d = dNorm(number); return d ? (consentMap.get(d) || null) : null; }
  function setConsentLocal(number, info) {
    const d = dNorm(number); if (!d) return;
    if (info) consentMap.set(d, info); else consentMap.delete(d);
    consentRecent.set(d, Date.now());
  }
  async function loadConsentMap() {
    try {
      const cl = (window.api && window.api.store) ? ((await window.api.store.get('tmcrm_consent')) || []) : [];
      if (Array.isArray(cl)) cl.forEach(c => { if (c && c.digits) consentMap.set(String(c.digits), { at: c.at || '', via: c.via || '전화 동의' }); });
    } catch (e) {}
    // 미러가 비어 있어도(=TM 미개봉) 내 통화기록에 남은 동의 표시로 복구
    records.forEach(r => {
      const d = dNorm(r && r.number);
      if (d && r.consentAt && !consentMap.has(d)) consentMap.set(d, { at: r.consentAt, via: r.consentVia || '전화 동의' });
    });
  }
  document.addEventListener('dialer:consent-update', (e) => {
    const items = (e && e.detail && e.detail.items) || [];
    const next = new Map(items.filter(c => c && c.digits).map(c => [String(c.digits), { at: c.at || '', via: c.via || '전화 동의' }]));
    // 방금(20초 내) 이 화면에서 직접 바꾼 번호는 미러가 덮지 못하게 로컬 값을 유지 — "해제했는데 되살아남" 방지
    const now = Date.now();
    consentRecent.forEach((t, d) => {
      if (now - t > CONSENT_LOCAL_HOLD_MS) { consentRecent.delete(d); return; }
      if (consentMap.has(d)) next.set(d, consentMap.get(d)); else next.delete(d);
    });
    consentMap = next;
    renderQueue(); refreshConsentBtn();
  });
  // 현재 번호의 동의 여부에 따라 결과 영역의 수신동의 버튼을 체크 상태로 바꾼다
  function refreshConsentBtn() {
    const b = $('dl-consent-btn'); if (!b) return;
    const cur = (curIdx >= 0 && queue[curIdx]) ? consentOf(queue[curIdx].number) : null;
    if (cur) {
      b.textContent = '☑ 수신동의됨';
      b.style.borderColor = 'rgba(52,181,110,.9)';
      b.style.background = 'rgba(52,181,110,.22)';
      b.style.color = '#9ff0bd';
      b.title = '수신동의 받은 번호입니다 (' + (cur.at ? String(cur.at).slice(0, 10) : '') + ' · ' + (cur.via || '전화 동의') + ')\n다시 누르면 해제합니다';
    } else {
      b.textContent = '✅ 수신동의';
      b.style.borderColor = 'rgba(52,181,110,.55)';
      b.style.background = '';
      b.style.color = '#7fd8a4';
      b.title = '통화 중 "앞으로 안내 연락 동의"를 받으면 누르세요 — 이 번호에 동의 표시(✓)가 저장되고 일시·방식·상담사가 기록됩니다';
    }
  }
  let tmInfoCache = { at: 0, map: null };
  async function getTmInfo(number) {
    const d = dNorm(number); if (!d) return null;
    const now = Date.now();
    if (!tmInfoCache.map || now - tmInfoCache.at > 15000) {
      let all = [];
      try { if (window.TMCRM && TMCRM.getCustomers) all = (await TMCRM.getCustomers()) || []; } catch (e) {}
      const m = new Map();
      all.forEach(c => { const k = dNorm(c && c.phone); if (k) m.set(k, c); });
      tmInfoCache = { at: now, map: m };
    }
    return tmInfoCache.map.get(d) || null;
  }
  function tmNoCall(c) { return !!(c && (c.optOutAt || c.srcState === '격리')); }
  // ✅ P6) 동의 체크는 TM 정보와 별개로 로컬 consentMap 기준으로도 항상 앞에 붙인다(TM 미개봉에도 보이게)
  function consentPrefixFor(number) {
    const cs = consentOf(number);
    return cs ? '✅ 수신동의 받음' + (cs.at ? ' (' + String(cs.at).slice(0, 10) + ')' : '') + '\n' : '';
  }
  function srcLineFor(c) {
    if (!c) return '';
    if (c.optOutAt) return '⛔ 발신금지 — ' + (c.optOutReason || '수신거부') + ' (' + String(c.optOutAt).slice(0, 10) + ' 처리)';
    if (c.srcState === '격리') return '🚫 출처불명 격리 — 발신금지';
    const bits = [];
    if (c.source || c.srcPath) bits.push((c.source || c.srcPath) + (c.srcPath && c.source && c.srcPath !== c.source ? ' (' + c.srcPath + ')' : ''));
    if (c.srcDate) bits.push(String(c.srcDate).slice(2) + ' 수집');
    if (c.srcConsent) bits.push(c.srcConsent);
    if (!bits.length) return '⚠️ 출처 미분류 — TM 고객관리에서 확인 필요';
    return '📌 출처: ' + bits.join(' · ');
  }
  // 현재 통화 번호 아래 출처 한 줄 표시 (showCurrent 마다 갱신 · 비동기 경합은 seq로 차단)
  let srcInfoSeq = 0;
  async function updateSrcInfo(number) {
    let el = $('dl-src-info');
    if (!el) {
      const cur = $('dl-current'); if (!cur || !cur.parentElement) return;
      el = document.createElement('div'); el.id = 'dl-src-info';
      el.style.cssText = 'display:none;margin:8px 0 0;padding:6px 9px;border-radius:8px;font-size:11.5px;font-weight:700;line-height:1.5;border:1px solid var(--border);color:var(--text-2);background:var(--bg-2);';
      cur.parentElement.insertBefore(el, cur.nextSibling);
    }
    const seq = ++srcInfoSeq;
    if (!number) { el.style.display = 'none'; return; }
    // 🆕 P3) 수신거부 대장 번호(고객 DB는 파기됨)도 표시 — TM 조회 전에 즉시
    if (optOutSet.has(dNorm(number))) {
      el.textContent = '⛔ 수신거부 이력 — 재발신 방지 목록 등록(발신 금지)';
      el.style.color = '#ffb3ab'; el.style.borderColor = '#b0392e'; el.style.display = 'block';
      return;
    }
    const c = await getTmInfo(number);
    if (seq !== srcInfoSeq) return;   // 그 사이 다른 번호로 바뀜 → 이 응답은 버림
    const t = consentPrefixFor(number) + srcLineFor(c);   // ✅ P6) 동의 체크를 맨 앞에
    if (!t.trim()) { el.style.display = 'none'; return; }
    el.textContent = t.trim();
    const danger = tmNoCall(c), warn = /미분류/.test(t);
    el.style.color = danger ? '#ffb3ab' : (warn ? '#e8a84a' : 'var(--text-2)');
    el.style.borderColor = danger ? '#b0392e' : (warn ? 'rgba(232,168,74,.5)' : 'var(--border)');
    el.style.display = 'block';
  }
  // ⛔ P4) 수신거부 사유 입력 모달 — "고객이 뭐라고 했는지"를 반드시 남긴다.
  //    빠른 선택 칩으로 한 번에 고르되, 직접 입력도 가능. 사유 없이는 저장 불가(무단 클릭 억제).
  //    → Promise<{said} | null>  (취소 시 null)
  const OPTOUT_REASONS = [
    '전화하지 말라고 하심',
    '관심 없다고 하심',
    '내 번호 어떻게 알았냐고 항의하심',
    '이미 계약했다고 하심',
    '다시 걸면 신고한다고 하심',
    '통화 중 강하게 화내며 끊으심',
  ];
  function askOptOutReason(number) {
    return new Promise(resolve => {
      const old = document.getElementById('dl-optout-modal'); if (old) old.remove();
      // 통화가 없으면 0이 아니라 null — 대장에서 '통화 없음'으로 정확히 구분되게 (0초 통화와 다름)
      const callSec = dialStart ? Math.round((Date.now() - dialStart) / 1000) : null;
      const shortWarn = (callSec == null || callSec < 8)
        ? '<div style="margin-top:10px;padding:9px 11px;border-radius:8px;background:rgba(232,168,74,.14);border:1px solid rgba(232,168,74,.5);font-size:12px;color:#e8a84a;line-height:1.55;">⚠️ 통화 기록이 없거나 매우 짧습니다(' + (callSec == null ? '통화 없음' : callSec + '초') + ').<br>수신거부는 고객이 실제로 거부 의사를 밝힌 경우에만 사용하세요 — 통화시간·상담사가 함께 기록되어 관리자에게 보고됩니다.</div>'
        : '';
      const ov = document.createElement('div');
      ov.id = 'dl-optout-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:100005;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
      ov.innerHTML =
        '<div style="width:min(430px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#1c1b18;border:1px solid #b0392e;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
          '<div style="padding:15px 18px 12px;border-bottom:1px solid var(--border);font-size:16px;font-weight:800;color:#e8564a;">⛔ 수신거부 — 고객이 뭐라고 하셨나요?</div>' +
          '<div style="overflow-y:auto;padding:15px 18px;">' +
            '<div style="font-size:13px;color:var(--text-2);line-height:1.6;">' + escapeHtml(fmtPhone(number)) + ' 고객을 <b style="color:#ffb3ab;">DB에서 파기</b>하고 재발신 방지 목록에 올립니다.<br>이 기록은 되돌릴 수 없고, 누가·언제·왜 눌렀는지 남습니다.</div>' +
            // 📏 판단 기준 — "수신거부인지 애매하다"는 상황을 없앤다. 애매하면 '관심없음'이 정답.
            '<div style="margin-top:10px;padding:10px 12px;border-radius:9px;background:var(--bg-2);border:1px solid var(--border);font-size:12px;line-height:1.65;">' +
              '<div style="color:#ffb3ab;font-weight:800;margin-bottom:4px;">이럴 때만 수신거부</div>' +
              '<div style="color:var(--text-2);">"다시는 전화하지 마세요" · "번호 어떻게 알았냐" 항의 · "신고하겠다" — <b>연락 자체를 거부</b></div>' +
              '<div style="color:#7fd8a4;font-weight:800;margin:8px 0 4px;">이건 수신거부 아님 → [관심없음]</div>' +
              '<div style="color:var(--text-2);">"지금은 관심 없어요" · "바빠요" · 그냥 끊음 — <b>나중에 다시 걸 수 있는 고객</b>입니다. 수신거부로 누르면 DB가 사라져 회사 자산이 없어집니다.</div>' +
            '</div>' +
            shortWarn +
            '<div style="font-size:12.5px;font-weight:800;color:var(--accent);margin:16px 0 7px;">빠른 선택</div>' +
            '<div id="dl-oo-chips" style="display:flex;flex-wrap:wrap;gap:6px;">' +
              OPTOUT_REASONS.map(r => '<button class="dl-btn dl-oo-chip" data-r="' + escapeHtml(r) + '" style="font-size:12px;padding:7px 10px;text-align:left;">' + escapeHtml(r) + '</button>').join('') +
            '</div>' +
            '<div style="font-size:12.5px;font-weight:800;color:var(--accent);margin:16px 0 7px;">고객 발언 · 상황 (필수)</div>' +
            '<textarea id="dl-oo-said" rows="3" placeholder="예) 어디서 번호 알았냐고 화내시며 다시 걸지 말라고 하심" ' +
              'style="width:100%;box-sizing:border-box;padding:10px 11px;font-size:13px;font-family:inherit;line-height:1.6;border-radius:9px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);outline:none;resize:vertical;"></textarea>' +
            '<div id="dl-oo-hint" style="font-size:11.5px;color:var(--text-3);margin-top:6px;">5자 이상 적어주세요. 통화 녹음도 증빙으로 자동 보관됩니다.</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;padding:12px 18px 16px;border-top:1px solid var(--border);">' +
            '<button id="dl-oo-cancel" class="dl-btn" style="flex:1;padding:11px;font-size:14px;">취소</button>' +
            '<button id="dl-oo-ok" class="dl-btn red" style="flex:1.4;padding:11px;font-size:14px;font-weight:800;opacity:.5;" disabled>기록하고 파기</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      const ta = ov.querySelector('#dl-oo-said');
      const okb = ov.querySelector('#dl-oo-ok');
      const sync = () => {
        const ok = ta.value.trim().length >= 5;
        okb.disabled = !ok; okb.style.opacity = ok ? '1' : '.5';
        ov.querySelector('#dl-oo-hint').textContent = ok ? '입력 완료 — 기록할 수 있어요.' : '5자 이상 적어주세요. 통화 녹음도 증빙으로 자동 보관됩니다.';
      };
      ta.addEventListener('input', sync);
      ov.querySelectorAll('.dl-oo-chip').forEach(b => b.onclick = () => {
        const r = b.dataset.r;
        ta.value = ta.value.trim() ? (ta.value.trim() + ' · ' + r) : r;
        sync(); ta.focus();
      });
      const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(null); } }
      ov.querySelector('#dl-oo-cancel').onclick = () => done(null);
      okb.onclick = () => { const s = ta.value.trim(); if (s.length < 5) return; done({ said: s, callSec }); };
      document.addEventListener('keydown', onKey);
      setTimeout(() => { try { ta.focus(); } catch (e) {} }, 40);
    });
  }
  // ⚖ 수신거부 기록 — 사유 입력 후 거부 처리 + TM DB 파기/재발신 방지 + 상담사·통화시간 감사 로그
  async function legalOneClick(kind) {
    if (curIdx < 0 || !queue[curIdx]) { toast('먼저 번호를 선택하세요'); return; }
    const item = queue[curIdx];
    const ans = await askOptOutReason(item.number);
    if (!ans) { toast('수신거부 기록을 취소했어요'); return; }
    const now = new Date();
    const stamp = '[' + kind + ' · ' + now.toLocaleString('ko-KR') + ' 기록] ' + ans.said;
    item.tag = '거부'; touchQ(item); dialSyncSoon();
    const existing = (item._recRef && records.indexOf(item._recRef) !== -1) ? item._recRef : findRecordFor(item.number);
    let rec;
    if (existing) { rec = existing; rec.tag = '거부'; }
    else {
      rec = {
        number: item.number, name: currentCustomerName() || null, tag: '거부', memo: '',
        dialAt: now.toLocaleString('ko-KR'),
        time: now.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        duration: null, ts: now.toISOString(),
      };
      records.push(rec);
      item._recRef = rec; item._saved = true;
    }
    rec.memo = rec.memo ? (rec.memo + '\n' + stamp) : stamp;
    // 메모장에도 같은 스탬프를 남겨 이후 [정지]의 commitCurrent(메모장 내용으로 갱신)가 기록을 지우지 않게 한다
    try { const inp = $('np-input'); if (inp) inp.value = inp.value ? (inp.value + '\n' + stamp) : stamp; } catch (e) {}
    persistRecords(); renderRecords(); persistQueue(); renderQueue();
    // 🆕 P4) 사유(고객 발언)·통화시간을 함께 전송 → TM 대장에 감사 근거로 저장
    //    ts 는 '지금 시각' — rec.ts(기록 생성시각)를 쓰면 TM 중복방지(lkey)에 걸려 재처리가 무시된다.
    emitJipSync(Object.assign({}, rec, { ts: now.toISOString(), legal: kind, said: ans.said, callSec: ans.callSec }));
    optOutSet.add(dNorm(item.number));   // 즉시 재발신 방지 (TM은 대장 기록 후 DB 파기)
    tmInfoCache.at = 0;   // 캐시 무효화 → 발신금지·출처 표시 즉시 반영
    updateSrcInfo(item.number);
    pullLegalEvidence(item.number, kind);   // 🆕 P2) 수신거부 통화 녹음도 증빙으로 자동 보관 (분쟁 대비)
    toast('⛔ 수신거부 기록 — 고객 DB 파기 · 재발신 방지 등록 (' + now.toLocaleString('ko-KR') + ')');
  }
  // ✅ P6) 수신동의 토글 — 이 번호에 '동의 체크(✓)'를 켜고 끈다. 메모에 글자를 쓰지 않고
  //    구조화 필드(rec.consentAt / item.consentAt / consentMap)로 저장하므로 중복 클릭해도 겹쳐 쌓이지 않는다.
  //    상담사 이름은 TM(applyOne, 로그인 계정)이 붙여 법정 로그에 남는다.
  //    ⚠ 이 번호의 통화기록(rec)이 없으면 만들어서 붙인다 — "번호의 기록 안에" 남기기 위함.
  function recordFor(item, now) {
    const existing = (item._recRef && records.indexOf(item._recRef) !== -1) ? item._recRef : findRecordFor(item.number);
    if (existing) return existing;
    const rec = {
      number: item.number, name: currentCustomerName() || null, tag: item.tag || null, memo: '',
      dialAt: now.toLocaleString('ko-KR'),
      time: now.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      duration: null, ts: now.toISOString(),
    };
    records.push(rec);
    item._recRef = rec; item._saved = true;
    return rec;
  }
  async function consentOneClick() {
    if (curIdx < 0 || !queue[curIdx]) { toast('먼저 번호를 선택하세요'); return; }
    const item = queue[curIdx];
    const now = new Date();
    const already = consentOf(item.number);

    if (already) {
      // ☑ → ☐ 해제 (오기록 정정). 기록에는 '해제'가 남는다.
      const ok = await appConfirm(
        '이 번호의 수신동의 표시를 해제할까요?\n\n' + fmtPhone(item.number) +
        '\n동의 일시: ' + (already.at ? new Date(already.at).toLocaleString('ko-KR') : '기록 없음') +
        '\n\n(해제 이력은 기록에 남습니다)', { danger: true, okText: '해제' });
      if (!ok) return;
      setConsentLocal(item.number, null);
      item.consentAt = ''; item.consentVia = ''; touchQ(item);
      const rec = recordFor(item, now);
      rec.consentAt = ''; rec.consentVia = '';
      persistRecords(); persistQueue(); renderRecords(); renderQueue(); refreshConsentBtn();
      // ⚠ rec 을 통째로 보내면 ts=기록 생성시각(고정) → TM 의 중복방지(lkey)에 걸려 두 번째 토글부터 무시된다.
      //    법정 이벤트는 '지금 시각'으로 별도 페이로드를 보낸다(통화 결과가 아니므로 tag·memo 도 비움).
      emitJipSync({ number: item.number, name: item.name || '', tag: '', memo: '',
        ts: now.toISOString(), legal: '수신동의 해제' });
      tmInfoCache.at = 0; updateSrcInfo(item.number);
      toast('수신동의 표시를 해제했어요');
      return;
    }

    // ☐ → ☑ 설정
    const at = now.toISOString(), via = '전화 동의';
    setConsentLocal(item.number, { at, via });
    item.consentAt = at; item.consentVia = via; touchQ(item);   // 큐 행 ✅ 즉시 반영
    const rec = recordFor(item, now);
    rec.consentAt = at; rec.consentVia = via;                    // 📌 번호의 기록 안에 구조화 저장(메모 아님)
    persistRecords(); persistQueue(); renderRecords(); renderQueue(); refreshConsentBtn();
    // ⚠ 위 해제 경로와 같은 이유로 '지금 시각' 전용 페이로드 (rec 통째 전송 금지 — lkey 중복으로 무시됨)
    emitJipSync({ number: item.number, name: item.name || '', tag: '', memo: '',
      ts: at, legal: '수신동의', consentAt: at, consentVia: via });
    tmInfoCache.at = 0;
    updateSrcInfo(item.number);
    pullLegalEvidence(item.number, '수신동의');   // 🆕 P2) 동의 녹취 자동 보관
    toast('✅ 수신동의 체크 — 이 번호에 동의 표시가 저장됐어요 (' + via + ' · ' + now.toLocaleString('ko-KR') + ')');
  }
  // ============================================================
  // 💬 P8) 통화 직후 문자 — 템플릿 골라 폰 메시지앱을 채워서 연다(발송 버튼은 사람이 누름).
  //   ⚖ 정보통신망법 §50 가드:
  //     · 수신거부 번호 → 완전 차단
  //     · 광고성(ad:true) 템플릿은 ①수신동의(✓) 받은 번호에만 ②야간 21~08시 금지
  //       ③(광고) 표기 + 무료수신거부 안내 자동 점검
  //     · 정보성(방금 상담한 내용 안내)은 위 제한 없음
  // ============================================================
  const SMS_TPL_KEY = 'smsTemplates';
  const SMS_TPL_DEFAULT = [
    { id: 't1', name: '상담 감사 + 자료', ad: false,
      body: '{이름}님 안녕하세요, 방금 통화드린 {상담사}입니다.\n말씀드린 자료 보내드립니다. 궁금하신 점 있으시면 편하게 연락 주세요. 감사합니다.' },
    { id: 't2', name: '방문 예약 확정', ad: false,
      body: '{이름}님, 방문 예약 안내드립니다.\n일시: {예약일시}\n장소: 모델하우스\n오시는 길 안내가 필요하시면 연락 주세요. {상담사} 드림' },
    { id: 't3', name: '부재중 안내', ad: false,
      body: '{이름}님 안녕하세요, {상담사}입니다.\n연락드렸는데 통화가 어려우셨습니다. 편하신 시간 알려주시면 그때 다시 연락드리겠습니다.' },
    { id: 't4', name: '오시는 길 안내', ad: false,
      body: '{이름}님, 문의 주신 위치 안내드립니다.\n모델하우스 주소: (주소 입력)\n주차 가능하며 상담 예약 시 대기 없이 안내해 드립니다. {상담사}' },
    { id: 't5', name: '분양 안내 (광고)', ad: true,
      body: '(광고) {이름}님, 문의 주신 단지 분양 정보 안내드립니다.\n(내용 입력)\n무료수신거부 0800-000-0000' },
  ];
  let smsTemplates = SMS_TPL_DEFAULT.slice();
  async function loadSmsTemplates() {
    try {
      const t = (window.api && window.api.store) ? await window.api.store.get(SMS_TPL_KEY) : null;
      if (Array.isArray(t) && t.length) smsTemplates = t;
    } catch (e) {}
  }
  function saveSmsTemplates() { try { if (window.api && window.api.store) window.api.store.set(SMS_TPL_KEY, smsTemplates); } catch (e) {} }
  function smsFill(body, number) {
    const item = queue.find(q => dNorm(q.number) === dNorm(number));
    const nm = (item && item.name) || currentCustomerName() || '고객';
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const t2 = new Date(Date.now() + 86400000);
    const cb = item && item.callbackAt
      ? (item.callbackAt.slice(5).replace('-', '월 ') + '일' + (item.callbackTime ? ' ' + item.callbackTime : ''))
      : '(일시 입력)';
    return String(body || '')
      .replace(/\{이름\}/g, nm)
      .replace(/\{상담사\}/g, myName || '담당자')
      .replace(/\{오늘\}/g, (d.getMonth() + 1) + '월 ' + d.getDate() + '일')
      .replace(/\{내일\}/g, (t2.getMonth() + 1) + '월 ' + t2.getDate() + '일')
      .replace(/\{예약일시\}/g, cb);
  }
  let myName = '';   // 로그인 계정 이름 — TM 미러에서 채움(없으면 '담당자')
  async function loadMyNameForSms() {
    try { const me = (window.api && window.api.crm) ? await window.api.crm.me() : null; if (me && me.ok && me.name) myName = me.name; } catch (e) {}
  }
  function openSmsModal(number0) {
    const number = number0 || ((curIdx >= 0 && queue[curIdx]) ? queue[curIdx].number : '');
    if (!number) { toast('먼저 번호를 선택하세요'); return; }
    const d = dNorm(number);
    if (optOutSet.has(d)) { appAlert('수신거부한 번호입니다.\n문자도 보낼 수 없습니다.', { title: '⛔ 수신거부 번호', danger: true }); return; }
    if (document.getElementById('dl-sms-modal')) return;
    const hasConsent = !!consentOf(number);
    const hour = new Date().getHours();
    const night = (hour >= 21 || hour < 8);
    let curId = smsTemplates[0] ? smsTemplates[0].id : '';
    let editMode = false;

    const ov = document.createElement('div');
    ov.id = 'dl-sms-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100006;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML =
      '<div style="width:min(470px,95vw);max-height:90vh;display:flex;flex-direction:column;background:#1c1b18;border:1px solid var(--accent);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
        '<div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border);">' +
          '<b style="font-size:15px;color:var(--text-1);">💬 통화 후 문자</b>' +
          '<span style="font-size:11.5px;color:var(--text-3);">' + escapeHtml(fmtPhone(number)) + (hasConsent ? ' · ✅ 수신동의' : '') + '</span>' +
          '<button id="dl-sms-x" style="margin-left:auto;background:transparent;border:none;color:var(--text-3);font-size:18px;cursor:pointer;line-height:1;">✕</button>' +
        '</div>' +
        '<div style="overflow-y:auto;padding:12px 16px;flex:1;">' +
          '<div id="dl-sms-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;"></div>' +
          '<div id="dl-sms-warn"></div>' +
          '<textarea id="dl-sms-body" rows="7" style="width:100%;box-sizing:border-box;padding:11px;font-size:13px;font-family:inherit;line-height:1.7;border-radius:9px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);outline:none;resize:vertical;"></textarea>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">' +
            '<span id="dl-sms-len" style="font-size:11px;color:var(--text-3);"></span>' +
            '<span style="flex:1;"></span>' +
            '<button id="dl-sms-edit" class="dl-btn" style="font-size:11.5px;padding:5px 9px;">✏️ 이 템플릿 수정</button>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;">' +
            '<button id="dl-sms-img" class="dl-btn" style="font-size:11.5px;padding:5px 9px;">📷 사진 첨부</button>' +
            '<span id="dl-sms-imgname" style="font-size:11px;color:var(--text-3);">사진 없음 · 글자만 보냅니다</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.6;">치환: {이름} {상담사} {오늘} {내일} {예약일시}</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;padding:12px 16px 16px;border-top:1px solid var(--border);">' +
          '<button id="dl-sms-cancel" class="dl-btn" style="flex:1;padding:11px;">닫기</button>' +
          '<button id="dl-sms-go" class="dl-btn accent" style="flex:1.6;padding:11px;font-weight:800;">📲 폰에서 문자 열기</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const bodyEl = ov.querySelector('#dl-sms-body');
    const goBtn = ov.querySelector('#dl-sms-go');
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

    function curTpl() { return smsTemplates.find(t => t.id === curId) || smsTemplates[0]; }
    // ⚖ 법 가드 — 광고성일 때만 제한. 막을 사유가 있으면 {block:true, msg}
    function guard() {
      const t = curTpl(); if (!t) return { block: false };
      if (!t.ad) return { block: false };
      if (!hasConsent) return { block: true, msg: '⛔ 광고성 문자는 <b>수신동의(✅)를 받은 번호</b>에만 보낼 수 있습니다.<br>이 번호는 아직 동의 표시가 없습니다. (정보통신망법 §50①)' };
      if (night) return { block: true, msg: '⛔ 21시~08시에는 광고성 문자를 보낼 수 없습니다.<br>(야간 수신 별도 동의 필요 · 정보통신망법 §50③)' };
      const b = bodyEl.value;
      const miss = [];
      if (!/\(광고\)/.test(b)) miss.push('(광고) 표기');
      if (!/수신거부|무료거부/.test(b)) miss.push('무료수신거부 안내');
      if (miss.length) return { block: true, msg: '⛔ 광고 문자에는 <b>' + miss.join(' · ') + '</b>가 반드시 들어가야 합니다. (정보통신망법 §50④)' };
      if (/0{3,}-0{3,}/.test(b)) return { block: true, msg: '⛔ 수신거부 번호가 예시값(0800-000-0000) 그대로입니다. 실제 번호로 바꿔주세요.' };
      return { block: false };
    }
    function paint() {
      ov.querySelector('#dl-sms-chips').innerHTML = smsTemplates.map(t =>
        '<button class="dl-sms-chip" data-id="' + t.id + '" style="padding:5px 10px;font-size:11.5px;font-weight:700;border-radius:13px;cursor:pointer;white-space:nowrap;' +
          'border:1px solid ' + (t.id === curId ? 'var(--accent)' : 'var(--border)') + ';' +
          'background:' + (t.id === curId ? 'rgba(201,100,66,.22)' : 'var(--bg-2)') + ';' +
          'color:' + (t.id === curId ? 'var(--text-1)' : 'var(--text-3)') + ';">' +
          (t.ad ? '📢 ' : '') + escapeHtml(t.name) + '</button>').join('');
      ov.querySelectorAll('.dl-sms-chip').forEach(b => b.onclick = () => {
        curId = b.dataset.id; editMode = false;
        bodyEl.value = smsFill(curTpl().body, number);
        paint();
      });
      const g = guard();
      const warnEl = ov.querySelector('#dl-sms-warn');
      warnEl.innerHTML = g.block
        ? '<div style="margin-bottom:8px;padding:10px 12px;border-radius:9px;background:rgba(224,97,70,.14);border:1px solid rgba(224,97,70,.5);font-size:12px;color:#ffb3ab;line-height:1.6;">' + g.msg + '</div>'
        : (curTpl() && curTpl().ad
          ? '<div style="margin-bottom:8px;padding:9px 11px;border-radius:9px;background:rgba(52,181,110,.12);border:1px solid rgba(52,181,110,.4);font-size:12px;color:#7fd8a4;line-height:1.6;">✅ 수신동의 받은 번호 · 발송 가능 시간입니다.</div>'
          : '');
      goBtn.disabled = g.block;
      goBtn.style.opacity = g.block ? '.45' : '1';
      const len = bodyEl.value.length;
      ov.querySelector('#dl-sms-len').textContent = len + '자' + (len > 90 ? ' · 장문(LMS)으로 전송됩니다' : '');
      ov.querySelector('#dl-sms-edit').textContent = editMode ? '💾 템플릿 저장' : '✏️ 이 템플릿 수정';
    }
    bodyEl.value = smsFill(curTpl() ? curTpl().body : '', number);
    bodyEl.addEventListener('input', paint);
    ov.querySelector('#dl-sms-edit').onclick = () => {
      if (!editMode) { const t = curTpl(); if (t) bodyEl.value = t.body; editMode = true; paint(); toast('원본 템플릿을 수정하세요 (치환 태그 그대로 두면 자동으로 채워집니다)'); }
      else {
        const t = curTpl(); if (t) { t.body = bodyEl.value; saveSmsTemplates(); }
        editMode = false; bodyEl.value = smsFill(curTpl().body, number); paint(); toast('템플릿을 저장했어요');
      }
    };
    // 📷 사진 첨부 — PC판은 1장만. (am start 로는 사진 여러 장을 넘길 수 없다 → 여러 장은 폰 앱에서)
    let smsImgPath = '';
    const imgBtn = ov.querySelector('#dl-sms-img');
    const imgName = ov.querySelector('#dl-sms-imgname');
    if (imgBtn) imgBtn.onclick = async () => {
      if (smsImgPath) {                                   // 이미 붙어 있으면 떼기
        smsImgPath = '';
        imgName.textContent = '사진 없음 · 글자만 보냅니다';
        imgBtn.textContent = '📷 사진 첨부';
        return;
      }
      let pr = null;
      try { pr = await D.pickImage(); } catch (e) { pr = null; }
      if (!pr || !pr.ok) { if (pr && !pr.canceled) toast('사진을 고르지 못했어요'); return; }
      smsImgPath = pr.path;
      imgName.textContent = '📷 ' + String(pr.path).split(/[\\/]/).pop();
      imgBtn.textContent = '✕ 사진 빼기';
    };
    ov.querySelector('#dl-sms-x').onclick = close;
    ov.querySelector('#dl-sms-cancel').onclick = close;
    goBtn.onclick = async () => {
      if (guard().block) return;
      if (!connected) { toast('먼저 폰에 연결하세요'); return; }
      let r = null;
      try {
        r = smsImgPath ? await D.mmsCompose(number, bodyEl.value, [smsImgPath])
                       : await D.smsCompose(number, bodyEl.value);
      } catch (e) { r = null; }
      // 사진 등록에 실패하면 글자만이라도 열어준다 — 조용히 실패시키지 않는다
      if (r && !r.ok && r.fellBack) toast(r.message || '사진은 못 붙였고 글자만 열었어요');
      if (r && r.ok) {
        // 📌 문자 작성 기록 — 큐/기록에 구조화 저장(💬 표시). 실제 발송은 폰에서 누르므로 '작성함'으로 표기.
        const now = new Date();
        const item = queue.find(q => dNorm(q.number) === d);
        if (item) { item.smsAt = now.toISOString(); touchQ(item); persistQueue(); renderQueue(); }
        const rec = findRecordFor(number);
        if (rec) { rec.smsAt = now.toISOString(); persistRecords(); renderRecords(); }
        toast('📲 폰 메시지앱을 열었어요 — 내용 확인 후 폰에서 [전송]을 누르세요');
        close();
      } else toast('메시지앱 열기 실패 — 폰 연결을 확인하세요');
    };
    document.addEventListener('keydown', onKey);
    paint();
    setTimeout(() => { try { bodyEl.focus(); } catch (e) {} }, 40);
  }

  // 🎙 P2) 증빙 녹음 자동 이관 — 법정 이벤트(수신동의/수신거부) 통화의 녹음 파일을
  //    폰에서 PC 영구 보관 폴더(userData\consent-evidence)로 pull하고 TM 법정 로그에 경로를 남긴다.
  //    녹음 파일은 통화 종료 후에야 생기므로 8초 간격 최대 22회(≈3분, 통화가 길어져도 기다림) 재시도. 같은 파일은 한 번만.
  const evidencePulled = new Set();   // 이미 이관한 폰 쪽 경로(remote)

  /* ⚠️ 증빙 없음 표시 — 동의·거부를 눌렀는데 녹음을 확보하지 못한 건은 반드시 흔적을 남긴다.
     개인정보보호법 §22·정보통신망법 §50상 동의 사실의 입증 책임은 회사에 있는데,
     조용히 넘어가면 나중에 "증빙이 있는 줄 알았다"가 된다. 없으면 없다고 기록해 두는 편이
     훨씬 안전하다 — 나중에 "그때 이렇게 조치했다"를 보여줄 수 있어야 한다. */
  function noteEvidenceMissing(number, kind, reason) {
    try {
      emitJipSync({
        number, name: '', tag: '', memo: '',
        ts: new Date().toISOString(),
        legal: '증빙 없음', evidence: '', evidenceMiss: reason || '녹음 없음', evidenceKind: kind
      });
    } catch (e) { /* 기록 실패해도 본 동작은 막지 않는다 */ }
  }

  async function pullLegalEvidence(number, kind) {
    if (!connected) {
      noteEvidenceMissing(number, kind, '폰 미연결');
      toast('⚠️ 폰이 연결되어 있지 않아 녹음 증빙을 보관하지 못했습니다 — 「증빙 없음」으로 기록됩니다', 6000);
      return;
    }
    if (!D || !D.pullEvidence || !D.recordingsFor) { noteEvidenceMissing(number, kind, '기능 사용 불가'); return; }
    const d = dNorm(number);
    // 이 통화로 인정할 기준 시각: 발신 시작(없으면 최근 10분) − 2분 여유(폰·PC 시계 오차)
    const sinceTs = (dialStart || (Date.now() - 10 * 60 * 1000)) - 2 * 60 * 1000;
    for (let i = 0; i < 22; i++) {
      let list = [];
      try { list = (await D.recordingsFor(number)) || []; } catch (e) { list = []; }
      const cand = list.find(f => f && f.remote && f.ts >= sinceTs);
      if (cand && evidencePulled.has(cand.remote)) return;   // 같은 통화에서 다른 버튼의 루프가 이미 이관함 → 조용히 종료
      if (cand) {
        let r = null;
        try { r = await D.pullEvidence(cand.remote, d + '_' + kind + '_' + cand.name); } catch (e) { r = null; }
        if (r && r.ok && r.path) {
          evidencePulled.add(cand.remote);
          // TM 법정 로그에 증빙 경로 기록 (새 ts → 중복 방지 키 분리)
          emitJipSync({ number, name: '', tag: '', memo: '', ts: new Date().toISOString(), legal: '증빙 녹음', evidence: r.path });
          toast('🎙 통화 녹음 증빙 보관 완료 — ' + cand.name);
        } else {
          noteEvidenceMissing(number, kind, '보관 실패' + (r && r.message ? ' · ' + String(r.message).slice(0, 40) : ''));
          toast('⚠️ 녹음 증빙 보관 실패 — 「증빙 없음」으로 기록됩니다' + (r && r.message ? ' (' + String(r.message).slice(0, 40) + ')' : ''), 6000);
        }
        return;
      }
      await new Promise(rs => setTimeout(rs, 8000));
    }
    noteEvidenceMissing(number, kind, '녹음 파일 없음');
    showEvidenceMissingNotice();
  }

  /* 녹음이 아예 없을 때는 토스트로 흘려보내지 않는다 — 폰 통화녹음이 꺼져 있다는 뜻이고,
     그대로 두면 이후 모든 동의·거부 건이 증빙 없이 쌓인다. 한 번은 눈에 걸리게 띄운다.
     ※ '녹음을 켜라'는 지시가 아니라, 켜 두면 본인이 보호된다는 안내로 쓴다. */
  let evidenceNoticeShownAt = 0;
  function showEvidenceMissingNotice() {
    toast('⚠️ 이번 통화의 녹음을 찾지 못했습니다 — 「증빙 없음」으로 기록됩니다', 6000);
    if (Date.now() - evidenceNoticeShownAt < 6 * 60 * 60 * 1000) return;   // 6시간에 한 번만
    evidenceNoticeShownAt = Date.now();
    const wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.style.display = 'flex';
    wrap.innerHTML =
      '<div class="modal" style="max-width:520px">' +
        '<div class="modal-header"><h3>🎙 폰 통화녹음이 꺼져 있는 것 같아요</h3></div>' +
        '<div class="modal-body" style="font-size:14px;line-height:1.75">' +
          '<p style="margin:0 0 10px">수신동의·수신거부를 눌렀는데 <b>그 통화의 녹음 파일을 찾지 못했습니다.</b> ' +
          '이 건은 <b>「증빙 없음」</b>으로 기록됩니다.</p>' +
          '<p style="margin:0 0 10px">나중에 고객이 <b>“동의한 적 없다”</b>고 하실 때, ' +
          '상담사님을 지켜주는 건 그때의 통화 녹음입니다. ' +
          '개인정보 관련 문제는 회사뿐 아니라 <b>담당한 개인도 책임</b>을 질 수 있어서요.</p>' +
          '<p style="margin:0 0 12px;color:var(--text-3)">폰 <b>전화 앱 → 설정 → 통화 녹음 → 자동 녹음</b>을 켜 두시면 ' +
          '이후 동의·거부 건은 자동으로 보관됩니다.</p>' +
          '<div style="text-align:right"><button class="btn-primary" id="ev-notice-ok">알겠습니다</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('#ev-notice-ok').onclick = close;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
  }

  // 📵 폰에 저장된 차단번호 → 차단목록(blocklist) + TM 고객관리에 '차단요청' 고객으로 반영
  async function importPhoneBlocked() {
    if (!connected) { toast('먼저 폰을 연결하세요'); return; }
    toast('📵 폰 차단목록 불러오는 중…');
    let nums = [];
    try { nums = (await D.blockedNumbers()) || []; } catch (e) {}
    if (!nums.length) { toast('‘차단요청’ 연락처를 못 찾았어요 (폰 연락처 이름에 ‘차단’ 필요)'); return; }
    // nums: [{number, name}]. 1) 차단목록(파일)에 한 번에 저장 + blockedSet 먼저 채움 → emitJipSync 개별저장(경합) 방지
    let added = 0;
    nums.forEach(it => { const d = String(it.number).replace(/\D/g, ''); if (d && !blockedSet.has(d)) { blockedSet.add(d); added++; } });
    try { await D.addBlockedBulk(nums.map(it => it.number)); } catch (e) {}
    // 2) TM 고객관리에 '차단요청' 고객으로 반영
    let i = 0;
    for (const it of nums) {
      emitJipSync({ number: it.number, name: it.name || '', tag: '차단요청', memo: '', ts: new Date(Date.now() + (i++)).toISOString() });
    }
    toast(`📵 차단요청 연락처 ${nums.length}개 반영 (신규 ${added}개) — TM 고객관리 상태 ‘차단요청’으로 확인`);
  }
  // TM 고객관리(iframe)에서 [폰 차단번호 가져오기] 누르면 이 창으로 요청이 옴
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'tmcrm:import-blocked') importPhoneBlocked(); });

  // 현재 번호를 통화기록 1건으로 확정. force=true면 메모 저장 시 호출(결과 일원화).
  function commitCurrent(force) {
    if (curIdx < 0 || !queue[curIdx]) return;
    const item = queue[curIdx];
    try { if (window.__assembleNoteForm) window.__assembleNoteForm(); } catch (e) {} // 열린 양식 → 본문 반영
    const memo = memoPadContent() || item._memoFromPad || '';
    const newTag = pendingTag || item.tag || null;
    // ✅ 이미 이 통화에서 기록을 만들었으면 → 새로 만들지 말고 그 기록을 '갱신'.
    //    (예: 실수로 부재로 저장 후 거부로 바꾸고 정지 → 거부로 반영). 중복 생성 방지.
    if (item._saved && item._recRef && records.indexOf(item._recRef) !== -1) {
      const r = item._recRef;
      if ((newTag || null) !== (r.tag || null) || memo !== (r.memo || '')) {
        r.tag = newTag; r.memo = memo;
        r.cbDate = item.callbackAt || null; r.cbTime = item.callbackTime || null;   // 🆕 P3) 콜백 날짜·시간 동봉
        item.tag = newTag; item.memo = memo;
        touchQ(item);
        item._memoFromPad = '';
        persistRecords(); renderRecords();
        emitJipSync(r);   // 🔗 변경된 결과/메모 → 집수호 반영
        dialSyncSoon();
      }
      clearCallback();
      return;
    }
    // 저장 표시됐지만 연결된 기록을 잃었을 때: 새 메모/결과가 없으면 중복 방지로 건너뛰고,
    //   있으면 떨어뜨리지 말고 아래에서 새 기록으로 남긴다. (위 갱신분기가 정상참조는 이미 처리)
    if (item._saved && !memo && !pendingTag) return;
    if (!force && !pendingTag && !memo) return; // 입력 없으면 기록 안 함
    const dur = dialStart ? Math.round((Date.now() - dialStart) / 1000) : null;
    item.tag = newTag; item.memo = memo;
    touchQ(item);
    const now = new Date();
    const rec = {                             // 전화 순서대로 (마지막이 맨 밑)
      number: item.number, name: currentCustomerName() || null,
      tag: item.tag || null, memo,
      dialAt: now.toLocaleString('ko-KR'),
      time: now.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      duration: dur, ts: now.toISOString(),
      cbDate: item.callbackAt || null, cbTime: item.callbackTime || null,   // 🆕 P3) 콜백 날짜·시간 동봉
    };
    records.push(rec);
    item._recRef = rec;                       // 이 통화의 기록 참조 → 이후 수정 시 갱신
    // ⚠ 작업4: 저장 상한(2000건) 제거 — 기록은 전부 영구 보존. 화면 렌더만 아래 renderRecords()에서 제한.
    item._memoFromPad = ''; item._saved = true;
    persistRecords(); renderRecords();
    emitJipSync(rec);    // 🔗 새 통화 결과/메모 → 집수호 반영
    clearCallback();     // 📞 콜백 저장 완료 → 배지 해제
    dialSyncSoon();
  }
  function advanceSelection() {
    commitCurrent();
    if (curIdx >= 0 && queue[curIdx]) { queue[curIdx].done = true; touchQ(queue[curIdx]); }
    clearMemoPad();
    const t = nextUncalledIndex(curIdx + 1);   // 결과 있는 번호는 건너뛰고 다음 미통화로
    if (t >= 0) { curIdx = t; persistQueue(); renderQueue(); showCurrent(); return true; }
    persistQueue(); renderQueue(); showCurrent(); return false;
  }
  // 큰 메모장 비우기 (다음 통화 준비)
  function clearMemoPad() {
    const inp = $('np-input');
    if (inp) { inp.value = ''; }
    try { window.api.store.set('noteDraft', ''); } catch (e) {}
    const hdr = $('np-call-header'); if (hdr) hdr.style.display = 'none';
  }

  function stop() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    looping = false;
    const hasNext = advanceSelection();   // 정지: 기록 저장 후 다음 번호로 인덱스 이동 (원본 동작)
    stopCallTimer(); dialStart = 0; updateCallTimer();   // ⏱ 경과 타이머 정지·리셋
    clearCurrentCallFlag();               // 📴 정지 → '통화중' 배지 해제
    toast(hasNext ? '정지 — 다음 번호 준비됨. [시작]을 누르세요' : '정지 — 마지막 번호였습니다');
  }
  // 종료: ADB로 통화만 끊음. 다음 번호로 안 넘어감(제자리). 루프 유지 — [다음 번호] 대기 (원본 동작)
  async function endCall() {
    if (!connected) { toast('연결 안 됨'); return; }
    await D.endCall();
    clearCurrentCallFlag();   // 📴 통화 끊김 → '통화중' 배지 해제
    toast('통화 끊김 — 결과·메모 입력 후 [다음 번호]를 누르세요');
  }

  function clearCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  // 다음 번호: 자동 통화종료 → 메모/결과 기록 저장 → 통화후대기 → 다음 발신
  let __nextBusy = false;   // ⏳ 연타 방지 — await 도중 한 번 더 눌리면 번호가 건너뛰어지는 문제 차단
  async function next() {
    if (!looping) { toast('정지 상태 — [시작]을 누르세요'); return; }
    if (__nextBusy) return;                                       // 처리 중이면 이번 클릭은 무시
    __nextBusy = true;
    try {
      clearCountdown();
      if (connected) { try { await D.endCall(); } catch (e) {} }   // ✂ 자동 통화 종료
      const hasNext = advanceSelection();                          // 메모/결과 → 기록 저장 + 다음으로
      stopCallTimer(); dialStart = 0; updateCallTimer();           // ⏱ 직전 통화 타이머 정지·리셋 (다음 발신 때 자동 재시작)
      if (!hasNext) { looping = false; toast('✔ 모든 번호에 발신 완료'); return; }
      const c = $('dl-current');
      let left = Math.max(0, parseInt($('dl-wait').value, 10) || 0);
      if (left === 0) { dialCurrent(); return; }
      countdownTimer = setInterval(() => {
        if (!looping) { clearCountdown(); return; }
        if (left <= 0) { clearCountdown(); showCurrent(); dialCurrent(); }
        else { c.textContent = `다음 발신까지 ${left}초…`; c.classList.remove('idle'); left--; }
      }, 1000);
    } finally {
      __nextBusy = false;
    }
  }

  async function clearRecords() {
    // 🎯 '기록 초기화' — 통화 기록(history)만 비운다. 발신 번호 목록은 유지.
    //    (이전엔 번호 목록까지 함께 지워서 '목록 초기화' 버튼과 동작이 완전히 같았음)
    if (looping) { toast('발신 중에는 초기화 불가 — 정지 먼저'); return; }
    if (!(await appConfirm('통화 기록을 초기화할까요?\n(발신 번호 목록은 그대로 유지됩니다)', { okText: '초기화', danger: true }))) return;
    records = []; persistRecords(); renderRecords();
  }
  // 📋 기록 단일 복사(개별 행/번호)에 쓰이는 클립보드 헬퍼 — 대량 복사 3종은 제거됨
  function copyText(txt, msg) {
    try { navigator.clipboard.writeText(txt); } catch (e) {
      const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) {} ta.remove();
    }
    toast(msg);
  }

  let qTimer = null;
  function persistQueue() { clearTimeout(qTimer); qTimer = setTimeout(() => D.setQueue(queue.map(({ _memoFromPad, _saved, _recRef, ...q }) => q)), 300); }
  // 🔑 작업8: dialRecords 병합 키 — dialer-main.js dlRecKey() / sync-server.js recKey()와 동일 규칙(mid>ts>번호+시각).
  //    세 곳의 키 규칙이 어긋나면 dedup이 깨지므로 필드 추가 시 셋 다 맞출 것.
  function recSyncKey(r) {
    if (!r) return '';
    return r.mid || r.ts || (String(r.number || '').replace(/\D/g, '') + '|' + (r.dialAt || r.time || ''));
  }
  function persistRecords() {
    // dialer:setRecords 는 이제 단일 병합 writer(dialer-main.js writeDialRecords)를 거친다.
    // 응답으로 "이 화면이 아직 모르던, 다른 writer(폰 sync-server)가 그 사이 추가한 기록"을 돌려주면
    // 편입한다 — 추가전용(절대 records를 지우지 않음)이라 기존 기록을 잃을 위험이 없다.
    D.setRecords(records).then(extras => {
      if (!extras || !extras.length) return;
      const known = new Set(records.map(recSyncKey));
      let added = false;
      extras.forEach(r => {
        const k = recSyncKey(r);
        if (k && !known.has(k)) { records.push(r); known.add(k); added = true; }
      });
      if (added) {
        records.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
        renderRecords();
      }
    }).catch(() => {});
  }

  // ============================================================
  //  📱 PC 발신목록 ↔ 폰(모바일) 큐 동기화 — mobileCustomers/mobileTombstones 저장소 경유
  //   · 폰이 sync-server 로 넣은 mobileCustomers 와 PC 발신큐를 번호 기준 병합.
  //   · 안 건 번호가 양쪽 발신목록에 서로 보이게 함. 삭제=tombstone, 통화=done LWW.
  //   · 발신 중 현재 번호는 보호(안 지움), 신규는 뒤에 추가(인덱스 안 흔듦). merge 로직은 Node 16/16 검증.
  // ============================================================
  const MCUST_KEY = 'mobileCustomers', MTOMB_KEY = 'mobileTombstones';
  let dialSyncTimer = null, dialSyncDebTimer = null, dialSyncBusy = false;
  const dNorm = s => String(s || '').replace(/\D/g, '');
  function qNowIso() { return new Date().toISOString(); }
  function qRid() { return 'q-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  // 큐 항목 변경시각 갱신(LWW 전파용) — 결과 확정·수정 시 호출
  function touchQ(item) { if (item) item.updatedAt = qNowIso(); }

  function mergeDialSync(q, mcust, mtomb, ci, isLooping, now, rid) {
    // 큐 항목을 폰 고객 레코드로 만들 때 PC 전용 내부필드(_saved 등, 순환참조 위험)와 큐 전용 개념(tag, 원래도 고객 레코드엔 없던 필드)은
    // 제외하고, callbackAt 등 그 외 미지 필드만 보존한다.
    const stripInternal = (it) => { const { _memoFromPad, _saved, _recRef, tag, ...pub } = it; return pub; };
    const tomb = new Map();
    (mtomb || []).forEach(t => { if (!t || !t.number) return; const n = dNorm(t.number); const e = tomb.get(n); if (!e || String(t.at) > String(e.at)) tomb.set(n, { number: n, at: t.at }); });
    const isTombed = (n, upd) => { const t = tomb.get(n); return !!(t && String(t.at) >= String(upd || '')); };
    let qChanged = false, mChanged = false;
    q.forEach(it => { if (!it.id) { it.id = rid(); qChanged = true; } if (!it.updatedAt) { it.updatedAt = now; qChanged = true; } });
    const qByNum = new Map(); q.forEach(it => qByNum.set(dNorm(it.number), it));
    // 1) 폰 고객 → PC 큐
    (mcust || []).forEach(c => {
      if (!c || !c.number) return; const n = dNorm(c.number); if (!n) return;
      const upd = c.updatedAt || '';
      if (isTombed(n, upd)) return;
      const it = qByNum.get(n);
      if (!it) {
        // {...패자(c: 폰 고객), ...승자(명시필드)} — c의 미지 필드(callbackAt 등)도 새 큐 항목에 보존
        const nit = Object.assign({}, c, { number: n, tag: null, memo: c.memo || '', done: !!c.done, id: c.id || rid(), updatedAt: upd || now });
        q.push(nit); qByNum.set(n, nit); qChanged = true;
      }
      else if (String(upd) > String(it.updatedAt || '')) {
        if ((c.name || '') !== (it.name || '')) { it.name = c.name || ''; qChanged = true; }
        if ((c.memo || '') !== (it.memo || '')) { it.memo = c.memo || ''; qChanged = true; }   // 📝 메모 정합
        if (!!c.done !== !!it.done) { it.done = !!c.done; qChanged = true; }
        it.updatedAt = upd;
      }
    });
    // 2) tombstone → PC 큐 제거(현재 통화중 번호 보호)
    for (let i = q.length - 1; i >= 0; i--) {
      const it = q[i]; const n = dNorm(it.number);
      if (isTombed(n, it.updatedAt)) { if (isLooping && i === ci) continue; q.splice(i, 1); if (i < ci) ci--; qChanged = true; }
    }
    if (ci >= q.length) ci = q.length - 1;
    // 3) PC 큐 → 폰 고객(LWW 업서트)
    const mByNum = new Map(); (mcust || []).forEach(c => { if (c && c.number) mByNum.set(dNorm(c.number), c); });
    q.forEach(it => {
      const n = dNorm(it.number); if (!n) return;
      if (isTombed(n, it.updatedAt)) return;
      const called = !!it.tag || !!it.done;
      const ex = mByNum.get(n);
      if (!ex) {
        // {...패자(it: 큐 항목), ...승자(명시필드)} — it의 미지 필드(callbackAt 등)를 새 고객 레코드에 보존
        mcust.push(Object.assign({}, stripInternal(it), { id: it.id, name: it.name || '', number: n, memo: it.memo || '', updatedAt: it.updatedAt || now, done: called }));
        mChanged = true;
      }
      else if (String(it.updatedAt || '') > String(ex.updatedAt || '')) {
        if ((it.name || '') !== (ex.name || '')) { ex.name = it.name || ''; mChanged = true; }
        if ((it.memo || '') !== (ex.memo || '')) { ex.memo = it.memo || ''; mChanged = true; }   // 📝 메모 정합
        if (called !== !!ex.done) { ex.done = called; mChanged = true; }
        ex.updatedAt = it.updatedAt || now;
      }
    });
    return { ci, qChanged, mChanged };
  }

  async function dialSync() {
    if (dialSyncBusy || !window.api || !window.api.store) return;
    dialSyncBusy = true;
    try {
      let mcust = [], mtomb = [];
      try { mcust = (await window.api.store.get(MCUST_KEY)) || []; } catch (e) {}
      try { mtomb = (await window.api.store.get(MTOMB_KEY)) || []; } catch (e) {}
      if (!Array.isArray(mcust)) mcust = []; if (!Array.isArray(mtomb)) mtomb = [];
      const res = mergeDialSync(queue, mcust, mtomb, curIdx, looping, qNowIso(), qRid);
      curIdx = res.ci;
      if (res.mChanged) { try { await window.api.store.set(MCUST_KEY, mcust); } catch (e) {} }
      if (res.qChanged) { persistQueue(); renderQueue(); showCurrent(); }
    } catch (e) { /* 동기화 실패는 발신에 영향 없음 */ }
    finally { dialSyncBusy = false; }
  }
  function dialSyncSoon() { clearTimeout(dialSyncDebTimer); dialSyncDebTimer = setTimeout(dialSync, 800); }
  // 삭제된 번호를 폰에도 전파(tombstone)
  async function addDialTombstones(numbers) {
    if (!numbers || !numbers.length || !window.api || !window.api.store) return;
    try {
      let mtomb = (await window.api.store.get(MTOMB_KEY)) || []; if (!Array.isArray(mtomb)) mtomb = [];
      const at = qNowIso();
      numbers.forEach(num => { const n = dNorm(num); if (!n) return; mtomb = mtomb.filter(t => dNorm(t.number) !== n); mtomb.push({ number: n, at }); });
      await window.api.store.set(MTOMB_KEY, mtomb);
    } catch (e) {}
  }

  // 큰 메모장(np-wrapper)을 발신 패널 현재통화 밑으로 이동 (#2 요청)
  function relocateMemoPad(tries) {
    tries = tries || 0;
    const wrap = $('np-wrapper'), slot = $('dl-memo-slot');
    if (wrap && slot) {
      const oldParent = wrap.parentElement;   // memo-area 의 inline-search-panel
      wrap.style.minHeight = '220px';
      const inp = $('np-input'); if (inp) inp.style.minHeight = '120px';
      slot.appendChild(wrap);
      // 저장된 메모 '목록'(검색바+리스트)만 떼서 오른쪽 아래(기록 밑)로 이동.
      // 입력창(현재통화+메모작성)은 가운데 그대로. → 저장 시 목록이 변해도 입력창이 안 흔들림.
      try {
        const notesSlot = $('dl-notes-slot');
        const bar = $('np-notes-bar'), list = $('np-list');
        if (notesSlot && bar) notesSlot.appendChild(bar);
        if (notesSlot && list) notesSlot.appendChild(list);
      } catch (e) {}
      // #1: 멘트 영역에 남은 빈 "메모장" 칸 숨기고 빠른대응만 남기기
      try {
        const isp = document.querySelector('.memo-area .inline-search-panel');
        if (isp) isp.style.display = 'none';
        const grid = document.querySelector('.memo-area .memo-bottom-grid');
        if (grid) grid.style.gridTemplateColumns = '1fr';
        if (oldParent && oldParent !== slot && oldParent.classList && oldParent.classList.contains('inline-search-panel')) oldParent.style.display = 'none';
      } catch (e) {}
      return;
    }
    if (tries < 40) setTimeout(() => relocateMemoPad(tries + 1), 150);
  }

  // 앱 시작 시 자동연결 (마지막 성공 IP 우선)
  async function autoConnect() {
    let ip = '';
    try { ip = await D.autostartIp(); } catch (e) {}
    if (!ip) return;
    $('dl-ip').value = ip;
    setStatus('connecting');
    const r = await D.connect(ip);
    connected = !!(r && r.ok);
    setStatus(connected ? 'on' : 'off', connected ? '자동 연결됨' : '자동연결 실패');
    if (connected) { toast('✓ 자동 연결됨 (' + ip + ')'); refreshCallLogCache(); }
  }

  // 🔁 자동 재연결 감시 — 폰을 들고 나갔다 와도(와이파이 끊김/IP 변경) 알아서 다시 연결.
  //    저장 IP 로 몇 번 실패하면 → 같은 와이파이 대역을 자동 스캔해 폰의 '바뀐 IP'까지 찾아냄.
  let __reconnBusy = false;
  let __reconnMiss = 0;   // 저장 IP 연속 실패 횟수 (임계 도달 시 서브넷 스캔으로 승격)
  let __guidedOnce = false;   // 자동 스캔도 실패했을 때 지침 경고창을 '한 번만' 띄우기 위한 플래그
  function startAutoReconnect() {
    setInterval(async () => {
      if (__reconnBusy) return;                       // 이전 시도 진행 중이면 건너뜀
      const ip = ($('dl-ip').value || '').trim();
      const host = ip ? (ip.includes(':') ? ip : ip + ':5555') : '';
      const ipOnly = host ? host.split(':')[0] : '';
      __reconnBusy = true;
      try {
        // 1) 현재 폰이 실제로 붙어있는지 확인 (device 상태)
        if (ipOnly) {
          let alive = false;
          try { const ds = await D.devices(); alive = (ds || []).some(d => d.serial && d.serial.indexOf(ipOnly) === 0 && d.state === 'device'); } catch (e) {}
          if (alive) {
            __reconnMiss = 0; __guidedOnce = false;
            if (!connected) { connected = true; setStatus('on', '자동 재연결됨'); toast('✓ 폰 자동 재연결됨'); refreshCallLogCache(); }
            return;
          }
        }
        // 2) 끊긴 상태 → 저장된 IP 로 조용히 재연결 시도 (토스트 스팸 없이)
        if (connected) { connected = false; setStatus('off', '연결 끊김 — 자동 재연결 중…'); }
        else { setStatus('connecting', '자동 재연결 중…'); }
        if (host) {
          const r = await D.connect(host);
          if (r && r.ok) { __reconnMiss = 0; __guidedOnce = false; connected = true; setStatus('on', '자동 재연결됨'); toast('✓ 폰 자동 재연결됨'); refreshCallLogCache(); return; }
        }
        // 3) 저장 IP 로 여러 번 실패 → 폰 IP 가 바뀐 듯 → 서브넷 자동 스캔(무거워서 가끔만)
        __reconnMiss++;
        if (__reconnMiss >= 3) {
          setStatus('connecting', '폰 IP 바뀜? 자동 탐색 중…');
          let f = null;
          try { f = await D.autoFind(); } catch (e) {}
          __reconnMiss = 0;   // 성공/실패 무관 리셋 → 매 틱 스캔 방지(다음 승격까지 다시 ~21초)
          if (f && f.ok && f.ip) {
            __guidedOnce = false;
            $('dl-ip').value = f.ip;
            connected = true; setStatus('on', '폰 찾음 — 자동 연결됨');
            toast('✓ 폰 새 IP(' + f.ip + ')로 자동 연결됨'); refreshCallLogCache();
            return;
          }
          // 스캔도 실패 = 다른 Wi-Fi거나 5555 꺼짐(폰 재부팅) → 지침 경고창을 '한 번만' 띄움
          if (!connected) {
            setStatus('off', '폰 대기 중… (안 되면 USB로 1번 bat 실행)');
            if (!__guidedOnce) { __guidedOnce = true; guideFindFailure(f || {}); }   // 자동은 스팸 방지로 1회만
          }
        } else if (!connected) {
          setStatus('off', '폰 대기 중… (자동 재연결)');
        }
      } finally { __reconnBusy = false; }
    }, 7000);
  }

  // ============================================================
  //  📅 콜백 스케줄링 — '나중연락' 선택 직후 날짜를 지정해 큐 항목에 callbackAt(YYYY-MM-DD) 저장.
  //     콜백 도래(오늘 이하) 항목은 발신목록 위 슬림 바로 안내 → [발신목록에 올리기]로 되살림.
  // ============================================================
  function isoDateStr(d) { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; }
  function todayIso() { return isoDateStr(new Date()); }
  function addDaysIso(n) { const d = new Date(); d.setDate(d.getDate() + n); return isoDateStr(d); }
  function closeCallbackPicker() {
    const p = document.getElementById('dl-cbpick'); if (p) p.remove();
    document.removeEventListener('mousedown', onCbPickOutside, true);
  }
  function onCbPickOutside(e) {
    const p = document.getElementById('dl-cbpick');
    if (p && !p.contains(e.target)) closeCallbackPicker();
  }
  // anchorEl 근처에 [내일/3일 후/7일 후/직접선택/지정 안 함] 팝오버 → onPick(dateStr) 콜백으로 실제 저장은 호출자가 처리
  function openCallbackPicker(anchorEl, onPick) {
    closeCallbackPicker();
    if (!anchorEl) return;
    const pop = document.createElement('div');
    pop.id = 'dl-cbpick';
    pop.className = 'dl-cbpick';
    pop.innerHTML =
      '<div class="dl-cbpick-title">📅 언제 다시 연락할까요?</div>' +
      '<div class="dl-cbpick-row">' +
        '<button class="dl-cbpick-btn" data-d="' + addDaysIso(1) + '">내일</button>' +
        '<button class="dl-cbpick-btn" data-d="' + addDaysIso(3) + '">3일 후</button>' +
        '<button class="dl-cbpick-btn" data-d="' + addDaysIso(7) + '">7일 후</button>' +
      '</div>' +
      '<div class="dl-cbpick-row">' +
        '<input type="date" id="dl-cbpick-date" class="dl-cbpick-date">' +
        '<button class="dl-cbpick-btn accent" id="dl-cbpick-pick">📅 선택</button>' +
      '</div>' +
      '<button class="dl-cbpick-none" id="dl-cbpick-none">지정 안 함</button>';
    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth || 210;
    let left = r.left; if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 4) left = 4;
    let top = r.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(4, r.top - pop.offsetHeight - 6);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    const finish = (dateStr) => { closeCallbackPicker(); if (dateStr) { try { onPick && onPick(dateStr); } catch (e) {} } };
    pop.querySelectorAll('.dl-cbpick-btn[data-d]').forEach(b => b.onclick = () => finish(b.dataset.d));
    pop.querySelector('#dl-cbpick-pick').onclick = () => { const v = pop.querySelector('#dl-cbpick-date').value; if (v) finish(v); };
    pop.querySelector('#dl-cbpick-none').onclick = () => closeCallbackPicker();
    setTimeout(() => document.addEventListener('mousedown', onCbPickOutside, true), 0);
  }
  // 큐 항목에 콜백 예정일 저장 — 저장·재렌더·동기화까지 처리
  function setCallbackAt(item, dateStr) {
    if (!item || !dateStr) return;
    item.callbackAt = dateStr;
    touchQ(item);
    persistQueue(); renderQueue(); dialSyncSoon();
    toast('📅 콜백 예정: ' + dateStr);
  }
  // 콜백 도래 바 — done && callbackAt<=오늘 인 항목이 있으면 발신목록 위에 슬림 바로 안내(0건이면 숨김)
  function renderCallbackBar() {
    const today = todayIso();
    const due = queue.filter(q => q && q.done && q.callbackAt && q.callbackAt <= today);
    let bar = document.getElementById('dl-cbbar');
    if (!due.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'dl-cbbar';
      bar.className = 'dl-cbbar';
      const queueSec = document.querySelector('.dl-sec-queue');
      if (queueSec && queueSec.parentElement) queueSec.parentElement.insertBefore(bar, queueSec);
      else return;
    }
    bar.innerHTML = '<span class="dl-cbbar-txt">📅 콜백 예정 ' + due.length + '건</span>' +
      '<button class="dl-btn accent" id="dl-cbbar-btn">발신목록에 올리기</button>';
    bar.querySelector('#dl-cbbar-btn').onclick = () => {
      due.forEach(q => { q.done = false; delete q.callbackAt; touchQ(q); });
      persistQueue(); renderQueue(); dialSyncSoon(); renderCallbackBar();
      toast('📅 콜백 ' + due.length + '건을 발신목록에 올렸어요');
    };
  }

  // ============================================================
  //  📞 콜백 처리 — 부재로 넘어간 번호가 다시 전화 오면, 현재 통화로 다시 불러와
  //     결과(가망 등) 바꾸고 메모 남기기. 저장하면 통화기록/메모에 새 이력으로 쌓임.
  //  + 수신 울림 자동 감지(배너). 걸려온 '번호'는 ADB가 안 주므로, 방금 통화한
  //     사람들 중에서 한 번 탭으로 고르게 한다.
  // ============================================================
  function setCallbackBadge(on) {
    let badge = $('dl-callback-badge');
    if (!badge) {
      const cur = $('dl-current'); if (!cur) return;
      badge = document.createElement('div');
      badge.id = 'dl-callback-badge';
      badge.className = 'dl-callback-badge';
      cur.parentNode.insertBefore(badge, cur);
    }
    badge.style.display = on ? '' : 'none';
    if (on) badge.textContent = '📞 콜백 처리 중 — 통화 결과를 선택하고 [정지]를 누르세요';
  }
  function clearCallback() {
    if (!callbackActive) return;
    callbackActive = false;
    setCallbackBadge(false);
  }

  // 과거 연락처를 현재 통화로 다시 불러오기 (기록의 📞 버튼 / 수신 배너에서 호출)
  function enterCallback(number, name, lastMemo, lastTag) {
    if (!number) return;
    // ⏹ 이전 번호가 아직 통화 중(정지를 안 눌러 타이머가 돌고 있음)이면 강제 정지 후 이 번호로 전환
    //    — 발신번호목록 더블클릭(startFrom)과 동일한 처리
    if (dialStart) { try { stopCallTimer(); } catch (e) {} dialStart = 0; updateCallTimer(); }
    clearCurrentCallFlag();
    const dnum = String(number).replace(/\D/g, '');
    let idx = queue.findIndex(q => String(q.number).replace(/\D/g, '') === dnum);
    if (idx < 0) { queue.push({ number, tag: null, memo: '', done: false }); idx = queue.length - 1; persistQueue(); }
    curIdx = idx;
    looping = false;                 // 자동발신 흐름 멈춤 (콜백에 집중)
    callbackActive = true;
    dialStart = null;                // 콜백은 우리가 건 게 아니므로 통화시간 미기록
    // 🔗 같은 번호의 가장 최근 기록을 찾아 연결 → 콜백 저장 시 그 기록을 '갱신'.
    //    (중복 기록 생성 방지 + 기록↔발신 결과 연동)
    let existing = null;
    for (let i = records.length - 1; i >= 0; i--) {
      if (String(records[i].number).replace(/\D/g, '') === dnum) { existing = records[i]; break; }
    }
    if (queue[curIdx]) {
      if (existing) { queue[curIdx]._recRef = existing; queue[curIdx]._saved = true; }   // 기존 기록 갱신 모드
      else { queue[curIdx]._recRef = null; queue[curIdx]._saved = false; }                // 기록 없으면 새로 생성
    }
    try { clearCountdown(); } catch (e) {}
    showCurrent();                   // dl-current 갱신 + 결과선택 초기화
    announceCall(number);            // __dialerCurrentCall/메모 번호 세팅 + 이름 자동조회
    const nm = $('customer-name'); if (nm && name) nm.value = name;
    // 마지막 결과를 미리 선택해 보여주고 → 사용자가 가망 등으로 바꾸게
    if (lastTag) {
      pendingTag = lastTag; window.__dialerResult = lastTag;
      document.querySelectorAll('.dl-result-btn').forEach(b => b.classList.toggle('sel', b.dataset.tag === lastTag));
    }
    // 지난 메모를 채워줘서 보고 수정/추가 가능하게
    const inp = $('np-input'); if (inp) { inp.value = lastMemo || ''; try { inp.focus(); } catch (e) {} }
    setCallbackBadge(true);
    hideIncomingBanner();
    renderQueue();
    toast('📞 콜백: ' + fmtPhone(number) + ' — 통화 결과 선택 후 [정지]를 누르세요');
  }

  // 📞 수신 울림 배너 (걸려온 번호는 못 받아오니, 최근 통화 중에서 고르게)
  function hideIncomingBanner() {
    const b = document.getElementById('dl-incoming-banner'); if (b) b.remove();
    clearTimeout(window.__dlibTimer);
    clearTimeout(window.__dlOutRetry);   // 발신번호 재시도 중단
  }
  // 📲 '직접 건 발신'의 실제 번호를 정확히 얻는다.
  //   1순위: dumpsys telecom 의 현재 통화 핸들(번호 노출 기종에서 실시간·정확).
  //   2순위: 통화기록에서 baseline(발신 감지 순간의 최신 기록) '이후에 새로 생긴' 발신(type2)만 채택.
  //     → 통화기록은 '통화 종료 시' 써지므로, 이전 통화 번호를 현재 통화로 오인하던 문제를 원천 차단.
  //     (date=통화시작시각·폰시계 기준이라 PC-폰 시계차와 무관하게 안전)
  async function detectOutgoingNumber() {
    // ⚠️ 화면 스크래핑(screenDialNumber)은 쓰지 않는다 — '더콜' 등 통화앱이 화면에 다른 번호(스팸DB·서비스번호)를
    //   함께 띄워, 실제 건 번호 대신 '엉뚱한 번호'를 집을 수 있어(실측: 01000000000 발신 → 화면 01039912225) 오히려 위험.
    // 1순위: telecom 핸들(번호 노출 기종에서 실시간). 이 폰은 마스킹이라 보통 빈값 → 통화기록 폴백.
    try { const ac = await D.activeCall(); if (ac && ac.number) return ac.number; } catch (e) {}
    // 2순위: 통화기록에서 baseline 이후 새 발신(통화 종료 시 확실히 기록됨). 이전 통화 오검출 원천 차단 = 정확함 보장.
    try {
      const lc = await D.lastCall();
      if (lc && lc.number && lc.type === '2' && lc.date && lc.date > outgoingBaselineDate) return lc.number;
    } catch (e) {}
    return '';
  }
  // 발신 시 번호를 즉시 못 잡았을 때(통화기록이 아직 안 써짐) 몇 초간 재시도 → 번호 뜨면 배너 갱신
  function retryOutgoingNumber(left) {
    clearTimeout(window.__dlOutRetry);
    const ban = document.getElementById('dl-incoming-banner');
    if (!ban || !ban.classList.contains('is-outgoing')) return;   // 닫혔거나 다른 배너면 중단
    if (ban.querySelector('#dlib-known-btn')) return;             // 이미 번호 잡음
    if (left <= 0) return;
    window.__dlOutRetry = setTimeout(async () => {
      const known = await detectOutgoingNumber();
      const ban2 = document.getElementById('dl-incoming-banner');
      if (!ban2 || !ban2.classList.contains('is-outgoing')) return;
      if (known) { showIncomingBanner(known, 'outgoing'); return; }   // 번호 확보 → 갱신
      retryOutgoingNumber(left - 1);
    }, 1800);
  }
  function showIncomingBanner(known, mode) {
    const outgoing = (mode === 'outgoing');   // 내가 핸드폰으로 직접 건 전화
    hideIncomingBanner();
    const recent = []; const seen = new Set();
    for (let i = records.length - 1; i >= 0 && recent.length < 4; i--) {
      const r = records[i]; const d = String(r.number).replace(/\D/g, '');
      if (!d || seen.has(d)) continue; seen.add(d); recent.push(r);
    }
    // 🆕 ADB로 실제 번호를 잡았으면(known) → 그 번호로 바로 불러오는 큰 버튼을 맨 위에.
    //    같은 번호의 과거 기록이 있으면 이름/메모/결과도 함께 불러온다.
    const kd = known ? String(known).replace(/\D/g, '') : '';
    let knownRec = null;
    if (kd) { for (let i = records.length - 1; i >= 0; i--) { if (String(records[i].number).replace(/\D/g, '') === kd) { knownRec = records[i]; break; } } }
    const knownLead = outgoing ? '📝 이 번호 메모하기' : '📞 이 번호로 콜백';
    const knownBlock = kd
      ? '<button class="dlib-known" id="dlib-known-btn"><span class="dlib-known-lead">' + knownLead + '</span>' +
        '<b>' + fmtPhone(known) + '</b>' + (knownRec && knownRec.name ? ' · ' + escapeHtml(knownRec.name) : '') + '</button>'
      : '';
    const ban = document.createElement('div');
    ban.id = 'dl-incoming-banner';
    ban.className = 'dl-incoming-banner' + (outgoing ? ' is-outgoing' : '');
    const headTitle = outgoing ? '📲 직접 건 전화 감지' : '📞 전화가 왔어요!';
    const headSub = outgoing
      ? (kd ? '방금 건 번호를 감지했어요 — 아래 버튼으로 메모' : '최근 통화 4명 — 메모할 번호를 누르세요')
      : (kd ? '걸려온 번호를 감지했어요 — 아래 파란 버튼으로 콜백' : '최근 통화 4명 — 콜백이면 누르세요');
    const answerBlock = outgoing ? '' : '<button class="dlib-answer" id="dlib-answer-btn">📞 전화 받기</button>';
    ban.innerHTML =
      '<div class="dlib-head">' + headTitle + '<span class="dlib-sub">' +
      headSub +
      '</span><button class="dlib-x" title="닫기">✕</button></div>' +
      answerBlock +
      knownBlock +
      '<div class="dlib-list">' +
      (recent.length
        ? recent.map((r, i) => '<button class="dlib-item" data-i="' + i + '"><b>' + fmtPhone(r.number) + '</b>' +
            (r.name ? ' · ' + escapeHtml(r.name) : '') + '<span class="dlib-tag">' + escapeHtml(r.tag || '') + '</span></button>').join('')
        : '<span class="dlib-empty">최근 통화 기록이 없어요 — 아래에서 번호·이름으로 찾으세요</span>') +
      '</div>' +
      // 🔎 최근 4명에 없으면(예: 1시간 전 통화) 전체 기록에서 번호·이름으로 찾아 콜백
      '<div class="dlib-search-wrap">' +
      '<input type="text" id="dlib-search" class="dlib-search" placeholder="🔎 더 예전 통화? 번호·이름으로 찾기" autocomplete="off">' +
      '<div class="dlib-search-results" id="dlib-search-results"></div>' +
      '</div>';
    document.body.appendChild(ban);
    ban.querySelector('.dlib-x').onclick = hideIncomingBanner;
    const answerBtn = ban.querySelector('#dlib-answer-btn');
    if (answerBtn) answerBtn.onclick = async () => {
      answerBtn.disabled = true; answerBtn.textContent = '📞 받는 중…';
      try { const r = await D.answerCall(); toast(r && r.ok ? '📞 전화를 받았어요' : '받기 실패 — 폰에서 직접 받아주세요'); } catch (e) { toast('받기 실패'); }
      setTimeout(() => { answerBtn.disabled = false; answerBtn.textContent = '📞 전화 받기'; }, 1500);
    };
    const knownBtn = ban.querySelector('#dlib-known-btn');
    if (knownBtn) knownBtn.onclick = () => enterCallback(known, knownRec && knownRec.name, knownRec && knownRec.memo, knownRec && knownRec.tag);
    ban.querySelectorAll('.dlib-item').forEach(btn => btn.onclick = () => {
      const r = recent[+btn.dataset.i]; if (r) enterCallback(r.number, r.name, r.memo, r.tag);
    });
    // 🔎 검색: 전체 통화기록에서 번호(숫자) 또는 이름 부분일치 → 중복 제거 → 콜백으로 불러와 메모 수정
    const sInput = ban.querySelector('#dlib-search');
    const sRes = ban.querySelector('#dlib-search-results');
    if (sInput && sRes) {
      sInput.addEventListener('input', () => {
        const raw = sInput.value.trim();
        const qDigit = raw.replace(/\D/g, '');
        const qLower = raw.toLowerCase();
        if (!raw) { sRes.innerHTML = ''; return; }
        const hits = []; const used = new Set();
        for (let i = records.length - 1; i >= 0 && hits.length < 8; i--) {
          const r = records[i]; const d = String(r.number).replace(/\D/g, '');
          if (!d || used.has(d)) continue;
          const nameHit = r.name && r.name.toLowerCase().includes(qLower);
          const numHit = qDigit && d.includes(qDigit);
          if (nameHit || numHit) { used.add(d); hits.push(r); }
        }
        if (!hits.length) { sRes.innerHTML = '<div class="dlib-noresult">일치하는 통화가 없어요</div>'; return; }
        sRes.innerHTML = hits.map((r, i) => '<button class="dlib-result" data-i="' + i + '"><b>' + fmtPhone(r.number) + '</b>' +
          (r.name ? ' · ' + escapeHtml(r.name) : '') +
          (r.tag ? '<span class="dlib-tag">' + escapeHtml(r.tag) + '</span>' : '') +
          (r.time ? '<span class="dlib-when">' + escapeHtml(r.time) + '</span>' : '') + '</button>').join('');
        sRes.querySelectorAll('.dlib-result').forEach(b => b.onclick = () => {
          const r = hits[+b.dataset.i]; if (r) enterCallback(r.number, r.name, r.memo, r.tag);
        });
      });
    }
    clearTimeout(window.__dlibTimer);
    window.__dlibTimer = setTimeout(hideIncomingBanner, 45000);   // 45초 후 자동 닫힘 (검색 여유)
  }

  // 공용: 날짜시각 포맷 + 녹음/문자 섹션 로더 (번호상세·발신확인창 공용)
  function fmtDTms(ms) { const dt = new Date(ms); if (isNaN(dt) || !ms) return ''; const two = n => String(n).padStart(2, '0'); return `${dt.getMonth() + 1}/${dt.getDate()} ${two(dt.getHours())}:${two(dt.getMinutes())}`; }
  function loadRecordingsInto(recEl, number) {
    D.recordingsFor(number).then(list => {
      if (!list || !list.length) { recEl.innerHTML = '<span style="color:var(--text-3);font-size:12px;">녹음 없음</span>'; return; }
      recEl.innerHTML = list.map((r, i) =>
        '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05);">' +
          '<span style="flex:1;font-size:13px;color:var(--text-1);">🎙 ' + (fmtDTms(r.ts) || escapeHtml(r.name)) + '</span>' +
          '<button class="dl-btn dl-nd-play" data-i="' + i + '" style="padding:5px 12px;font-size:12px;">▶ 재생</button>' +
        '</div><div class="dl-nd-player" data-p="' + i + '"></div>').join('');
      recEl.querySelectorAll('.dl-nd-play').forEach(b => b.onclick = () => {
        const i = +b.dataset.i; playRec(list[i], recEl.querySelector('.dl-nd-player[data-p="' + i + '"]'));
      });
    }).catch(() => { recEl.innerHTML = '<span style="color:#cf6b5c;font-size:12px;">녹음 조회 실패</span>'; });
  }
  function loadSmsInto(smsEl, number) {
    D.smsFor(number).then(list => {
      if (!list || !list.length) { smsEl.innerHTML = '<span style="color:var(--text-3);font-size:12px;">문자 없음</span>'; return; }
      smsEl.innerHTML = list.slice(0, 60).map(m => {
        const sent = m.type === '2';
        return '<div style="display:flex;justify-content:' + (sent ? 'flex-end' : 'flex-start') + ';margin:5px 0;">' +
          '<div style="max-width:78%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:' + (sent ? '#2e7d52' : '#2b2824') + ';color:' + (sent ? '#eafff2' : 'var(--text-1)') + ';">' +
            (escapeHtml(m.body) || '<i style="opacity:.6">(내용 없음)</i>') +
            '<div style="font-size:10px;opacity:.6;margin-top:3px;text-align:right;">' + fmtDTms(m.date) + '</div>' +
          '</div></div>';
      }).join('');
    }).catch(() => { smsEl.innerHTML = '<span style="color:#cf6b5c;font-size:12px;">문자 조회 실패</span>'; });
  }

  // 🎙 녹음 파일을 내려받아 인앱 재생 (실패 시 기본 플레이어로 폴백)
  async function playRec(rec, container) {
    container.innerHTML = '<span style="color:var(--text-3);font-size:12px;">불러오는 중…</span>';
    let res = null;
    try { res = await D.pullRecording(rec.remote, rec.name); } catch (e) {}
    if (!res || !res.ok || !res.path) { container.innerHTML = '<span style="color:#cf6b5c;font-size:12px;">재생 실패</span>'; return; }
    const url = 'file:///' + encodeURI(res.path.replace(/\\/g, '/'));
    container.innerHTML = '';
    const audio = document.createElement('audio');
    audio.controls = true; audio.autoplay = true; audio.src = url;
    audio.style.cssText = 'width:100%;height:36px;margin:6px 0;';
    audio.onerror = () => {
      container.innerHTML = '<button class="dl-btn" style="font-size:12px;padding:6px 12px;">📂 플레이어로 열기</button>';
      container.firstChild.onclick = () => D.openPath(res.path);
    };
    container.appendChild(audio);
  }

  // 📇 번호 상세 — 통화 녹음(재생) + 문자(SMS 스레드) + 걸기
  async function openNumberDetail(number, name) {
    if (document.getElementById('dl-numdetail')) return;
    if (!connected) { toast('먼저 폰을 연결하세요'); return; }
    const ov = document.createElement('div');
    ov.id = 'dl-numdetail';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML =
      '<div style="width:min(500px,95vw);max-height:86vh;display:flex;flex-direction:column;background:#1c1b18;border:1px solid var(--accent);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
        '<div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border);">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:16px;font-weight:800;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(name || fmtPhone(number)) + '</div>' +
            (name ? '<div style="font-size:12px;color:var(--text-3);">' + escapeHtml(fmtPhone(number)) + '</div>' : '') +
          '</div>' +
          '<button class="dl-btn green" id="dl-nd-dial" style="padding:8px 13px;">📞 걸기</button>' +
          '<button id="dl-nd-x" style="background:transparent;border:none;color:var(--text-3);font-size:18px;cursor:pointer;line-height:1;">✕</button>' +
        '</div>' +
        '<div style="overflow-y:auto;padding:14px 16px;">' +
          '<div style="font-size:13px;font-weight:800;color:var(--accent);margin-bottom:6px;">🎙 통화 녹음</div>' +
          '<div id="dl-nd-rec"><span style="color:var(--text-3);font-size:12px;">불러오는 중…</span></div>' +
          '<div style="font-size:13px;font-weight:800;color:var(--accent);margin:18px 0 6px;">💬 문자</div>' +
          '<div id="dl-nd-sms"><span style="color:var(--text-3);font-size:12px;">불러오는 중…</span></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc); };
    function onEsc(e) { if (e.key === 'Escape') close(); }
    ov.querySelector('#dl-nd-x').onclick = close;
    ov.querySelector('#dl-nd-dial').onclick = () => { close(); dialNumberFromExternal(number, name || ''); };
    document.addEventListener('keydown', onEsc);
    loadRecordingsInto(ov.querySelector('#dl-nd-rec'), number);
    loadSmsInto(ov.querySelector('#dl-nd-sms'), number);
  }

  // 📋 폰 통화기록 → 번호별 통화횟수 리스트 모달 (거기서 바로 걸기)
  // ============================================================
  //  👥 TM 고객관리 → 발신목록 불러오기
  //  · TM 고객관리(tmcrm)에 저장된 고객을 그 화면과 같은 방식으로 필터링해서 보고,
  //    필요한 사람만 골라 '발신 번호 목록'에 올린다.
  //  · 상태 11종 다중선택 + 부재 차수(2차·3차…) + 등급 + 다음연락일 + 검색.
  //  · 데이터는 tmcrm.bridge 의 TMCRM.getCustomers() 로 받아온다(TM 창 열려있으면 실시간).
  //  · 차단요청 고객과 blocklist 번호는 고를 수 없게 잠근다(발신금지 정책 유지).
  // ============================================================
  const TM_STATUSES = ['신규', '부재', '연속부재', '나중연락', '관심없음', '결번', '가망', '방문예약', '방문완료', '계약협의', '계약완료'];   // 🆕 P3) 거부·차단요청 폐지(자동 파기) / P5) 관심없음 / P7) 결번
  const TM_STATUS_COLOR = { 신규: '#6b93c4', 부재: '#9aa0a6', 연속부재: '#7d8288', 나중연락: '#cf9d52', 관심없음: '#8a877d', 결번: '#6b6660', 가망: '#cf6b5c', 방문예약: '#c96442', 방문완료: '#5a9d6b', 계약협의: '#5a9d6b', 계약완료: '#3ec46d', 거부: '#8a877d', 차단요청: '#b23a48' };

  let tmLoadBusy = false;   // 🔒 위 callLogBusy와 같은 이유 — 불러오는 동안 재클릭 시 모달 겹침 방지
  async function openTmLoadModal() {
    if (tmLoadBusy) return;
    if (document.getElementById('dl-tmload-modal')) return;
    if (!(window.TMCRM && window.TMCRM.getCustomers)) { toast('TM 고객관리를 불러올 수 없어요'); return; }
    tmLoadBusy = true;
    toast('👥 고객 불러오는 중…');
    let all = [];
    try { all = (await window.TMCRM.getCustomers()) || []; } catch (e) { all = []; }
    tmLoadBusy = false;
    if (document.getElementById('dl-tmload-modal')) return;   // 기다리는 사이 이미 열렸으면 중복 생성 방지
    all = all.filter(r => r && dNorm(r.phone));
    if (!all.length) {
      toast('TM 고객관리에 저장된 고객이 없어요 (한 번 열어서 확인해 보세요)');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows = all.map(r => {
      const d = dNorm(r.phone);
      return {
        digits: d, phone: r.phone, name: r.name || '',
        status: r.status || '신규', grade: r.grade || '',
        buje: +(r.bujeCount || 0),
        lastCall: r.lastCall || (r.lastCallAt ? String(r.lastCallAt).slice(0, 10) : ''),
        nextCall: r.nextCall || '', memo: (r.memo || '').split('\n')[0] || '',
        createdAt: r.createdAt || '',
        blocked: (r.status === '차단요청') || blockedSet.has(d),
        noCall: (r.srcState === '격리') || !!r.optOutAt,   // 🆕 P1) 출처불명 격리·수신거부/민원 → 발신 잠금
        optOutReason: r.optOutReason || '',
        src: r.source || r.srcPath || '',                  // 🆕 P1) 출처 한 줄 표시용
        inQueue: queue.some(q => dNorm(q.number) === d)
      };
    });

    const selSt = new Set();          // 선택된 상태(비면 전체)
    let fBuje = '', fGrade = '', fNext = '', fSearch = '', sortMode = 'recent', hideQueued = false;
    const picked = new Set();         // 선택된 고객 digits

    const ov = document.createElement('div');
    ov.id = 'dl-tmload-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    const inp = 'padding:7px 9px;font-size:12px;border-radius:7px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);outline:none;min-width:0;';
    ov.innerHTML =
      '<div style="width:min(620px,95vw);max-height:88vh;display:flex;flex-direction:column;background:#1c1b18;border:1px solid var(--accent);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
        '<div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border);">' +
          '<b style="font-size:15px;color:var(--text-1);">👥 TM 고객 불러오기</b>' +
          '<span id="dl-tl-total" style="font-size:11.5px;color:var(--text-3);"></span>' +
          '<button id="dl-tl-x" title="닫기" style="margin-left:auto;background:transparent;border:none;color:var(--text-3);font-size:18px;cursor:pointer;line-height:1;">✕</button>' +
        '</div>' +
        '<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">' +
          '<div id="dl-tl-chips" style="display:flex;flex-wrap:wrap;gap:5px;"></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:nowrap;">' +
            '<input id="dl-tl-search" placeholder="🔎 이름·번호·메모 검색" autocomplete="off" style="flex:1;min-width:64px;' + inp + '">' +
            '<select id="dl-tl-buje" title="부재 횟수(차수)로 좁히기" style="' + inp + '">' +
              '<option value="">부재 차수 전체</option><option value="1">1차 부재</option><option value="2">2차 부재</option>' +
              '<option value="3">3차 부재</option><option value="4">4차 이상</option>' +
            '</select>' +
            '<select id="dl-tl-grade" title="등급으로 좁히기" style="' + inp + '">' +
              '<option value="">등급 전체</option><option>A</option><option>B</option><option>C</option><option>D</option>' +
            '</select>' +
            '<select id="dl-tl-next" title="다음 연락일로 좁히기" style="' + inp + '">' +
              '<option value="">연락일 전체</option><option value="due">오늘까지(밀린 것 포함)</option>' +
              '<option value="today">오늘</option><option value="none">연락일 미정</option>' +
            '</select>' +
            '<select id="dl-tl-sort" title="정렬" style="' + inp + '">' +
              '<option value="recent">최근 통화순</option><option value="old">오래된 통화순</option>' +
              '<option value="next">연락일 빠른순</option><option value="name">이름순</option>' +
            '</select>' +
          '</div>' +
          '<label style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-3);cursor:pointer;">' +
            '<input type="checkbox" id="dl-tl-hideq"> 이미 발신목록에 있는 고객 숨기기' +
          '</label>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border);">' +
          '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2);cursor:pointer;">' +
            '<input type="checkbox" id="dl-tl-all"> <span id="dl-tl-alltxt">보이는 고객 전체선택</span>' +
          '</label>' +
          '<span id="dl-tl-count" style="margin-left:auto;font-size:11.5px;color:var(--text-3);"></span>' +
        '</div>' +
        '<div id="dl-tl-list" style="overflow-y:auto;padding:6px 8px;flex:1;"></div>' +
        '<div style="display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border);">' +
          '<button class="dl-btn" id="dl-tl-cancel" style="flex:1;">닫기</button>' +
          '<button class="dl-btn accent" id="dl-tl-add" style="flex:2;">발신목록에 올리기 (0)</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    const listEl = ov.querySelector('#dl-tl-list');
    const chipsEl = ov.querySelector('#dl-tl-chips');
    const addBtn = ov.querySelector('#dl-tl-add');
    const allBox = ov.querySelector('#dl-tl-all');
    ov.querySelector('#dl-tl-total').textContent = `전체 ${rows.length}명`;
    const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc); };
    function onEsc(e) { if (e.key === 'Escape') close(); }

    // 상태 조건을 뺀 나머지 필터 — 상태칩의 인원수를 셀 때 재사용한다(칩을 누르기 전에 몇 명인지 보이게)
    function matchNoStatus(r) {
      if (fBuje) { const n = +fBuje; if (n === 4 ? r.buje < 4 : r.buje !== n) return false; }
      if (fGrade) { const g = r.grade || ((r.status === '부재' || r.status === '연속부재') ? 'D' : ''); if (g !== fGrade) return false; }
      if (fNext === 'due' && !(r.nextCall && r.nextCall <= today)) return false;
      if (fNext === 'today' && r.nextCall !== today) return false;
      if (fNext === 'none' && r.nextCall) return false;
      if (hideQueued && r.inQueue) return false;
      const f = fSearch.trim().toLowerCase();
      if (f) {
        const fd = f.replace(/\D/g, '');
        if (!((fd && r.digits.includes(fd)) || r.name.toLowerCase().includes(f) || r.memo.toLowerCase().includes(f))) return false;
      }
      return true;
    }
    const match = r => (!selSt.size || selSt.has(r.status)) && matchNoStatus(r);
    const visible = () => rows.filter(match);
    const pickable = () => visible().filter(r => !r.blocked && !r.noCall);   // 🆕 P1) 발신금지도 선택 불가

    function renderChips() {
      const base = rows.filter(matchNoStatus);
      const cnt = {}; base.forEach(r => { cnt[r.status] = (cnt[r.status] || 0) + 1; });
      const chip = (label, on, key, color, n) =>
        '<button class="dl-tl-chip" data-k="' + escapeHtml(key) + '" style="padding:4px 9px;font-size:11.5px;font-weight:700;border-radius:13px;cursor:pointer;white-space:nowrap;' +
          'border:1px solid ' + (on ? (color || 'var(--accent)') : 'var(--border)') + ';' +
          'background:' + (on ? (color ? color + '33' : 'rgba(201,100,66,.22)') : 'var(--bg-2)') + ';' +
          'color:' + (on ? 'var(--text-1)' : 'var(--text-3)') + ';">' +
          escapeHtml(label) + (n != null ? ' <span style="opacity:.75;font-weight:600;">' + n + '</span>' : '') + '</button>';
      chipsEl.innerHTML = chip('전체', selSt.size === 0, '', '', base.length) +
        TM_STATUSES.map(s => chip(s, selSt.has(s), s, TM_STATUS_COLOR[s], cnt[s] || 0)).join('');
      chipsEl.querySelectorAll('.dl-tl-chip').forEach(b => b.onclick = () => {
        const k = b.dataset.k;
        if (!k) selSt.clear();
        else if (selSt.has(k)) selSt.delete(k); else selSt.add(k);
        render();
      });
    }

    function render() {
      renderChips();
      let arr = visible();
      if (sortMode === 'recent') arr.sort((a, b) => (b.lastCall || '').localeCompare(a.lastCall || ''));
      else if (sortMode === 'old') arr.sort((a, b) => (a.lastCall || '9999').localeCompare(b.lastCall || '9999'));
      else if (sortMode === 'next') arr.sort((a, b) => (a.nextCall || '9999').localeCompare(b.nextCall || '9999'));
      else arr.sort((a, b) => a.name.localeCompare(b.name));

      listEl.innerHTML = arr.length ? arr.map(r => {
        const on = picked.has(r.digits);
        const color = TM_STATUS_COLOR[r.status] || 'var(--text-3)';
        const badge = '<span style="font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:11px;white-space:nowrap;' +
          'color:' + color + ';background:' + color + '22;border:1px solid ' + color + '66;">' + escapeHtml(r.status) +
          ((r.status === '부재' || r.status === '연속부재') && r.buje ? ' ' + r.buje + '차' : '') + '</span>';
        const bits = [];
        if (r.grade) bits.push(r.grade + '등급');
        if (r.src) bits.push('출처 ' + r.src);   // 🆕 P1) 출처 한 줄 표시
        if (r.lastCall) bits.push('최근 ' + r.lastCall.slice(2));
        if (r.nextCall) bits.push('다음 ' + r.nextCall.slice(2) + (r.nextCall <= today ? ' ⏰' : ''));
        if (r.noCall) bits.push('발신금지' + (r.optOutReason ? '(' + r.optOutReason + ')' : '(출처불명 격리)'));   // 🆕 P1
        if (r.inQueue) bits.push('이미 목록에 있음');
        const sub = bits.join(' · ');
        const locked = r.blocked || r.noCall;   // 🆕 P1) 차단요청 + 발신금지 모두 잠금
        return '<label class="dl-tl-row" data-d="' + r.digits + '" style="display:flex;align-items:center;gap:9px;padding:8px 9px;border-bottom:1px solid rgba(255,255,255,.04);' +
            (locked ? 'opacity:.45;' : 'cursor:pointer;') + (on ? 'background:rgba(201,100,66,.12);' : '') + '">' +
            (locked
              ? '<span title="' + (r.blocked ? '차단요청 고객이라 발신할 수 없어요' : '발신금지(격리·수신거부) 고객이라 발신할 수 없어요') + '" style="width:14px;text-align:center;">' + (r.blocked ? '🚫' : '⛔') + '</span>'
              : '<input type="checkbox" class="dl-tl-cb" data-d="' + r.digits + '"' + (on ? ' checked' : '') + '>') +
            '<div style="flex:1;min-width:0;">' +
              '<div style="display:flex;align-items:center;gap:6px;min-width:0;">' +
                '<b style="font-size:13.5px;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                  escapeHtml(r.name || fmtPhone(r.phone)) + '</b>' + badge +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                escapeHtml((r.name ? fmtPhone(r.phone) + (sub ? ' · ' : '') : '') + sub) + '</div>' +
              (r.memo ? '<div style="font-size:11px;color:var(--text-3);opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📝 ' + escapeHtml(r.memo) + '</div>' : '') +
            '</div>' +
          '</label>';
      }).join('') : '<div style="padding:26px;text-align:center;color:var(--text-3);font-size:13px;">조건에 맞는 고객이 없어요</div>';

      listEl.querySelectorAll('.dl-tl-cb').forEach(cb => cb.onchange = () => {
        if (cb.checked) picked.add(cb.dataset.d); else picked.delete(cb.dataset.d);
        paintCount();
        const row = cb.closest('.dl-tl-row');
        if (row) row.style.background = cb.checked ? 'rgba(201,100,66,.12)' : '';
      });
      paintCount();
    }
    function paintCount() {
      const pk = pickable();
      const shownPicked = pk.filter(r => picked.has(r.digits)).length;
      allBox.checked = pk.length > 0 && shownPicked === pk.length;
      ov.querySelector('#dl-tl-count').textContent = `보이는 고객 ${visible().length}명 · 선택 ${picked.size}명`;
      ov.querySelector('#dl-tl-alltxt').textContent = `보이는 고객 전체선택 (${pk.length}명)`;
      addBtn.textContent = `발신목록에 올리기 (${picked.size})`;
      addBtn.disabled = !picked.size;
      addBtn.style.opacity = picked.size ? '1' : '.5';
    }

    allBox.onchange = () => {
      const pk = pickable();
      if (allBox.checked) pk.forEach(r => picked.add(r.digits));
      else pk.forEach(r => picked.delete(r.digits));
      render();
    };
    const searchEl = ov.querySelector('#dl-tl-search');
    searchEl.addEventListener('input', () => { fSearch = searchEl.value; render(); });
    ov.querySelector('#dl-tl-buje').onchange = (e) => { fBuje = e.target.value; render(); };
    ov.querySelector('#dl-tl-grade').onchange = (e) => { fGrade = e.target.value; render(); };
    ov.querySelector('#dl-tl-next').onchange = (e) => { fNext = e.target.value; render(); };
    ov.querySelector('#dl-tl-sort').onchange = (e) => { sortMode = e.target.value; render(); };
    ov.querySelector('#dl-tl-hideq').onchange = (e) => { hideQueued = e.target.checked; render(); };
    ov.querySelector('#dl-tl-x').onclick = close;
    ov.querySelector('#dl-tl-cancel').onclick = close;
    addBtn.onclick = () => {
      const items = rows.filter(r => picked.has(r.digits) && !r.blocked && !r.noCall)
        .map(r => ({ number: r.phone, name: r.name || '' }));
      if (!items.length) { toast('올릴 고객을 선택하세요'); return; }
      close();
      document.dispatchEvent(new CustomEvent('dialer:queue-add', { detail: { items } }));
    };
    document.addEventListener('keydown', onEsc);
    render();
    setTimeout(() => { try { searchEl.focus(); } catch (e) {} }, 30);
  }

  let callLogBusy = false;   // 🔒 폰에서 불러오는 동안(최대 12초) 재클릭/더블클릭 차단 — 없으면 모달이 여러 장 겹쳐 쌓임
  async function openCallLogModal() {
    if (callLogBusy) { toast('📋 통화기록 불러오는 중… 잠시만요'); return; }
    if (document.getElementById('dl-calllog-modal')) return;
    if (!connected) { toast('먼저 폰을 연결하세요'); return; }
    callLogBusy = true;
    toast('📋 통화기록 불러오는 중…');
    let rows = [];
    try { rows = (await D.callLogList(500)) || []; } catch (e) {}
    callLogBusy = false;
    if (document.getElementById('dl-calllog-modal')) return;   // 기다리는 사이 이미 열렸으면 중복 생성 방지
    if (!rows.length) { toast('통화기록을 못 불러왔어요 (권한/기종 문제일 수 있어요)'); return; }
    // 번호별 집계
    const map = {};
    rows.forEach(r => {
      const d = String(r.number).replace(/\D/g, ''); if (!d) return;
      if (!map[d]) map[d] = { number: r.number, digits: d, count: 0, out: 0, inc: 0, miss: 0, last: 0, lastType: '' };
      const g = map[d]; g.count++;
      if (r.type === '2') g.out++; else if (r.type === '1') g.inc++; else if (r.type === '3') g.miss++;
      if (r.date > g.last) { g.last = r.date; g.lastType = r.type; }
    });
    const groups = Object.values(map);
    const nameOf = (d) => { for (let i = records.length - 1; i >= 0; i--) { const r = records[i]; if (r && String(r.number).replace(/\D/g, '') === d && r.name) return r.name; } return ''; };
    const fmtDate = (ms) => { const dt = new Date(ms); if (isNaN(dt)) return ''; return `${dt.getMonth() + 1}/${dt.getDate()}`; };
    const typeLabel = (t) => ({ '1': '수신', '2': '발신', '3': '부재중' })[t] || '';
    let sortMode = 'recent', filter = '';

    const ov = document.createElement('div');
    ov.id = 'dl-calllog-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML =
      '<div style="width:min(470px,94vw);max-height:82vh;display:flex;flex-direction:column;background:#1c1b18;border:1px solid var(--accent);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;">' +
        '<div style="display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border);">' +
          '<b style="font-size:15px;color:var(--text-1);">📋 통화기록에서 걸기</b>' +
          '<span id="dl-cl-total" style="font-size:11.5px;color:var(--text-3);"></span>' +
          '<button id="dl-cl-x" title="닫기" style="margin-left:auto;background:transparent;border:none;color:var(--text-3);font-size:18px;cursor:pointer;line-height:1;">✕</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid var(--border);">' +
          '<input id="dl-cl-search" placeholder="🔎 번호·이름 검색" autocomplete="off" style="flex:1;min-width:0;padding:8px 11px;font-size:13px;border-radius:8px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);outline:none;">' +
          '<button class="dl-btn" id="dl-cl-recent" style="font-size:11.5px;">최근순</button>' +
          '<button class="dl-btn" id="dl-cl-freq" style="font-size:11.5px;">자주통화순</button>' +
        '</div>' +
        '<div id="dl-cl-list" style="overflow-y:auto;padding:8px;"></div>' +
      '</div>';
    document.body.appendChild(ov);

    const listEl = ov.querySelector('#dl-cl-list');
    ov.querySelector('#dl-cl-total').textContent = `번호 ${groups.length}개 · 통화 ${rows.length}건`;
    const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc); };
    function onEsc(e) { if (e.key === 'Escape') close(); }
    function markSort() {
      ov.querySelector('#dl-cl-recent').classList.toggle('accent', sortMode === 'recent');
      ov.querySelector('#dl-cl-freq').classList.toggle('accent', sortMode === 'freq');
    }
    function renderList() {
      let arr = groups.slice();
      const f = filter.trim().toLowerCase(), fd = f.replace(/\D/g, '');
      if (f) arr = arr.filter(g => (fd && g.digits.includes(fd)) || (nameOf(g.digits).toLowerCase().includes(f)));
      if (sortMode === 'freq') arr.sort((a, b) => b.count - a.count || b.last - a.last);
      else arr.sort((a, b) => b.last - a.last);
      listEl.innerHTML = arr.length ? arr.map(g => {
        const nm = nameOf(g.digits);
        const disp = nm || fmtPhone(g.number);
        const sub = (nm ? fmtPhone(g.number) + ' · ' : '') + `최근 ${fmtDate(g.last)} ${typeLabel(g.lastType)}`;
        const brk = `발신 ${g.out}·수신 ${g.inc}${g.miss ? '·부재 ' + g.miss : ''}`;
        return '<div style="display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid rgba(255,255,255,.04);">' +
            '<div class="dl-cl-detail" data-num="' + escapeHtml(g.number) + '" title="녹음·문자 보기" style="flex:1;min-width:0;cursor:pointer;">' +
              '<div style="font-weight:700;color:var(--text-1);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(disp) + '</div>' +
              '<div style="font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(sub + ' · ' + brk) + '</div>' +
            '</div>' +
            '<span title="총 통화 횟수" style="font-size:12px;font-weight:800;color:var(--accent);background:rgba(212,165,116,.15);border:1px solid var(--accent);border-radius:14px;padding:3px 9px;white-space:nowrap;">' + g.count + '회</span>' +
            '<button class="dl-btn dl-cl-detail" data-num="' + escapeHtml(g.number) + '" title="녹음·문자 보기" style="padding:7px 9px;font-size:13px;white-space:nowrap;">🎙💬</button>' +
            '<button class="dl-btn green dl-cl-dial" data-num="' + escapeHtml(g.number) + '" style="padding:7px 11px;font-size:12.5px;white-space:nowrap;">📞</button>' +
          '</div>';
      }).join('') : '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px;">일치하는 통화가 없어요</div>';
      listEl.querySelectorAll('.dl-cl-dial').forEach(b => b.onclick = (e) => {
        e.stopPropagation(); const num = b.dataset.num; close();
        dialNumberFromExternal(num, nameOf(String(num).replace(/\D/g, '')));
      });
      listEl.querySelectorAll('.dl-cl-detail').forEach(el => el.onclick = (e) => {
        e.stopPropagation(); const num = el.dataset.num; close();
        openNumberDetail(num, nameOf(String(num).replace(/\D/g, '')));
      });
    }
    ov.querySelector('#dl-cl-x').onclick = close;
    const searchEl = ov.querySelector('#dl-cl-search');
    searchEl.addEventListener('input', () => { filter = searchEl.value; renderList(); });
    ov.querySelector('#dl-cl-recent').onclick = () => { sortMode = 'recent'; markSort(); renderList(); };
    ov.querySelector('#dl-cl-freq').onclick = () => { sortMode = 'freq'; markSort(); renderList(); };
    document.addEventListener('keydown', onEsc);
    markSort(); renderList();
    setTimeout(() => { try { searchEl.focus(); } catch (e) {} }, 30);
  }

  // 통화상태 감시 — 수신(RINGING) 전환을 잡으면 배너. (callState는 이미 노출돼 있음)
  function startCallWatch() {
    setInterval(async () => {
      if (!connected) return;
      let st = 'UNKNOWN';
      try { st = await D.callState(); } catch (e) { return; }
      if (st === 'UNKNOWN') return;
      const becameRinging = (st === 'RINGING' && lastCallState !== 'RINGING');
      // 우리가 방금 발신한 직후(가드 시간 내)거나 콜백 처리 중이면 수신으로 안 봄
      if (becameRinging && Date.now() > dialGuardUntil && !callbackActive) {
        // baseline = 지금 최신 통화기록 date(=직전 통화). 현재 수신은 끊긴 뒤 이보다 새 기록으로 나타남 → 이전 수신번호 오검출 차단.
        incomingBaselineDate = 0;
        try { const lc0 = await D.lastCall(); incomingBaselineDate = (lc0 && lc0.date) ? lc0.date : 0; } catch (e) {}
        // 걸려온 번호: 1) dumpsys mCallIncomingNumber(실시간 필드), 2) 화면(수신 UI) 실시간 스크래핑,
        //   3) 통화기록 baseline 이후 새 수신(type1). 다 비면 known='' → 기존처럼 최근목록에서 고르기.
        let known = '';
        try { const info = await D.callInfo(); if (info && info.incoming) known = info.incoming; } catch (e) {}
        // (화면 스크래핑은 통화앱이 다른 번호를 섞어 띄워 위험하므로 미사용 — 발신 감지와 동일 정책)
        if (!known) { try { const lc = await D.lastCall(); if (lc && lc.number && lc.type === '1' && lc.date && lc.date > incomingBaselineDate) known = lc.number; } catch (e) {} }
        showIncomingBanner(known);
      }
      // 📲 내가 핸드폰으로 직접 건 전화 감지: IDLE→OFFHOOK 직행(수신은 RINGING을 거치므로 제외).
      //    우리 프로그램 발신은 dialGuardUntil 로, 자동발신/콜백 흐름은 플래그로 제외.
      const becameOutgoing = (st === 'OFFHOOK' && lastCallState === 'IDLE');
      if (becameOutgoing && Date.now() > dialGuardUntil && !callbackActive && !looping) {
        // baseline = '지금(발신 직전) 최신 통화기록의 date' = 직전 통화. 현재 통화는 이보다 새 기록으로 나타난다.
        //   → 통화기록이 통화종료 시 써지기 전까지, 이전 번호를 현재 통화로 오인하지 않는다.
        outgoingBaselineDate = 0;
        try { const lc0 = await D.lastCall(); outgoingBaselineDate = (lc0 && lc0.date) ? lc0.date : 0; } catch (e) {}
        const known = await detectOutgoingNumber();
        showIncomingBanner(known, 'outgoing');
        if (!known) retryOutgoingNumber(8);   // 통화가 끝나며 기록이 써질 때까지 대기(통화가 길면 아래 IDLE에서 마저 채움)
      }
      // 📴 통화 종료 감지: 직전이 통화중(OFFHOOK/RINGING)이었다가 IDLE 전환 → '통화중' 배지 자동 해제
      //    (상대가 먼저 끊어도, 발신 자동흐름이 아닐 때만. 루프 중에는 다음 발신이 곧 새 통화로 갱신함)
      if (st === 'IDLE' && lastCallState !== 'IDLE' && lastCallState !== 'UNKNOWN' && !looping) {
        clearCurrentCallFlag();
        // 통화 종료 직후 = call_log 에 발신번호가 확실히 쓰인 시점. 발신 배너가 번호를 아직 못 잡았으면 마지막으로 채운다.
        const ob = document.getElementById('dl-incoming-banner');
        if (ob && ob.classList.contains('is-outgoing') && !ob.querySelector('#dlib-known-btn')) retryOutgoingNumber(3);
      }
      // 통화가 끝날 때마다(루프 포함) 통화기록 캐시 갱신 → '이미 통화한 번호' 확인이 최신 유지
      if (st === 'IDLE' && lastCallState !== 'IDLE' && lastCallState !== 'UNKNOWN') refreshCallLogCache();
      lastCallState = st;
    }, 3000);
  }

  async function init() {
    buildPanel();
    try { queue = (await D.getQueue()) || []; } catch (e) { queue = []; }
    try { records = (await D.getRecords()) || []; } catch (e) { records = []; }
    try { (await D.getBlocklist() || []).forEach(d => blockedSet.add(String(d))); } catch (e) {}
    await loadOptOutSet();   // 🆕 P3) 수신거부 대장(재발신 방지) 로드
    await loadConsentMap();  // ✅ P6) 수신동의 체크 로드 (store 미러 + 내 통화기록 복구) — records 로드 뒤여야 함
    await loadSmsTemplates();   // 💬 P8) 문자 템플릿(인앱 편집분) 로드
    loadMyNameForSms();         // 💬 P8) {상담사} 치환용 계정 이름 (실패해도 '담당자'로 동작)
    try { const s = (await D.getSettings()) || {}; $('dl-wait').value = (typeof s.waitSec === 'number' ? s.waitSec : 5); } catch (e) {}
    try { const ip = await D.loadIp(); if (ip) $('dl-ip').value = ip; } catch (e) {}
    if (queue.length && curIdx < 0) curIdx = 0;
    renderQueue(); renderRecords(); showCurrent();
    renderCallbackBar();             // 📅 콜백 도래 바 — 초기 표시
    setInterval(renderCallbackBar, 60000);   // 60초마다 재확인
    relocateMemoPad();   // 큰 메모장을 발신 패널로 도킹
    autoConnect();       // 마지막 성공 IP로 자동 연결
    startAutoReconnect();// 🔁 폰 끊기면 자동 재연결 (연결 버튼 안 눌러도 됨)
    startCallWatch();    // 📞 수신 울림 감지 시작 (콜백 배너)
    dialSync();          // 📱 폰 큐 동기화 1회 + 주기 반복 (안 건 번호 양방향 표시)
    dialSyncTimer = setInterval(dialSync, 6000);

    $('dl-connect').onclick = smartConnect;
    // 📏 IP 입력칸 폭(드래그 조절) 기억 — PC마다 저장/복원. CSS min/max 안에서만 유효.
    //   ⚠️ 저장은 인라인 style.width(=사용자가 드래그로 정한 값)만. 좁은 패널에서 flex 자동축소된
    //      '렌더 폭'을 저장하면 원하는 값을 덮어써 버리므로 절대 그걸 저장하지 않는다.
    (function initIpWidth() {
      const wrap = document.querySelector('.dl-ip-wrap'); if (!wrap) return;
      try { const w = parseInt(localStorage.getItem('dl-ip-width') || '', 10); if (w >= 60 && w <= 400) wrap.style.width = w + 'px'; } catch (e) {}
      let t = null;
      try {
        const ro = new ResizeObserver(() => {
          clearTimeout(t);
          t = setTimeout(() => {
            const px = parseInt(wrap.style.width || '', 10);   // 인라인(드래그로 정한 값)만
            if (px >= 60 && px <= 400) { try { localStorage.setItem('dl-ip-width', String(px)); } catch (e) {} }
          }, 300);
        });
        ro.observe(wrap);
      } catch (e) {}
    })();
    $('dl-clear-btn').onclick = openQueueClearMenu;
    { const clb = $('dl-calllog'); if (clb) clb.onclick = openCallLogModal; }
    { const tlb = $('dl-tmload'); if (tlb) tlb.onclick = openTmLoadModal; }
    { const rbtn = $('dl-records-btn'); if (rbtn) rbtn.onclick = openRecordsModal; }
    // 선택 삭제(체크) 모드 — '목록 초기화 > 하나씩 선택해서 삭제'로 진입
    $('dl-sel-del').onclick = async () => {
      if (!selQueue.size) { toast('지울 번호를 체크하세요'); return; }
      await delNumbers([...selQueue], true);   // 성공 시 delNumbers가 selQueue를 비움
      if (!selQueue.size) exitQueueSelMode();  // 삭제됨 → 모드 종료 (취소 시 유지)
    };
    $('dl-sel-cancel').onclick = exitQueueSelMode;
    $('dl-start').onclick = start;
    $('dl-stop').onclick = stop;
    $('dl-end').onclick = endCall;
    $('dl-next').onclick = next;
    const smsBtn = $('dl-sms-btn'); if (smsBtn) smsBtn.onclick = () => openSmsModal();   // 💬 P8) 통화 후 문자
    $('dl-rec-clear').onclick = clearRecords;

    let ipTimer = null;
    $('dl-ip').addEventListener('input', () => {
      clearTimeout(ipTimer);
      ipTimer = setTimeout(() => { const v = $('dl-ip').value.trim(); if (v) D.saveIp(v); }, 500);
    });
    $('dl-wait').addEventListener('change', () => {
      D.setSettings({ waitSec: Math.max(0, parseInt($('dl-wait').value, 10) || 0) });
    });
    // Ctrl+Enter = 다음 번호 (단, 텍스트 입력 중이 아닐 때 우선 발신제어로)
    document.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.ctrlKey && e.key === 'Enter') {
        const inMemo = document.activeElement && document.activeElement.id === 'np-input';
        if (!inMemo) { e.preventDefault(); next(); }
      }
    });
    $('dl-collapse').onclick = () => {
      const collapsed = document.body.classList.toggle('dialer-collapsed');
      $('dl-collapse').textContent = collapsed ? '›' : '‹';
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
