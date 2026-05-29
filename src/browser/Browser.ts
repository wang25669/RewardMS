import rebrowser, { BrowserContext } from 'patchright'
import { newInjectedContext } from 'fingerprint-injector'
import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'

import type { MicrosoftRewardsBot } from '../index'
import { loadSessionData, saveFingerprintData } from '../util/Load'
import { UserAgentManager } from './UserAgent'

import type { Account, AccountProxy } from '../interface/Account'

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

interface BrowserCreationResult {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

class Browser {
    private readonly bot: MicrosoftRewardsBot
    private static readonly BROWSER_ARGS = [
        '--no-sandbox',
        '--mute-audio',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-user-media-security=true',
        '--disable-blink-features=Attestation',
        '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys',
        '--disable-save-password-bubble',
        // 设置时区为亚洲/上海（UTC+8）
        '--timezone=Asia/Shanghai',
        // 设置默认语言为中文
        '--lang=zh-CN',
        '--accept-lang=zh-CN,zh;q=0.9,en;q=0.8'
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        let browser: rebrowser.Browser
        try {
            const proxyConfig = account.proxy.url
                ? {
                      server: this.formatProxyServer(account.proxy),
                      ...(account.proxy.username &&
                          account.proxy.password && {
                              username: account.proxy.username,
                              password: account.proxy.password
                          })
                  }
                : undefined

            browser = await rebrowser.chromium.launch({
                headless: this.bot.config.headless,
                ...(proxyConfig && { proxy: proxyConfig }),
                args: [...Browser.BROWSER_ARGS]
            })
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Launch failed: ${errorMessage}`)
            throw error
        }

        try {
            const sessionData = await loadSessionData(
                this.bot.config.sessionPath,
                account.email,
                account.saveFingerprint,
                this.bot.isMobile
            )

            let fingerprint = sessionData.fingerprint

            // 指纹自检 & 质量评估：检测已保存的指纹是否损坏或不合规（如 Mac 特征泄漏到 Android，或 SwiftShader 泄漏）
            let needsRegenerate = false
            if (fingerprint) {
                const fp = fingerprint.fingerprint || {}
                const nav = fp.navigator || {}
                const screen = (fp.screen || {}) as any
                const vc = fp.videoCard || {}
                const fonts = fp.fonts || []

                const savedPlatform = nav.platform || ''
                const savedUA = nav.userAgent || ''
                const expectedPlatformKeyword = this.bot.isMobile ? 'Linux' : 'Win'
                const hasCorrectUA = this.bot.isMobile
                    ? savedUA.includes('Android') && savedUA.includes('EdgA')
                    : savedUA.includes('Windows') && savedUA.includes('Edg/')

                if (!savedPlatform.includes(expectedPlatformKeyword) || !hasCorrectUA) {
                    needsRegenerate = true
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BROWSER',
                        `Saved fingerprint is corrupted (platform: "${savedPlatform}", UA match: ${hasCorrectUA}), regenerating...`
                    )
                } else if (this.bot.isMobile) {
                    // 移动端深度自检
                    const hasMacGPULeak = vc.renderer && (vc.renderer.includes('Apple') || vc.renderer.includes('Metal') || vc.renderer.includes('M2') || vc.renderer.includes('M1'))
                    const hasDesktopGPULeak = vc.renderer && (vc.renderer.includes('Intel') || vc.renderer.includes('NVIDIA') || vc.renderer.includes('AMD') || vc.renderer.includes('SwiftShader') || vc.renderer.includes('GeForce'))
                    const hasMacFontLeak = fonts.some((f: any) => typeof f === 'string' && (f.includes('Helvetica Neue') || f.includes('Menlo') || f.includes('Gill Sans') || f.includes('Arial Unicode MS')))
                    const hasDesktopResolution = screen.width > 800
                    const hasZeroTouchPoints = nav.maxTouchPoints === 0
                    const hasMobileCoordinateLeak = (screen.availLeft && screen.availLeft !== 0) || 
                                                     (screen.availTop && screen.availTop !== 0) || 
                                                     (screen.screenX && screen.screenX !== 0) || 
                                                     (screen.screenY && screen.screenY !== 0)

                    if (hasMacGPULeak || hasDesktopGPULeak || hasMacFontLeak || hasDesktopResolution || hasZeroTouchPoints || hasMobileCoordinateLeak) {
                        needsRegenerate = true
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'BROWSER',
                            `Saved mobile fingerprint has low quality, coordinate leaks, or leaked desktop/Mac features, regenerating...`
                        )
                    }
                } else {
                    // 桌面端深度自检
                    const hasSoftwareGPULeak = vc.renderer && (vc.renderer.includes('SwiftShader') || vc.renderer.includes('software') || vc.renderer.includes('Microsoft'))
                    if (hasSoftwareGPULeak) {
                        needsRegenerate = true
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'BROWSER',
                            `Saved desktop fingerprint is using software SwiftShader GPU, regenerating...`
                        )
                    }
                }
            } else {
                needsRegenerate = true
            }

            if (needsRegenerate) {
                fingerprint = await this.generateFingerprint(this.bot.isMobile)
            }

            const userAgentManager = new UserAgentManager(this.bot)
            fingerprint = userAgentManager.normalizeFingerprint(fingerprint, this.bot.isMobile, account.langCode)

            const context = await newInjectedContext(browser as any, { fingerprint })

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'credentials', {
                    value: {
                        create: () => Promise.reject(new Error('WebAuthn disabled')),
                        get: () => Promise.reject(new Error('WebAuthn disabled'))
                    }
                })
            })

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            // 屏蔽不必要的资源类型和被墙域名以加速页面加载
            // 注意：Dockerfile 镜像源是构建时问题（GitHub Actions 海外构建不受影响），
            // 但此处是运行时逻辑，容器在国内运行时 Google 域名会被墙导致页面卡死
            await context.route('**/*', async (route, request) => {
                const url = request.url()
                const resourceType = request.resourceType()
                if (
                    resourceType === 'media' ||
                    resourceType === 'font' ||
                    url.includes('googleapis.com') ||
                    url.includes('gstatic.com') ||
                    url.includes('google-analytics.com') ||
                    url.includes('doubleclick.net') ||
                    url.includes('googletagmanager.com')
                ) {
                    await route.abort()
                } else {
                    await route.continue()
                }
            })

            await context.addCookies(sessionData.cookies)

            if (
                (account.saveFingerprint.mobile && this.bot.isMobile) ||
                (account.saveFingerprint.desktop && !this.bot.isMobile)
            ) {
                await saveFingerprintData(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint)
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Created browser with User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`
            )
            this.bot.logger.debug(this.bot.isMobile, 'BROWSER-FINGERPRINT', JSON.stringify(fingerprint))

            return { context: context as unknown as BrowserContext, fingerprint }
        } catch (error) {
            await browser.close().catch(() => {})
            throw error
        }
    }

    private formatProxyServer(proxy: AccountProxy): string {
        try {
            const urlObj = new URL(proxy.url)
            const protocol = urlObj.protocol.replace(':', '')
            return `${protocol}://${urlObj.hostname}:${proxy.port}`
        } catch {
            return `${proxy.url}:${proxy.port}`
        }
    }

    async generateFingerprint(isMobile: boolean) {
        // 严格限制 operatingSystems 以防止 FingerprintGenerator 发生跨系统 Relax
        // 移动端仅使用 android，桌面端仅使用 windows
        const fingerPrintData = new FingerprintGenerator().getFingerprint({
            devices: isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: isMobile ? ['android'] : ['windows'],
            browsers: [{ name: 'edge' }]
        })

        const userAgentManager = new UserAgentManager(this.bot)
        const updatedFingerPrintData = await userAgentManager.updateFingerprintUserAgent(fingerPrintData, isMobile)

        return updatedFingerPrintData
    }
}

export default Browser
