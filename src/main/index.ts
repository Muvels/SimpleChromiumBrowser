import path, { join } from 'path';

import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  webContents,
  Menu,
  MenuItem,
  clipboard
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { ElectronBlocker } from '@ghostery/adblocker-electron';

import icon from '../../resources/icon.png?asset';

import settingsStore from './utils/settingsStore';
import { autocomplete } from './utils/autocomplete';

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    autoHideMenuBar: true,
    transparent: false,
    titleBarStyle: process.platform === 'darwin' ? 'default' : 'hiddenInset', // Dont show buttons on macos
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    },
    frame: false
  });

  const chromiumUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
  mainWindow.webContents.setUserAgent(chromiumUserAgent);

  if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((_details) => ({ action: 'deny' }));

  if (settingsStore.get('settings.adBlocker')) {
    void ElectronBlocker.fromPrebuiltAdsAndTracking().then((blocker) => {
      blocker.enableBlockingInSession(session.defaultSession);
    });
  } else {
    console.log('No ad blocker active');
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  autoUpdater.autoDownload = false;
  autoUpdater
    .checkForUpdates()
    .then((updateCheckResult) => {
      console.log(
        updateCheckResult,
        autoUpdater.currentVersion,
        updateCheckResult?.updateInfo.version !== autoUpdater.currentVersion.version
      );
      if (updateCheckResult?.updateInfo.version !== autoUpdater.currentVersion.version) {
        mainWindow.webContents.send('update-available');
      }
    })
    .catch((error) => {
      console.error('Error checking for updates:', error);
    });

  ipcMain.on('webview-ready', (_event, webViewId: number) => {
    const wv = webContents.fromId(webViewId);

    const handleBeforeInputEvent = (_, input): void => {
      if (input.type !== 'keyDown') return;
      if (input.meta && input.key === 'Escape') {
        mainWindow.webContents.send('blur-tab');
        return;
      }
      if (input.key === settingsStore.get('settings.hotkeys.Browser.toggleDevTools'))
        return wv?.openDevTools();
      if (input.key === settingsStore.get('settings.hotkeys.Browser.reload')) return wv?.reload();
      if (input.key === settingsStore.get('settings.hotkeys.Browser.undo'))
        return wv?.navigationHistory.goBack();
      if (input.key === settingsStore.get('settings.hotkeys.Browser.redo'))
        return wv?.navigationHistory.goForward();
    };

    const handleContextMenu = (
      _: object,
      infos: Electron.Event<Electron.ContextMenuParams>
    ): void => {
      const url = infos.linkURL !== '' ? infos.linkURL : null;
      const selectionText: string | null = infos.selectionText !== '' ? infos.selectionText : null;
      const menu = new Menu();

      url &&
        menu.append(
          new MenuItem({
            label: `Open Link in New Tab`,
            click: (): void => {
              mainWindow.webContents.send('create-tab', url);
            }
          })
        );
      url &&
        menu.append(
          new MenuItem({
            label: `Open Link in Split View`,
            submenu: [
              {
                label: 'Vertical Split',
                click: (): void => {
                  mainWindow.webContents.send('create-split', url, 'column');
                }
              },
              {
                label: 'Horizontal Split',
                click: (): void => {
                  mainWindow.webContents.send('create-split', url, 'row');
                }
              }
            ],
            click: (): void => {
              mainWindow.webContents.send('create-tab', url);
            }
          })
        );
      selectionText &&
        menu.append(
          new MenuItem({
            label: `Copy Text`,
            click: (): void => {
              clipboard.write({ text: selectionText });
            }
          })
        );
      menu.popup();
    };

    wv?.on('before-input-event', handleBeforeInputEvent);
    //@ts-ignore This needs to be handled this way
    wv?.on('context-menu', handleContextMenu);

    // Neue Fenster blocken
    wv?.setWindowOpenHandler((details) => {
      mainWindow.webContents.send('create-tab', details.url);
      return { action: 'deny' };
    });

    wv?.once('destroyed', () => {
      wv.removeListener('before-input-event', handleBeforeInputEvent);
      //@ts-ignore This needs to be handled this way
      wv.removeListener('context-menu', handleContextMenu);
    });
  });
}

console.log('=============== USER DATA PATH: ', app.getPath('userData'), ' ===============');

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron');

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // IPC test
  ipcMain.on('minimize', () => {
    const window = BrowserWindow.getFocusedWindow();
    if (window) window.minimize();
  });

  ipcMain.on('maximize', () => {
    const window = BrowserWindow.getFocusedWindow();
    if (window) {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    }
  });

  ipcMain.on('close', () => {
    const window = BrowserWindow.getFocusedWindow();
    if (window) window.close();
  });

  // IPC to store settings
  ipcMain.on('store-set', (_event, key: string, value: string) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    settingsStore.set(key, value);
  });

  ipcMain.handle('store-get', (_event, key: string) => settingsStore.get(key) as string);

  ipcMain.handle('get-suggestions', async (_event, q: string) => await autocomplete(q));

  createWindow();

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  const extensionPath = path.join(
    '/Users/matteomarolt/Library/Application Support/Google/Chrome/Default/Extensions/fmkadmapgofadopljbjfkapdkoienihi/6.0.1_0' // Replace with the actual path
  );

  try {
    void session.defaultSession.loadExtension(extensionPath as string);
    console.log('React Developer Tools loaded successfully.');
  } catch (err) {
    console.error('Failed to load React Developer Tools:', err);
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
