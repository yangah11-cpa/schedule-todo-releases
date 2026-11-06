const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  load: call('data:load'),
  save: call('data:save'),
  exportData: call('data:export'),
  importData: call('data:import'),
  openExternal: call('app:openExternal'),
  version: call('app:version'),
  info: call('app:info'),
  focus: call('app:focus'),
  prefs: { get: call('prefs:get'), set: call('prefs:set') },
  patch: {
    state: call('patch:state'),
    apply: call('patch:apply'),
    onReady: (cb) => ipcRenderer.on('patch:ready', (_e, v) => cb(v)),
  },
  update: {
    state: call('update:state'),
    check: call('update:check'),
    install: call('update:install'),
    onState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb(s)),
  },
  google: {
    status: call('g:status'),
    setClient: call('g:setClient'),
    connect: call('g:connect'),
    disconnect: call('g:disconnect'),
    calendars: call('g:calendars'),
    events: call('g:events'),
    insert: call('g:insert'),
    patch: call('g:patch'),
    remove: call('g:delete'),
  },
});
