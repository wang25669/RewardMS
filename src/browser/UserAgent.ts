import axios from 'axios'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import type { ChromeVersion, EdgeVersion } from '../interface/UserAgentUtil'
import type { MicrosoftRewardsBot } from '../index'

export class UserAgentManager {
    private static readonly NOT_A_BRAND_VERSION = '99'

    constructor(private bot: MicrosoftRewardsBot) {}

    async getUserAgent(isMobile: boolean) {
        const system = this.getSystemComponents(isMobile)
        const app = await this.getAppComponents(isMobile)

        const uaTemplate = isMobile
            ? `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Mobile Safari/537.36 EdgA/${app.edge_version}`
            : `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Safari/537.36 Edg/${app.edge_version}`

        const platformVersion = isMobile
            ? `${Math.floor(Math.random() * 5) + 10}.0.0`
            : (Math.random() > 0.5 ? '10.0.0' : '15.0.0')

        const uaMetadata = {
            isMobile,
            platform: isMobile ? 'Android' : 'Windows',
            fullVersionList: [
                { brand: 'Not/A)Brand', version: `${UserAgentManager.NOT_A_BRAND_VERSION}.0.0.0` },
                { brand: 'Microsoft Edge', version: app['edge_version'] },
                { brand: 'Chromium', version: app['chrome_version'] }
            ],
            brands: [
                { brand: 'Not/A)Brand', version: UserAgentManager.NOT_A_BRAND_VERSION },
                { brand: 'Microsoft Edge', version: app['edge_major_version'] },
                { brand: 'Chromium', version: app['chrome_major_version'] }
            ],
            platformVersion,
            architecture: isMobile ? '' : 'x86',
            bitness: isMobile ? '' : '64',
            model: '',
            // 设置中文语言和时区
            language: 'zh-CN',
            languages: ['zh-CN', 'zh', 'en-US'],
            timeZone: 'Asia/Shanghai'
        }

        return { userAgent: uaTemplate, userAgentMetadata: uaMetadata }
    }

    async getChromeVersion(isMobile: boolean): Promise<string> {
        try {
            const request = {
                //本地编译时候可替换代理地址
                //url: 'https://git.8998.dpdns.org/chrome-for-testing/last-known-good-versions.json',
                url: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 5000 // 增加超时限制，防止国内网络卡死
            }

            const response = await axios(request)
            const data: ChromeVersion = response.data
            return data.channels.Stable.version
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'USERAGENT-CHROME-VERSION',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            // Fallback to a known stable version if API fails
            return '129.0.0.0'
        }
    }

