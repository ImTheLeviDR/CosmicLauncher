const fs = require('fs-extra')
const os = require('os')
const path = require('path')

let dataPath
if (process.platform === 'win32') {
    dataPath = path.join(process.env.APPDATA, '.cosmiclauncher')
} else if (process.platform === 'darwin') {
    dataPath = path.join(process.env.HOME, 'Library', 'Application Support', 'CosmicLauncher')
} else {
    dataPath = path.join(process.env.HOME, '.cosmiclauncher')
}

const configPath = path.join(dataPath, 'config.json')

const DEFAULT_CONFIG = {
    selectedAccount: null,
    authenticationDatabase: {},
    selectedVersion: null
}

let config = null

exports.getLauncherDirectory = function(){
    return dataPath
}

exports.save = function(){
    fs.ensureDirSync(dataPath)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'UTF-8')
}

exports.load = function(){
    let doLoad = true

    if(!fs.existsSync(configPath)){
        fs.ensureDirSync(dataPath)
        doLoad = false
        config = DEFAULT_CONFIG
        exports.save()
    }
    
    if(doLoad){
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'UTF-8'))
            config = {...DEFAULT_CONFIG, ...config}
            exports.save()
        } catch (err){
            console.error('Error loading config:', err)
            config = DEFAULT_CONFIG
            exports.save()
        }
    }
    console.log('Config loaded')
}

exports.isLoaded = function(){
    return config != null
}

exports.getSelectedAccount = function(){
    return config.authenticationDatabase[config.selectedAccount]
}

exports.setSelectedAccount = function(uuid){
    const authAcc = config.authenticationDatabase[uuid]
    if(authAcc != null) {
        config.selectedAccount = uuid
        exports.save()
    }
    return authAcc
}

exports.addMicrosoftAuthAccount = function(uuid, accessToken, name, mcExpires, msAccessToken, msRefreshToken, msExpires) {
    config.selectedAccount = uuid
    config.authenticationDatabase[uuid] = {
        type: 'microsoft',
        accessToken,
        username: name.trim(),
        uuid: uuid.trim(),
        displayName: name.trim(),
        expiresAt: mcExpires,
        microsoft: {
            access_token: msAccessToken,
            refresh_token: msRefreshToken,
            expires_at: msExpires
        }
    }
    return config.authenticationDatabase[uuid]
}

exports.updateMicrosoftAuthAccount = function(uuid, accessToken, msAccessToken, msRefreshToken, msExpires, mcExpires) {
    config.authenticationDatabase[uuid].accessToken = accessToken
    config.authenticationDatabase[uuid].expiresAt = mcExpires
    config.authenticationDatabase[uuid].microsoft.access_token = msAccessToken
    config.authenticationDatabase[uuid].microsoft.refresh_token = msRefreshToken
    config.authenticationDatabase[uuid].microsoft.expires_at = msExpires
    return config.authenticationDatabase[uuid]
}

exports.removeAuthAccount = function(uuid){
    if(config.authenticationDatabase[uuid] != null){
        delete config.authenticationDatabase[uuid]
        if(config.selectedAccount === uuid){
            const keys = Object.keys(config.authenticationDatabase)
            if(keys.length > 0){
                config.selectedAccount = keys[0]
            } else {
                config.selectedAccount = null
            }
        }
        return true
    }
    return false
}

exports.getAuthAccount = function(uuid){
    return config.authenticationDatabase[uuid]
}

exports.getAuthDatabase = function(){
    return config.authenticationDatabase
}

exports.getSelectedUuid = function(){
    return config.selectedAccount
}

exports.getSelectedVersion = function(){
    return config.selectedVersion
}

exports.setSelectedVersion = function(versionId){
    config.selectedVersion = versionId
    exports.save()
}