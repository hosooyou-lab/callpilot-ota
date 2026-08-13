const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lic', {
  machineId: () => ipcRenderer.invoke('license:machineId'),
  activate: (authKey) => ipcRenderer.invoke('license:activate', authKey),
  quit: () => ipcRenderer.invoke('license:quit'),
  requestActivation: () => ipcRenderer.invoke('license:requestActivation'),
  pollActivation: () => ipcRenderer.invoke('license:pollActivation'),
});
