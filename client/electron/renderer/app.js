// NaverBot renderer - UI 로직 (v2 Clean)
const bridge = window.nbBridge;

if (!bridge) {
  document.body.innerHTML =
    '<div style="padding:40px;color:#ef4f5f;font-family:sans-serif;">' +
    '<h2>preload.js 로드 실패</h2><p>Electron IPC 브릿지 문제.</p></div>';
  throw new Error("preload bridge not available");
}

// ── 상태 ──
const state = {
  subtype: "info",
  tone: "friendly",
  speech: "polite_yo",
  wordCount: "medium",
  loggedIn: false,
  user: null, // {email, nick, plan}
};

// ── 패널 전환 ──
const navItems = document.querySelectorAll(".nav-item");
const panels = document.querySelectorAll(".panel");

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.dataset.panel;
    navItems.forEach((n) => n.classList.toggle("active", n === item));
    panels.forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== target));
  });
});

function goToPanel(name) {
  const btn = document.querySelector(`.nav-item[data-panel="${name}"]`);
  if (btn) btn.click();
}

// ── Chip 선택 ──
function initChips(id, key) {
  const wrap = document.getElementById(id);
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    wrap.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    state[key] = btn.dataset.value;
  });
}
initChips("subtypeChips", "subtype");
initChips("toneChips", "tone");
initChips("speechChips", "speech");
initChips("wordCountChips", "wordCount");

// ── 체험 차감 (%APPDATA%/NaverBotSaaS/trial_used.txt — 별도 파일) ──
let _trialUsedCache = 0;
async function _getTrialUsed() {
  _trialUsedCache = await bridge.getTrialUsed();
  return _trialUsedCache;
}
function _setTrialUsed(n) {
  _trialUsedCache = n;
  bridge.setTrialUsed(n);
}
function _deductTrial() {
  if (!state.user || !state.user.trial) return;
  const used = _trialUsedCache + 1;
  _setTrialUsed(used);
  state.user.trial_used = used;
  const rem = Math.max(0, state.user.trial_limit - used);
  setUserBadge(`체험 남은 ${rem}회`, rem > 0 ? "green" : "gray");
  clearExtraPlanCard();
  renderPlanCard(state.user);
  if (rem <= 0) {
    setTimeout(() => {
      showModal("체험 횟수 소진", "무료 체험 횟수가 모두 소진되었습니다.\n프로 등급으로 업그레이드하면 무제한 이용 가능합니다.", "프로 등급 구독", () => bridge.openExternal("https://snsmakeit.com/pricing"));
    }, 2000);
  }
}

// ── 커스텀 모달 ──
function showModal(title, message, btnText = "확인", onConfirm = null) {
  let overlay = document.getElementById("modalOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modalOverlay";
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-title" id="modalTitle"></div>
        <div class="modal-message" id="modalMessage"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="modalCancel">닫기</button>
          <button class="btn btn-primary" id="modalConfirm"></button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById("modalCancel").addEventListener("click", () => overlay.style.display = "none");
  }
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalMessage").textContent = message;
  const confirmBtn = document.getElementById("modalConfirm");
  confirmBtn.textContent = btnText;
  confirmBtn.onclick = () => {
    overlay.style.display = "none";
    if (onConfirm) onConfirm();
  };
  overlay.style.display = "flex";
}

// ── 유틸 ──
function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function initialOf(text) {
  if (!text) return "?";
  return text.trim().charAt(0).toUpperCase();
}

// ── 로그 ──
const logEl = $("log");
function addLog(text) {
  const cur = logEl.textContent || "";
  logEl.textContent = (cur.startsWith("준비 완료") ? "" : cur + "\n") + text;
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog() { logEl.textContent = ""; }
$("clearLogBtn").addEventListener("click", clearLog);

// ── 발행 이력 관리 ──
async function getPublishHistory() {
  const cfg = (await bridge.loadConfig()) || {};
  return Array.isArray(cfg.publish_history) ? cfg.publish_history : [];
}

async function addPublishHistory(entry) {
  const cfg = (await bridge.loadConfig()) || {};
  if (!Array.isArray(cfg.publish_history)) cfg.publish_history = [];
  cfg.publish_history.unshift({ ...entry, time: new Date().toLocaleString("ko-KR") });
  // 최근 50개만 유지
  cfg.publish_history = cfg.publish_history.slice(0, 50);
  await bridge.saveConfig(cfg);
  renderPublishHistory();
}

async function renderPublishHistory() {
  // 달력 기반으로 전환됨 — 달력 재렌더링
  const cfg = (await bridge.loadConfig()) || {};
  window._cachedConfig = cfg;
  renderCalendar();
}

$("clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("발행 이력을 모두 삭제하시겠습니까?")) return;
  const cfg = (await bridge.loadConfig()) || {};
  cfg.publish_history = [];
  await bridge.saveConfig(cfg);
  renderPublishHistory();
});

// ── 대시보드 자동 운영 상태 ──
async function renderDashboardAutopilot() {
  const cfg = (await bridge.loadConfig()) || {};
  const ap = cfg.autopilot;
  const card = $("dashboardAutopilotCard");
  if (!card) return;
  if (!ap || !ap.active) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  const badge = $("dashboardAutopilotBadge");
  badge.textContent = "운영 중";
  badge.style.background = "var(--success-soft)";
  badge.style.color = "#065f46";

  const startDate = ap.started_at ? new Date(ap.started_at).toLocaleDateString("ko-KR") : "-";
  let endText = "무기한";
  if (ap.duration_days > 0 && ap.started_at) {
    const end = new Date(new Date(ap.started_at).getTime() + ap.duration_days * 86400000);
    endText = end.toLocaleDateString("ko-KR") + "까지";
  }

  $("dashboardAutopilotInfo").innerHTML = `
    <strong>테마:</strong> ${escapeHtml(ap.theme || "")}<br>
    <strong>발행:</strong> 하루 ${ap.posts_per_day || 3}개<br>
    <strong>시작:</strong> ${startDate}<br>
    <strong>기간:</strong> ${endText}<br>
    <strong>실행 시간:</strong> 매일 ${ap.start_time || "09:00"}
  `;
}

$("dashboardStopBtn").addEventListener("click", async () => {
  if (!confirm("자동 운영을 중지하시겠습니까?")) return;
  const r = await bridge.clearSchedule();
  const cfg = (await bridge.loadConfig()) || {};
  if (cfg.autopilot) cfg.autopilot.active = false;
  await bridge.saveConfig(cfg);
  renderDashboardAutopilot();
  // Step 5의 버튼도 동기화
  if ($("startAutopilotBtn")) $("startAutopilotBtn").style.display = "";
  if ($("stopAutopilotBtn")) $("stopAutopilotBtn").style.display = "none";
  if ($("autopilotStatus")) $("autopilotStatus").style.display = "none";
  addLog("[자동 운영] 중지됨");
});

bridge.onLog((text) => addLog(text.trim()));

// ── 사이드바 유저 배지 ──
function setUserBadge(text, state = "gray") {
  const badge = $("userBadge");
  badge.querySelector(".user-dot").className = "user-dot dot-" + state;
  badge.querySelector(".user-text").textContent = text;
}

// ── 스케줄 잠금 (trial 사용자는 사용 불가) ──
function updateScheduleLock(data) {
  const saveBtn = document.getElementById("saveScheduleBtn");
  const addBtn = document.getElementById("addTimeBtn");
  const clearBtn = document.getElementById("clearScheduleBtn");
  const scheduleCard = document.querySelector('.panel[data-panel="schedule"] .card');

  if (data && data.trial) {
    // trial → 잠금
    if (saveBtn) saveBtn.disabled = true;
    if (addBtn) addBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    // 잠금 표시 배너 추가
    if (scheduleCard && !scheduleCard.querySelector(".lock-banner")) {
      const banner = document.createElement("div");
      banner.className = "lock-banner";
      banner.innerHTML = `
        <div style="background:#fef3c7;color:#92400e;padding:12px 14px;border-radius:10px;font-size:12px;margin-bottom:14px;line-height:1.5;">
          <strong>체험 모드</strong>는 스케줄 자동 실행을 사용할 수 없습니다.<br>
          구독하면 매일 자동 발행이 가능합니다. <a href="#" id="lockPricingLink" style="color:#ef4f5f;font-weight:600;">snsmakeit.com/pricing</a>
        </div>
      `;
      scheduleCard.insertBefore(banner, scheduleCard.firstChild);
      const lp = banner.querySelector("#lockPricingLink");
      if (lp) lp.addEventListener("click", (e) => { e.preventDefault(); bridge.openExternal("https://snsmakeit.com/pricing"); });
    }
  } else {
    // 구독중 → 잠금 해제
    if (saveBtn) saveBtn.disabled = false;
    if (addBtn) addBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
    const banner = document.querySelector('.panel[data-panel="schedule"] .lock-banner');
    if (banner) banner.remove();
  }
}

