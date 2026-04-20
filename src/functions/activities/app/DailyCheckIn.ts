import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { Workers } from '../../Workers'

export class DailyCheckIn extends Workers {
    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doDailyCheckIn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `Starting Daily Check-In | geo=${this.bot.userData.geoLocale} | currentPoints=${this.oldBalance}`
        )

        try {
            // 以 mitmproxy 抓包为准，中国区签到 type=103
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', 'Attempting Daily Check-In | type=103')

            const response = await this.submitDaily()
            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Received Daily Check-In response | type=103 | status=${response?.status ?? 'unknown'}`
            )

            const newBalance = Number(response?.data?.response?.balance ?? this.oldBalance)
            this.gainedPoints = newBalance - this.oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Balance delta after Daily Check-In | type=103 | oldBalance=${this.oldBalance} | newBalance=${newBalance} | gainedPoints=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Completed Daily Check-In | type=103 | gainedPoints=${this.gainedPoints} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Daily Check-In completed but no points gained (may already be checked in today) | oldBalance=${this.oldBalance} | finalBalance=${newBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error during Daily Check-In | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async submitDaily() {
        try {
            // 请求体与 mitmproxy 抓包完全一致
            const jsonData = {
                amount: 1,
                attributes: {},
                id: randomUUID(),
                type: 103,
                country: 'cn',
                risk_context: {},
                channel: 'SAAndroid'
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Preparing Daily Check-In payload | type=103 | id=${jsonData.id} | amount=${jsonData.amount} | country=${jsonData.country}`
            )

            // 请求头与 mitmproxy 抓包对齐（Android BingSapphire）
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${this.bot.accessToken}`,
                    'x-rewards-partnerid': 'startapp',
                    'x-rewards-appid': 'SAAndroid/31.1.2110003554',
                    'x-rewards-ismobile': 'true',
                    'x-rewards-country': 'cn',
                    'x-rewards-language': 'zh',
                    'x-rewards-flights': 'rwgobig',
                    'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.002; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 BingSapphire/31.1.2110003554',
                    'content-type': 'application/json; charset=utf-8',
                },
                data: JSON.stringify(jsonData)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Sending Daily Check-In request | type=103 | url=${request.url}`
            )

            return this.bot.axios.request(request)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error in submitDaily | type=103 | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
