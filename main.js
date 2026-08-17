const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ejs = require('ejs');
const ConfigManager = require('./app/assets/js/configmanager');
const AuthManager = require('./app/assets/js/authmanager');
const LaunchManager = require('./app/assets/js/launchmanager');
const ModManager = require('./app/assets/js/modmanager');
const ModpackManager = require('./app/assets/js/modpackmanager');
const ModrinthImporter = require('./app/assets/js/modrinthimporter');
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants');

const EJS_FILE = path.join(__dirname, 'index.ejs');

function getCompiledHtmlPath() {
    if (app.isPackaged) {
        return path.join(app.getPath('userData'), 'index_compiled.html');
    }
    return path.join(__dirname, 'index_compiled.html');
}

function compileTemplate() {
    const template = fs.readFileSync(EJS_FILE, 'utf-8');
    const accounts = ConfigManager.getAuthDatabase() || {};
    const selectedUuid = ConfigManager.getSelectedUuid();
    const selectedModpack = ModpackManager.getSelected() || ModpackManager.getById('default');
    const selectedVersion = selectedModpack?.version === 'latest'
        ? 'latest'
        : (selectedModpack?.version || ConfigManager.getSelectedVersion() || '1.20.4');
    const loader = selectedModpack?.loader || ConfigManager.getSelectedLoader() || 'vanilla';
    const launcherAction = ConfigManager.getLauncherAction();
    const allowMultipleInstances = ConfigManager.getAllowMultipleInstances();
    const syncOptionsAcrossModpacks = ModpackManager.getSyncOptionsEnabled();
    const modpacks = ModpackManager.list();
    const theme = ConfigManager.getTheme();
    let installedMods = {};
    try { installedMods = ModManager.getInstalledMods() || {}; } catch(e) { console.error('Failed to load mods for template:', e); }

    const assetRoot = `${pathToFileURL(__dirname).href}/`;
    const html = ejs.render(template, {
        accounts,
        selectedUuid,
        selectedVersion,
        loader,
        launcherAction,
        allowMultipleInstances,
        syncOptionsAcrossModpacks,
        modpacks,
        selectedModpack,
        theme,
        installedMods,
        assetRoot,
    }, { filename: EJS_FILE });

    const compiledPath = getCompiledHtmlPath();
    fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
    fs.writeFileSync(compiledPath, html, 'utf-8');
    return compiledPath;
}

ConfigManager.load();
ModpackManager.load();

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception in main process:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in main process:', reason);
});

// Single instance lock - prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindowRef) {
            if (mainWindowRef.isMinimized()) mainWindowRef.restore();
            mainWindowRef.show();
            mainWindowRef.focus();
        }
    });
}

// Store reference to main window
let mainWindowRef = null

async function openMicrosoftLogin() {
    console.log('Opening Microsoft login window...');
    if (msftAuthWindow) {
        console.log('Login window already open');
        return
    }
    msftAuthSuccess = false
    msftAuthWindow = new BrowserWindow({
        title: 'Microsoft Login',
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: path.join(__dirname, 'app', 'assets', 'logo.png')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        console.log('Login window closed');
    })

    msftAuthWindow.webContents.on('did-navigate', async (_, uri) => {
        console.log('Navigated to:', uri);
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}
            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v;
            });
            console.log('Got auth code:', queryMap.code);
            
            const authCode = queryMap.code;
            if (authCode) {
                // Process auth immediately in main process
                try {
                    const account = await AuthManager.addMicrosoftAccount(authCode);
                    console.log('Account added:', account.displayName);
                    if (mainWindowRef) {
                        mainWindowRef.webContents.send('accountAdded', { success: true, account: account });
                    }
                } catch(err) {
                    console.error('Auth error:', err);
                    if (mainWindowRef) {
                        mainWindowRef.webContents.send('accountAdded', { success: false, error: err });
                    }
                }
            }

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
}

ipcMain.on('openMicrosoftLogin', () => {
    openMicrosoftLogin()
})

const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    console.log('OPEN_LOGIN received', arguments_);
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: 'Microsoft Login',
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: path.join(__dirname, 'app', 'assets', 'logo.png')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}
            
            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v;
            });

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: 'Microsoft Logout',
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: path.join(__dirname, 'app', 'assets', 'logo.png')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return { result: true }
    } catch(error) {
        return { result: false, error: error }
    }
})

ipcMain.handle('addMicrosoftAccount', async (event, authCode) => {
    try {
        const account = await AuthManager.addMicrosoftAccount(authCode)
        return { success: true, account: account }
    } catch(error) {
        console.error('Add account error:', error)
        return { success: false, error: error }
    }
})

