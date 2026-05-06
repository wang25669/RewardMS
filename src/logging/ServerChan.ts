import axios, { AxiosRequestConfig } from 'axios'
import PQueue from 'p-queue'
import type { WebhookServerChanConfig } from '../interface/Config'

const serverChanQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export async function sendServerChan(config: WebhookServerChanConfig | undefined, desp: string): Promise<void> {
    if (!config?.enabled || !config.sendKey) return

    const data = new URLSearchParams()
    data.append('title', config.title || 'Microsoft Rewards \u6bcf\u65e5\u6c47\u603b')
    data.append('desp', desp)

    const request: AxiosRequestConfig = {
        method: 'POST',
        url: `https://sctapi.ftqq.com/${config.sendKey}.send`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data,
        timeout: 10000
    }

    await serverChanQueue.add(async () => {
        await axios(request)
    })
}

export async function flushServerChanQueue(timeoutMs = 5000): Promise<void> {
    await Promise.race([
        (async () => {
            await serverChanQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('serverChan flush timeout')), timeoutMs))
    ]).catch(() => {})
}