// ── 플랜 카드 ──
function renderPlanCard(data) {
  const badge = $("planBadge");
  const title = $("planTitle");
  const desc = $("planDesc");
  const card = $("planCard");

  // 기존 user-card / plan-actions 제거 후 재구성
  card.innerHTML = "";

  if (!data || !data.valid) {
    // 로그아웃 상태
    card.innerHTML = `
      <div class="plan-badge">로그인 필요</div>
      <div class="plan-title">구독 정보 없음</div>
      <div class="plan-desc">로그인 후 구독 상태가 표시됩니다.</div>
    `;
    return;
  }

  const plan = (data.plan || "member").toUpperCase();
  const nick = data.nick || (data.email || "").split("@")[0];
  const email = data.email || "";
  const avatar = initialOf(nick);

  card.innerHTML = `
    <div class="user-card">
      <div class="avatar">${escapeHtml(avatar)}</div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(nick)}</div>
        <div class="user-email">${escapeHtml(email)}</div>
      </div>
      <button class="btn btn-outline btn-sm" id="logoutBtn">로그아웃</button>
    </div>
  `;

  // 플랜 상태 카드
  const planCard = document.createElement("div");
  planCard.className = "card";
  planCard.style.marginTop = "16px";

  if (data.trial) {
    const remaining = Math.max(0, data.trial_limit - data.trial_used);
    planCard.innerHTML = `
      <div class="plan-badge" style="background:#fef3c7;color:#92400e;">체험</div>
      <div class="plan-title">무료 체험 중</div>
      <div class="plan-desc">남은 횟수: <strong style="color:#ef4f5f;">${remaining}회</strong> / ${data.trial_limit}회 · 자동 스케줄 사용 불가</div>
      <div class="plan-actions">
        <button class="btn btn-primary btn-sm" id="subscribeBtn">구독하기</button>
        <button class="btn btn-outline btn-sm" id="refreshBtn">새로고침</button>
      </div>
    `;
  } else {
    planCard.innerHTML = `
      <div class="plan-badge active">${escapeHtml(plan)}</div>
      <div class="plan-title">라이선스 활성</div>
      <div class="plan-desc">모든 기능이 활성화됐습니다${data.expires_at ? " · 만료 " + new Date(data.expires_at).toLocaleDateString("ko-KR") : ""}</div>
      <div class="plan-actions">
        <button class="btn btn-outline btn-sm" id="refreshBtn">새로고침</button>
        <button class="btn btn-outline btn-sm" id="managePricingBtn">구독 관리</button>
      </div>
    `;
  }
  card.after(planCard);

  // 이벤트 바인딩
  $("logoutBtn").addEventListener("click", handleLogout);
  planCard.querySelector("#refreshBtn").addEventListener("click", () =>
    bridge.verifyAccount().then((r) => handleVerifyResult(r, data.email))
  );
  const subBtn = planCard.querySelector("#subscribeBtn");
  if (subBtn) subBtn.addEventListener("click", () => bridge.openExternal("https://snsmakeit.com/pricing"));
  const mgrBtn = planCard.querySelector("#managePricingBtn");
  if (mgrBtn) mgrBtn.addEventListener("click", () => bridge.openExternal("https://snsmakeit.com/mypage"));
}

// 기존 plan 카드 제거 (중복 방지)
function clearExtraPlanCard() {
  const panel = document.querySelector('.panel[data-panel="home"]') || document.querySelector('.panel[data-panel="account"]');
  if (!panel) return;
  const cards = panel.querySelectorAll('.card');
  // 서비스 소개(1) + 로그인 카드(2) + 플랜 카드(3) → 4번째부터 제거
  cards.forEach((c, i) => {
    if (i >= 3) c.remove();
  });
}

// ── 설정 로드 ──
async function loadSavedConfig() {
  const cfg = await bridge.loadConfig();
  if (!cfg) return;

  if (cfg.makeit_email && $("makeitEmail")) $("makeitEmail").value = cfg.makeit_email;
  if (cfg.naver_id) {
    $("naverId").value = cfg.naver_id;
    // 기존 계정을 리스트에 자동 추가
    if (!Array.isArray(cfg.naver_accounts)) cfg.naver_accounts = [];
    if (!cfg.naver_accounts.includes(cfg.naver_id)) {
      cfg.naver_accounts.push(cfg.naver_id);
      await bridge.saveConfig(cfg);
    }
  }

  if (cfg.write) {
    if (cfg.write.keyword) $("keyword").value = cfg.write.keyword;
    if (cfg.write.target) $("target").value = cfg.write.target;
    if (cfg.write.extra) $("extra").value = cfg.write.extra;
    if (cfg.write.naver_template && $("naverTemplate")) $("naverTemplate").value = cfg.write.naver_template;

    ["subtype", "tone", "speech", "wordCount"].forEach((k) => {
      if (cfg.write[k]) {
        state[k] = cfg.write[k];
        const map = { subtype: "subtypeChips", tone: "toneChips", speech: "speechChips", wordCount: "wordCountChips" };
        const wrap = $(map[k]);
        wrap.querySelectorAll(".chip").forEach((c) => {
          c.classList.toggle("active", c.dataset.value === cfg.write[k]);
        });
      }
    });
  }

  // 스케줄 복원
  if (cfg.schedule && Array.isArray(cfg.schedule.times)) {
    cfg.schedule.times.forEach((t) => scheduleTimes.add(t));
  }
}

// ── 현재 UI 상태 → config ──
function collectConfig() {
  const extra = ($("extra") && $("extra").value.trim()) || ($("extraManual") && $("extraManual").value.trim()) || "";
  return {
    naver_id: ($("naverId") && $("naverId").value.trim()) || "",
    write: {
      keyword: ($("keyword") && $("keyword").value.trim()) || "",
      target: ($("target") && $("target").value.trim()) || "",
      extra,
      subtype: state.subtype,
      tone: state.tone,
      speech: state.speech,
      wordCount: state.wordCount,
      naver_template: ($("naverTemplate") && $("naverTemplate").value.trim()) || "",
      image_count: ($("blogImageCount") && parseInt($("blogImageCount").value)) || 5,
    },
  };
}

// ── 메이킷 브라우저 로그인 ──
// 버튼 클릭 시 브라우저 열림 → 로그인 완료 후 makeit-sns:// protocol로 복귀
async function handleBrowserLogin() {
  addLog("[계정] 로그인 창 여는 중...");
  setUserBadge("대기 중...", "gray");
  await bridge.openLoginWindow();
}

// Custom protocol 콜백 수신 (main.js가 전달)
bridge.onAuthCallback(async (params) => {
  if (!params || !params.access_token) {
    addLog("[계정] 잘못된 콜백");
    setUserBadge("로그인 실패", "red");
    return;
  }

  addLog("[계정] 토큰 수신 완료, 구독 상태 확인 중...");
  setUserBadge("확인 중...", "gray");

  // config에 토큰 + 이메일 저장
  const cfg = (await bridge.loadConfig()) || {};
  cfg.makeit_access_token = params.access_token;
  cfg.makeit_refresh_token = params.refresh_token || "";
  cfg.makeit_email = params.email || "";
  cfg.makeit_uid = params.uid || "";
  cfg.makeit_token_expires = params.expires_at || "";
  await bridge.saveConfig(cfg);

  // 구독 상태 확인 (verify)
  const r = await bridge.verifyAccount();
  handleVerifyResult(r, params.email);

  // 계정 패널로 이동
  goToPanel("home");
});

function handleVerifyResult(r, email) {
  clearExtraPlanCard();
  // 로그인 카드 표시/숨김
  const loginCard = document.getElementById("loginCard");
  if (r.ok && r.result && r.result.status === "ok") {
    if (loginCard) loginCard.style.display = "none";
  } else {
    if (loginCard) loginCard.style.display = "";
  }
  if (r.ok && r.result && r.result.status === "ok") {
    const data = {
      valid: true,
      email,
      nick: r.result.nick || "",
      plan: r.result.plan || "member",
      expires_at: r.result.expires_at || "",
      trial: !!r.result.trial,
      trial_used: Math.max(r.result.trial_used || 0, _trialUsedCache),
      trial_limit: r.result.trial_limit || 5,
    };
    state.loggedIn = true;
    state.user = data;
    const remaining = data.trial ? Math.max(0, data.trial_limit - data.trial_used) : 0;
    const badgeText = data.trial
      ? `체험 남은 ${remaining}회`
      : `${data.plan} · ${data.nick || email}`;
    setUserBadge(badgeText, data.trial ? (remaining > 0 ? "green" : "gray") : "green");
    renderPlanCard(data);
    updateScheduleLock(data);
    addLog(data.trial
      ? `[계정] 체험 모드 — ${data.trial_used}/${data.trial_limit} 사용`
      : `[계정] 로그인 성공 — ${data.plan} 플랜`);
  } else {
    const err = (r.result && r.result.error) || r.error || "로그인 실패";
    state.loggedIn = false;
    state.user = null;
    setUserBadge("로그인 실패", "red");
    renderPlanCard(null);
    addLog(`[계정] 실패: ${err}`);
  }
}

