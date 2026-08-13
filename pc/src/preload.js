const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    delete: (key) => ipcRenderer.invoke('store:delete', key)
  },
  window: {
    setAlwaysOnTop: (value) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
    getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
    refocus: () => ipcRenderer.invoke('window:refocus')
  },
  app: {
    importData: () => ipcRenderer.invoke('app:import'),
    pickJsonFile: () => ipcRenderer.invoke('app:pickJsonFile')
  },
  feedback: (msg) => ipcRenderer.invoke('app:feedback', msg),
  // 🖥 배치 총폭(CSS px)을 알려주면 main 이 창 폭에 맞춰 앱 전체를 확대/축소 → 어느 모니터든 같은 화면
  //    minW(최소 배치폭) = 확대 상한 계산용 — 모든 패널이 min-width에 닿는 지점 이상으론 못 키움
  zoomFit: (layoutW, minW, keepZoom) => ipcRenderer.invoke('zoom:fit', layoutW, minW, keepZoom),
  dialer: {
    loadIp: () => ipcRenderer.invoke('dialer:loadIp'),
    autostartIp: () => ipcRenderer.invoke('dialer:autostartIp'),
    lastGoodIp: () => ipcRenderer.invoke('dialer:lastGoodIp'),
    saveIp: (ip) => ipcRenderer.invoke('dialer:saveIp', ip),
    connect: (ip) => ipcRenderer.invoke('dialer:connect', ip),
    reconnect: (ip) => ipcRenderer.invoke('dialer:reconnect', ip),
    autoFind: () => ipcRenderer.invoke('dialer:autoFind'),
    devices: () => ipcRenderer.invoke('dialer:devices'),
    dial: (number) => ipcRenderer.invoke('dialer:dial', number),
    smsCompose: (number, body) => ipcRenderer.invoke('dialer:smsCompose', number, body),
    pickImage: () => ipcRenderer.invoke('dialer:pickImage'),
    mmsCompose: (number, body, paths) => ipcRenderer.invoke('dialer:mmsCompose', number, body, paths),
    endCall: () => ipcRenderer.invoke('dialer:endCall'),
    callState: () => ipcRenderer.invoke('dialer:callState'),
    callInfo: () => ipcRenderer.invoke('dialer:callInfo'),
    lastCall: () => ipcRenderer.invoke('dialer:lastCall'),
    activeCall: () => ipcRenderer.invoke('dialer:activeCall'),
    answerCall: () => ipcRenderer.invoke('dialer:answerCall'),
    blockedNumbers: () => ipcRenderer.invoke('dialer:blockedNumbers'),
    addBlockedContact: (number) => ipcRenderer.invoke('dialer:addBlockedContact', number),
    callLogList: (limit) => ipcRenderer.invoke('dialer:callLogList', limit),
    smsFor: (number) => ipcRenderer.invoke('dialer:smsFor', number),
    recordingsFor: (number) => ipcRenderer.invoke('dialer:recordingsFor', number),
    pullRecording: (remote, name) => ipcRenderer.invoke('dialer:pullRecording', remote, name),
    pullEvidence: (remote, name) => ipcRenderer.invoke('dialer:pullEvidence', remote, name),   // 🆕 P2) 증빙 녹음 영구 보관

    openPath: (p) => ipcRenderer.invoke('dialer:openPath', p),
    getBlocklist: () => ipcRenderer.invoke('dialer:getBlocklist'),
    addBlocked: (number) => ipcRenderer.invoke('dialer:addBlocked', number),
    addBlockedBulk: (numbers) => ipcRenderer.invoke('dialer:addBlockedBulk', numbers),
    removeBlocked: (number) => ipcRenderer.invoke('dialer:removeBlocked', number),
    setSerial: (s) => ipcRenderer.invoke('dialer:setSerial', s),
    getQueue: () => ipcRenderer.invoke('dialer:getQueue'),
    setQueue: (q) => ipcRenderer.invoke('dialer:setQueue', q),
    getRecords: () => ipcRenderer.invoke('dialer:getRecords'),
    setRecords: (r) => ipcRenderer.invoke('dialer:setRecords', r),
    getSettings: () => ipcRenderer.invoke('dialer:getSettings'),
    setSettings: (s) => ipcRenderer.invoke('dialer:setSettings', s)
  },
  // 배분 CRM Phase2: 서버 배정 고객 가져오기(토큰은 main에만 있고 여기로 안 넘어옴)
  crm: {
    me: () => ipcRenderer.invoke('crm:me'),
    assigned: () => ipcRenderer.invoke('crm:assigned'),
    upload: (items) => ipcRenderer.invoke('crm:upload', items)
  },
  on: (channel, callback) => {
    const valid = ['hotkey:focus-search', 'data:imported', 'menu:action'];
    if (valid.includes(channel)) ipcRenderer.on(channel, (e, ...args) => callback(...args));
  }
});
