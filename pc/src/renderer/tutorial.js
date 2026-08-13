// ============================================================
//  tutorial.js — 첫 실행 온보딩(스포트라이트 순차 안내)
//  - 하이라이트된 요소를 직접 눌러볼 수 있게 클릭은 통과시킴
//  - ADB 연결 안내(USB + 1_무선연결_초기설정_자동IP.bat) 포함
//  - 상단 메뉴 [도움말 → 튜토리얼 다시 보기]에서 재실행 (menu:action 'tutorial')
// ============================================================
(function () {
  const KEY = 'tutorialDone';

  const STEPS = [
    { center: true, title: '👋 콜파일럿이 뭐예요?',
      body: '콜파일럿은 「전화 걸기 + 통화 멘트 + 고객 관리 + 콜백 관리」를 한 화면에서 하는 영업 통화 프로그램이에요.\n\n화면은 3부분입니다.\n• 왼쪽 = 발신(전화 거는 곳)\n• 가운데 = 스크립트(읽을 멘트)\n• 오른쪽 = 콜 관리 / TM 고객관리(고객 정리)\n\n안내 중에도 하이라이트된 곳을 직접 눌러볼 수 있어요. 천천히 따라오세요!',
      next: '시작하기' },

    { sel: '.dialer-rail', title: '📞 ① 발신 패널 (왼쪽)',
      body: '폰과 연결해서 전화를 자동으로 걸어주는 곳이에요. 번호 목록을 넣고 [시작]을 누르면 위에서부터 순서대로 전화가 걸립니다.\n\n왜 이렇게? — 한 명씩 손으로 거는 것보다 훨씬 빠르게 많은 고객에게 연락하기 위해서예요.' },
    { sel: '#dl-connect', title: '폰 연결 (ADB)',
      body: '먼저 폰과 PC를 연결해야 전화를 걸 수 있어요. 폰 IP를 넣고 [연결]을 누르세요.\n\n안 되면 → 폰을 USB로 PC에 꽂고 앱 폴더의 「1_무선연결_초기설정_자동IP.bat」를 한 번 실행한 뒤 다시 [연결]. (폰·PC가 같은 와이파이여야 해요)' },
    { sel: '#dl-add-input', title: '번호 추가',
      body: '전화할 번호를 붙여넣고 [＋ 추가]. 줄바꿈·쉼표·공백으로 여러 개를 한 번에 넣을 수 있어요. 추가한 번호는 아래 목록에 쌓입니다.' },
    { sel: '#dl-calllog', title: '📋 통화기록에서 걸기',
      body: '폰의 통화기록을 번호별로 모아 「몇 번 통화했는지」와 함께 보여줘요. 번호를 누르면 그 사람의 🎙 녹음과 💬 문자를 바로 보고, 거기서 전화도 걸 수 있어요.\n\n왜? — 예전에 통화했던 고객을 다시 찾아 걸 때 편하라고요.' },
    { sel: '#dl-records-btn', title: '📂 기록',
      body: '통화기록을 검색하고, 결과를 나중에 고쳐 넣는 창을 여기서 열어요. 창 위쪽에 오늘 콜 수·연결률·평균 통화시간도 바로 보여줘서 오늘 얼마나 통화했는지 한눈에 확인할 수 있어요.' },
    { sel: '#dl-start', title: '자동 발신 시작 / 다음 번호',
      body: '[▶ 시작] = 목록 위에서부터 자동으로 전화. [▶▶ 다음 번호](Ctrl+Enter) = 하나씩 넘기기. [■ 정지]는 자동 진행 멈춤, [✂ 종료]는 현재 통화 끊기예요.' },
    { center: true, title: '🔔 전에 통화한 사람이면 확인창이 떠요',
      body: '이미 통화했던 번호로 걸려고 하면 → 「언제 통화했는지 + 🎙 녹음 + 💬 문자」가 한 창에 떠서, 들어보고 다시 걸지 정할 수 있어요.\n\n🚫 그 번호가 「차단요청」한 사람이면 → 빨간 경고가 뜨고 전화가 아예 안 걸립니다. 실수로 다시 거는 걸 막아줘요.' },
    { sel: '#dl-results', title: '통화 결과 남기기',
      body: '통화가 끝나면 결과 버튼을 누르세요. 뜻은 —\n• 가망: 관심 있는 유망 고객\n• 부재: 안 받음\n• 거부: 거절\n• 나중연락: 지금 말고 나중에\n• 방문예약: 방문 약속 잡음\n• 🚫 차단요청: 다시 걸면 안 되는 번호(자동으로 발신 차단)\n\n📅 「나중연락」을 고르면 그 자리에서 언제 다시 걸지(내일 / 3일 후 / 7일 후 / 직접 선택) 바로 정할 수 있어요.\n\n결과+메모는 오른쪽 고객관리에 자동으로 정리됩니다.' },
    { center: true, title: '📅 콜백 예정일이 되면 알려줘요',
      body: '정한 날짜가 되면 발신목록 위에 「📅 콜백 예정 N건」 띠가 떠요. [발신목록에 올리기]를 누르면 그 사람들이 다시 통화 대상으로 목록에 담깁니다.\n\n→ 다시 걸기로 한 약속을 놓치지 않아요.' },

    { sel: '#memo-content', title: '📝 ② 스크립트 (가운데)',
      body: '통화 중 읽을 멘트예요. 카드를 고르면 여기 크게 표시됩니다. 위 [＋ 새 스크립트]로 나만의 멘트를 추가할 수 있어요.\n\n왜 가운데? — 전화하면서 눈으로 바로 읽기 좋은 위치라서요.' },
    { sel: '#quick-keywords', title: '⚡ 빠른 대응',
      body: '고객이 하는 말(반론)에 맞는 답변 멘트를 한 번에 띄웁니다. 위 「🔎 키워드로 찾기」에 단어를 치면 관련 버튼만 남아 빠르게 골라요. 예: "비싸요" → 관련 대응 멘트.' },
    { sel: '#memo-more-btn', title: '⋯ 멘트 더보기 메뉴',
      body: '자주 안 쓰는 기능(시작화면 고정 · 글씨 설정 · 데이터 복원 · 튜토리얼 다시보기)은 이 ⋯ 메뉴 안에 모아뒀어요. 필요할 때만 열어보세요.' },

    { sel: '#crm-root', title: '🗂 ③ 콜 관리 (오른쪽)',
      body: '통화하며 남긴 메모가 고객별로 자동으로 쌓이는 곳이에요. 위쪽 탭으로 나뉩니다 —\n• 오늘: 오늘 연락할 사람\n• 고객 DB: 전체 고객 목록\n• 캘린더: 날짜별 콜백\n• 현황: 통계' },
    { center: true, title: '📞 오늘 탭 → 발신목록에 올리기',
      body: '「오늘」 탭에서는 오늘·놓친 콜백 고객이 모여 있어요. [📞 발신목록에 올리기] 버튼 한 번이면 그 고객들이 그대로 발신 대상에 담겨서, 왼쪽 발신 패널에서 바로 이어서 걸 수 있어요.' },
    { center: true, title: '📊 현황 — 연결률 / 예약전환율',
      body: '「현황」 탭에서 연결률(전화가 실제로 연결된 비율)과 예약전환율(연결된 통화 중 방문예약까지 잡은 비율)을 따로 보여줘요.\n\n→ 전화가 안 닿는 게 문제인지, 통화는 되는데 예약을 못 잡는 게 문제인지 구분해서 볼 수 있어요.' },
    { center: true, title: '👤 고객 DB 사용법',
      body: '「고객 DB」 탭에서 —\n• 🔎 검색: 이름·번호·메모로 찾기\n• 빠른보기: 🆕신규 / 콜백 / 🔥가망만 골라보기\n• 상태: 부재·가망·차단요청 등으로 거르기\n• 정렬: 최근·콜백임박·이름순\n• ＋고객: 번호로 새 고객 직접 등록\n\n각 고객의 🎙💬 버튼으로 녹음·문자도 볼 수 있어요.' },
    { center: true, title: '🚫 차단요청 번호 관리',
      body: '「차단요청」으로 표시한 번호는 —\n① 다시 걸려고 하면 빨간 경고로 막아주고,\n② TM 고객관리에서 상태를 「차단요청」으로 걸러 한눈에 모아 볼 수 있고,\n③ 앱 안에 저장돼서, 이 앱을 다른 사람에게 넘겨줘도 그 목록이 그대로 따라갑니다. → 받은 사람도 그 번호로 실수로 전화하지 않아요.' },
    { center: true, title: '🔴 콜 관리 버튼의 빨간 숫자',
      body: '화면 오른쪽 아래 [🗂 콜 관리] 버튼에 빨간 숫자가 뜨면, 그만큼 오늘·놓친 콜백이 있다는 뜻이에요. 숫자를 보면 지금 연락해야 할 고객이 몇 명인지 바로 알 수 있어요.' },

    { sel: '#crm-open-tmcrm', title: '📇 TM 고객관리',
      body: '마지막! 이 버튼을 누르면 「TM 고객관리」가 크게 열려요. 콜 관리보다 더 자세한 고객 DB·통계 도구예요.\n\n아래 버튼을 누르면 제가 열어드리고, 그 화면 안에서 버튼을 하나씩 이어서 안내할게요.\n\n(핵심 흐름: ①폰 연결 → ②번호 추가 → ③시작 → ④결과·콜백 지정 → 콜 관리·기록 확인. 이 안내는 [도움말 → 튜토리얼 다시 보기]에서 다시 볼 수 있어요.)',
      next: '📇 열고 사용법 보기',
      action: function () { try { if (window.TMCRM) { window.TMCRM.open(); if (window.TMCRM.tutorial) window.TMCRM.tutorial(); } } catch (e) {} } },
  ];

  let idx = 0, root = null, onResize = null, onKey = null;

  function injectStyle() {
    if (document.getElementById('tut-style')) return;
    const s = document.createElement('style');
    s.id = 'tut-style';
    s.textContent = `
      .tut-root { position: fixed; inset: 0; z-index: 100000; }
      .tut-dim { position: fixed; inset: 0; background: rgba(0,0,0,0.72); }
      .tut-spot { position: fixed; border-radius: 10px; border: 2px solid var(--accent, #c96442);
        box-shadow: 0 0 0 9999px rgba(0,0,0,0.72), 0 0 0 4px rgba(201,100,66,0.35);
        pointer-events: none; transition: all 0.18s ease; }
      .tut-tip { position: fixed; width: 340px; max-width: calc(100vw - 32px);
        background: var(--bg-2, #1e1a16); border: 1px solid var(--border-strong, #4a453f); border-radius: 12px;
        box-shadow: 0 18px 50px rgba(0,0,0,0.6); padding: 16px 18px 14px; color: var(--text-1, #f2f2f2);
        font-family: 'Pretendard', -apple-system, 'Malgun Gothic', sans-serif; }
      .tut-tip-title { font-size: 15px; font-weight: 800; margin-bottom: 8px; color: var(--accent, #c96442); }
      .tut-tip-body { font-size: 13px; line-height: 1.65; white-space: pre-wrap; color: var(--text-2, #e2e2e2); }
      .tut-tip-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
      .tut-step { font-size: 11px; color: var(--text-3, #9a9a9a); margin-right: auto; }
      .tut-btn { padding: 7px 13px; border-radius: 7px; font-size: 12.5px; font-weight: 700;
        cursor: pointer; border: 1px solid var(--border-strong, rgba(255,255,255,0.16)); background: rgba(255,255,255,0.06); color: var(--text-1, #eee); }
      .tut-btn:hover { background: rgba(255,255,255,0.12); }
      .tut-btn.primary { background: linear-gradient(135deg,#e08a5f,#c96442); color: #fff; border: none; }
      .tut-btn.ghost { background: transparent; border: none; color: var(--text-3, #9a9a9a); }
    `;
    document.head.appendChild(s);
  }

  function cleanup() {
    if (root) { root.remove(); root = null; }
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
  }

  function finish() {
    cleanup();
    try { window.api.store.set(KEY, true); } catch (e) {}
  }

  function go(n) {
    idx = n;
    if (idx < 0) idx = 0;
    if (idx >= STEPS.length) { finish(); return; }
    render();
  }
  // 다음 버튼: 현재 스텝에 action 이 있으면 실행(예: TM 고객관리 열기) 후 진행
  function nextStep() {
    const s = STEPS[idx];
    if (s && s.action) { try { s.action(); } catch (e) {} }
    go(idx + 1);
  }

  function render() {
    if (!root) return;
    const step = STEPS[idx];
    const dim = root.querySelector('.tut-dim');
    const spot = root.querySelector('.tut-spot');
    const tip = root.querySelector('.tut-tip');

    let rect = null;
    if (step.sel) { const el = document.querySelector(step.sel); if (el) rect = el.getBoundingClientRect(); }

    if (rect && rect.width > 0 && rect.height > 0) {
      // 스포트라이트: 대상만 밝게, 나머지 어둡게. 클릭은 통과(직접 눌러보기 가능)
      dim.style.display = 'none';
      const pad = 6;
      spot.style.display = 'block';
      spot.style.left = Math.max(2, rect.left - pad) + 'px';
      spot.style.top = Math.max(2, rect.top - pad) + 'px';
      spot.style.width = Math.min(window.innerWidth - 4, rect.width + pad * 2) + 'px';
      spot.style.height = Math.min(window.innerHeight - 4, rect.height + pad * 2) + 'px';
    } else {
      // 중앙 안내(대상 없음) — 전체 딤 + 가운데 카드
      spot.style.display = 'none';
      dim.style.display = 'block';
    }

    tip.querySelector('.tut-tip-title').textContent = step.title;
    tip.querySelector('.tut-tip-body').textContent = step.body;
    tip.querySelector('.tut-step').textContent = `${idx + 1} / ${STEPS.length}`;
    const prevBtn = tip.querySelector('.tut-prev');
    const nextBtn = tip.querySelector('.tut-next');
    prevBtn.style.visibility = idx === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = step.next || (idx === STEPS.length - 1 ? '마치기' : '다음 ▸');

    // 툴팁 위치: 대상 아래(공간 없으면 위), 없으면 화면 중앙
    tip.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left, top;
      if (rect && rect.width > 0) {
        left = rect.left + rect.width / 2 - tw / 2;
        top = rect.bottom + 14;
        if (top + th > window.innerHeight - 8) top = rect.top - th - 14;   // 아래 공간 없으면 위
        if (top < 8) top = 8;
      } else {
        left = window.innerWidth / 2 - tw / 2;
        top = window.innerHeight / 2 - th / 2;
      }
      left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      tip.style.visibility = 'visible';
    });
  }

  function start(force) {
    cleanup();
    injectStyle();
    idx = 0;
    root = document.createElement('div');
    root.className = 'tut-root';
    root.innerHTML =
      '<div class="tut-dim"></div>' +
      '<div class="tut-spot"></div>' +
      '<div class="tut-tip">' +
      '  <div class="tut-tip-title"></div>' +
      '  <div class="tut-tip-body"></div>' +
      '  <div class="tut-tip-foot">' +
      '    <span class="tut-step"></span>' +
      '    <button class="tut-btn ghost tut-skip">건너뛰기</button>' +
      '    <button class="tut-btn tut-prev">◂ 이전</button>' +
      '    <button class="tut-btn primary tut-next">다음 ▸</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(root);
    root.querySelector('.tut-skip').onclick = finish;
    root.querySelector('.tut-prev').onclick = () => go(idx - 1);
    root.querySelector('.tut-next').onclick = () => nextStep();
    onResize = () => render();
    window.addEventListener('resize', onResize);
    onKey = (e) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') nextStep();
      else if (e.key === 'ArrowLeft') go(idx - 1);
    };
    document.addEventListener('keydown', onKey);
    render();
  }

  window.Tutorial = { start, reset: () => { try { window.api.store.set(KEY, false); } catch (e) {} } };

  // 첫 실행 자동 시작 — 레이아웃(발신·콜관리)이 준비된 뒤에.
  async function maybeAutoStart(tries) {
    tries = tries || 0;
    let done = true;
    try { done = await window.api.store.get(KEY); } catch (e) { done = false; }
    if (done) return;
    if (!document.querySelector('.dialer-rail') || !document.querySelector('#crm-root')) {
      if (tries < 40) return setTimeout(() => maybeAutoStart(tries + 1), 300);
    }
    setTimeout(() => start(true), 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => maybeAutoStart(0));
  else maybeAutoStart(0);
})();
