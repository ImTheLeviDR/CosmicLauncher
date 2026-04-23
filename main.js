const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const ConfigManager = require('./app/assets/js/configmanager');
const AuthManager = require('./app/assets/js/authmanager');
const LaunchManager = require('./app/assets/js/launchmanager');
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants');

ConfigManager.load();

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
        icon: path.join(__dirname, 'template', 'build', 'icon.png')
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
        icon: path.join(__dirname, 'template', 'build', 'icon.png')
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
        icon: path.join(__dirname, 'template', 'build', 'icon.png')
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

ipcMain.handle('removeAccount', async (event, uuid) => {
    try {
        ConfigManager.removeAuthAccount(uuid)
        ConfigManager.save()
        return { success: true }
    } catch(error) {
        return { success: false, error: error }
    }
})

ipcMain.handle('launchGame', async (event, versionId) => {
    try {
        const isValid = await AuthManager.validateSelected()
        if (!isValid) {
            return { success: false, error: 'Account validation failed. Please re-login.' }
        }

        const account = ConfigManager.getSelectedAccount()
        if (!account) {
            return { success: false, error: 'No account selected' }
        }

        LaunchManager.on('progress', (data) => {
            if (mainWindowRef) {
                mainWindowRef.webContents.send('launchProgress', data)
            }
        })

        await LaunchManager.launchVanilla(versionId, account)
        
        if (mainWindowRef) {
            mainWindowRef.webContents.send('launchLog', '=== Game launched! Closing launcher... ===')
        }
        
        await new Promise(r => setTimeout(r, 5000))
        
        if (mainWindowRef) {
            mainWindowRef.destroy()
        }
        
        app.quit()
        
        return { success: true }
    } catch(error) {
        console.error('Launch error:', error)
        return { success: false, error: error.message || 'Failed to launch game' }
    }
})

ipcMain.handle('getAvailableVersions', async () => {
    try {
        const manifest = await LaunchManager.getVersionManifest()
        return { success: true, versions: manifest.versions }
    } catch(error) {
        console.error('Version manifest error:', error)
        return { success: false, error: error.message }
    }
})

let win

function createWindow() {
    win = new BrowserWindow({
        width: 960,
        height: 640,
        frame: false,
        transparent: false,
        backgroundColor: '#0a0a1a',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

mainWindowRef = win;
    console.log('Main window created');

    win.loadFile('index.html');

    win.webContents.on('did-finish-load', () => {
        win.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'F12') {
                win.webContents.toggleDevTools();
            }
        });
    });

ipcMain.on('minimize', () => win.minimize());
ipcMain.on('close', () => {
    if (mainWindowRef) {
        mainWindowRef.hide()
    }
});
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});