ipcMain.handle('getAccounts', async () => {
    const db = ConfigManager.getAuthDatabase()
    const selected = ConfigManager.getSelectedUuid()
    return { database: db, selectedAccount: selected }
})

ipcMain.handle('setSelectedAccount', async (event, uuid) => {
    try {
        ConfigManager.setSelectedAccount(uuid)
        return { success: true }
    } catch(error) {
        return { success: false, error: error }
    }
})

ipcMain.handle('getSelectedVersion', () => {
    return ConfigManager.getSelectedVersion()
})

ipcMain.handle('saveSelectedVersion', (event, versionId) => {
    ConfigManager.setSelectedVersion(versionId)
    ConfigManager.save()
    return { success: true }
})

ipcMain.handle('getSelectedLoader', () => {
    return ConfigManager.getSelectedLoader()
})

ipcMain.handle('saveSelectedLoader', (event, loader) => {
    ConfigManager.setSelectedLoader(loader)
    ConfigManager.save()
    return { success: true }
})

ipcMain.handle('mods:needsSync', (event, versionId, loader) => {
    return { success: true, needsSync: ConfigManager.needsModSync(versionId, loader) }
})

ipcMain.handle('mods:getSyncState', () => {
    return { success: true, ...ConfigManager.getModsSyncState() }
})

ipcMain.handle('mods:markSynced', (event, versionId, loader) => {
    ConfigManager.markModsSynced(versionId, loader)
    return { success: true }
})

ipcMain.handle('getLaunchOptions', () => {
    return {
        launcherAction: ConfigManager.getLauncherAction(),
        allowMultipleInstances: ConfigManager.getAllowMultipleInstances()
    }
})

ipcMain.handle('setLauncherAction', (event, action) => {
    ConfigManager.setLauncherAction(action)
    ConfigManager.save()
    return { success: true, launcherAction: ConfigManager.getLauncherAction() }
})

ipcMain.handle('setAllowMultipleInstances', (event, allowed) => {
    ConfigManager.setAllowMultipleInstances(allowed)
    ConfigManager.save()
    return { success: true, allowMultipleInstances: ConfigManager.getAllowMultipleInstances() }
})

ipcMain.handle('getTheme', () => {
    return { success: true, theme: ConfigManager.getTheme(), themes: ConfigManager.getValidThemes() }
})

ipcMain.handle('saveTheme', (event, theme) => {
    const saved = ConfigManager.setTheme(theme)
    return { success: saved, theme: ConfigManager.getTheme() }
})

ipcMain.handle('isGameRunning', () => {
    return LaunchManager.isGameRunning()
})

ipcMain.handle('stopGame', async () => {
    try {
        const stopped = LaunchManager.stopGame()
        return { success: stopped }
    } catch (error) {
        return { success: false, error: error.message || 'Failed to stop game' }
    }
})

ipcMain.handle('removeAccount', async (event, uuid) => {
    try {
        ConfigManager.removeAuthAccount(uuid)
        ConfigManager.save()
        return { success: true }
    } catch(error) {
        return { success: false, error: error }
    }
})

ipcMain.handle('launchGame', async (event, modpackId) => {
    try {
        if (!ConfigManager.getAllowMultipleInstances() && LaunchManager.isGameRunning()) {
            return { success: false, error: 'Game is already running.' }
        }

        const isValid = await AuthManager.validateSelected()
        if (!isValid) {
            return { success: false, error: 'Account validation failed. Please re-login.' }
        }

        const account = ConfigManager.getSelectedAccount()
        if (!account) {
            return { success: false, error: 'No account selected' }
        }

        const pack = ModpackManager.getById(modpackId) || ModpackManager.getSelected()
        if (!pack) {
            return { success: false, error: 'No modpack selected' }
        }

        ModpackManager.setSelected(pack.id)
        const selectedLoader = pack.loader || 'vanilla'
        const versionId = pack.version || 'latest'

        LaunchManager.on('progress', (data) => {
            if (mainWindowRef) {
                mainWindowRef.webContents.send('launchProgress', data)
            }
        })

        LaunchManager.on('gameLog', (message) => {
            if (mainWindowRef) {
                mainWindowRef.webContents.send('gameLog', message)
            }
        })

        LaunchManager.on('gameExit', () => {
            if (mainWindowRef) {
                mainWindowRef.webContents.send('gameExit')
            }
        })

        if (selectedLoader === 'fabric') {
            await LaunchManager.launchFabric(versionId, account, pack.id)
        } else {
            await LaunchManager.launchVanilla(versionId, account, pack.id)
        }

        const resolved = await LaunchManager.resolveVersionId(versionId)
        if (pack.version !== 'latest') {
            ConfigManager.setSelectedVersion(resolved)
        }
        ConfigManager.setSelectedLoader(selectedLoader)
        ConfigManager.save()

        if (mainWindowRef) {
            mainWindowRef.webContents.send('gameStarted')
            mainWindowRef.webContents.send('launchLog', '=== Game launched! ===')
            const launcherAction = ConfigManager.getLauncherAction()
            if (launcherAction === 'hide') {
                mainWindowRef.hide()
            } else if (launcherAction === 'exit') {
                app.quit()
            }
        }

        return { success: true, versionId: resolved, modpackId: pack.id }
    } catch(error) {
        console.error('Launch error:', error)
        return { success: false, error: error.message || 'Failed to launch game' }
    }
})

