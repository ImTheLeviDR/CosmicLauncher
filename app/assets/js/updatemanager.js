const https = require('https')
const { app } = require('electron')

const GITHUB_OWNER = 'ImTheLeviDR'
const GITHUB_REPO = 'CosmicLauncher'
const REQUEST_TIMEOUT_MS = 8000

function parseVersion(version) {
    if (!version || typeof version !== 'string') return [0, 0, 0]
    const clean = version.replace(/^v/i, '').replace(/^[^\d]*/, '').split('-')[0].split('+')[0]
    return clean.split('.').slice(0, 3).map((n) => parseInt(n, 10) || 0)
}

function compareVersions(a, b) {
    const pa = parseVersion(a)
    const pb = parseVersion(b)
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0)
        if (diff !== 0) return diff
    }
    return 0
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': `CosmicLauncher/${app.getVersion()}`,
                Accept: 'application/vnd.github+json'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchJson(res.headers.location).then(resolve, reject)
                return
            }

            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`GitHub returned ${res.statusCode}`))
                    return
                }
                try {
                    resolve(JSON.parse(data))
                } catch (err) {
                    reject(new Error('Could not parse GitHub response'))
                }
            })
        })

        req.on('error', reject)
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy()
            reject(new Error('Update check timed out'))
        })
    })
}

function assetName(asset) {
    return asset?.name || ''
}

function pickInstallerAsset(assets, version) {
    if (!Array.isArray(assets)) return null

    if (process.platform === 'linux') {
        const expected = `Cosmic.Launcher-${version}-x64.AppImage`
        return assets.find((asset) => assetName(asset) === expected)
            || assets.find((asset) => /\.AppImage$/i.test(assetName(asset)))
            || assets.find((asset) => /\.deb$/i.test(assetName(asset)))
            || null
    }

    if (process.platform === 'darwin') {
        return assets.find((asset) => /\.dmg$/i.test(assetName(asset)))
            || null
    }

    const expected = `Cosmic.Launcher.Setup.${version}.exe`
    return assets.find((asset) => assetName(asset) === expected)
        || assets.find((asset) => /\.exe$/i.test(assetName(asset)) && /setup/i.test(assetName(asset)))
        || assets.find((asset) => /\.exe$/i.test(assetName(asset)))
        || null
}

function pickLatestRelease(releases) {
    const published = (releases || []).filter((release) => release && !release.draft && release.tag_name)
    if (!published.length) return null
    return published.reduce((best, release) => {
        const version = String(release.tag_name).replace(/^v/i, '')
        const bestVersion = String(best.tag_name).replace(/^v/i, '')
        return compareVersions(version, bestVersion) > 0 ? release : best
    })
}

exports.checkForUpdate = async function() {
    const current = app.getVersion()
    const releases = await fetchJson(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`)
    if (!Array.isArray(releases)) throw new Error('Unexpected GitHub response')

    const latestRelease = pickLatestRelease(releases)
    if (!latestRelease) {
        return {
            success: true,
            current,
            latest: current,
            updateAvailable: false,
            htmlUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
            downloadUrl: null
        }
    }

    const latest = String(latestRelease.tag_name).replace(/^v/i, '')
    const asset = pickInstallerAsset(latestRelease.assets, latest)
    return {
        success: true,
        current,
        latest,
        updateAvailable: compareVersions(latest, current) > 0,
        htmlUrl: latestRelease.html_url,
        downloadUrl: asset?.browser_download_url || latestRelease.html_url
    }
}

exports.getCurrentVersion = function() {
    return app.getVersion()
}
