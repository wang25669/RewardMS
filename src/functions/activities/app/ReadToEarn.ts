import type { AxiosRequestConfig } from 'axios'
import { randomBytes } from 'crypto'
import { Workers } from '../../Workers'

export class ReadToEarn extends Workers {
    public async doReadToEarn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'READ-TO-EARN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        const delayMin = this.bot.config.searchSettings.readDelay.min
        const delayMax = this.bot.config.searchSettings.readDelay.max
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'READ-TO-EARN',
            `Starting Read to Earn | geo=${this.bot.userData.geoLocale} | delayRange=${delayMin}-${delayMax} | currentPoints=${startBalance}`
        )

        try {
            const jsonData = {
                amount: 1,
                id: '1',
                type: 101,
                attributes: {
                    offerid: 'ENUS_readarticle3_30points'
                },
                country: this.bot.userData.geoLocale
            }

            const articleCount = 10
            let totalGained = 0
            let articlesRead = 0
            let oldBalance = startBalance

            for (let i = 0; i < articleCount; ++i) {
                jsonData.id = randomBytes(64).toString('hex')

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Submitting Read to Earn activity | article=${i + 1}/${articleCount} | id=${jsonData.id} | country=${jsonData.country}`
                )

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

                const response = await this.bot.axios.request(request)

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Received Read to Earn response | article=${i + 1}/${articleCount} | status=${response?.status ?? 'unknown'}`
                )

                const newBalance = Number(response?.data?.response?.balance ?? oldBalance)
                const gainedPoints = newBalance - oldBalance

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Balance delta after article | article=${i + 1}/${articleCount} | oldBalance=${oldBalance} | newBalance=${newBalance} | gainedPoints=${gainedPoints}`
                )

                if (gainedPoints <= 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `No points gained, stopping Read to Earn | article=${i + 1}/${articleCount} | status=${response.status} | oldBalance=${oldBalance} | newBalance=${newBalance}`
                    )
                    break
                }

                // Update point tracking
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                totalGained += gainedPoints
                articlesRead = i + 1
                oldBalance = newBalance

                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Read article ${i + 1}/${articleCount} | status=${response.status} | gainedPoints=${gainedPoints} | newBalance=${newBalance}`,
                    'green'
                )

                // Wait random delay between articles
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Waiting between articles | article=${i + 1}/${articleCount} | delayRange=${delayMin}-${delayMax}`
                )

                await this.bot.utils.wait(this.bot.utils.randomDelay(delayMin, delayMax))
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Completed Read to Earn | articlesRead=${articlesRead} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${finalBalance}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Error during Read to Earn | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
