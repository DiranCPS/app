const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

function createWindow() {
  const appPagePath = path.resolve(__dirname, "..", "dist", "index.html");
  const appPageUrl = pathToFileURL(appPagePath);
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#111713",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      event.preventDefault();
      void shell.openExternal(url);
      return;
    }
    try {
      if (fileURLToPath(new URL(url)) !== fileURLToPath(appPageUrl)) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  void window.loadFile(appPagePath);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
