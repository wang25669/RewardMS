import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'

import { IpcLog, Logger } from './logging/Logger'
import Utils from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { checkNodeVersion } from './util/Validator'

import { Login } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import { sendServerChan, flushServerChanQueue } from './logging/ServerChan'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'

interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    startedAt: string
    endedAt: string
    duration: number
    success: boolean
    error?: string
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as any }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs), flushServerChanQueue(timeoutMs)])
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString(undefined, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    })
}

function createAccountStats(
    email: string,
    startedAtMs: number,
    initialPoints: number,
    collectedPoints: number,
    success: boolean,
    error?: string
): AccountStats {
    const endedAtMs = Date.now()
    const finalPoints = initialPoints + collectedPoints

    return {
        email,
        initialPoints,
        finalPoints,
        collectedPoints,
        startedAt: formatTime(startedAtMs),
        endedAt: formatTime(endedAtMs),
        duration: parseFloat(((endedAtMs - startedAtMs) / 1000).toFixed(1)),
        success,
        error
    }
}

function formatDailyAccountSummary(stats: AccountStats[], runStartTime: number): string {
    const totalCollectedPoints = stats.reduce((sum, s) => sum + s.collectedPoints, 0)
    const successCount = stats.filter(s => s.success).length
    const failedCount = stats.length - successCount
    const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

    const lines = [
        'Microsoft Rewards \u6bcf\u65e5\u6c47\u603b',
        '',
        `\u8d26\u53f7\u6570\uff1a${stats.length}`,
        `\u6210\u529f\uff1a${successCount}`,
        `\u5931\u8d25\uff1a${failedCount}`,
        `\u4eca\u65e5\u603b\u83b7\u53d6\uff1a+${totalCollectedPoints}`,
        `\u603b\u8017\u65f6\uff1a${totalDurationMinutes}min`,
        ''
    ]

    for (const stat of stats) {
        lines.push(`- ${stat.email}${stat.success ? '' : ' \u5931\u8d25'}`)
        lines.push(`  \u79ef\u5206\uff1a${stat.initialPoints} + ${stat.collectedPoints} = ${stat.finalPoints}`)
        lines.push(`  \u5f00\u59cb\uff1a${stat.startedAt}`)
        lines.push(`  \u7ed3\u675f\uff1a${stat.endedAt}`)
        lines.push(`  \u8017\u65f6\uff1a${stat.duration.toFixed(1)}s`)
        lines.push('')
    }

    return lines.join('\n').trimEnd()
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

export class MicrosoftRewardsBot {
    public logger: Logger
    public config
    public utils: Utils
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData

    public accessToken = ''
    public requestToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    public fingerprint!: BrowserFingerprintWithHeaders

    private pointsCanCollect = 0

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)
    private searchManager: SearchManager

    public axios!: AxiosClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0
        }
        this.logger = new Logger(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Utils()
        this.workers = new Workers(this)
        this.searchManager = new SearchManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                this.runMaster(runStartTime)
            } else {
                this.runWorker(runStartTime)
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private runMaster(runStartTime: number): void {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []

        for (const chunk of accountChunks) {
            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog

                if (log && typeof log.content === 'string') {
                    const config = this.config
                    const webhook = config.webhook
                    const content = log.content
                    const level = log.level
                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                }
            })
        }

        const onWorkerDone = async (label: 'exit' | 'disconnect', worker: Worker, code?: number): Promise<void> => {
            const { pid } = worker.process
            this.activeWorkers -= 1

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            } else {
                this.exitedWorkers.push(pid)
            }

            this.logger.warn(
                'main',
                `CLUSTER-WORKER-${label.toUpperCase()}`,
                `Worker ${worker.process?.pid ?? '?'} ${label} | Code: ${code ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )
            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `Completed all accounts | Accounts processed: ${allAccountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                    'green'
                )
                await this.sendDailyAccountSummary(allAccountStats, runStartTime)
                await flushAllWebhooks()
                process.exit(code ?? 0)
            }
        }

        cluster.on('exit', (worker, code) => {
            void onWorkerDone('exit', worker, code)
        })
        cluster.on('disconnect', worker => {
            void onWorkerDone('disconnect', worker, undefined)
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)
        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} received ${chunk.length} accounts.`
            )
            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())
                if (process.send) {
                    process.send({ __stats: stats })
                }

                process.disconnect()
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )
                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async sendDailyAccountSummary(stats: AccountStats[], runStartTime: number): Promise<void> {
        const config = this.config.webhook.serverChan

        if (!config?.enabled || !config.sendKey) {
            return
        }

        try {
            await sendServerChan(config, formatDailyAccountSummary(stats, runStartTime))
        } catch (error) {
            this.logger.warn(
                'main',
                'SERVER-CHAN',
                `Failed to send daily account summary: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const account of accounts) {
            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)

            try {
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`
                )

                this.axios = new AxiosClient(account.proxy)

                const result: { initialPoints: number; collectedPoints: number } | undefined = await this.Main(
                    account
                ).catch(error => {
                    void this.logger.error(
                        true,
                        'FLOW',
                        `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints
                    const stats = createAccountStats(
                        accountEmail,
                        accountStartTime,
                        accountInitialPoints,
                        collectedPoints,
                        true
                    )
                    const durationSeconds = stats.duration.toFixed(1)

                    accountStats.push(stats)

                    this.logger.info(
                        'main',
                        'ACCOUNT-END',
                        `Completed account: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`,
                        'green'
                    )
                } else {
                    accountStats.push(createAccountStats(accountEmail, accountStartTime, 0, 0, false, 'Flow failed'))
                }
            } catch (error) {
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push(
                    createAccountStats(
                        accountEmail,
                        accountStartTime,
                        0,
                        0,
                        false,
                        error instanceof Error ? error.message : String(error)
                    )
                )
            }
        }

        if (this.config.clusters <= 1 && !cluster.isWorker) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | Accounts processed: ${accountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                'green'
            )

            await this.sendDailyAccountSummary(accountStats, runStartTime)
            await flushAllWebhooks()
            process.exit()
        }

        return accountStats
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                    )
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                // 尝试获取 Desktop Dashboard 数据（新 UI 可能失败）
                let data: DashboardData | null = null
                try {
                    data = await this.browser.func.getDashboardData()
                } catch (error) {
                    this.logger.warn(
                        this.isMobile,
                        'MAIN',
                        'Desktop dashboard API not available, using App dashboard as fallback'
                    )
                }

                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()

                // 设置语言代码 (优先使用 accounts.json 配置)
                this.userData.langCode = (account.langCode || 'en').toLowerCase()

                // 如果 Desktop API 失败，使用 App Dashboard 数据
                if (!data) {
                    // 从 App Dashboard 获取国家信息
                    const appCountry = appData.response.profile.attributes.country || 'cn'
                    this.userData.geoLocale =
                        account.geoLocale === 'auto' ? appCountry.toLowerCase() : account.geoLocale.toLowerCase()
                    const appBalance = Number(appData.response.balance ?? 0)
                    this.userData.initialPoints = appBalance
                    this.userData.currentPoints = appBalance
                    this.logger.info(
                        this.isMobile,
                        'GEO-LOCALE',
                        `Using App Dashboard country: ${this.userData.geoLocale}`
                    )
                } else {
                    // Set geo
                    this.userData.geoLocale =
                        account.geoLocale === 'auto'
                            ? data.userProfile.attributes.country
                            : account.geoLocale.toLowerCase()
                    if (this.userData.geoLocale.length > 2) {
                        this.logger.warn(
                            'main',
                            'GEO-LOCALE',
                            `The provided geoLocale is longer than 2 (${this.userData.geoLocale} | auto=${account.geoLocale === 'auto'}), this is likely invalid and can cause errors!`
                        )
                    }

                    const desktopBalance = Number(data.userStatus.availablePoints ?? 0)
                    this.userData.initialPoints = desktopBalance
                    this.userData.currentPoints = desktopBalance
                }
                const initialPoints = this.userData.initialPoints ?? 0

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                const appEarnable = await this.browser.func.getAppEarnablePoints()

                this.pointsCanCollect =
                    (browserEarnable?.mobileSearchPoints ?? 0) + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${this.pointsCanCollect} | Browser: ${
                        browserEarnable?.mobileSearchPoints ?? 0
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`
                )

                if (this.config.workers.doAppPromotions) await this.workers.doAppPromotions(appData)

                // Desktop Dashboard 相关任务（仅当 API 可用时执行）
                if (data) {
                    if (this.config.workers.doDailySet) await this.workers.doDailySet(data, this.mainMobilePage)
                    if (this.config.workers.doSpecialPromotions) await this.workers.doSpecialPromotions(data)
                    if (this.config.workers.doMorePromotions)
                        await this.workers.doMorePromotions(data, this.mainMobilePage)
                } else {
                    this.logger.warn(
                        this.isMobile,
                        'WORKERS',
                        'Skipping desktop tasks - Desktop Dashboard API not available'
                    )
                }

                if (this.config.workers.doDailyCheckIn) await this.activities.doDailyCheckIn()
                if (this.config.workers.doReadToEarn) await this.activities.doReadToEarn()

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                this.cookies.mobile = await initialContext.cookies()

                // 搜索任务也需要 data
                if (data) {
                    const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                        data,
                        missingSearchPoints,
                        mobileSession,
                        account,
                        accountEmail
                    )

                    mobileContextClosed = true

                    //this.userData.gainedPoints = mobilePoints + desktopPoints

                    // Mobile session 可能已关闭，直接用搜索获得的积分计算
                    //const collectedPoints = mobilePoints + desktopPoints

                    const finalPoints = Number(this.userData.currentPoints ?? initialPoints)
                    const collectedPoints = Math.max(0, finalPoints - initialPoints)
                    this.userData.gainedPoints = collectedPoints

                    this.logger.info(
                        'main',
                        'FLOW',
                        //`Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`
                        `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | Old: ${initialPoints} → New: ${finalPoints} | ${accountEmail}`
                    )

                    return {
                        initialPoints,
                        collectedPoints: collectedPoints || 0
                    }
                } else {
                    this.logger.warn(
                        this.isMobile,
                        'FLOW',
                        'Skipping search tasks - Desktop Dashboard API not available'
                    )
                    const finalPoints = Number(this.userData.currentPoints ?? initialPoints)
                    const collectedPoints = Math.max(0, finalPoints - initialPoints)
                    this.userData.gainedPoints = collectedPoints
                    return {
                        initialPoints,
                        collectedPoints
                    }
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch {}
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    // Check before doing anything
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
