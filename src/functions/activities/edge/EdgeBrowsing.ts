import type { AxiosRequestConfig } from 'axios'
import type { MicrosoftRewardsBot } from '../../../index'

type EdgeBrowsingPromotion = {
    name?: string
    attributes?: Record<string, string | undefined>
}

interface EdgeBrowsingReporterOptions {
    userAgent?: string
}

export class EdgeBrowsingReporter {
    private readonly offerId = 'DailyCheckIn_Edge'
    private readonly activityType = '29'
    private readonly reportIntervalMs = 5 * 60 * 1000
    private readonly maxReports = 6
    private sentReports = 0
    private timer: NodeJS.Timeout | null = null

    constructor(
        private bot: MicrosoftRewardsBot,
        private options: EdgeBrowsingReporterOptions = {}
    ) {}

    async start(): Promise<void> {
        if (this.bot.config.workers.doEdgeBrowsing === false) {
            this.bot.logger.info(false, 'EDGE-BROWSING', 'Skipping: worker disabled in config')
            return
        }

        if (!this.bot.accessToken) {
            this.bot.logger.warn(false, 'EDGE-BROWSING', 'Skipping: app access token not available')
            return
        }

        const eligible = await this.isEligible()
        if (!eligible) {
            return
        }

        this.bot.logger.info(
            false,
            'EDGE-BROWSING',
            `Starting Edge browsing reporter | interval=${this.reportIntervalMs / 60000}min | maxReports=${this.maxReports}`
        )

        this.timer = setInterval(() => {
            void this.reportOnce()
        }, this.reportIntervalMs)
    }

    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }

        if (this.sentReports > 0) {
            this.bot.logger.info(false, 'EDGE-BROWSING', `Stopped Edge browsing reporter | reportsSent=${this.sentReports}`)
        }
    }

    private async isEligible(): Promise<boolean> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=edge&options=Profile,Promotions',
                method: 'GET',
                headers: this.edgeHeaders()
            }

            const response = await this.bot.axios.request(request)
            const promotions = (response?.data?.response?.promotions ?? []) as EdgeBrowsingPromotion[]
            const promotion = promotions.find(p => p.name === 'edge_browsing_streak_flight')

            if (!promotion) {
                this.bot.logger.info(false, 'EDGE-BROWSING', 'Skipping: Edge browsing streak promotion not found')
                return false
            }

            const attributes = promotion.attributes ?? {}
            const complete = attributes.complete?.toLowerCase() === 'true'

            this.bot.logger.debug(
                false,
                'EDGE-BROWSING',
                `Promotion status | offerId=${attributes.offerid ?? this.offerId} | complete=${attributes.complete} | reportEvery=${attributes.report_per_minutes ?? '5'}min`
            )

            if (complete) {
                this.bot.logger.info(false, 'EDGE-BROWSING', 'Skipping: Edge browsing streak already complete')
                return false
            }

            return true
        } catch (error) {
            this.bot.logger.warn(
                false,
                'EDGE-BROWSING',
                `Skipping: failed to inspect Edge browsing promotion | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async reportOnce(): Promise<void> {
        if (this.sentReports >= this.maxReports) {
            await this.stop()
            return
        }

        try {
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: this.edgeHeaders(),
                data: JSON.stringify({
                    amount: 1,
                    attributes: {
                        offerid: this.offerId
                    },
                    request_user_info: true,
                    type: this.activityType
                })
            }

            const response = await this.bot.axios.request(request)
            const activity = response?.data?.response?.activity
            this.sentReports++

            this.bot.logger.info(
                false,
                'EDGE-BROWSING',
                `Reported Edge browsing usage | report=${this.sentReports}/${this.maxReports} | status=${response.status} | type=${activity?.type ?? this.activityType}`
            )
        } catch (error) {
            this.bot.logger.warn(
                false,
                'EDGE-BROWSING',
                `Report failed | report=${this.sentReports + 1}/${this.maxReports} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private edgeHeaders(): Record<string, string> {
        const country = (this.bot.userData.geoLocale || 'cn').toUpperCase()
        const userAgent =
            this.options.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0'

        return {
            authorization: `Bearer ${this.bot.accessToken}`,
            'x-rewards-appid': 'EdgeDesktop',
            'x-rewards-country': country,
            'x-rewards-language': 'zh-CN',
            'x-rewards-partnerid': 'EdgeHub',
            'user-agent': userAgent,
            'content-type': 'application/json'
        }
    }
}
