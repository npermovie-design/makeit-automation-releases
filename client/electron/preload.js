// Electron preload - 안전한 IPC 브릿지
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nbBridge", {
  // 설정
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (cfg) => ipcRenderer.invoke("config:save", cfg),

  // 비밀번호 (service: NaverBotSaaS | NaverBotSaaS_Makeit)
  savePassword: (username, password, service) =>
    ipcRenderer.invoke("password:save", { username, password, service }),

  // 메이킷 계정 검증
  verifyAccount: () => ipcRenderer.invoke("account:verify"),

  // 네이버 세션 저장 (first_login)
  naverFirstLogin: (naverId) => ipcRenderer.invoke("naver:firstLogin", naverId),

  // 키워드 글감 분석
  analyzeKeyword: (keyword) => ipcRenderer.invoke("keyword:analyze", keyword),

  // 봇 실행
  runOnce: (overrides) => ipcRenderer.invoke("bot:runOnce", overrides),
  stopBot: () => ipcRenderer.invoke("bot:stop"),
  onLog: (cb) => {
    ipcRenderer.on("bot:log", (_, text) => cb(text));
  },

  // 체험 횟수 (별도 파일로 저장 — 경쟁 상태 없음)
  getTrialUsed: () => ipcRenderer.invoke("trial:get"),
  setTrialUsed: (n) => ipcRenderer.invoke("trial:set", n),

  // 외부 링크
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  // 스케줄 (Windows Task Scheduler)
  createSchedule: (times) => ipcRenderer.invoke("schedule:create", { times }),
  listSchedule: () => ipcRenderer.invoke("schedule:list"),
  clearSchedule: () => ipcRenderer.invoke("schedule:clear"),

  // Custom protocol 콜백 (브라우저 로그인 완료 시 호출됨)
  onAuthCallback: (cb) => {
    ipcRenderer.on("auth:callback", (_, params) => cb(params));
  },

  // 내부 로그인 창 열기
  openLoginWindow: () => ipcRenderer.invoke("auth:openLoginWindow"),
});
