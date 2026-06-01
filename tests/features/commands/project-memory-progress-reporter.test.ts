import { describe, expect, it, spyOn } from 'bun:test'
import createProjectMemoryProgressReporter from '@/entrypoints/cli/commands/_support/project-memory-progress-reporter'
import consoleOutput from '@/support/console-output'

describe('project memory progress reporter', () => {
    it('shows transient vector index sync progress at batch boundaries', () => {
        const output: string[] = []
        const logSpy = spyOn(consoleOutput, 'print').mockImplementation(
            message => {
                output.push(String(message))
                return consoleOutput
            },
        )
        const errorSpy = spyOn(consoleOutput, 'writeError').mockImplementation(
            message => {
                output.push(String(message))
                return consoleOutput
            },
        )

        try {
            const reporter = createProjectMemoryProgressReporter()

            reporter.report({
                phase: 'embeddings',
                stage: 'embed',
                status: 'start',
                total: 18868,
            })
            reporter.report({
                current: 10000,
                phase: 'embeddings',
                stage: 'embed',
                status: 'progress',
                total: 18868,
            })
            reporter.report({
                batchCurrent: 2,
                batchSize: 5000,
                batchTotal: 4,
                current: 10000,
                phase: 'embeddings',
                stage: 'index',
                status: 'start',
                total: 18868,
            })
            reporter.report({
                batchCurrent: 2,
                batchSize: 5000,
                batchTotal: 4,
                current: 10000,
                phase: 'embeddings',
                stage: 'index',
                status: 'done',
                total: 18868,
            })
            reporter.report({
                current: 10001,
                phase: 'embeddings',
                stage: 'embed',
                status: 'progress',
                total: 18868,
            })

            const rendered = stripAnsi(output.join(''))
            expect(rendered).toContain('⏸ 10000/18868 vectors indexed')
            expect(rendered).toContain(
                'Syncing vector index: batch 2/4, writing 5000 vectors...',
            )
            expect(rendered).toContain('10001/18868 vectors indexed')
            expect(rendered).toMatch(
                /Syncing vector index: batch 2\/4, writing 5000 vectors\.\.\.\r +\r/u,
            )
        } finally {
            logSpy.mockRestore()
            errorSpy.mockRestore()
        }
    })
})

function stripAnsi(value: string): string {
    const ansiPattern = new RegExp(
        `${String.fromCharCode(27)}\\[[0-9;]*m`,
        'gu',
    )
    return value.replaceAll(ansiPattern, '')
}
