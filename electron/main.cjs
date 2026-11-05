const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

function getMinecraftDirectories() {
  const home = app.getPath("home");
  if (process.platform === "win32") {
    return [path.join(process.env.APPDATA || app.getPath("appData"), ".minecraft")];
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "minecraft")];
  }
  return [path.join(home, ".minecraft")];
}

async function findMinecraftJars() {
  const jars = [];
  for (const root of getMinecraftDirectories()) {
    const versionsPath = path.join(root, "versions");
    let entries;
    try {
      entries = await fs.readdir(versionsPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[\w.-]+$/.test(entry.name)) continue;
      const jarPath = path.join(versionsPath, entry.name, `${entry.name}.jar`);
      try {
        if ((await fs.stat(jarPath)).isFile()) jars.push(entry.name);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return [...new Set(jars)].sort((left, right) => {
    const a = left.split(/[.-]/).map((part) => Number(part) || 0);
    const b = right.split(/[.-]/).map((part) => Number(part) || 0);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (b[index] ?? 0) - (a[index] ?? 0);
      if (difference) return difference;
    }
    return left.localeCompare(right);
  });
}

ipcMain.handle("minecraft:list-versions", () => findMinecraftJars());
ipcMain.handle("minecraft:read-version", async (_event, version) => {
  if (typeof version !== "string" || !/^[\w.-]+$/.test(version)) {
    throw new Error("Minecraft 버전 이름이 올바르지 않아요.");
  }
  const versions = await findMinecraftJars();
  if (!versions.includes(version)) {
    throw new Error(`Minecraft ${version} JAR 파일을 찾지 못했어요.`);
  }
  for (const root of getMinecraftDirectories()) {
    const jarPath = path.join(root, "versions", version, `${version}.jar`);
    try {
      const file = await fs.readFile(jarPath);
      const buffer = new ArrayBuffer(file.byteLength);
      new Uint8Array(buffer).set(file);
      return buffer;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Minecraft ${version} JAR 파일을 읽지 못했어요.`);
});

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
      preload: path.join(__dirname, "preload.cjs"),
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
