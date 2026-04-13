// NaverBot Electron - main process
// - BrowserWindow 생성
// - 설정 저장/로드
// - Python runner.py 서브프로세스 실행
// - Custom protocol makeit-sns:// 핸들링 (브라우저 OAuth 콜백)

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const http = require("http");
const urlLib = require("url");

// ── Custom protocol 등록 ──
const PROTOCOL = "makeit-sns";
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// ── Single instance ── (protocol deep link 처리)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── 설정 파일 경로 (%APPDATA%\NaverBotSaaS\config.json) ──
const CONFIG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "NaverBotSaaS"
);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  try {
    ensureConfigDir();
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error("config load:", e);
    return null;
  }
}

function saveConfig(cfg) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

// ── Python 경로 ──
function getPythonRuntimeDir() {
  // 패키징 여부와 무관하게 우선순위:
  // 1) packaged: resources/python-runtime/
  // 2) dev: client/electron/python-runtime/ (로컬 번들 테스트)
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, "python-runtime");
    if (fs.existsSync(p)) return p;
  }
  const dev = path.join(__dirname, "python-runtime");
  if (fs.existsSync(dev)) return dev;
  return null;
}

function getPythonPath() {
  const runtime = getPythonRuntimeDir();
  if (runtime) {
    const winPath = path.join(runtime, "python.exe");
    if (fs.existsSync(winPath)) return winPath;
    const macPath = path.join(runtime, "bin", "python3");
    if (fs.existsSync(macPath)) return macPath;
  }
  // 시스템 폴백: Mac은 python3
  return process.platform === "darwin" ? "python3" : "python";
}

function getPlaywrightBrowsersPath() {
  const runtime = getPythonRuntimeDir();
  if (runtime) return path.join(runtime, ".playwright-browsers");
  return null;
}

function getRunnerPath() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "python", "runner.py");
    if (fs.existsSync(bundled)) return bundled;
  }
  return path.join(__dirname, "..", "python", "runner.py");
}

function getPythonEnv() {
  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  const browsers = getPlaywrightBrowsersPath();
  if (browsers) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  // Python embeddable 호환: runner.py 폴더를 sys.path에 추가
  const runnerDir = path.dirname(getRunnerPath());
  env.PYTHONPATH = runnerDir;
  return env;
}

// ── Window ──
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "메이킷 SNS 자동화",
    backgroundColor: "#0f1116",
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // mainWindow.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 초기 실행 시 process.argv에 protocol URL이 있으면 처리
  handleProtocolArgs(process.argv);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── Protocol URL 파싱 + 렌더러에 전달 ──
function parseProtocolUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== `${PROTOCOL}:`) return null;
    const params = {};
    u.searchParams.forEach((v, k) => (params[k] = v));
    return params;
  } catch {
    return null;
  }
}

function handleAuthCallback(params) {
  if (!params) return;
  // URL params에 email/uid가 없으면 access_token JWT 디코드로 추출
  if (params.access_token && (!params.email || !params.uid)) {
    try {
      const parts = params.access_token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
        if (!params.email) params.email = payload.email || "";
        if (!params.uid) params.uid = payload.sub || "";
      }
    } catch (e) {
      console.error("[auth] JWT decode 실패:", e);
    }
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("auth:callback", params);
  }
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.close();
  }
}

function handleProtocolArgs(argv) {
  const url = (argv || []).find((a) => typeof a === "string" && a.startsWith(`${PROTOCOL}://`));
  if (url) handleAuthCallback(parseProtocolUrl(url));
}

app.on("second-instance", (event, argv) => {
  // Windows: protocol 클릭 시 두 번째 인스턴스가 argv에 URL 갖고 시작됨
  handleProtocolArgs(argv);
});

app.on("open-url", (event, url) => {
  // macOS
  event.preventDefault();
  handleAuthCallback(parseProtocolUrl(url));
});

// ── IPC: 체험 횟수 (별도 파일) ──
const TRIAL_PATH = path.join(CONFIG_DIR, "trial_used.txt");
ipcMain.handle("trial:get", () => {
  try {
    if (fs.existsSync(TRIAL_PATH)) return parseInt(fs.readFileSync(TRIAL_PATH, "utf8").trim()) || 0;
  } catch {}
  return 0;
});
ipcMain.handle("trial:set", (_, n) => {
  try {
    ensureConfigDir();
    fs.writeFileSync(TRIAL_PATH, String(n), "utf8");
  } catch {}
});

// ── IPC: 설정 ──
ipcMain.handle("config:load", () => loadConfig());
ipcMain.handle("config:save", (_, cfg) => {
  saveConfig(cfg);
  return { ok: true };
});