ipcMain.handle('modpacks:list', () => {
    try {
        return {
            success: true,
            modpacks: ModpackManager.list(),
            selectedId: ModpackManager.getSelectedId(),
            syncOptionsAcrossModpacks: ModpackManager.getSyncOptionsEnabled(),
        }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('modpacks:select', (event, id) => {
    try {
        const pack = ModpackManager.setSelected(id)
        return { success: true, modpack: pack }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('modpacks:create', (event, data) => {
    try {
        const pack = ModpackManager.create(data || {})
        return { success: true, modpack: pack }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('modpacks:update', (event, id, data) => {
    try {
        const pack = ModpackManager.update(id, data || {})
        return { success: true, modpack: pack }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('modpacks:remove', (event, id) => {
    try {
        ModpackManager.remove(id)
        return { success: true, selectedId: ModpackManager.getSelectedId() }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('modpacks:setSyncOptions', (event, enabled) => {
    try {
        const value = ModpackManager.setSyncOptionsEnabled(enabled)
        return { success: true, syncOptionsAcrossModpacks: value }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('modpacks:listModrinth', async () => {
    try {
        return await ModrinthImporter.listInstances()
    } catch (error) {
        console.error('Modrinth instance list failed:', error)
        return { success: false, error: error.message || 'Could not read Modrinth instances' }
    }
})

ipcMain.handle('modpacks:importModrinth', async (event, instanceId) => {
    try {
        const result = await ModrinthImporter.importInstance(instanceId)
        return { success: true, ...result }
    } catch (error) {
        console.error('Modrinth import failed:', error)
        return { success: false, error: error.message || 'Could not import Modrinth instance' }
    }
})

ipcMain.handle('modpacks:resolveVersion', async (event, versionSpec) => {
    try {
        const versionId = await LaunchManager.resolveVersionId(versionSpec || 'latest')
        return { success: true, versionId }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('getAvailableVersions', async () => {
    try {
        const manifest = await LaunchManager.getVersionManifest(true)
        return { success: true, versions: manifest.versions }
    } catch(error) {
        console.error('Version manifest error:', error)
        return { success: false, error: error.message }
    }
})

ipcMain.handle('openModsFolder', async () => {
    const modsDir = ModManager.getMinecraftModsDirectory()
    try {
        const fs = require('fs-extra')
        fs.ensureDirSync(modsDir)
        await shell.openPath(modsDir)
        return { success: true }
    } catch(error) {
        console.error('Open mods folder error:', error)
        return { success: false, error: error.message }
    }
})

ipcMain.handle('openInstanceFolder', async () => {
    const instanceDir = LaunchManager.getGameDirectory()
    try {
        const fs = require('fs-extra')
        fs.ensureDirSync(instanceDir)
        await shell.openPath(instanceDir)
        return { success: true }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:search', async (event, query) => {
    try {
        const results = await ModManager.searchMods(query, [], ['fabric'])
        return { success: true, results }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:install', async (event, projectId, versionId, gameVersion, loader) => {
    try {
        const result = await ModManager.installMod(projectId, versionId, gameVersion, loader)
        return { success: true, data: result }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:remove', async (event, projectId) => {
    try {
        await ModManager.removeMod(projectId)
        return { success: true }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:list', async () => {
    try {
        const mods = ModManager.getInstalledMods()
        return { success: true, mods }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:setEnabled', async (event, projectId, enabled) => {
    try {
        ModManager.setModEnabled(projectId, enabled)
        return { success: true }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:syncForVersion', async (event, gameVersion, loader) => {
    try {
        const changed = ModManager.syncModsForVersion(gameVersion, loader)
        return { success: true, changed }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:getProject', async (event, projectId) => {
    try {
        const project = await ModManager.getProject(projectId)
        return { success: true, project }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:getVersions', async (event, projectId, gameVersions, loaders) => {
    try {
        const versions = await ModManager.getProjectVersions(projectId, gameVersions, loaders)
        return { success: true, versions }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:checkCompatibility', async (event, gameVersion, loader) => {
    try {
        const result = await ModManager.checkModsCompatibility(gameVersion, loader)
        return { success: true, ...result }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:autoUpdateForVersion', async (event, gameVersion, loader) => {
    try {
        const results = { updated: [], failed: [], installedDeps: [], depConflicts: [] }

        for (let pass = 0; pass < 5; pass++) {
            const compat = await ModManager.checkModsCompatibility(gameVersion, loader)
            if (compat.updatable.length === 0) break

            results.depConflicts = compat.depConflicts || []

            for (const mod of compat.updatable) {
                try {
                    const res = await ModManager.updateMod(mod.projectId, gameVersion, loader)
                    if (res.updated) {
                        results.updated.push({ projectId: mod.projectId, title: mod.title, newVersion: res.mod.versionNumber })
                    }
                    if (res.deps && res.deps.length > 0) {
                        results.installedDeps.push(...res.deps.filter(Boolean).map(d => ({ projectId: d.projectId, title: d.title })))
                    }
                    if (res.depConflicts) {
                        results.depConflicts.push(...res.depConflicts)
                    }
                } catch (e) {
                    results.failed.push({ projectId: mod.projectId, title: mod.title, error: e.message })
                }
            }
        }

        const finalCompat = await ModManager.checkModsCompatibility(gameVersion, loader)
        for (const mod of finalCompat.incompatible) {
            try {
                ModManager.setModEnabled(mod.projectId, false)
            } catch (error) {
                results.failed.push({ projectId: mod.projectId, title: mod.title, error: error.message })
            }
        }

        return { success: true, ...results }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

ipcMain.handle('mods:validateConflicts', async () => {
    try {
        const conflicts = await ModManager.validateAllModConflicts()
        return { success: true, conflicts }
    } catch (error) {
        return { success: false, error: error.message }
    }
})

let win
let tray

function createTray() {
    let iconPath
    if (process.platform === 'darwin') {
        iconPath = path.join(__dirname, 'app', 'assets', 'logo.png')
    } else {
        iconPath = path.join(__dirname, 'app', 'assets', 'logo.png')
    }
    let trayIcon;
    try {
        trayIcon = nativeImage.createFromPath(iconPath);
        if (trayIcon.isEmpty()) {
            if (process.platform === 'darwin') {
                trayIcon = nativeImage.createEmpty()
            } else {
                trayIcon = nativeImage.createEmpty()
            }
        }
    } catch(e) {
        trayIcon = nativeImage.createEmpty();
    }
    
    const iconSize = process.platform === 'darwin' ? 22 : 16
    tray = new Tray(trayIcon.resize({ width: iconSize, height: iconSize }))
    tray.setToolTip('Cosmic Launcher');
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show',
            click: () => {
                if (mainWindowRef) {
                    mainWindowRef.show();
                    mainWindowRef.focus();
                }
            }
        },
        {
            label: 'Quit',
            click: () => {
                if (mainWindowRef) {
                    mainWindowRef.destroy();
                }
                app.quit();
            }
        }
    ]);
    
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
        if (mainWindowRef) {
            if (mainWindowRef.isVisible()) {
                mainWindowRef.hide();
            } else {
                if (mainWindowRef.isDestroyed()) {
                    mainWindowRef = new BrowserWindow({
                        width: 960,
                        height: 640,
                        frame: false,
                        maximizable: false,
                        transparent: false,
                        show: false,
                        backgroundColor: '#0a0a1a',
                        webPreferences: {
                            nodeIntegration: true,
                            contextIsolation: false,
                            preload: path.join(__dirname, 'preload.js')
                        }
                    });
                    mainWindowRef.loadFile(compileTemplate());
                    createTray();
                } else {
                    mainWindowRef.show();
                    mainWindowRef.focus();
                    mainWindowRef.webContents.send('triggerOpenAnimation');
                }
            }
        }
    });
}

function showMainWindowWithAnimation() {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
    mainWindowRef.show();
    mainWindowRef.focus();
    mainWindowRef.webContents.send('triggerOpenAnimation');
}

function createWindow() {
    win = new BrowserWindow({
        width: 960,
        height: 640,
        frame: false,
        maximizable: false,
        transparent: false,
        show: false,
        backgroundColor: '#0a0a1a',
        icon: path.join(__dirname, 'app', 'assets', 'logo.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindowRef = win;
    console.log('Main window created');

    win.loadFile(compileTemplate());

    win.webContents.on('did-finish-load', () => {
        win.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'F12') {
                win.webContents.toggleDevTools();
            }
        });
    });

    createTray();
}

ipcMain.on('minimize', () => win.minimize());
ipcMain.on('close', () => {
    if (mainWindowRef) {
        mainWindowRef.hide()
    }
});
ipcMain.on('showFromTray', () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send('triggerOpenAnimation');
    }
});

ipcMain.on('startup-ready', () => {
    showMainWindowWithAnimation();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});