async function handleLogout() {
  state.loggedIn = false;
  state.user = null;
  const cfg = (await bridge.loadConfig()) || {};
  delete cfg.makeit_access_token;
  delete cfg.makeit_refresh_token;
  delete cfg.makeit_uid;
  delete cfg.makeit_email;
  await bridge.saveConfig(cfg);
  clearExtraPlanCard();
  renderPlanCard(null);
  // 로그인 카드 다시 표시
  const loginCard = document.getElementById("loginCard");
  if (loginCard) loginCard.style.display = "";
  setUserBadge("로그인 필요", "gray");
  addLog("[계정] 로그아웃됨");
}

$("browserLoginBtn").addEventListener("click", handleBrowserLogin);

// 외부 링크
$("brandLink").addEventListener("click", (e) => {
  e.preventDefault();
  bridge.openExternal("https://snsmakeit.com/");
});
$("pricingLink").addEventListener("click", (e) => {
  e.preventDefault();
  bridge.openExternal("https://snsmakeit.com/pricing");
});
$("aboutWeb").addEventListener("click", (e) => {
  e.preventDefault();
  bridge.openExternal("https://snsmakeit.com/");
});

// ── 네이버 계정 리스트 관리 ──
async function getNaverAccounts() {
  const cfg = (await bridge.loadConfig()) || {};
  return Array.isArray(cfg.naver_accounts) ? cfg.naver_accounts : [];
}

async function addNaverAccount(id) {
  const cfg = (await bridge.loadConfig()) || {};
  if (!Array.isArray(cfg.naver_accounts)) cfg.naver_accounts = [];
  if (!cfg.naver_accounts.includes(id)) {
    cfg.naver_accounts.push(id);
    await bridge.saveConfig(cfg);
  }
}

async function removeNaverAccount(id) {
  const cfg = (await bridge.loadConfig()) || {};
  if (!Array.isArray(cfg.naver_accounts)) return;
  cfg.naver_accounts = cfg.naver_accounts.filter(a => a !== id);
  if (cfg.naver_id === id) cfg.naver_id = cfg.naver_accounts[0] || "";
  await bridge.saveConfig(cfg);
}

async function renderNaverAccountList() {
  const accounts = await getNaverAccounts();
  const box = $("naverAccountList");
  const currentId = ($("naverId") && $("naverId").value.trim()) || "";

  if (accounts.length === 0) {
    box.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">저장된 계정이 없습니다. 아래에서 계정을 추가하세요.</div>';
    return;
  }

  box.innerHTML = "";
  accounts.forEach(id => {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;margin:4px 0;border-radius:8px;background:var(--bg-elev);border:2px solid " + (id === currentId ? "var(--accent)" : "transparent") + ";cursor:pointer;transition:all 0.15s;";
    item.innerHTML = `
      <div style="flex:1;font-size:13px;font-weight:${id === currentId ? '600' : '400'};color:var(--text);">${escapeHtml(id)}</div>
      ${id === currentId ? '<span style="font-size:11px;color:var(--accent);font-weight:600;">사용 중</span>' : ''}
      <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px;" data-remove="${escapeHtml(id)}">삭제</button>
    `;
    // 계정 선택
    item.addEventListener("click", (e) => {
      if (e.target.dataset.remove) return;
      $("naverId").value = id;
      bridge.loadConfig().then(cfg => {
        cfg = cfg || {};
        cfg.naver_id = id;
        bridge.saveConfig(cfg);
      });
      renderNaverAccountList();
      addLog(`[네이버] 계정 전환: ${id}`);
    });
    // 삭제 버튼
    const rmBtn = item.querySelector("[data-remove]");
    if (rmBtn) {
      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`"${id}" 계정을 목록에서 삭제하시겠습니까?`)) {
          await removeNaverAccount(id);
          if ($("naverId").value === id) $("naverId").value = "";
          renderNaverAccountList();
          addLog(`[네이버] 계정 삭제: ${id}`);
        }
      });
    }
    box.appendChild(item);
  });
}

// ── 네이버 계정 저장 ──
$("savePwBtn").addEventListener("click", async () => {
  const id = $("naverId").value.trim();
  const pw = $("naverPw").value;
  if (!id || !pw) return showModal("알림","네이버 ID와 비밀번호를 입력하세요","확인");
  const r = await bridge.savePassword(id, pw, "NaverBotSaaS");
  if (r.ok) {
    $("naverPw").value = "";
    addLog("[네이버] 계정 저장 완료");
    const cfg = (await bridge.loadConfig()) || {};
    cfg.naver_id = id;
    await bridge.saveConfig(cfg);
    await addNaverAccount(id);
    renderNaverAccountList();
  } else {
    alert("저장 실패: " + (r.error || ""));
  }
});

// ── 이미지 갯수 슬라이더 ──
if ($("blogImageCount")) {
  $("blogImageCount").addEventListener("input", () => {
    if ($("blogImageCountBadge")) $("blogImageCountBadge").textContent = $("blogImageCount").value;
  });
}
if ($("cafeImageCount")) {
  $("cafeImageCount").addEventListener("input", () => {
    if ($("cafeImageCountBadge")) $("cafeImageCountBadge").textContent = $("cafeImageCount").value;
  });
}

// ── 블로그 모드 선택 (1회/예약 vs 자동운영) ──
function showBlogMode(mode) {
  $("blogModeSelect").style.display = mode ? "none" : "";
  $("blogAutopilotView").style.display = mode === "autopilot" ? "" : "none";
  const manualView = $("blogManualView");
  if (manualView) manualView.style.display = mode === "manual" ? "" : "none";
}

if ($("modeManual")) $("modeManual").addEventListener("click", () => showBlogMode("manual"));
if ($("modeAutopilot")) $("modeAutopilot").addEventListener("click", () => {
  showBlogMode("autopilot");
  // 자동 운영 화면에서도 계정 리스트 렌더링
  renderAutopilotAccountList();
});
if ($("autopilotBackBtn")) $("autopilotBackBtn").addEventListener("click", () => showBlogMode(null));
if ($("manualBackBtn")) $("manualBackBtn").addEventListener("click", () => showBlogMode(null));

async function renderAutopilotAccountList() {
  const accounts = await getNaverAccounts();
  const box = $("autopilotAccountList");
  if (!box) return;
  const currentId = ($("naverId") && $("naverId").value.trim()) || "";
  if (accounts.length === 0) {
    box.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">저장된 계정 없음. 1회/예약 발행에서 먼저 계정을 추가하세요.</div>';
    return;
  }
  box.innerHTML = accounts.map(id =>
    `<div style="display:inline-block;padding:6px 14px;margin:3px;border-radius:20px;font-size:12px;background:${id === currentId ? 'var(--accent-soft)' : 'var(--bg-elev)'};color:${id === currentId ? 'var(--accent)' : 'var(--text)'};font-weight:${id === currentId ? '600' : '400'};border:1px solid ${id === currentId ? 'var(--accent)' : 'var(--border-soft)'};">${id}</div>`
  ).join("");
}

// ── 달력 ──
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calSelectedDate = new Date().toISOString().slice(0, 10);

function renderCalendar() {
  const grid = $("calendarGrid");
  if (!grid) return;
  const title = $("calendarTitle");
  title.textContent = `${calYear}년 ${calMonth + 1}월`;

  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  let html = "";
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
  dayNames.forEach(d => { html += `<div class="cal-header">${d}</div>`; });

  // 이전 달 빈칸
  for (let i = 0; i < firstDay; i++) html += `<div class="cal-day other-month"></div>`;

  // 날짜
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const isToday = dateStr === today;
    const isSelected = dateStr === calSelectedDate;
    const cls = `cal-day${isToday ? " today" : ""}${isSelected ? " selected" : ""}`;
    // 해당 날짜 이력 확인
    const dots = getDotsForDate(dateStr);
    html += `<div class="${cls}" data-date="${dateStr}">
      ${d}
      <div class="cal-dots">${dots}</div>
    </div>`;
  }

  grid.innerHTML = html;
  grid.querySelectorAll(".cal-day[data-date]").forEach(el => {
    el.addEventListener("click", () => {
      calSelectedDate = el.dataset.date;
      renderCalendar();
      renderDayHistory(calSelectedDate);
    });
  });

  renderDayHistory(calSelectedDate);
}

