import { describe, expect, it, spyOn } from 'bun:test'
import createExtractionProgressReporter from '@/modules/extraction/create-extraction-progress-reporter'
import consoleOutput from '@/support/console-output'
import stripAnsi from '@/support/strip-ansi'

describe('extraction progress reporter', () => {
    it('animates interactive progress independently of progress events', async () => {
        const output: string[] = []
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
            const reporter = createExtractionProgressReporter()

            reporter.report({
                current: 1,
                path: 'src/slow-file.ts',
                phase: 'sections',
                status: 'progress',
                total: 4,
            })
            await new Promise(resolve => setTimeout(resolve, 225))
            reporter.done()

            const rendered = stripAnsi(output.join(''))
            expect(rendered).toContain('⠋  25% 1/4')
            expect(rendered).toContain('⠙  25% 1/4')
            expect(rendered).toContain('⠹  25% 1/4')
            expect(rendered).toContain('Extracting files')
        } finally {
            errorSpy.mockRestore()
            interactiveSpy.mockRestore()
        }
    })

    it('does not animate non-interactive progress output', async () => {
        const output: string[] = []
        const errorSpy = spyOn(consoleOutput, 'error').mockImplementation(
            message => {
                output.push(message)
            },
        )
        const interactiveSpy = spyOn(
            consoleOutput,
            'stderrIsInteractive',
        ).mockReturnValue(false)

        try {
            const reporter = createExtractionProgressReporter()

            reporter.report({
                current: 1,
                path: 'src/slow-file.ts',
                phase: 'sections',
                status: 'progress',
                total: 4,
            })
            await new Promise(resolve => setTimeout(resolve, 225))
            reporter.done()

            expect(output).toEqual([
                'Extracting files   25% 1/4  Extracting files',
            ])
        } finally {
            errorSpy.mockRestore()
            interactiveSpy.mockRestore()
        }
    })
})