    async getEdgeVersions(isMobile: boolean) {
        try {
            const request = {
                url: 'https://edgeupdates.microsoft.com/api/products',
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 5000 // 增加超时限制
            }

            const response = await axios(request)
            const data: EdgeVersion[] = response.data
            const stable = data.find(x => x.Product == 'Stable') as EdgeVersion
            return {
                android: stable.Releases.find(x => x.Platform == 'Android')?.ProductVersion,
                windows: stable.Releases.find(x => x.Platform == 'Windows' && x.Architecture == 'x64')?.ProductVersion
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'USERAGENT-EDGE-VERSION',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            // Fallback to a known stable version if API fails
            return { android: '129.0.2792.84', windows: '129.0.2792.60' }
        }
    }

    getSystemComponents(mobile: boolean): string {
        if (mobile) {
            const androidVersion = 10 + Math.floor(Math.random() * 5)
            return `Linux; Android ${androidVersion}; K`
        }

        return 'Windows NT 10.0; Win64; x64'
    }

    async getAppComponents(isMobile: boolean) {
        const versions = await this.getEdgeVersions(isMobile)
        const edgeVersion = isMobile ? versions.android : (versions.windows as string)
        const edgeMajorVersion = edgeVersion?.split('.')[0]

        let chromeVersion = await this.getChromeVersion(isMobile)
        if (chromeVersion === '129.0.0.0' && edgeVersion) {
            chromeVersion = edgeVersion
        }
        const chromeMajorVersion = chromeVersion?.split('.')[0]
        const chromeReducedVersion = `${chromeMajorVersion}.0.0.0`

        return {
            not_a_brand_version: `${UserAgentManager.NOT_A_BRAND_VERSION}.0.0.0`,
            not_a_brand_major_version: UserAgentManager.NOT_A_BRAND_VERSION,
            edge_version: edgeVersion as string,
            edge_major_version: edgeMajorVersion as string,
            chrome_version: chromeVersion as string,
            chrome_major_version: chromeMajorVersion as string,
            chrome_reduced_version: chromeReducedVersion as string
        }
    }

    async updateFingerprintUserAgent(
        fingerprint: BrowserFingerprintWithHeaders,
        isMobile: boolean
    ): Promise<BrowserFingerprintWithHeaders> {
        try {
            const userAgentData = await this.getUserAgent(isMobile)
            const componentData = await this.getAppComponents(isMobile)

            //@ts-expect-error Errors due it not exactly matching
            fingerprint.fingerprint.navigator.userAgentData = userAgentData.userAgentMetadata
            fingerprint.fingerprint.navigator.userAgent = userAgentData.userAgent
            fingerprint.fingerprint.navigator.appVersion = userAgentData.userAgent.replace(
                `${fingerprint.fingerprint.navigator.appCodeName}/`,
                ''
            )

            // 修复浏览器指纹与 UA 的矛盾
            if (isMobile) {
                fingerprint.fingerprint.navigator.platform = 'Linux armv8l'
                fingerprint.fingerprint.navigator.deviceMemory = 4
                fingerprint.fingerprint.navigator.hardwareConcurrency = 8
            } else {
                fingerprint.fingerprint.navigator.platform = 'Win32'
                fingerprint.fingerprint.navigator.deviceMemory = 8
                fingerprint.fingerprint.navigator.hardwareConcurrency = 16
            }

            fingerprint.headers['user-agent'] = userAgentData.userAgent
            fingerprint.headers['sec-ch-ua'] =
                `"Microsoft Edge";v="${componentData.edge_major_version}", "Not=A?Brand";v="${componentData.not_a_brand_major_version}", "Chromium";v="${componentData.chrome_major_version}"`
            fingerprint.headers['sec-ch-ua-full-version-list'] =
                `"Microsoft Edge";v="${componentData.edge_version}", "Not=A?Brand";v="${componentData.not_a_brand_version}", "Chromium";v="${componentData.chrome_version}"`
            // 设置中文语言头
            fingerprint.headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8'
            fingerprint.headers['accept-encoding'] = 'gzip, deflate, br, zstd'
            fingerprint.headers['sec-fetch-site'] = 'same-site'
            fingerprint.headers['sec-fetch-mode'] = 'navigate'
            fingerprint.headers['sec-fetch-user'] = '?1'
            fingerprint.headers['sec-fetch-dest'] = 'document'
            fingerprint.headers['upgrade-insecure-requests'] = '1'

            /*
            Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0
            sec-ch-ua-full-version-list: "Microsoft Edge";v="129.0.2792.84", "Not=A?Brand";v="8.0.0.0", "Chromium";v="129.0.6668.90"
            sec-ch-ua: "Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"
    
            Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36
            "Google Chrome";v="129.0.6668.90", "Not=A?Brand";v="8.0.0.0", "Chromium";v="129.0.6668.90"
            */

            return fingerprint
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'USER-AGENT-UPDATE',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    normalizeFingerprint(
        fingerprint: BrowserFingerprintWithHeaders,
        isMobile: boolean,
        langCode?: string
    ): BrowserFingerprintWithHeaders {
        const lang = langCode || 'zh-CN'
        const mainLang = lang.split('-')[0] || lang
        const languages = lang.toLowerCase().startsWith('zh')
            ? ['zh-CN', 'zh', 'en-US']
            : [lang, mainLang, 'en-US']

        const headers = fingerprint.headers || {}

        // Accept-Language
        const acceptLangValue = languages.map((l, idx) => idx === 0 ? l : `${l};q=${(1 - idx * 0.1).toFixed(1)}`).join(',')
        headers['accept-language'] = acceptLangValue

        // Navigator properties
        if (fingerprint.fingerprint && fingerprint.fingerprint.navigator) {
            const nav = fingerprint.fingerprint.navigator
            nav.language = lang
            nav.languages = languages

            // 检测 UA 字符串是否与目标模式不匹配（FingerprintGenerator Relax 导致）
            const currentUA = nav.userAgent || ''
            const uaMismatch = isMobile
                ? !currentUA.includes('Android')
                : !currentUA.includes('Windows')

            if (uaMismatch && currentUA.length > 0) {
                // 从现有 UA 中提取 Chrome 版本号
                const chromeMatch = currentUA.match(/Chrome\/(\d+)/)
                const chromeMajor = chromeMatch ? chromeMatch[1] : '130'

                // 尝试从 UA 或 headers 中提取 Edge 版本号
                const edgMatch = currentUA.match(/Edg[A-Za-z]*\/([\d.]+)/)
                const edgeVersion = edgMatch ? edgMatch[1]! : `${chromeMajor}.0.0.0`
                const edgeMajor = edgeVersion.split('.')[0]!

                if (isMobile) {
                    const androidVersion = 10 + Math.floor(Math.random() * 5)
                    nav.userAgent = `Mozilla/5.0 (Linux; Android ${androidVersion}; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36 EdgA/${edgeVersion}`
                } else {
                    nav.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36 Edg/${edgeVersion}`
                }

                // 同步修正 appVersion
                nav.appVersion = nav.userAgent.replace('Mozilla/', '')

                // 同步修正 headers
                headers['user-agent'] = nav.userAgent
                headers['sec-ch-ua'] =
                    `"Microsoft Edge";v="${edgeMajor}", "Not=A?Brand";v="99", "Chromium";v="${chromeMajor}"`
                headers['sec-ch-ua-full-version-list'] =
                    `"Microsoft Edge";v="${edgeVersion}", "Not=A?Brand";v="99.0.0.0", "Chromium";v="${chromeMajor}.0.0.0"`

                // 同步修正 userAgentData 中的 brands
                if (nav.userAgentData) {
                    nav.userAgentData.brands = [
                        { brand: 'Not/A)Brand', version: '99' },
                        { brand: 'Microsoft Edge', version: edgeMajor! },
                        { brand: 'Chromium', version: chromeMajor! }
                    ]
                    nav.userAgentData.fullVersionList = [
                        { brand: 'Not/A)Brand', version: '99.0.0.0' },
                        { brand: 'Microsoft Edge', version: edgeVersion! },
                        { brand: 'Chromium', version: `${chromeMajor!}.0.0.0` }
                    ]
                }
            }

            if (isMobile) {
                nav.platform = 'Linux armv8l'
                nav.deviceMemory = 4
                nav.hardwareConcurrency = 8
                nav.maxTouchPoints = nav.maxTouchPoints || 5

                if (nav.userAgentData) {
                    nav.userAgentData.mobile = true
                    nav.userAgentData.platform = 'Android'
                    nav.userAgentData.architecture = ''
                    nav.userAgentData.bitness = ''
                    // 确保 platformVersion 合法（Android 10-14）
                    const androidPvMajor = 10 + Math.floor(Math.random() * 5)
                    nav.userAgentData.platformVersion = `${androidPvMajor}.0.0`
                }
            } else {
                nav.platform = 'Win32'
                nav.deviceMemory = 8
                nav.hardwareConcurrency = 16
                nav.maxTouchPoints = 0

                if (nav.userAgentData) {
                    nav.userAgentData.mobile = false
                    nav.userAgentData.platform = 'Windows'
                    nav.userAgentData.architecture = 'x86'
                    nav.userAgentData.bitness = '64'
                    // 确保 platformVersion 是合法 Windows 10/11 版本
                    nav.userAgentData.platformVersion = Math.random() > 0.5 ? '10.0.0' : '15.0.0'
                }
            }
        }

        // Screen normalization
        if (fingerprint.fingerprint && fingerprint.fingerprint.screen) {
            const screen = fingerprint.fingerprint.screen

            // 移动端：如果 Relax 产生了桌面分辨率（宽度 > 800），则强制修正
            if (isMobile && screen.width > 800) {
                const mobileScreens = [
                    { w: 412, h: 915, aw: 412, ah: 783 },
                    { w: 393, h: 873, aw: 393, ah: 786 },
                    { w: 360, h: 800, aw: 360, ah: 720 },
                    { w: 384, h: 854, aw: 384, ah: 756 },
                    { w: 414, h: 896, aw: 414, ah: 808 }
                ]
                const picked = mobileScreens[Math.floor(Math.random() * mobileScreens.length)]!
                screen.width = picked.w
                screen.height = picked.h
                screen.availWidth = picked.aw
                screen.availHeight = picked.ah
            }

            if (!screen.innerWidth || screen.innerWidth === 0) {
                screen.innerWidth = isMobile ? screen.width : (screen.availWidth || screen.width)
            }
            if (!screen.innerHeight || screen.innerHeight === 0) {
                screen.innerHeight = isMobile ? (screen.height - 100) : ((screen.availHeight || screen.height) - 80)
            }
            if (screen.clientWidth === 0) {
                screen.clientWidth = screen.innerWidth
            }
            if (screen.clientHeight === 0) {
                screen.clientHeight = screen.innerHeight
            }
        }

        // GPU renderer normalization
        if (fingerprint.fingerprint && fingerprint.fingerprint.videoCard) {
            const vc = fingerprint.fingerprint.videoCard
            if (!isMobile) {
                // Desktop: Override software renderer (SwiftShader) with realistic Intel GPU
                if (!vc.renderer || vc.renderer.includes('SwiftShader') || vc.renderer.includes('software') || vc.renderer.includes('Microsoft')) {
                    vc.renderer = 'ANGLE (Intel, Intel(R) UHD Graphics (0x0000A721) Direct3D11 vs_5_0 ps_5_0, D3D11)'
                    vc.vendor = 'Google Inc. (Intel)'
                }
            } else {
                // Mobile: Ensure no Apple/Windows/software GPU leaks into Android mobile
                if (
                    !vc.renderer ||
                    vc.renderer.includes('Apple') ||
                    vc.renderer.includes('Metal') ||
                    vc.renderer.includes('SwiftShader') ||
                    vc.renderer.includes('Direct3D') ||
                    vc.renderer.includes('ANGLE')
                ) {
                    const mobileGPUs = [
                        { renderer: 'Adreno (TM) 610', vendor: 'Google Inc. (Qualcomm)' },
                        { renderer: 'Adreno (TM) 620', vendor: 'Google Inc. (Qualcomm)' },
                        { renderer: 'Adreno (TM) 640', vendor: 'Google Inc. (Qualcomm)' },
                        { renderer: 'Mali-G57 MC2', vendor: 'Google Inc. (ARM)' },
                        { renderer: 'Mali-G78', vendor: 'Google Inc. (ARM)' }
                    ]
                    const picked = mobileGPUs[Math.floor(Math.random() * mobileGPUs.length)]!
                    vc.renderer = picked.renderer
                    vc.vendor = picked.vendor
                }
            }
        }

        // Battery normalization (Avoid constant 100% / charging state on mobile)
        if (fingerprint.fingerprint && fingerprint.fingerprint.battery) {
            const battery = fingerprint.fingerprint.battery
            if (isMobile) {
                if (battery.level === '1' && battery.charging === 'true') {
                    battery.charging = Math.random() > 0.3 ? 'true' : 'false'
                    battery.level = (0.4 + Math.random() * 0.55).toFixed(2)
                }
            }
        }

        // Headers overrides (strictly matching packet captures - all lowercase keys)
        headers['sec-ch-ua-mobile'] = isMobile ? '?1' : '?0'
        headers['sec-ch-ua-platform'] = isMobile ? '"Android"' : '"Windows"'

        return fingerprint
    }
}