function getDotsForDate(dateStr) {
  // config에서 publish_history 확인
  const cfg = window._cachedConfig || {};
  const history = Array.isArray(cfg.publish_history) ? cfg.publish_history : [];
  const dayItems = history.filter(h => (h.time || "").includes(dateStr.replace(/-/g, ". ").replace(/^20/, "20")));
  // 간단 매칭: 날짜 포함 여부
  const matched = history.filter(h => {
    if (!h.time) return false;
    // "2026. 4. 12." 형식 매칭
    const parts = dateStr.split("-");
    const y = parseInt(parts[0]);
    const m = parseInt(parts[1]);
    const d = parseInt(parts[2]);
    return h.time.includes(`${y}. ${m}. ${d}.`) || h.time.includes(`${y}.${m}.${d}`);
  });
  if (matched.length === 0) return "";
  const ok = matched.filter(h => !h.error).length;
  const fail = matched.filter(h => h.error).length;
  let dots = "";
  for (let i = 0; i < Math.min(ok, 3); i++) dots += '<div class="cal-dot-item blog"></div>';
  for (let i = 0; i < Math.min(fail, 2); i++) dots += '<div class="cal-dot-item fail"></div>';
  return dots;
}

async function renderDayHistory(dateStr) {
  const parts = dateStr.split("-");
  const m = parseInt(parts[1]);
  const d = parseInt(parts[2]);
  if ($("dayHistoryTitle")) $("dayHistoryTitle").textContent = `${m}월 ${d}일 발행 이력`;

  const cfg = (await bridge.loadConfig()) || {};
  window._cachedConfig = cfg;
  const history = Array.isArray(cfg.publish_history) ? cfg.publish_history : [];
  const y = parseInt(parts[0]);
  const dayItems = history.filter(h => {
    if (!h.time) return false;
    return h.time.includes(`${y}. ${m}. ${d}.`) || h.time.includes(`${y}.${m}.${d}`);
  });

  const box = $("publishHistory");
  if (!box) return;
  if (dayItems.length === 0) {
    box.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">이 날짜에 발행 이력이 없습니다.</div>';
    return;
  }
  box.innerHTML = "";
  dayItems.forEach(h => {
    const ok = !h.error;
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div class="history-dot ${ok ? 'ok' : 'fail'}"></div>
      <div class="history-body">
        <div class="history-title">${escapeHtml(h.title || h.topic || "제목 없음")}</div>
        <div class="history-meta">${escapeHtml(h.time || "")} · ${escapeHtml(h.naver_id || "")}</div>
        ${ok && h.url ? `<a class="history-link" data-url="${escapeHtml(h.url)}">${escapeHtml(h.url)}</a>` : ""}
        ${h.error ? `<div style="color:var(--danger);font-size:11px;margin-top:2px;">${escapeHtml(h.error)}</div>` : ""}
      </div>
    `;
    const link = item.querySelector(".history-link");
    if (link) link.addEventListener("click", (e) => { e.preventDefault(); bridge.openExternal(link.dataset.url); });
    box.appendChild(item);
  });
}

if ($("calPrev")) $("calPrev").addEventListener("click", () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});
if ($("calNext")) $("calNext").addEventListener("click", () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});

// ── 네이버 로그인 (세션 저장) ──
$("naverLoginBtn").addEventListener("click", async () => {
  const id = $("naverId").value.trim();
  if (!id) return showModal("알림","네이버 ID를 먼저 입력하세요","확인");
  $("naverLoginBtn").disabled = true;
  $("naverLoginBtn").textContent = "브라우저 열는 중...";
  addLog("[네이버] 세션 저장용 브라우저 열기 — 직접 로그인하세요");
  goToPanel("execlog");
  const r = await bridge.naverFirstLogin(id);
  $("naverLoginBtn").disabled = false;
  $("naverLoginBtn").textContent = "네이버 로그인 (세션 저장)";
  if (r.ok) {
    addLog("[네이버] 세션 저장 완료! 이제 자동 발행 가능합니다.");
    await bridge.saveConfig({ ...(await bridge.loadConfig() || {}), naver_id: id });
    await addNaverAccount(id);
    renderNaverAccountList();
  } else {
    addLog("[네이버] 세션 저장 실패: " + (r.error || ""));
  }
});

// ══════════════════════════════════════════════════════════
// ── 단계별 마법사 로직 ──
// ══════════════════════════════════════════════════════════
let wizCurrentStep = 1;
let analysisData = null;

function goWizStep(step) {
  wizCurrentStep = step;
  for (let i = 1; i <= 4; i++) {
    const el = $(`wizStep${i}`);
    if (el) el.classList.toggle("hidden", i !== step);
  }
  // 단계 바 업데이트
  document.querySelectorAll(".step-item").forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.remove("active", "done");
    if (s === step) el.classList.add("active");
    else if (s < step) el.classList.add("done");
  });
}

// Step 1 → 2 (주제→글감분석)
$("step1Next").addEventListener("click", async () => {
  const keyword = $("keyword").value.trim();
  if (!keyword) return showModal("알림", "키워드/주제를 입력하세요.", "확인");
  const nid = $("naverId") ? $("naverId").value.trim() : "";
  if (!nid) return showModal("알림", "계정 설정에서 네이버 계정을 먼저 등록하세요.", "확인");
  goWizStep(2);
  // 분석 시작
  $("analysisLoading").style.display = "block";
  $("analysisResult").style.display = "none";
  $("analysisError").style.display = "none";
  $("analysisSkip").style.display = "none";
  try {
    const r = await bridge.analyzeKeyword(keyword);
    $("analysisLoading").style.display = "none";
    if (r.ok && r.result) {
      analysisData = r.result;
      $("analysisResult").style.display = "block";
      // 추천 제목 렌더링
      const box = $("suggestedTitles");
      box.innerHTML = "";
      if (analysisData.suggested_titles && analysisData.suggested_titles.length > 0) {
        analysisData.suggested_titles.forEach((t, i) => {
          const div = document.createElement("div");
          div.className = "suggest-title";
          div.textContent = `${i + 1}. ${t}`;
          div.dataset.title = t;
          div.addEventListener("click", () => {
            box.querySelectorAll(".suggest-title").forEach(s => s.classList.remove("selected"));
            div.classList.add("selected");
          });
          box.appendChild(div);
        });
      }
      // 구조 요약
      $("structureSummary").textContent = analysisData.structure_summary || "분석 데이터 없음";
      // 추가 프롬프트 자동 반영
      if (analysisData.extra_prompt) {
        $("extra").value = analysisData.extra_prompt;
      }
    } else {
      $("analysisError").style.display = "block";
      $("analysisError").textContent = `분석 실패: ${r.error || "알 수 없는 오류"}. "분석 건너뛰기"를 눌러 직접 작성하세요.`;
    }
  } catch (e) {
    $("analysisLoading").style.display = "none";
    $("analysisError").style.display = "block";
    $("analysisError").textContent = `오류: ${e.message}`;
  }
});
// Step 2: 글감 분석
// 건너뛰기
$("step2Skip").addEventListener("click", () => {
  $("analysisLoading").style.display = "none";
  $("analysisResult").style.display = "none";
  $("analysisError").style.display = "none";
  $("analysisSkip").style.display = "block";
});
$("step2Prev").addEventListener("click", () => goWizStep(1));
$("step2Next").addEventListener("click", () => {
  // 분석 중이면 차단
  if ($("analysisLoading") && $("analysisLoading").style.display !== "none") {
    showModal("분석 중", "글감 분석이 진행 중입니다.\n분석이 완료되거나 '건너뛰기'를 눌러주세요.", "확인");
    return;
  }
  goWizStep(3);
});

// Step 3: 스타일
$("step3Prev").addEventListener("click", () => goWizStep(2));
$("step3Next").addEventListener("click", () => {
  // 발행 요약 생성
  const keyword = $("keyword").value.trim();
  const target = $("target").value.trim();
  const selected = document.querySelector(".suggest-title.selected");
  const selectedTitle = selected ? selected.dataset.title : "";

  let summary = `<strong>네이버 ID:</strong> ${escapeHtml($("naverId").value)}<br>`;
  summary += `<strong>키워드:</strong> ${escapeHtml(keyword)}<br>`;
  if (target) summary += `<strong>대상 독자:</strong> ${escapeHtml(target)}<br>`;
  if (selectedTitle) summary += `<strong>참고 제목:</strong> ${escapeHtml(selectedTitle)}<br>`;
  summary += `<strong>글 타입:</strong> ${state.subtype} / <strong>톤:</strong> ${state.tone} / <strong>말투:</strong> ${state.speech} / <strong>분량:</strong> ${state.wordCount}<br>`;

  let extra = $("extra").value.trim() || ($("extraManual") && $("extraManual").value.trim()) || "";
  // 선택한 제목을 프롬프트에 반영 + config에 저장
  if (selectedTitle) {
    extra = `글 제목은 반드시 "${selectedTitle}"으로 작성. 이 제목을 그대로 사용할 것. ` + extra;
  }
  if ($("extra")) $("extra").value = extra;
  if (extra) summary += `<strong>추가 프롬프트:</strong> ${escapeHtml(extra.slice(0, 100))}${extra.length > 100 ? "..." : ""}`;

  $("publishSummary").innerHTML = summary;
  goWizStep(4);
});

// Step 4: 발행
$("step4Prev").addEventListener("click", () => goWizStep(3));

// 발행 모드 전환 (즉시 / 예약)
const publishModeChips = $("publishModeChips");
if (publishModeChips) {
  publishModeChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    publishModeChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    const mode = chip.dataset.value;
    if ($("publishNowSection")) $("publishNowSection").style.display = mode === "now" ? "" : "none";
    if ($("publishScheduleSection")) $("publishScheduleSection").style.display = mode === "schedule" ? "" : "none";
  });
}

// 자동 운영 chip 상태
let autopilotCount = "3";
let autopilotDuration = "30";
const apCountChips = $("autopilotCountChips");
if (apCountChips) {
  apCountChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    apCountChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    autopilotCount = chip.dataset.value;
  });
}
const apDurChips = $("autopilotDurationChips");
if (apDurChips) {
  apDurChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    apDurChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    autopilotDuration = chip.dataset.value;
  });
}

// 자동 운영 시작
$("startAutopilotBtn").addEventListener("click", async () => {
  const theme = $("autopilotTheme").value.trim();
  if (!theme) return showModal("알림","테마를 입력하세요","확인");
  const naverId = $("naverId").value.trim();
  if (!naverId) return showModal("알림","네이버 계정을 설정하세요","확인");
  if (!state.loggedIn) return showModal("알림","먼저 메이킷 계정에 로그인하세요","확인");

  const startTime = $("autopilotStartTime").value || "09:00";
  const cfg = collectConfig();
  const saved = (await bridge.loadConfig()) || {};
  const merged = {
    ...saved, ...cfg,
    autopilot: {
      theme,
      posts_per_day: parseInt(autopilotCount),
      duration_days: parseInt(autopilotDuration),
      start_time: startTime,
      started_at: new Date().toISOString(),
      active: true,
    }
  };
  await bridge.saveConfig(merged);

  // Windows Task Scheduler에 등록
  const r = await bridge.createSchedule([startTime]);
  if (r.ok) {
    addLog(`[자동 운영] 시작됨 — 테마: "${theme}", 하루 ${autopilotCount}개, ${autopilotDuration === "0" ? "무기한" : autopilotDuration + "일"}`);
    addLog(`[자동 운영] 매일 ${startTime}에 자동 실행됩니다.`);
    $("startAutopilotBtn").style.display = "none";
    $("stopAutopilotBtn").style.display = "";
    $("autopilotStatus").style.display = "";
    $("autopilotStatusBody").innerHTML = `
      <strong>테마:</strong> ${escapeHtml(theme)}<br>
      <strong>발행:</strong> 하루 ${autopilotCount}개<br>
      <strong>기간:</strong> ${autopilotDuration === "0" ? "무기한" : autopilotDuration + "일"}<br>
      <strong>시작 시간:</strong> ${startTime}<br>
      <strong>상태:</strong> <span style="color:var(--success);font-weight:600;">운영 중</span>
    `;
    renderDashboardAutopilot();
    goToPanel("execlog");
  } else {
    addLog("[자동 운영] 스케줄 등록 실패");
    alert("스케줄 등록에 실패했습니다.");
  }
});

// 자동 운영 중지
$("stopAutopilotBtn").addEventListener("click", async () => {
  const r = await bridge.clearSchedule();
  const cfg = (await bridge.loadConfig()) || {};
  if (cfg.autopilot) cfg.autopilot.active = false;
  await bridge.saveConfig(cfg);
  $("startAutopilotBtn").style.display = "";
  $("stopAutopilotBtn").style.display = "none";
  $("autopilotStatus").style.display = "none";
  addLog("[자동 운영] 중지됨");
});

// 앱 시작 시 자동 운영 상태 복원
async function restoreAutopilotStatus() {
  const cfg = (await bridge.loadConfig()) || {};
  if (cfg.autopilot && cfg.autopilot.active) {
    const ap = cfg.autopilot;
    if ($("autopilotTheme")) $("autopilotTheme").value = ap.theme || "";
    $("startAutopilotBtn").style.display = "none";
    $("stopAutopilotBtn").style.display = "";
    $("autopilotStatus").style.display = "";
    $("autopilotStatusBody").innerHTML = `
      <strong>테마:</strong> ${escapeHtml(ap.theme || "")}<br>
      <strong>발행:</strong> 하루 ${ap.posts_per_day || 3}개<br>
      <strong>기간:</strong> ${!ap.duration_days ? "무기한" : ap.duration_days + "일"}<br>
      <strong>시작 시간:</strong> ${ap.start_time || "09:00"}<br>
      <strong>상태:</strong> <span style="color:var(--success);font-weight:600;">운영 중</span>
    `;
  }
}

// ── 지금 1회 발행 ──
const runBtn = $("runNowBtn");
const stopBtn = $("stopBtn");

runBtn.addEventListener("click", async () => {
  if (!state.loggedIn) {
    alert("먼저 계정 패널에서 로그인하세요");
    goToPanel("home");
    return;
  }
  // 체험 횟수 소진 체크
  if (state.user && state.user.trial) {
    const remaining = Math.max(0, state.user.trial_limit - state.user.trial_used);
    if (remaining <= 0) {
      showModal("체험 횟수 소진", "무료 체험 횟수가 모두 소진되었습니다.\n구독하면 무제한으로 이용할 수 있습니다.", "구독하기", () => bridge.openExternal("https://snsmakeit.com/pricing"));
      return;
    }
  }
  if (!state.loggedIn) {
    showModal("로그인 필요", "메이킷 계정에 먼저 로그인하세요.", "확인");
    goToPanel("home");
    return;
  }

  const cfg = collectConfig();
  if (!cfg.naver_id) return showModal("알림", "네이버 계정 설정에서 네이버 ID를 먼저 등록하세요.", "확인");
  if (!cfg.write.keyword) return showModal("알림", "키워드/주제를 입력하세요.", "확인");

  // 선택 제목 저장
  const selectedTitle = document.querySelector("#suggestedTitles .suggest-title.selected");
  cfg._selected_title = selectedTitle ? selectedTitle.dataset.title : "";

  clearLog();
  addLog("[시작] 봇 실행 중... (1~3분 소요)");
  runBtn.disabled = true;
  stopBtn.disabled = false;
  $("resultCard").style.display = "none";
  // 체험 즉시 차감 + 캐시 + 플랜카드 갱신
  _deductTrial();
  goToPanel("execlog");

  // config 저장 (비동기, UI 블로킹 없음)
  bridge.loadConfig().then(saved => {
    const merged = { ...(saved || {}), ...cfg };
    bridge.saveConfig(merged);
  });

  const r = await bridge.runOnce(cfg);

  runBtn.disabled = false;
  stopBtn.disabled = true;

  goToPanel("automation");
  const resultCard = $("resultCard");
  const resultBody = $("resultBody");
  resultCard.style.display = "block";

  if (r.ok && r.result && r.result.status === "ok") {
    // 단일 발행 또는 자동 운영 다중 발행
    if (r.result.posts && Array.isArray(r.result.posts)) {
      // 자동 운영 다중 결과
      let html = `<div class="result-success">${escapeHtml(r.result.message || "완료")}</div>`;
      for (const p of r.result.posts) {
        if (p.url) {
          html += `<div style="margin-top:8px;font-size:13px;"><strong>${escapeHtml(p.title || "")}</strong><br><a class="post-url" data-url="${escapeHtml(p.url)}" style="color:var(--accent);cursor:pointer;">${escapeHtml(p.url)}</a></div>`;
          addPublishHistory({ title: p.title, url: p.url, topic: p.topic, naver_id: $("naverId").value.trim() });
        } else {
          html += `<div style="margin-top:8px;font-size:13px;color:var(--danger);">${escapeHtml(p.topic || "")} — ${escapeHtml(p.error || "실패")}</div>`;
          addPublishHistory({ title: p.topic, error: p.error, naver_id: $("naverId").value.trim() });
        }
      }
      resultBody.innerHTML = html;
    } else {
      // 단일 발행
      resultBody.innerHTML = `
        <div class="result-success">발행 성공</div>
        <div style="margin-top:10px;font-size:13px;color:var(--text-sub);">제목: ${escapeHtml(r.result.title || "")}</div>
        ${r.result.post_url ? `<a class="post-url" data-url="${escapeHtml(r.result.post_url)}">${escapeHtml(r.result.post_url)}</a>` : ""}
      `;
      addPublishHistory({ title: r.result.title, url: r.result.post_url, topic: r.result.topic, naver_id: $("naverId").value.trim() });
    }
    resultBody.querySelectorAll(".post-url").forEach(link => {
      link.addEventListener("click", (e) => { e.preventDefault(); bridge.openExternal(link.dataset.url); });
    });
  } else {
    const err = (r.result && r.result.message) || r.error || "알 수 없는 오류";
    resultBody.innerHTML = `<div class="result-error">실패</div><div style="margin-top:10px;font-size:13px;color:var(--text-sub);">${escapeHtml(err)}</div>`;
    addPublishHistory({ title: "발행 실패", error: err, naver_id: $("naverId").value.trim() });
  }

  // 발행 성공/실패 상관없이 횟수 자동 업데이트 (글 생성이 됐으면 차감됨)
  try {
    const verifyR = await bridge.verifyAccount();
    handleVerifyResult(verifyR, (state.user && state.user.email) || "");
  } catch (e) {
    console.error("verify refresh failed:", e);
  }
});

stopBtn.addEventListener("click", async () => {
  await bridge.stopBot();
  addLog("[중지] 사용자가 중지함");
  runBtn.disabled = false;
  stopBtn.disabled = true;
});

// ── 프리셋 저장/불러오기 ──
async function loadPresets() {
  const cfg = (await bridge.loadConfig()) || {};
  return Array.isArray(cfg.presets) ? cfg.presets : [];
}

async function savePresets(presets) {
  const cfg = (await bridge.loadConfig()) || {};
  cfg.presets = presets;
  await bridge.saveConfig(cfg);
}

async function renderPresets() {
  const list = document.getElementById("presetList");
  if (!list) return;
  const presets = await loadPresets();
  if (presets.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">저장된 프리셋이 없습니다</div>';
    return;
  }
  list.innerHTML = "";
  presets.forEach((p, i) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = p.name;
    chip.title = "클릭: 불러오기 / 우클릭: 삭제";
    chip.addEventListener("click", () => applyPreset(p));
    chip.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      if (confirm(`"${p.name}" 프리셋 삭제하시겠습니까?`)) {
        const current = await loadPresets();
        current.splice(i, 1);
        await savePresets(current);
        renderPresets();
      }
    });
    list.appendChild(chip);
  });
}

function applyPreset(preset) {
  const w = preset.write || {};
  if (w.keyword !== undefined) $("keyword").value = w.keyword;
  if (w.target !== undefined) $("target").value = w.target;
  if (w.extra !== undefined) $("extra").value = w.extra;
  if (w.naver_template !== undefined && $("naverTemplate")) $("naverTemplate").value = w.naver_template;

  ["subtype", "tone", "speech", "wordCount"].forEach((k) => {
    if (w[k]) {
      state[k] = w[k];
      const map = { subtype: "subtypeChips", tone: "toneChips", speech: "speechChips", wordCount: "wordCountChips" };
      const wrap = $(map[k]);
      wrap.querySelectorAll(".chip").forEach((c) => {
        c.classList.toggle("active", c.dataset.value === w[k]);
      });
    }
  });
  addLog(`[프리셋] "${preset.name}" 불러옴`);
}

document.getElementById("savePresetBtn")?.addEventListener("click", async () => {
  const name = document.getElementById("presetName").value.trim();
  if (!name) return showModal("알림","프리셋 이름을 입력하세요","확인");
  const cfg = collectConfig();
  const presets = await loadPresets();
  // 같은 이름 덮어쓰기
  const idx = presets.findIndex((p) => p.name === name);
  const entry = { name, write: cfg.write };
  if (idx >= 0) presets[idx] = entry;
  else presets.push(entry);
  await savePresets(presets);
  document.getElementById("presetName").value = "";
  renderPresets();
  addLog(`[프리셋] "${name}" 저장됨`);
});

// ── 스케줄 ──
const scheduleTimes = new Set();
const scheduleEl = $("scheduleTimes");

function renderSchedule() {
  scheduleEl.innerHTML = "";
  const sorted = [...scheduleTimes].sort();
  if (sorted.length === 0) {
    scheduleEl.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">등록된 시간이 없습니다</div>';
    return;
  }
  sorted.forEach((t) => {
    const div = document.createElement("div");
    div.className = "time-chip";
    div.innerHTML = `${t} <button data-time="${t}">×</button>`;
    scheduleEl.appendChild(div);
  });
  scheduleEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      scheduleTimes.delete(btn.dataset.time);
      renderSchedule();
    });
  });
}

$("addTimeBtn").addEventListener("click", () => {
  const t = $("newScheduleTime").value;
  if (t) {
    scheduleTimes.add(t);
    renderSchedule();
  }
});

$("saveScheduleBtn").addEventListener("click", async () => {
  if (scheduleTimes.size === 0) return showModal("알림","시간을 1개 이상 추가하세요","확인");
  const saved = (await bridge.loadConfig()) || {};
  await bridge.saveConfig({ ...saved, ...collectConfig() });
  const times = [...scheduleTimes].sort();
  addLog(`[스케줄] 등록 중: ${times.join(", ")}`);
  const r = await bridge.createSchedule(times);
  if (r.ok) {
    addLog(`[스케줄] ${times.length}개 등록 완료`);
    const cfg = (await bridge.loadConfig()) || {};
    cfg.schedule = { times };
    await bridge.saveConfig(cfg);
  } else {
    addLog(`[스케줄] 등록 실패`);
  }
});

$("clearScheduleBtn").addEventListener("click", async () => {
  const r = await bridge.clearSchedule();
  if (r.ok) {
    scheduleTimes.clear();
    renderSchedule();
    addLog(`[스케줄] ${r.deleted}개 삭제 완료`);
  }
});

// ═══════════════════════════════════════════════
// ── 카페 모드 선택 + 단계별 마법사 ──
// ═══════════════════════════════════════════════
function showCafeMode(mode) {
  if ($("cafeModeSelect")) $("cafeModeSelect").style.display = mode ? "none" : "";
  if ($("cafeManualView")) $("cafeManualView").style.display = mode === "manual" ? "" : "none";
  if ($("cafeAutopilotView")) $("cafeAutopilotView").style.display = mode === "autopilot" ? "" : "none";
}
if ($("cafeModeManual")) $("cafeModeManual").addEventListener("click", () => showCafeMode("manual"));
if ($("cafeModeAutopilot")) $("cafeModeAutopilot").addEventListener("click", () => showCafeMode("autopilot"));
if ($("cafeManualBackBtn")) $("cafeManualBackBtn").addEventListener("click", () => showCafeMode(null));
if ($("cafeAutopilotBackBtn")) $("cafeAutopilotBackBtn").addEventListener("click", () => showCafeMode(null));

// 카페 단계 전환
let cafeCurrentStep = 1;
let cafeAnalysisData = null;
function goCafeStep(step) {
  cafeCurrentStep = step;
  for (let i = 1; i <= 4; i++) {
    const el = $(`cafeStep${i}`);
    if (el) el.classList.toggle("hidden", i !== step);
  }
  document.querySelectorAll("#cafeStepBar .step-item").forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.remove("active", "done");
    if (s === step) el.classList.add("active");
    else if (s < step) el.classList.add("done");
  });
}

// Step 1 → 2
if ($("cafeStep1Next")) $("cafeStep1Next").addEventListener("click", () => {
  if (!$("cafeNumber").value.trim() || !$("cafeMenuId").value.trim()) return showModal("알림", "카페 번호와 게시판 번호를 입력하세요.", "확인");
  goCafeStep(2);
});
if ($("cafeStep2Prev")) $("cafeStep2Prev").addEventListener("click", () => goCafeStep(1));

// Step 2 → 3 (글감 분석 자동 시작)
if ($("cafeStep2Next")) $("cafeStep2Next").addEventListener("click", async () => {
  const keyword = $("cafeKeyword").value.trim();
  if (!keyword) return showModal("알림","키워드를 입력하세요","확인");
  goCafeStep(3);

  // 분석 시작
  $("cafeAnalysisLoading").style.display = "block";
  $("cafeAnalysisResult").style.display = "none";
  $("cafeAnalysisError").style.display = "none";
  $("cafeAnalysisSkip").style.display = "none";

  try {
    const r = await bridge.analyzeKeyword(keyword);
    $("cafeAnalysisLoading").style.display = "none";
    if (r.ok && r.result) {
      cafeAnalysisData = r.result;
      $("cafeAnalysisResult").style.display = "block";
      const box = $("cafeSuggestedTitles");
      box.innerHTML = "";
      if (cafeAnalysisData.suggested_titles && cafeAnalysisData.suggested_titles.length > 0) {
        cafeAnalysisData.suggested_titles.forEach((t, i) => {
          const div = document.createElement("div");
          div.className = "suggest-title";
          div.textContent = `${i + 1}. ${t}`;
          div.dataset.title = t;
          div.addEventListener("click", () => {
            box.querySelectorAll(".suggest-title").forEach(s => s.classList.remove("selected"));
            div.classList.add("selected");
          });
          box.appendChild(div);
        });
      }
      $("cafeStructureSummary").textContent = cafeAnalysisData.structure_summary || "분석 데이터 없음";
      if (cafeAnalysisData.extra_prompt && $("cafeAnalysisExtra")) {
        $("cafeAnalysisExtra").value = cafeAnalysisData.extra_prompt;
      }
    } else {
      $("cafeAnalysisError").style.display = "block";
      $("cafeAnalysisError").textContent = `분석 실패: ${r.error || "알 수 없는 오류"}. "건너뛰기"를 눌러 직접 작성하세요.`;
    }
  } catch (e) {
    $("cafeAnalysisLoading").style.display = "none";
    $("cafeAnalysisError").style.display = "block";
    $("cafeAnalysisError").textContent = `오류: ${e.message}`;
  }
});

// Step 3 (글감 분석)
if ($("cafeStep3Skip")) $("cafeStep3Skip").addEventListener("click", () => {
  $("cafeAnalysisLoading").style.display = "none";
  $("cafeAnalysisResult").style.display = "none";
  $("cafeAnalysisError").style.display = "none";
  $("cafeAnalysisSkip").style.display = "block";
});
if ($("cafeStep3Prev")) $("cafeStep3Prev").addEventListener("click", () => goCafeStep(2));
if ($("cafeStep3Next")) $("cafeStep3Next").addEventListener("click", () => {
  // 분석 중이면 차단
  if ($("cafeAnalysisLoading") && $("cafeAnalysisLoading").style.display !== "none") {
    showModal("분석 중", "글감 분석이 진행 중입니다.\n분석이 완료되거나 '건너뛰기'를 눌러주세요.", "확인");
    return;
  }
  // 요약 생성
  const cfg_nid = $("naverId") ? $("naverId").value : "";
  const selectedTitle = document.querySelector("#cafeSuggestedTitles .suggest-title.selected");
  const extra = ($("cafeAnalysisExtra") && $("cafeAnalysisExtra").value.trim()) || ($("cafeExtra") && $("cafeExtra").value.trim()) || "";

  let summary = `<strong>네이버 ID:</strong> ${escapeHtml(cfg_nid)}<br>`;
  summary += `<strong>카페:</strong> ${escapeHtml($("cafeId").value)} (${escapeHtml($("cafeNumber").value)})<br>`;
  summary += `<strong>게시판:</strong> ${escapeHtml($("cafeBoardName").value || $("cafeMenuId").value)}<br>`;
  summary += `<strong>키워드:</strong> ${escapeHtml($("cafeKeyword").value)}<br>`;
  if (selectedTitle) summary += `<strong>참고 제목:</strong> ${escapeHtml(selectedTitle.dataset.title)}<br>`;
  summary += `<strong>글 타입:</strong> ${cafeSubtype}`;
  if (extra) summary += `<br><strong>프롬프트:</strong> ${escapeHtml(extra.slice(0, 100))}${extra.length > 100 ? "..." : ""}`;

  $("cafeSummary").innerHTML = summary;
  goCafeStep(4);
});

// Step 4 (발행)
if ($("cafeStep4Prev")) $("cafeStep4Prev").addEventListener("click", () => goCafeStep(3));

// 카페 자동 운영
let cafeApDuration = "30";
if ($("cafeApDurationChips")) {
  $("cafeApDurationChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    $("cafeApDurationChips").querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    cafeApDuration = chip.dataset.value;
  });
}
// 카페 갯수 슬라이더
if ($("cafeApCount")) {
  $("cafeApCount").addEventListener("input", () => {
    const badge = $("cafeApCountBadge");
    if (badge) badge.textContent = $("cafeApCount").value;
  });
}

if ($("startCafeApBtn")) $("startCafeApBtn").addEventListener("click", async () => {
  const theme = $("cafeApTheme").value.trim();
  if (!theme) return showModal("알림","테마를 입력하세요","확인");
  const cafeId = ($("cafeApCafeId") && $("cafeApCafeId").value.trim()) || "";
  const cafeNumber = ($("cafeApCafeNumber") && $("cafeApCafeNumber").value.trim()) || "";
  const menuId = ($("cafeApMenuId") && $("cafeApMenuId").value.trim()) || "";
  const boardName = ($("cafeApBoardName") && $("cafeApBoardName").value.trim()) || "";
  if (!cafeNumber) return showModal("알림","카페 번호를 입력하세요","확인");
  if (!menuId) return showModal("알림","게시판 번호를 입력하세요","확인");
  const count = parseInt($("cafeApCount").value) || 5;
  const startTime = $("cafeApStartTime").value || "10:00";
  const cfg = (await bridge.loadConfig()) || {};
  if (!cfg.naver_id) return showModal("알림","블로그 자동화에서 네이버 계정을 먼저 설정하세요","확인");

  // 카페 설정도 같이 저장
  cfg.cafe = { cafe_id: cafeId, cafe_number: cafeNumber, menu_id: menuId, board_name: boardName };
  cfg.cafe_autopilot = { theme, posts_per_day: count, duration_days: parseInt(cafeApDuration), start_time: startTime, started_at: new Date().toISOString(), active: true };
  await bridge.saveConfig(cfg);
  const r = await bridge.createSchedule([startTime]);
  if (r.ok) {
    addLog(`[카페 자동] 시작 — 테마: "${theme}", 하루 ${count}개`);
    $("startCafeApBtn").style.display = "none";
    $("stopCafeApBtn").style.display = "";
    goToPanel("execlog");
  }
});
if ($("stopCafeApBtn")) $("stopCafeApBtn").addEventListener("click", async () => {
  await bridge.clearSchedule();
  const cfg = (await bridge.loadConfig()) || {};
  if (cfg.cafe_autopilot) cfg.cafe_autopilot.active = false;
  await bridge.saveConfig(cfg);
  $("startCafeApBtn").style.display = "";
  $("stopCafeApBtn").style.display = "none";
  addLog("[카페 자동] 중지됨");
});

// ── 카페 발행 모드 전환 (즉시 / 예약) ──
const cafePublishChips = $("cafePublishModeChips");
if (cafePublishChips) {
  cafePublishChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    cafePublishChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    const mode = chip.dataset.value;
    if ($("cafePublishNowSection")) $("cafePublishNowSection").style.display = mode === "now" ? "" : "none";
    if ($("cafePublishScheduleSection")) $("cafePublishScheduleSection").style.display = mode === "schedule" ? "" : "none";
  });
}

// 카페 예약 스케줄
const cafeScheduleTimes = new Set();
if ($("cafeAddTimeBtn")) {
  $("cafeAddTimeBtn").addEventListener("click", () => {
    const t = $("cafeNewScheduleTime").value;
    if (t) { cafeScheduleTimes.add(t); renderCafeSchedule(); }
  });
}
function renderCafeSchedule() {
  const el = $("cafeScheduleTimes");
  if (!el) return;
  const sorted = [...cafeScheduleTimes].sort();
  if (sorted.length === 0) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">등록된 시간이 없습니다</div>';
    return;
  }
  el.innerHTML = "";
  sorted.forEach(t => {
    const div = document.createElement("div");
    div.className = "time-chip";
    div.innerHTML = `${t} <button data-time="${t}">x</button>`;
    el.appendChild(div);
  });
  el.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => { cafeScheduleTimes.delete(btn.dataset.time); renderCafeSchedule(); });
  });
}
if ($("saveCafeScheduleBtn")) {
  $("saveCafeScheduleBtn").addEventListener("click", async () => {
    if (cafeScheduleTimes.size === 0) return showModal("알림", "시간을 1개 이상 추가하세요.", "확인");
    const times = [...cafeScheduleTimes].sort();
    // config에 카페 설정 + _cafe_mode 저장
    const cfg = (await bridge.loadConfig()) || {};
    cfg._cafe_mode = true;
    await bridge.saveConfig(cfg);
    const r = await bridge.createSchedule(times);
    if (r.ok) {
      addLog(`[카페 예약] ${times.length}개 스케줄 등록 완료: ${times.join(", ")}`);
      showModal("예약 완료", `매일 ${times.join(", ")}에 카페 글이 자동 발행됩니다.`, "확인");
    }
  });
}
if ($("clearCafeScheduleBtn")) {
  $("clearCafeScheduleBtn").addEventListener("click", async () => {
    await bridge.clearSchedule();
    cafeScheduleTimes.clear();
    renderCafeSchedule();
    addLog("[카페 예약] 스케줄 삭제 완료");
  });
}

// ── 카페 설정 저장 ──
if ($("saveCafeSettingsBtn")) {
  $("saveCafeSettingsBtn").addEventListener("click", async () => {
    const cfg = (await bridge.loadConfig()) || {};
    cfg.cafe = {
      cafe_id: ($("cafeId") && $("cafeId").value.trim()) || "",
      cafe_number: ($("cafeNumber") && $("cafeNumber").value.trim()) || "",
      menu_id: ($("cafeMenuId") && $("cafeMenuId").value.trim()) || "",
      board_name: ($("cafeBoardName") && $("cafeBoardName").value.trim()) || "",
    };
    await bridge.saveConfig(cfg);
    addLog("[카페] 설정 저장 완료");
  });
}

// 카페 설정 로드
async function loadCafeSettings() {
  const cfg = (await bridge.loadConfig()) || {};
  const cafe = cfg.cafe || {};
  if (cafe.cafe_id && $("cafeId")) $("cafeId").value = cafe.cafe_id;
  if (cafe.cafe_number && $("cafeNumber")) $("cafeNumber").value = cafe.cafe_number;
  if (cafe.menu_id && $("cafeMenuId")) $("cafeMenuId").value = cafe.menu_id;
  if (cafe.board_name && $("cafeBoardName")) $("cafeBoardName").value = cafe.board_name;
  if (cfg.naver_id && $("cafeNaverId")) $("cafeNaverId").value = cfg.naver_id;
  // 카페 자동 운영에 카페 설정 연동
  if (cafe.cafe_id && $("cafeApCafeId")) $("cafeApCafeId").value = cafe.cafe_id;
  if (cafe.cafe_number && $("cafeApCafeNumber")) $("cafeApCafeNumber").value = cafe.cafe_number;
  if (cafe.menu_id && $("cafeApMenuId")) $("cafeApMenuId").value = cafe.menu_id;
  if (cafe.board_name && $("cafeApBoardName")) $("cafeApBoardName").value = cafe.board_name;
  // 카페 자동 운영 상태 복원
  if (cfg.cafe_autopilot && cfg.cafe_autopilot.active) {
    if ($("cafeApTheme")) $("cafeApTheme").value = cfg.cafe_autopilot.theme || "";
    if ($("cafeApCount")) {
      $("cafeApCount").value = cfg.cafe_autopilot.posts_per_day || 5;
      if ($("cafeApCountBadge")) $("cafeApCountBadge").textContent = cfg.cafe_autopilot.posts_per_day || 5;
    }
    if ($("startCafeApBtn")) $("startCafeApBtn").style.display = "none";
    if ($("stopCafeApBtn")) $("stopCafeApBtn").style.display = "";
  }
}

// 카페 subtype chip
let cafeSubtype = "info";
if ($("cafeSubtypeChips")) {
  $("cafeSubtypeChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    $("cafeSubtypeChips").querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    cafeSubtype = chip.dataset.value;
  });
}

// 카페 발행
if ($("runCafeBtn")) {
  $("runCafeBtn").addEventListener("click", async () => {
    if (!state.loggedIn) {
      alert("먼저 계정 패널에서 메이킷 로그인하세요");
      return;
    }
    if (state.user && state.user.trial) {
      const remaining = Math.max(0, state.user.trial_limit - state.user.trial_used);
      if (remaining <= 0) {
        showModal("체험 횟수 소진", "무료 체험 횟수가 모두 소진되었습니다.\n구독하면 무제한으로 이용할 수 있습니다.", "구독하기", () => bridge.openExternal("https://snsmakeit.com/pricing"));
        return;
      }
    }
    const cfg = (await bridge.loadConfig()) || {};
    const cafe = cfg.cafe || {};
    if (!cafe.cafe_number || !cafe.menu_id) return showModal("알림","카페 설정을 먼저 저장하세요","확인");
    const naverId = cfg.naver_id;
    if (!naverId) return showModal("알림","네이버 ID를 블로그 자동화에서 먼저 설정하세요","확인");
    const keyword = ($("cafeKeyword") && $("cafeKeyword").value.trim()) || "";
    if (!keyword) return showModal("알림","키워드를 입력하세요","확인");

    $("runCafeBtn").disabled = true;
    clearLog();
    addLog("[카페] 글 생성 + 발행 시작...");
    goToPanel("execlog");
    _deductTrial();

    // 글 생성 → 카페 발행
    const merged = {
      ...cfg,
      write: {
        keyword,
        extra: ($("cafeAnalysisExtra") && $("cafeAnalysisExtra").value.trim()) || ($("cafeExtra") && $("cafeExtra").value.trim()) || "",
        subtype: cafeSubtype,
        tone: "friendly",
        speech: "polite_yo",
        wordCount: "medium",
      },
      _cafe_mode: true,
    };
    // 카페 글감분석 선택 제목 저장
    const cafeSelectedTitle = document.querySelector("#cafeSuggestedTitles .suggest-title.selected");
    merged._selected_title = cafeSelectedTitle ? cafeSelectedTitle.dataset.title : "";
    await bridge.saveConfig(merged);
    const r = await bridge.runOnce(merged);

    $("runCafeBtn").disabled = false;
    const resultCard = $("cafeResultCard");
    const resultBody = $("cafeResultBody");
    if (resultCard) resultCard.style.display = "block";

    if (r.ok && r.result && r.result.status === "ok") {
      if (resultBody) resultBody.innerHTML = `<div class="result-success">카페 발행 성공</div><div style="margin-top:10px;font-size:13px;">${escapeHtml(r.result.title || "")}</div>${r.result.post_url ? `<a class="post-url" data-url="${escapeHtml(r.result.post_url)}">${escapeHtml(r.result.post_url)}</a>` : ""}`;
      addPublishHistory({ title: r.result.title, url: r.result.post_url, naver_id: naverId, type: "cafe" });
    } else {
      const err = (r.result && r.result.message) || r.error || "실패";
      if (resultBody) resultBody.innerHTML = `<div class="result-error">실패: ${escapeHtml(err)}</div>`;
      addPublishHistory({ title: "카페 발행 실패", error: err, naver_id: naverId, type: "cafe" });
    }
  });
}

// ── 초기 (UI 블로킹 최소화) ──
// 1단계: 동기 UI 즉시 렌더
renderSchedule();
renderPlanCard(null);
setUserBadge("로그인 필요", "gray");

// 2단계: config 로드 + UI 반영 (비동기, 빠름)
bridge.loadConfig().then(async cfg => {
  if (!cfg) return;

  // 설정 복원 (동기적 DOM 조작만)
  if (cfg.naver_id && $("naverId")) $("naverId").value = cfg.naver_id;
  if (cfg.write) {
    if (cfg.write.keyword && $("keyword")) $("keyword").value = cfg.write.keyword;
    if (cfg.write.target && $("target")) $("target").value = cfg.write.target;
    if (cfg.write.extra && $("extra")) $("extra").value = cfg.write.extra;
    if (cfg.write.naver_template && $("naverTemplate")) $("naverTemplate").value = cfg.write.naver_template;
    ["subtype", "tone", "speech", "wordCount"].forEach(k => {
      if (cfg.write[k]) {
        state[k] = cfg.write[k];
        const map = { subtype: "subtypeChips", tone: "toneChips", speech: "speechChips", wordCount: "wordCountChips" };
        const wrap = $(map[k]);
        if (wrap) wrap.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.value === cfg.write[k]));
      }
    });
  }
  if (cfg.schedule && Array.isArray(cfg.schedule.times)) {
    cfg.schedule.times.forEach(t => scheduleTimes.add(t));
    renderSchedule();
  }

  // 계정 리스트 자동 추가
  if (cfg.naver_id) {
    if (!Array.isArray(cfg.naver_accounts)) cfg.naver_accounts = [];
    if (!cfg.naver_accounts.includes(cfg.naver_id)) {
      cfg.naver_accounts.push(cfg.naver_id);
      bridge.saveConfig(cfg);
    }
  }

  renderNaverAccountList();
  loadCafeSettings();
  renderPresets();
  restoreAutopilotStatus();
  renderCalendar();
  renderDashboardAutopilot();

  // 자동 로그인 (즉시 UI 반영)
  if (cfg.makeit_access_token && cfg.makeit_email) {
    const nick = (cfg.makeit_email || "").split("@")[0];
    const cachedUsed = await bridge.getTrialUsed();
    _trialUsedCache = cachedUsed;
    state.loggedIn = true;
    state.user = { valid: true, email: cfg.makeit_email, nick, plan: cfg._cached_plan || "", trial: !cfg._cached_plan, trial_used: cachedUsed, trial_limit: 5 };
    setUserBadge(nick, "green");
    const loginCard = document.getElementById("loginCard");
    if (loginCard) loginCard.style.display = "none";
    renderPlanCard(state.user);
  } else if (cfg.makeit_email) {
    state.loggedIn = true;
    const loginCard = document.getElementById("loginCard");
    if (loginCard) loginCard.style.display = "none";
    setUserBadge("확인 중...", "gray");
  }

  // 3단계: verify는 완전 지연 (UI 렌더 후 3초 뒤)
  setTimeout(() => {
    if (cfg.makeit_access_token || cfg.makeit_email) {
      bridge.verifyAccount().then(r => {
        handleVerifyResult(r, cfg.makeit_email || "");
        if (r.ok && r.result) {
          bridge.loadConfig().then(c => {
            c = c || {};
            // 서버 값과 로컬 중 큰 값 유지
            const maxUsed = Math.max(_trialUsedCache, r.result.trial_used || 0);
            _setTrialUsed(maxUsed);
            c._cached_trial_used = maxUsed;
            c._cached_plan = r.result.plan || "";
            bridge.saveConfig(c);
          });
        }
      });
    }
  }, 3000);
});
