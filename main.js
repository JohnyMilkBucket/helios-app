const { app, BrowserWindow, ipcMain, screen, session } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')

let mainWindow
// panel ('medical' | 'comms') -> its own floating overlay BrowserWindow.
// These are the only windows that keep the old transparent/always-on-top
// overlay behavior — the main window is now a normal app window.
const popouts = {}

const POPOUT_SIZE = {
  medical: { width: 420, height: 600 },
  comms:   { width: 400, height: 560 },
}

// Explicitly grant mic access instead of relying on Electron's undocumented
// per-platform default. Without this, getUserMedia({audio:true}) can resolve
// "successfully" with a real-looking stream even when access is actually
// blocked (OS-level or otherwise) — it just silently produces a track of
// zeros instead of throwing, so the app never even shows an error.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'media')
})

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    x: Math.floor((width - 1440) / 2),
    y: Math.floor((height - 900) / 2),

    // Normal app window — no longer a transparent always-on-top overlay.
    // Keeps the custom (frameless) titlebar look since the renderer already
    // draws its own title bar and window controls.
    frame: false,
    resizable: true,
    minWidth: 900,
    minHeight: 600,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.setMenuBarVisibility(false)

  // frame:false hides the native menu bar, which is where the default
  // DevTools shortcut normally lives — bind F12 explicitly so there's always
  // a guaranteed way to actually see console errors, in dev AND packaged
  // builds (this is not gated behind app.isPackaged on purpose).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // Don't leave orphaned floating panels behind once the main app closes.
    for (const win of Object.values(popouts)) win?.close()
  })
}

function openPopoutWindow(panel) {
  const existing = popouts[panel]
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const size = POPOUT_SIZE[panel] || { width: 400, height: 560 }

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: width - size.width - 40,
    y: 80,

    // These ARE the overlay windows now — transparent, frameless, always on
    // top of the game, no taskbar entry.
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: true,
    minWidth: 260,
    minHeight: 320,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { search: `popout=${panel}` })
  win.setMenuBarVisibility(false)

  popouts[panel] = win
  win.on('closed', () => {
    delete popouts[panel]
    mainWindow?.webContents.send('popout-closed', panel)
  })
}

// ── AUTO-UPDATE ───────────────────────────────────────────────────────────────
// Whenever a new build is published to GitHub Releases (`npm run release`),
// every installed copy picks it up on its own — no manual redistribution.
// Only meaningful in a packaged install; `npm start` always runs the local
// source, so autoUpdater is skipped entirely in dev.
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = false

function sendUpdateStatus(status) {
  mainWindow?.webContents.send('update-status', status)
}

autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'available', version: info.version }))
autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'not-available' }))
autoUpdater.on('error', (err) => sendUpdateStatus({ state: 'error', message: String(err?.message || err) }))
autoUpdater.on('download-progress', (p) => sendUpdateStatus({ state: 'downloading', percent: Math.round(p.percent) }))
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'downloaded', version: info.version }))

function checkForUpdates() {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch((err) => sendUpdateStatus({ state: 'error', message: String(err?.message || err) }))
}

app.whenReady().then(createWindow)
app.whenReady().then(() => {
  checkForUpdates()
  // Re-check periodically in case someone leaves the app open for hours —
  // not just on launch.
  setInterval(checkForUpdates, 30 * 60 * 1000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ── IPC HANDLERS ─────────────────────────────────────────────────────────────
// Resolved from whichever window's renderer actually sent the message, not a
// hardcoded reference to mainWindow — otherwise a popout's window controls
// (close, drag, opacity...) would incorrectly act on the main window instead
// of themselves, since both windows share the same preload API.
function senderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

// Window controls
ipcMain.on('window-minimize', (e) => senderWindow(e)?.minimize())
ipcMain.on('window-close',    (e) => senderWindow(e)?.close())
ipcMain.on('window-hide',     (e) => senderWindow(e)?.hide())

// Toggle always-on-top
ipcMain.on('toggle-always-on-top', (e, flag) => {
  senderWindow(e)?.setAlwaysOnTop(flag, 'screen-saver')
})

// Drag window (called from renderer titlebar drag)
ipcMain.on('window-drag-start', () => {
  // Electron handles drag via -webkit-app-region: drag in CSS
})

// Get window state
ipcMain.handle('window-is-maximized', (e) => senderWindow(e)?.isMaximized() ?? false)
ipcMain.on('window-maximize-toggle', (e) => {
  const w = senderWindow(e)
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
})

// Opacity control (0.1 - 1.0)
ipcMain.on('set-opacity', (e, value) => {
  senderWindow(e)?.setOpacity(Math.max(0.1, Math.min(1.0, value)))
})

// Click-through toggle (useful for reading-only mode in game)
ipcMain.on('set-ignore-mouse', (e, ignore) => {
  senderWindow(e)?.setIgnoreMouseEvents(ignore, { forward: true })
})

// ── POP-OUT PANELS (Medical / Comms) ─────────────────────────────────────────
ipcMain.handle('open-popout', (e, panel) => {
  openPopoutWindow(panel)
})
ipcMain.on('close-popout', (e, panel) => {
  popouts[panel]?.close()
})

// ── AUTO-UPDATE ───────────────────────────────────────────────────────────────
ipcMain.on('check-for-updates', () => checkForUpdates())
ipcMain.on('quit-and-install', () => autoUpdater.quitAndInstall())
ipcMain.handle('get-app-version', () => app.getVersion())
