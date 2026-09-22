'use strict';
/** The launcher page's only door to the main process: window.launcher. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('launcher', {
  snapshot: () => ipcRenderer.invoke('launcher:snapshot'),
  play: buildId => ipcRenderer.invoke('launcher:play', { buildId }),
  check: () => ipcRenderer.invoke('launcher:check'),
  downloadGame: () => ipcRenderer.invoke('launcher:downloadGame'),
  cancelDownload: () => ipcRenderer.invoke('launcher:cancelDownload'),
  installLauncherUpdate: () => ipcRenderer.invoke('launcher:installLauncherUpdate'),
  setSetting: (key, value) => ipcRenderer.invoke('launcher:setSetting', key, value),
  setUpdateSource: text => ipcRenderer.invoke('launcher:setUpdateSource', text),
  /** @param {File} file a File from a drop event */
  installFile: file => ipcRenderer.invoke('launcher:installFile', webUtils.getPathForFile(file)),
  pickFile: () => ipcRenderer.invoke('launcher:pickFile'),
  removeBuild: id => ipcRenderer.invoke('launcher:removeBuild', id),
  openDataFolder: () => ipcRenderer.invoke('launcher:openDataFolder'),
  openLink: url => ipcRenderer.invoke('launcher:openLink', url),
  onUpdateState: cb => subscribe('update:state', cb),
  onSnapshot: cb => subscribe('launcher:snapshot', cb),
});
