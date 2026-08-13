const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('crmAuth', {
  login: (loginId, password, remember) => ipcRenderer.invoke('crmlogin:submit', loginId, password, remember),
  quit: () => ipcRenderer.invoke('crmlogin:quit'),
  onNotice: (cb) => ipcRenderer.on('crmlogin:notice', (e, msg) => cb(msg)),
  onPrefill: (cb) => ipcRenderer.on('crmlogin:prefill', (e, id) => cb(id))
});
