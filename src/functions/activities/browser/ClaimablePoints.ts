import fs from 'fs'
import path from 'path'
import type { Frame, Page } from 'patchright'

import { Workers } from '../../Workers'
import type { Account } from '../../../interface/Account'

interface ClaimablePointsState {
    lastAttemptAt?: string
}

type SearchContext = Page | Frame

export class ClaimablePoints extends Workers {
    private readonly dashboardUrl = 'https://rewards.bing.com/dashboard'
    private readonly intervalMs = 3 * 24 * 60 * 60 * 1000
    private readonly stateFileName = 'claimable_points_state.json'
    private readonly pointsText = '\u79ef\u5206'
    private readonly claimableText = '\u53ef\u9886\u53d6'
    private readonly claimPointsText = '\u9886\u53d6\u79ef\u5206'

    public async doClaimablePoints(page: Page, account: Account): Promise<void> {
        const statePath = this.getStatePath(account.email)

        if (!this.shouldRun(statePath)) {
            this.bot.logger.info(this.bot.isMobile, 'CLAIMABLE-POINTS', 'Skipping: last attempt was within 3 days')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'CLAIMABLE-POINTS', 'Checking dashboard claimable points')

        let reachedDashboard = false
        const oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        try {
            await page.goto(this.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })
            reachedDashboard = true
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
            await this.dismissBlockingMessages(page)
            await this.bot.utils.wait(1500)

            const opened = await this.openClaimablePanel(page)
            let clicked = false

            if (opened) {
                await this.bot.utils.wait(2000)
                clicked = await this.clickClaimButton(page)
            }

            if (!clicked) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIMABLE-POINTS',
                    'No visible "claim points" button found on dashboard'
                )
                return
            }

            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
            await this.bot.utils.wait(3000)

            const newBalance = await this.bot.browser.func.getCurrentPoints().catch(() => oldBalance)
            const gainedPoints = Math.max(0, Number(newBalance) - oldBalance)

            if (gainedPoints > 0) {
                this.bot.userData.currentPoints = Number(newBalance)
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIMABLE-POINTS',
                `Claim action completed | gainedPoints=${gainedPoints} | oldBalance=${oldBalance} | newBalance=${newBalance}`,
                gainedPoints > 0 ? 'green' : undefined
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIMABLE-POINTS',
                `Claim attempt failed: ${error instanceof Error ? error.message : String(error)}`
            )
        } finally {
            if (reachedDashboard) {
                this.saveState(statePath)
            }
        }
    }

    private async dismissBlockingMessages(page: Page): Promise<void> {
        const selectors = [
            '#acceptButton',
            '#wcpConsentBannerCtrl > * > button:first-child',
            '#bnp_btn_accept',
            '#bnp_btn_reject',
            'button[aria-label*="Reject" i]'
        ]

        for (const selector of selectors) {
            const locator = page.locator(selector).first()
            if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
                await locator.click({ timeout: 3000 }).catch(() => {})
                await this.bot.utils.wait(250)
            }
        }
    }

    private async openClaimablePanel(page: Page): Promise<boolean> {
        const selectors = [
            `button:has-text("${this.claimableText}")`,
            `a:has-text("${this.claimableText}")`,
            `[role="button"]:has-text("${this.claimableText}")`,
            `[aria-label*="${this.claimableText}" i]`
        ]

        for (const selector of selectors) {
            const locator = page.locator(selector).first()
            if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
                this.bot.logger.debug(this.bot.isMobile, 'CLAIMABLE-POINTS', 'Opening claimable points panel')
                await locator.click({ timeout: 5000 }).catch(() => {})
                return true
            }
        }

        const openedByCard = await page.evaluate(({ claimableText, pointsText }) => {
            const isVisible = (element: Element) => {
                const style = window.getComputedStyle(element)
                const rect = element.getBoundingClientRect()
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
            }

            const clickableSelector = 'button, a, [role="button"], [onclick], [tabindex]'

            const getClickableTarget = (element: Element) => {
                const direct = element.closest(clickableSelector)
                if (direct && isVisible(direct)) return direct as HTMLElement

                let target: Element | null = element
                while (target && target !== document.body) {
                    const rect = target.getBoundingClientRect()
                    const text = target.textContent ?? ''
                    const looksLikeCard =
                        rect.width >= 120 &&
                        rect.width <= 380 &&
                        rect.height >= 70 &&
                        rect.height <= 220 &&
                        text.includes(claimableText) &&
                        text.includes(pointsText)

                    if (looksLikeCard && isVisible(target)) return target as HTMLElement
                    target = target.parentElement
                }

                return null
            }

            const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, section'))
                .map(element => {
                    const rect = element.getBoundingClientRect()
                    const text = `${element.textContent ?? ''} ${(element.getAttribute('aria-label') ?? '')}`
                    const target = getClickableTarget(element)
                    return { element, rect, text, target }
                })
                .filter(x => {
                    return (
                        isVisible(x.element) &&
                        x.target &&
                        x.rect.top < 420 &&
                        x.text.includes(claimableText) &&
                        x.text.includes(pointsText)
                    )
                })
                .sort((a, b) => {
                    const areaA = a.rect.width * a.rect.height
                    const areaB = b.rect.width * b.rect.height
                    return areaA - areaB
                })

            const target = candidates[0]?.target
            if (!target) return false
            target.click()
            return true
        }, { claimableText: this.claimableText, pointsText: this.pointsText })

        if (openedByCard) {
            this.bot.logger.debug(this.bot.isMobile, 'CLAIMABLE-POINTS', 'Opened claimable points panel by card text')
        }

        return openedByCard
    }

    private async clickClaimButton(page: Page): Promise<boolean> {
        const contexts: SearchContext[] = [page, ...page.frames()]
        const selectors = [
            `button:has-text("${this.claimPointsText}")`,
            `a:has-text("${this.claimPointsText}")`,
            `[role="button"]:has-text("${this.claimPointsText}")`,
            'button:has-text("Claim points")',
            'a:has-text("Claim points")',
            '[role="button"]:has-text("Claim points")',
            'button:has-text("Claim")',
            '[role="button"]:has-text("Claim")'
        ]

        for (const context of contexts) {
            for (const selector of selectors) {
                const locator = context.locator(selector).first()
                if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
                    this.bot.logger.info(this.bot.isMobile, 'CLAIMABLE-POINTS', 'Clicking claim button')
                    await locator.click({ timeout: 5000 })
                    return true
                }
            }
        }

        return false
    }

    private shouldRun(statePath: string): boolean {
        try {
            if (!fs.existsSync(statePath)) return true

            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as ClaimablePointsState
            if (!state.lastAttemptAt) return true

            const lastAttemptMs = new Date(state.lastAttemptAt).getTime()
            if (!Number.isFinite(lastAttemptMs)) return true

            return Date.now() - lastAttemptMs >= this.intervalMs
        } catch {
            return true
        }
    }

    private saveState(statePath: string): void {
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true })
            const state: ClaimablePointsState = { lastAttemptAt: new Date().toISOString() }
            fs.writeFileSync(statePath, JSON.stringify(state))
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIMABLE-POINTS',
                `Failed to save state: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private getStatePath(email: string): string {
        return path.join(__dirname, '../../../browser', this.bot.config.sessionPath, email, this.stateFileName)
    }
}
