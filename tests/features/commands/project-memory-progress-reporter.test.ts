import { describe, expect, it, spyOn } from 'bun:test'
import createProjectMemoryProgressReporter from '@/entrypoints/cli/commands/_support/project-memory-progress-reporter'
import consoleOutput from '@/support/console-output'
import stripAnsi from '@/support/strip-ansi'

describe('project memory progress reporter', () => {
    it('shows transient vector index sync progress at batch boundaries', async () => {
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
        const interactiveSpy = spyOn(
            consoleOutput,
            'stderrIsInteractive',
        ).mockReturnValue(true)

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
            await new Promise(resolve => setTimeout(resolve, 125))
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
            reporter.done()

            const rendered = stripAnsi(output.join(''))
            expect(rendered).toContain('⏸ 10000/18868 vectors indexed')
            expect(rendered).toContain(
                '⠋ Syncing vector index: batch 2/4, writing 5000 vectors...',
            )
            expect(rendered).toContain(
                '⠙ Syncing vector index: batch 2/4, writing 5000 vectors...',
            )
            expect(rendered).toContain('10001/18868 vectors indexed')
            expect(rendered).toContain(`${String.fromCharCode(27)}[1A`)
            expect(rendered).not.toContain('◐')
            expect(rendered).not.toContain('◓')
            expect(rendered).not.toContain('◑')
            expect(rendered).not.toContain('◒')
        } finally {
            logSpy.mockRestore()
            errorSpy.mockRestore()
            interactiveSpy.mockRestore()
        }
    })

    it('animates extraction progress independently of file progress events', async () => {
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
        const interactiveSpy = spyOn(
            consoleOutput,
            'stderrIsInteractive',
        ).mockReturnValue(true)

        try {
            const reporter = createProjectMemoryProgressReporter()

            reporter.report({
                current: 1,
                phase: 'sections',
                sectionCount: 3,
                status: 'progress',
                total: 10,
            })
            await new Promise(resolve => setTimeout(resolve, 225))
            reporter.done()

            const rendered = stripAnsi(output.join(''))
            expect(rendered).toContain('⠋ Extracting files: 1/10')
            expect(rendered).toContain('⠙ Extracting files: 1/10')
            expect(rendered).toContain('⠹ Extracting files: 1/10')
        } finally {
            logSpy.mockRestore()
            errorSpy.mockRestore()
            interactiveSpy.mockRestore()
        }
    })

    it('animates project memory extraction even when stderr is not a TTY', async () => {
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
        const interactiveSpy = spyOn(
            consoleOutput,
            'stderrIsInteractive',
        ).mockReturnValue(false)

        try {
            const reporter = createProjectMemoryProgressReporter()

            reporter.report({
                current: 1,
                phase: 'sections',
                sectionCount: 3,
                status: 'progress',
                total: 10,
            })
            await new Promise(resolve => setTimeout(resolve, 225))
            reporter.done()

            const rendered = stripAnsi(output.join(''))
            expect(rendered).toContain('⠋ Extracting files: 1/10')
            expect(rendered).toContain('⠙ Extracting files: 1/10')
            expect(rendered).toContain('⠹ Extracting files: 1/10')
        } finally {
            logSpy.mockRestore()
            errorSpy.mockRestore()
            interactiveSpy.mockRestore()
        }
    })
})
