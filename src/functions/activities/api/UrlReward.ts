import type { AxiosRequestConfig } from 'axios'
import type { BasePromotion } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'

export class UrlReward extends Workers {
    private cookieHeader: string = ''

    private fingerprintHeader: { [x: string]: string } = {}

    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doUrlReward(promotion: BasePromotion) {
        // 【新 UI 适配】：如果没有 Request token，使用 UI 点击模拟 (Next.js 架构)
        if (!this.bot.requestToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Token missing (New UI). Fallback: Simulating UI Click on Dashboard...`
            )

            try {
                const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                if (page) {
                    const dashboardUrl = 'https://rewards.bing.com/dashboard'
                    
                    // 1. 确保在 Dashboard 页面
                    if (!page.url().includes('rewards.bing.com/dashboard')) {
                        this.bot.logger.debug(this.bot.isMobile, 'URL-REWARD', 'Navigating to Dashboard...')
                        await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
                        // 等待 React 渲染 (等待用户卡片出现)
                        await page.waitForSelector('#user-card', { timeout: 10000 }).catch(() => {})
                    }

                    // 2. 尝试查找并点击对应的任务卡片（使用标题定位）
                    // promotion.title 是从 Dashboard API 获取到的真实标题 (例如 "钟楼奇观？")
                    this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Attempting to click card: "${promotion.title}"`)
                    
                    const target = page.getByText(promotion.title, { exact: false }).first()
                    const isVisible = await target.isVisible({ timeout: 5000 }).catch(() => false)
                    
                    if (isVisible) {
                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Found card! Clicking to trigger activity...`)
                        await target.click()
                        
                        // 3. 等待网络请求完成 (捕获点击后触发的隐形 API 调用)
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
                        
                        // 4. 额外等待确保后端记录
                        await this.bot.utils.wait(this.bot.utils.randomDelay(4000, 7000))

                        // 5. 无论跳转到哪里，都回到 Dashboard
                        if (!page.url().includes('rewards.bing.com/dashboard')) {
                            this.bot.logger.debug(this.bot.isMobile, 'URL-REWARD', 'Returning to Dashboard...')
                            await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                        }
                    } else {
                        this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Card "${promotion.title}" not found. Trying destination URL.`)
                        // 备选方案：访问链接
                        if (promotion.destinationUrl) {
                            await page.goto(promotion.destinationUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
                            await this.bot.utils.wait(5000)
                        }
                    }
                }
            } catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'URL-REWARD', `Fallback interaction failed: ${error instanceof Error ? error.message : String(error)}`)
            }
            return
        }

        const offerId = promotion.offerId

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | oldBalance=${this.oldBalance}`
        )

        try {
            this.cookieHeader = this.bot.browser.func.buildCookieHeader(
                this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop, [
                    'bing.com',
                    'live.com',
                    'microsoftonline.com'
                ]
            )

            const fingerprintHeaders = { ...this.bot.fingerprint.headers }
            delete fingerprintHeaders['Cookie']
            delete fingerprintHeaders['cookie']
            this.fingerprintHeader = fingerprintHeaders

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Prepared UrlReward headers | offerId=${offerId} | cookieLength=${this.cookieHeader.length} | fingerprintHeaderKeys=${Object.keys(this.fingerprintHeader).length}`
            )

            const formData = new URLSearchParams({
                id: offerId,
                hash: promotion.hash,
                timeZone: '60',
                activityAmount: '1',
                dbs: '0',
                form: '',
                type: '',
                __RequestVerificationToken: this.bot.requestToken
            })

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Prepared UrlReward form data | offerId=${offerId} | hash=${promotion.hash} | timeZone=60 | activityAmount=1`
            )

            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                method: 'POST',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.cookieHeader,
                    Referer: promotion.destinationUrl, // 使用活动链接作为 Referer
                    Origin: 'https://rewards.bing.com'
                },
                data: formData
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Sending UrlReward request | offerId=${offerId} | url=${request.url}`
            )

            const response = await this.bot.axios.request(request)

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Received UrlReward response | offerId=${offerId} | status=${response.status}`
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.gainedPoints = newBalance - this.oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Balance delta after UrlReward | offerId=${offerId} | oldBalance=${this.oldBalance} | newBalance=${newBalance} | gainedPoints=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward | offerId=${offerId} | status=${response.status} | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Failed UrlReward with no points | offerId=${offerId} | status=${response.status} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                )
            }

            this.bot.logger.debug(this.bot.isMobile, 'URL-REWARD', `Waiting after UrlReward | offerId=${offerId}`)

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlReward | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
