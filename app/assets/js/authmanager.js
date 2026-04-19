const ConfigManager = require('./configmanager')
const { MicrosoftAuth, MicrosoftErrorCode } = require('helios-core/microsoft')
const { AZURE_CLIENT_ID } = require('./ipcconstants')

const AUTH_MODE = { FULL: 0, MS_REFRESH: 1, MC_REFRESH: 2 }

function calculateExpiryDate(nowMs, expiresInS) {
    return nowMs + ((expiresInS-10)*1000)
}

function microsoftErrorDisplayable(errorCode) {
    const errors = {
        [MicrosoftErrorCode.NO_PROFILE]: { title: 'No Minecraft Profile', desc: 'Your Microsoft account does not have a Minecraft profile. Please purchase Minecraft to proceed.' },
        [MicrosoftErrorCode.NO_XBOX_ACCOUNT]: { title: 'No Xbox Account', desc: 'Your Microsoft account does not have an Xbox profile. Please create one at xbox.com' },
        [MicrosoftErrorCode.XBL_BANNED]: { title: 'Xbox Banned', desc: 'Your Xbox account has been banned from Xbox Live.' },
        [MicrosoftErrorCode.UNDER_18]: { title: 'Under 18', desc: 'Your account is under 18. Please set your account to adult in the Xbox settings.' },
        [MicrosoftErrorCode.UNKNOWN]: { title: 'Unknown Error', desc: 'An unknown error occurred. Please try again.' }
    }
    return errors[errorCode] || errors[MicrosoftErrorCode.UNKNOWN]
}

async function fullMicrosoftAuthFlow(entryCode, authMode) {
    try {
        let accessTokenRaw
        let accessToken
        if(authMode !== AUTH_MODE.MC_REFRESH) {
            const accessTokenResponse = await MicrosoftAuth.getAccessToken(entryCode, authMode === AUTH_MODE.MS_REFRESH, AZURE_CLIENT_ID)
            if(accessTokenResponse.responseStatus === 'ERROR') {
                return Promise.reject(microsoftErrorDisplayable(accessTokenResponse.microsoftErrorCode))
            }
            accessToken = accessTokenResponse.data
            accessTokenRaw = accessToken.access_token
        } else {
            accessTokenRaw = entryCode
        }
        
        const xblResponse = await MicrosoftAuth.getXBLToken(accessTokenRaw)
        if(xblResponse.responseStatus === 'ERROR') {
            return Promise.reject(microsoftErrorDisplayable(xblResponse.microsoftErrorCode))
        }
        const xstsResonse = await MicrosoftAuth.getXSTSToken(xblResponse.data)
        if(xstsResonse.responseStatus === 'ERROR') {
            return Promise.reject(microsoftErrorDisplayable(xstsResonse.microsoftErrorCode))
        }
        const mcTokenResponse = await MicrosoftAuth.getMCAccessToken(xstsResonse.data)
        if(mcTokenResponse.responseStatus === 'ERROR') {
            return Promise.reject(microsoftErrorDisplayable(mcTokenResponse.microsoftErrorCode))
        }
        const mcProfileResponse = await MicrosoftAuth.getMCProfile(mcTokenResponse.data.access_token)
        if(mcProfileResponse.responseStatus === 'ERROR') {
            return Promise.reject(microsoftErrorDisplayable(mcProfileResponse.microsoftErrorCode))
        }
        return {
            accessToken,
            accessTokenRaw,
            xbl: xblResponse.data,
            xsts: xstsResonse.data,
            mcToken: mcTokenResponse.data,
            mcProfile: mcProfileResponse.data
        }
    } catch(err) {
        console.error('Auth error:', err)
        return Promise.reject(microsoftErrorDisplayable(MicrosoftErrorCode.UNKNOWN))
    }
}

exports.addMicrosoftAccount = async function(authCode) {
    const fullAuth = await fullMicrosoftAuthFlow(authCode, AUTH_MODE.FULL)
    const now = new Date().getTime()

    const ret = ConfigManager.addMicrosoftAuthAccount(
        fullAuth.mcProfile.id,
        fullAuth.mcToken.access_token,
        fullAuth.mcProfile.name,
        calculateExpiryDate(now, fullAuth.mcToken.expires_in),
        fullAuth.accessToken.access_token,
        fullAuth.accessToken.refresh_token,
        calculateExpiryDate(now, fullAuth.accessToken.expires_in)
    )
    ConfigManager.save()
    return ret
}

exports.removeMicrosoftAccount = async function(uuid){
    ConfigManager.removeAuthAccount(uuid)
    ConfigManager.save()
    return Promise.resolve()
}

exports.validateSelected = async function(){
    const current = ConfigManager.getSelectedAccount()
    if(!current || current.type !== 'microsoft') {
        return false
    }

    const now = new Date().getTime()
    const mcExpiresAt = current.expiresAt
    const mcExpired = now >= mcExpiresAt

    if(!mcExpired) {
        return true
    }

    const msExpiresAt = current.microsoft.expires_at
    const msExpired = now >= msExpiresAt

    if(msExpired) {
        try {
            const res = await fullMicrosoftAuthFlow(current.microsoft.refresh_token, AUTH_MODE.MS_REFRESH)
            ConfigManager.updateMicrosoftAuthAccount(
                current.uuid,
                res.mcToken.access_token,
                res.accessToken.access_token,
                res.accessToken.refresh_token,
                calculateExpiryDate(now, res.accessToken.expires_in),
                calculateExpiryDate(now, res.mcToken.expires_in)
            )
            ConfigManager.save()
            return true
        } catch(_err) {
            return false
        }
    } else {
        try {
            const res = await fullMicrosoftAuthFlow(current.microsoft.access_token, AUTH_MODE.MC_REFRESH)
            ConfigManager.updateMicrosoftAuthAccount(
                current.uuid,
                res.mcToken.access_token,
                current.microsoft.access_token,
                current.microsoft.refresh_token,
                current.microsoft.expires_at,
                calculateExpiryDate(now, res.mcToken.expires_in)
            )
            ConfigManager.save()
            return true
        }
        catch(_err) {
            return false
        }
    }
}