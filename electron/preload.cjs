const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prismDesktop", {
  getMinecraftVersions: () => ipcRenderer.invoke("minecraft:list-versions"),
  readMinecraftJar: (version) => ipcRenderer.invoke("minecraft:read-version", version),
});
