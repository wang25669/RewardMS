import fs from 'fs/promises'
import path from 'path'
import type { Page } from 'patchright'

export async function errorDiagnostic(page: Page, error: Error): Promise<void> {
    try {
        if (!page) {
            return
        }

        if (page.isClosed()) {
            return
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const folderName = `error-${timestamp}`
        const outputDir = path.join(process.cwd(), 'diagnostics', folderName)

        // Error log content
        const errorLog = `
Name: ${error.name}
Message: ${error.message}
Timestamp: ${new Date().toISOString()}
---------------------------------------------------
Stack Trace:
${error.stack || 'No stack trace available'}
        `.trim()

        const [htmlContent, screenshotBuffer] = await Promise.all([
            page.content().catch(() => ''),
            page.isClosed() ? null : page.screenshot({ fullPage: true, type: 'png' }).catch(() => null)
        ])

        if (!htmlContent && !screenshotBuffer) {
            return
        }

        await fs.mkdir(outputDir, { recursive: true })

        const writes = [
            fs.writeFile(path.join(outputDir, 'dump.html'), htmlContent),
            fs.writeFile(path.join(outputDir, 'error.txt'), errorLog)
        ]

        if (screenshotBuffer) {
            writes.push(fs.writeFile(path.join(outputDir, 'screenshot.png'), screenshotBuffer))
        }

        await Promise.all(writes)

        console.log(`Diagnostics saved to: ${outputDir}`)
    } catch (error) {
        console.warn(
            `Unable to create error diagnostics: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}