// ── IPC: 비밀번호 저장 (keyring via python subprocess) ──
// service 파라미터로 네이버/메이킷 계정 구분
ipcMain.handle("password:save", async (_, { username, password, service }) => {
  const svc = service || "NaverBotSaaS";
  return new Promise((resolve) => {
    const py = spawn(getPythonPath(), ["-c",
      `import keyring, sys; keyring.set_password(sys.argv[1], sys.argv[2], sys.argv[3]); print('ok')`,
      svc, username, password,
    ], { env: getPythonEnv() });
    let out = "";
    let err = "";
    py.stdout.on("data", (d) => (out += d));
    py.stderr.on("data", (d) => (err += d));
    py.on("close", (code) => {
      resolve({ ok: code === 0 && out.trim() === "ok", error: err });
    });
  });
});

// ── IPC: 키워드 글감 분석 (runner.py analyze subprocess) ──
ipcMain.handle("keyword:analyze", async (_, keyword) => {
  if (!keyword) return { ok: false, error: "키워드 없음" };
  return new Promise((resolve) => {
    const py = spawn(getPythonPath(), [getRunnerPath(), "analyze", keyword], {
      cwd: path.dirname(getRunnerPath()),
      env: getPythonEnv(),
    });
    const chunks = [];
    py.stdout.on("data", (d) => chunks.push(d.toString("utf-8")));
    py.stderr.on("data", (d) => {
      if (mainWindow) mainWindow.webContents.send("bot:log", `[분석] ${d.toString("utf-8")}`);
    });
    py.on("close", (code) => {
      let parsed = null;
      try {
        const lines = chunks.join("").trim().split("\n").filter(Boolean);
        parsed = JSON.parse(lines[lines.length - 1]);
      } catch {}
      resolve({ ok: !!parsed, result: parsed, error: parsed ? "" : "분석 결과 파싱 실패" });
    });
    py.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
});

// ── IPC: 네이버 세션 저장 (first_login.py subprocess) ──
ipcMain.handle("naver:firstLogin", async (_, naverId) => {
  if (!naverId) return { ok: false, error: "네이버 ID 없음" };
  const firstLoginPath = app.isPackaged
    ? path.join(process.resourcesPath, "python", "first_login.py")
    : path.join(__dirname, "..", "python", "first_login.py");
  return new Promise((resolve) => {
    const py = spawn(getPythonPath(), [firstLoginPath, naverId], {
      cwd: path.dirname(firstLoginPath),
      env: getPythonEnv(),
    });
    let out = "";
    py.stdout.on("data", (d) => {
      const text = d.toString("utf-8");
      out += text;
      if (mainWindow) mainWindow.webContents.send("bot:log", text);
    });
    py.stderr.on("data", (d) => {
      if (mainWindow) mainWindow.webContents.send("bot:log", `[ERR] ${d.toString("utf-8")}`);
    });
    py.on("close", (code) => {
      const success = out.includes("세션 저장 완료");
      resolve({ ok: success, error: success ? "" : "로그인 미완료 또는 타임아웃" });
    });
    py.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
});

// ── IPC: 메이킷 계정 검증 (runner.py verify 호출) ──
ipcMain.handle("account:verify", async () => {
  return new Promise((resolve) => {
    const py = spawn(getPythonPath(), [getRunnerPath(), "verify"], {
      cwd: path.dirname(getRunnerPath()),
      env: getPythonEnv(),
    });
    const chunks = [];
    py.stdout.on("data", (d) => chunks.push(d.toString("utf-8")));
    py.on("close", (code) => {
      let parsed = null;
      try {
        const lines = chunks.join("").trim().split("\n").filter(Boolean);
        parsed = JSON.parse(lines[lines.length - 1]);
      } catch {}
      resolve({ ok: code === 0, result: parsed });
    });
    py.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
});

// ── IPC: 봇 실행 (runner.py subprocess) ──
let currentProcess = null;

ipcMain.handle("bot:runOnce", async (event, overrides = {}) => {
  if (currentProcess) {
    return { ok: false, error: "이미 실행 중입니다" };
  }

  // config 병합 (UI에서 override 받을 수 있음)
  const cfg = loadConfig() || {};
  const merged = { ...cfg, ...overrides };
  saveConfig(merged); // 최신 설정 저장

  const pythonPath = getPythonPath();
  const runnerPath = getRunnerPath();

  return new Promise((resolve) => {
    const py = spawn(pythonPath, [runnerPath, "run-once"], {
      cwd: path.dirname(runnerPath),
      env: getPythonEnv(),
    });
    currentProcess = py;

    const chunks = [];
    py.stdout.on("data", (d) => {
      const text = d.toString("utf-8");
      chunks.push(text);
      if (mainWindow) mainWindow.webContents.send("bot:log", text);
    });
    py.stderr.on("data", (d) => {
      const text = d.toString("utf-8");
      if (mainWindow) mainWindow.webContents.send("bot:log", `[ERR] ${text}`);
    });

    py.on("close", (code) => {
      currentProcess = null;
      const fullOut = chunks.join("");
      let parsed = null;
      try {
        // stdout 마지막 JSON 라인 파싱
        const lines = fullOut.trim().split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i]);
            break;
          } catch {}
        }
      } catch {}
      resolve({
        ok: code === 0,
        exit_code: code,
        result: parsed,
        raw: fullOut,
      });
    });

    py.on("error", (e) => {
      currentProcess = null;
      resolve({ ok: false, error: `Python 실행 실패: ${e.message}` });
    });
  });
});

ipcMain.handle("bot:stop", () => {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    return { ok: true };
  }
  return { ok: false, error: "실행 중인 봇 없음" };
});

// ── IPC: 외부 링크 ──
ipcMain.handle("shell:openExternal", (_, url) => shell.openExternal(url));

// ── 로그인 창 (인앱 login.html — 이메일/Google) ──
let authWindow = null;

function openLoginWindow() {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    return;
  }
  authWindow = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: false,
    title: "메이킷 로그인",
    backgroundColor: "#fafafa",
    webPreferences: {
      preload: path.join(__dirname, "auth-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  authWindow.setMenuBarVisibility(false);
  authWindow.loadFile(path.join(__dirname, "renderer", "login.html"));
  authWindow.on("closed", () => { authWindow = null; });
}

ipcMain.handle("auth:openLoginWindow", () => {
  openLoginWindow();
  return { ok: true };
});

// 로그인 창에서 sendResult → 메인 창에 forward
ipcMain.on("auth:result", (_, result) => {
  if (mainWindow) {
    mainWindow.webContents.send("auth:callback", result);
    mainWindow.focus();
  }
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.close();
  }
});

// ── Google OAuth via 로컬 HTTP 서버 (Loopback IP address flow) ──
// 표준 OAuth desktop 플로우: app → localhost HTTP server → browser → supabase → localhost callback
const AUTH_PORT = 54321;
let authHttpServer = null;

function closeAuthHttpServer() {
  if (authHttpServer) {
    try { authHttpServer.close(); } catch {}
    authHttpServer = null;
  }
}

function startAuthHttpServer() {
  return new Promise((resolve, reject) => {
    if (authHttpServer) return resolve(AUTH_PORT);

    const server = http.createServer((req, res) => {
      const parsed = urlLib.parse(req.url || "", true);

      if (parsed.pathname === "/callback") {
        // 브라우저가 redirect 후 도달 — 토큰은 URL fragment(#)에 있음 → JS로 추출 후 POST
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>메이킷 로그인 완료</title>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,BlinkMacSystemFont,"Pretendard","Segoe UI","Malgun Gothic",sans-serif;
  background:#fafafa; display:flex; align-items:center; justify-content:center;
  min-height:100vh; padding:20px; -webkit-font-smoothing:antialiased; }
.card { max-width:420px; width:100%; padding:40px 32px; background:#fff;
  border-radius:18px; box-shadow:0 4px 24px rgba(0,0,0,.06); text-align:center; border:1px solid #f0f1f4; }
.check { width:64px; height:64px; border-radius:50%; background:#d1fae5; color:#10b981;
  display:flex; align-items:center; justify-content:center; font-size:32px; margin:0 auto 16px; }
h1 { font-size:20px; font-weight:700; margin-bottom:8px; color:#111827; }
p { color:#6b7280; font-size:13px; line-height:1.6; }
.err { color:#b91c1c; }
</style></head><body>
<div class="card" id="card">
  <h1>로그인 처리 중...</h1>
  <p>잠시만 기다려주세요</p>
</div>
<script>
(async () => {
  try {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token") || "";
    const expires_at = params.get("expires_at") || "";

    if (!access_token) {
      const q = new URLSearchParams(window.location.search);
      const err = q.get("error_description") || q.get("error") || "토큰 없음";
      document.getElementById("card").innerHTML =
        '<h1 class="err">로그인 실패</h1><p>' + err + '</p>';
      return;
    }

    const resp = await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token, refresh_token, expires_at }),
    });

    if (resp.ok) {
      document.getElementById("card").innerHTML =
        '<div class="check">&#10003;</div>' +
        '<h1>로그인 완료!</h1>' +
        '<p>앱으로 돌아가세요.<br>이 창은 닫아도 됩니다.</p>';
    } else {
      document.getElementById("card").innerHTML =
        '<h1 class="err">서버 오류</h1><p>' + resp.status + '</p>';
    }
  } catch (e) {
    document.getElementById("card").innerHTML =
      '<h1 class="err">오류</h1><p>' + (e.message || e) + '</p>';
  }
})();
</script></body></html>`);
        return;
      }

      if (parsed.pathname === "/token" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            // JWT 디코드 해서 email/uid 추출
            let email = "", uid = "";
            try {
              const payload = JSON.parse(
                Buffer.from(data.access_token.split(".")[1], "base64").toString("utf8")
              );
              email = payload.email || "";
              uid = payload.sub || "";
            } catch {}

            if (mainWindow) {
              mainWindow.webContents.send("auth:callback", {
                access_token: data.access_token,
                refresh_token: data.refresh_token || "",
                email,
                uid,
                expires_at: data.expires_at || 0,
              });
              mainWindow.focus();
            }
            if (authWindow && !authWindow.isDestroyed()) authWindow.close();

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));

            // 2초 후 서버 종료
            setTimeout(closeAuthHttpServer, 2000);
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    server.listen(AUTH_PORT, "127.0.0.1", () => {
      authHttpServer = server;
      resolve(AUTH_PORT);
    });
    server.on("error", (e) => {
      // 포트 점유 등 — 이미 서버 있으면 무시
      if (e.code === "EADDRINUSE") resolve(AUTH_PORT);
      else reject(e);
    });
  });
}

// Google OAuth: snsmakeit.com 콜백 페이지 경유 (이미 Supabase에 허용된 도메인)
// 콜백 페이지의 스크립트가 토큰을 추출해서 makeit-sns:// 프로토콜로 앱 호출
ipcMain.on("auth:google", () => {
  const SUPABASE_URL = "https://ckzjnpzadeovrasucjmu.supabase.co";
  const redirectTo = "https://snsmakeit.com/naverbot-callback";
  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
  shell.openExternal(authUrl);
});

ipcMain.on("auth:openExternal", (_, url) => shell.openExternal(url));

// ── IPC: Windows Task Scheduler 통합 ──
// schtasks.exe로 매일 N시 자동 실행 등록
const TASK_NAME_PREFIX = "NaverBot_";

function runSchtasks(args) {
  return new Promise((resolve) => {
    const p = spawn("schtasks.exe", args, { windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, err: e.message }));
  });
}

ipcMain.handle("schedule:create", async (_, { times }) => {
  // times: ["09:00", "14:00", ...]
  // 각 시간마다 별도 task 생성
  if (!Array.isArray(times) || times.length === 0) {
    return { ok: false, error: "시간 리스트 필요" };
  }

  // runner.exe 또는 "python runner.py" 명령
  const pythonPath = getPythonPath();
  const runnerPath = getRunnerPath();
  const command = `"${pythonPath}" "${runnerPath}" run-once`;

  const results = [];
  for (let i = 0; i < times.length; i++) {
    const taskName = `${TASK_NAME_PREFIX}${i + 1}`;
    // 기존 task 있으면 제거
    await runSchtasks(["/Delete", "/TN", taskName, "/F"]);
    // 새로 생성
    const r = await runSchtasks([
      "/Create",
      "/TN", taskName,
      "/TR", command,
      "/SC", "DAILY",
      "/ST", times[i],
      "/F",
    ]);
    results.push({ time: times[i], ok: r.code === 0, message: r.out || r.err });
  }
  return { ok: results.every((r) => r.ok), results };
});

ipcMain.handle("schedule:list", async () => {
  const r = await runSchtasks(["/Query", "/FO", "CSV", "/NH"]);
  if (r.code !== 0) return { ok: false, tasks: [] };
  const tasks = r.out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(TASK_NAME_PREFIX))
    .map((line) => {
      const parts = line.replace(/"/g, "").split(",");
      return { name: parts[0], next_run: parts[1], status: parts[2] };
    });
  return { ok: true, tasks };
});

ipcMain.handle("schedule:clear", async () => {
  // 모든 NaverBot_* task 삭제
  const listR = await runSchtasks(["/Query", "/FO", "CSV", "/NH"]);
  const tasks = listR.out
    .split("\n")
    .map((l) => l.replace(/"/g, "").split(",")[0]?.trim())
    .filter((name) => name && name.startsWith(TASK_NAME_PREFIX));

  for (const name of tasks) {
    await runSchtasks(["/Delete", "/TN", name, "/F"]);
  }
  return { ok: true, deleted: tasks.length };
});
