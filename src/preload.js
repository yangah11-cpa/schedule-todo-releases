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
  push: { init: call('push:init'), notify: call('push:notify') },
  drive: { save: call('drive:save'), load: call('drive:load') },
  team: { open: call('team:open') },
  phone: { messages: call('phone:messages'), thread: call('phone:thread') },
  clip: { onPick: (cb) => ipcRenderer.on('clip:pick', (_e, d) => cb(d)) },
  outlook: { read: call('outlook:read'), selected: call('outlook:selected'), open: call('outlook:open'), onPick: (cb) => ipcRenderer.on('outlook:pick', () => cb()) },
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
    get: call('g:get'),
    insert: call('g:insert'),
    patch: call('g:patch'),
    remove: call('g:delete'),
    taskList: call('t:list'),
    taskInsert: call('t:insert'),
    taskPatch: call('t:patch'),
    taskDelete: call('t:delete'),
  },
});
