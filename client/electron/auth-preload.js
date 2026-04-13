// 로그인 창 전용 preload
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("authBridge", {
  sendResult: (result) => ipcRenderer.send("auth:result", result),
  openGoogleOAuth: () => ipcRenderer.send("auth:google"),
  openExternal: (url) => ipcRenderer.send("auth:openExternal", url),
});
