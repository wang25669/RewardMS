import type { AxiosRequestConfig } from 'axios'
import type { Page } from 'patchright'
import type { BasePromotion } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'

export class Quiz extends Workers {
    private cookieHeader: string = ''

    private fingerprintHeader: { [x: string]: string } = {}

    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    async doQuiz(promotion: BasePromotion, page?: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        const startBalance = this.oldBalance

        this.bot.logger.info(
            this.bot.isMobile,
            'QUIZ',
            `Starting quiz | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax} | currentPoints=${startBalance}`
        )

        try {
            if (page && promotion.destinationUrl) {
                this.bot.logger.info(this.bot.isMobile, 'QUIZ', `Simulating UI Quiz interaction | url=${promotion.destinationUrl}`)
                await page.goto(promotion.destinationUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
                await this.bot.utils.wait(3000)

                let totalGained = 0
                let attempts = 0
                const maxAttempts = 20
                let noGainedCounter = 0

                for (let i = 0; i < maxAttempts; i++) {
                    const quizOptions = await page.$$('.b_cards .b_card button, [data-option], .wk_choicesInstContainer .wk_choiceCard')
                    if (quizOptions.length > 0) {
                        const randomIndex = Math.floor(Math.random() * quizOptions.length)
                        this.bot.logger.debug(this.bot.isMobile, 'QUIZ', `Found ${quizOptions.length} quiz options, clicking randomly`)
                        
                        try {
                            const option = quizOptions[randomIndex]
                            if (option) {
                                await option.click()
                                await this.bot.utils.wait(3000)
                            }
                        } catch (e) {
                            this.bot.logger.debug(this.bot.isMobile, 'QUIZ', `Error clicking quiz option: ${e}`)
                        }

                        const newBalance = await this.bot.browser.func.getCurrentPoints()
                        const gainedPoints = newBalance - this.oldBalance

                        attempts = i + 1

                        if (gainedPoints > 0) {
                            this.bot.userData.currentPoints = newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                            this.oldBalance = newBalance
                            totalGained += gainedPoints
                            this.gainedPoints += gainedPoints
                            noGainedCounter = 0
                            this.bot.logger.info(this.bot.isMobile, 'QUIZ', `Quiz interaction ${i + 1} | gainedPoints=${gainedPoints} | newBalance=${newBalance}`, 'green')
                            
                            // Check if we've reached the max points for this quiz
                            if (totalGained >= promotion.pointProgressMax) {
                                this.bot.logger.info(this.bot.isMobile, 'QUIZ', `Reached max points for quiz (${promotion.pointProgressMax}), ending.`)
                                break
                            }
                        } else {
                            noGainedCounter++
                            this.bot.logger.debug(this.bot.isMobile, 'QUIZ', `Quiz interaction ${i + 1} | no points gained yet | noGainedCounter=${noGainedCounter}`)
                            if (noGainedCounter >= 8) { // If clicked 8 times and no points, assume quiz is done or stuck
                                this.bot.logger.warn(this.bot.isMobile, 'QUIZ', `No points gained after multiple interactions, assuming quiz is complete or stuck.`)
                                break
                            }
                        }
                    } else {
                        // Sometimes there's an overlay or 'Start playing' button
                        const startBtn = await page.$('#rqStartQuiz')
                        if (startBtn) {
                            this.bot.logger.debug(this.bot.isMobile, 'QUIZ', `Found start quiz button, clicking`)
                            await startBtn.click().catch(() => {})
                            await this.bot.utils.wait(2000)
                        } else {
                            this.bot.logger.debug(this.bot.isMobile, 'QUIZ', `No quiz options found, waiting...`)
                            await this.bot.utils.wait(2000)
                            noGainedCounter++
                            if (noGainedCounter >= 8) break
                        }
                    }
                }
                
                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed the quiz via UI | offerId=${offerId} | attempts=${attempts} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
                
                return // Skip API logic
            }
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
                'QUIZ',
                `Prepared quiz headers | offerId=${offerId} | cookieLength=${this.cookieHeader.length} | fingerprintHeaderKeys=${Object.keys(this.fingerprintHeader).length}`
            )

            // 8-question quiz
            if (promotion.activityProgressMax === 80) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Detected 8-question quiz (activityProgressMax=80), marking as completed | offerId=${offerId}`
                )

                // Not implemented
                return
            }

            //Standard points quizzes (20/30/40/50 max)
            if ([20, 30, 40, 50].includes(promotion.pointProgressMax)) {
                let oldBalance = startBalance
                let gainedPoints = 0
                const maxAttempts = 20
                let totalGained = 0
                let attempts = 0

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUIZ',
                    `Starting ReportActivity loop | offerId=${offerId} | maxAttempts=${maxAttempts} | startingBalance=${oldBalance}`
                )

                for (let i = 0; i < maxAttempts; i++) {
                    try {
                        const jsonData = {
                            UserId: null,
                            TimeZoneOffset: -60,
                            OfferId: offerId,
                            ActivityCount: 1,
                            QuestionIndex: '-1'
                        }

                        const request: AxiosRequestConfig = {
                            url: 'https://www.bing.com/bingqa/ReportActivity?ajaxreq=1',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                cookie: this.cookieHeader,
                                ...this.fingerprintHeader
                            },
                            data: JSON.stringify(jsonData)
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Sending ReportActivity request | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | url=${request.url}`
                        )

                        const response = await this.bot.axios.request(request)

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Received ReportActivity response | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | status=${response.status}`
                        )

                        const newBalance = await this.bot.browser.func.getCurrentPoints()
                        gainedPoints = newBalance - oldBalance

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Balance delta after ReportActivity | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | oldBalance=${oldBalance} | newBalance=${newBalance} | gainedPoints=${gainedPoints}`
                        )

                        attempts = i + 1

                        if (gainedPoints > 0) {
                            this.bot.userData.currentPoints = newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                            oldBalance = newBalance
                            totalGained += gainedPoints
                            this.gainedPoints += gainedPoints

                            this.bot.logger.info(
                                this.bot.isMobile,
                                'QUIZ',
                                `ReportActivity ${i + 1} → ${response.status} | offerId=${offerId} | gainedPoints=${gainedPoints} | newBalance=${newBalance}`,
                                'green'
                            )
                        } else {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'QUIZ',
                                `ReportActivity ${i + 1} | offerId=${offerId} | no more points gained, ending quiz | lastBalance=${newBalance}`
                            )
                            break
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Waiting between ReportActivity attempts | attempt=${i + 1}/${maxAttempts} | offerId=${offerId}`
                        )

                        await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))
                    } catch (error) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'QUIZ',
                            `Error during ReportActivity | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
                        )
                        break
                    }
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed the quiz successfully | offerId=${offerId} | attempts=${attempts} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Unsupported quiz configuration | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'QUIZ',
                `Error in doQuiz | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
