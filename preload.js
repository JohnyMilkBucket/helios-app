const { contextBridge, ipcRenderer } = require('electron')

// Expose safe IPC bridge to renderer
contextBridge.exposeInMainWorld('helios', {
  // Window controls
  minimize:          ()      => ipcRenderer.send('window-minimize'),
  close:             ()      => ipcRenderer.send('window-close'),
  hide:              ()      => ipcRenderer.send('window-hide'),
  maximizeToggle:    ()      => ipcRenderer.send('window-maximize-toggle'),
  isMaximized:       ()      => ipcRenderer.invoke('window-is-maximized'),

  // Overlay controls
  setAlwaysOnTop:   (flag)   => ipcRenderer.send('toggle-always-on-top', flag),
  setOpacity:       (val)    => ipcRenderer.send('set-opacity', val),
  setClickThrough:  (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),

  // Medical / Comms pop-out panels
  openPopout:       (panel)  => ipcRenderer.invoke('open-popout', panel),
  closePopout:      (panel)  => ipcRenderer.send('close-popout', panel),
  onPopoutClosed:   (cb)     => ipcRenderer.on('popout-closed', (_e, panel) => cb(panel)),

  // Clipboard
  copyText:         (text)    => ipcRenderer.send('copy-text', text),

  // Auto-update
  checkForUpdates:  ()       => ipcRenderer.send('check-for-updates'),
  quitAndInstall:   ()       => ipcRenderer.send('quit-and-install'),
  onUpdateStatus:   (cb)     => ipcRenderer.on('update-status', (_e, status) => cb(status)),
  getAppVersion:    ()       => ipcRenderer.invoke('get-app-version'),
})
