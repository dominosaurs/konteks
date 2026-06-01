import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as progressReporterModule from '@/entrypoints/cli/commands/_support/project-memory-progress-reporter'
import * as extractorModule from '@/modules/extraction/create-project-extractor'
import consoleOutput, {
    type ConsoleColorPalette,
} from '@/support/console-output'
import stripAnsi from '@/support/strip-ansi'
import type { ExtractProjectResponse } from '@/types/extraction'

type ConsoleOutputMessage = Parameters<typeof consoleOutput.print>[0]

let confirmResult = true
const confirmCalls: unknown[] = []
let extractedResponse: ExtractProjectResponse = {
    deletedFilePaths: [],
    detectedParserLanguages: [],
    embeddedCount: 0,
    embeddingReusedCount: 0,
    extractedAt: '2026-01-01T00:00:00.000Z',
    fileCount: 0,
    languageCount: 0,
    loadedParserCount: 0,
    mode: 'rebuild',
    ok: true,
    projectRoot: process.cwd(),
    sectionCount: 0,
    summaryRef: 'project-summary',
    technologies: [],
    updatedFilePaths: [],
    vectorCount: 0,
}
const extractorCalls: unknown[] = []
const progressReports: unknown[] = []
const summaryReports: unknown[] = []
let progressDoneCount = 0

mock.module('@inquirer/confirm', () => ({
    default: async (options: unknown) => {
        confirmCalls.push(options)
        return confirmResult
    },
}))

mock.module('@inquirer/input', () => ({
    default: async () => '',
}))

mock.module('@inquirer/number', () => ({
    default: async () => undefined,
}))

mock.module('@inquirer/select', () => ({
    default: async () => undefined,
}))

afterEach(() => {
    mock.restore()
})

describe('RebuildCommand', () => {
    const createCommand = async () => {
        const { default: RebuildCommand } = await import(
            '@/entrypoints/cli/commands/rebuild-command'
        )
        return new RebuildCommand()
    }

    const resetState = () => {
        confirmResult = true
        extractedResponse = {
            deletedFilePaths: [],
            detectedParserLanguages: [],
            embeddedCount: 0,
            embeddingReusedCount: 0,
            extractedAt: '2026-01-01T00:00:00.000Z',
            fileCount: 0,
            languageCount: 0,
            loadedParserCount: 0,
            mode: 'rebuild',
            ok: true,
            projectRoot: process.cwd(),
            sectionCount: 0,
            summaryRef: 'project-summary',
            technologies: [],
            updatedFilePaths: [],
            vectorCount: 0,
        }
        extractorCalls.length = 0
        progressReports.length = 0
        summaryReports.length = 0
        confirmCalls.length = 0
        progressDoneCount = 0
    }

    const installExtractorSpies = (
        options: { mockProgress?: boolean } = {},
    ) => {
        const extractorSpy = spyOn(
            extractorModule,
            'default',
        ).mockImplementation(
            (options = {}) =>
                ({
                    async execute(request: unknown) {
                        extractorCalls.push(request)
                        options.onProgress?.({
                            message: 'complete',
                            phase: 'done',
                            status: 'done',
                        })
                        return extractedResponse
                    },
                }) as ReturnType<typeof extractorModule.default>,
        )
        const progressSpy =
            options.mockProgress === false
                ? undefined
                : spyOn(progressReporterModule, 'default').mockImplementation(
                      () => ({
                          done() {
                              progressDoneCount += 1
                          },
                          report(event: unknown) {
                              progressReports.push(event)
                          },
                          summary(result: unknown) {
                              summaryReports.push(result)
                          },
                      }),
                  )

        return { extractorSpy, progressSpy }
    }

    it('skips rebuild when confirmation returns false', async () => {
        resetState()
        confirmResult = false
        const { extractorSpy, progressSpy } = installExtractorSpies()
        const logSpy = spyOn(consoleOutput, 'print').mockImplementation(
            () => consoleOutput,
        )
        const stdinSpy = spyOn(
            consoleOutput,
            'stdinIsInteractive',
        ).mockReturnValue(true)
        const stderrSpy = spyOn(
            consoleOutput,
            'stderrIsInteractive',
        ).mockReturnValue(true)

        try {
            await (await createCommand()).handle()
            expect(extractorCalls).toEqual([])
            expect(progressReports).toEqual([])
            expect(summaryReports).toEqual([])
            expect(progressDoneCount).toBe(0)
            expect(confirmCalls).toEqual([
                {
                    default: true,
                    message:
                        'Rebuild derived memory for this project? Durable memories and diary entries are preserved.',
                },
            ])
            expect(logSpy).toHaveBeenCalledWith(
                'Rebuild canceled. Derived memory was not changed.',
            )
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining(
                    'Project-local context memory for AI coding agents.',
                ),
            )
            expect(logSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('"skipped": true'),
            )
        } finally {
            extractorSpy.mockRestore()
            progressSpy?.mockRestore()
            stdinSpy.mockRestore()
            stderrSpy.mockRestore()
            logSpy.mockRestore()
        }
    })

    it('rebuilds the current project and prints rebuild mode output', async () => {
        resetState()
        extractedResponse = {
            deletedFilePaths: [],
            detectedParserLanguages: ['typescript'],
            embeddedCount: 3,
            embeddingReusedCount: 1,
            extractedAt: '2026-01-01T00:00:00.000Z',
            fileCount: 2,
            languageCount: 1,
            loadedParserCount: 1,
            mode: 'rebuild',
            ok: true,
            projectRoot: '/tmp/project',
            sectionCount: 4,
            summaryRef: 'project-summary',
            technologies: ['typescript'],
            updatedFilePaths: ['src/index.ts'],
            vectorCount: 4,
        }
        const { extractorSpy, progressSpy } = installExtractorSpies({
            mockProgress: false,
        })
        const output: string[] = []
        const logSpy = spyOn(consoleOutput, 'print').mockImplementation(
            message => {
                output.push(renderStdoutMessage(message))
                return consoleOutput
            },
        )
        const errorSpy = spyOn(consoleOutput, 'writeError').mockImplementation(
            message => {
                output.push(renderStderrMessage(message))
                return consoleOutput
            },
        )
        const stdinSpy = spyOn(
            consoleOutput,
            'stdinIsInteractive',
        ).mockReturnValue(false)
        const stderrSpy = spyOn(
            consoleOutput,
            'stderrIsInteractive',
        ).mockReturnValue(false)

        try {
            await (await createCommand()).handle()
            expect(extractorCalls).toEqual([
                { mode: 'rebuild', projectRoot: process.cwd() },
            ])
            const renderedOutput = stripAnsi(output.join('\n'))

            expect(renderedOutput).toContain('Rebuilding project memory')
            expect(renderedOutput).toContain(
                'Project-local context memory for AI coding agents.',
            )
            expect(renderedOutput).toContain('Konteks')
            expect(renderedOutput).toContain(
                '✓ Extracted 0 modules and 4 sections from 2 files',
            )
            expect(renderedOutput).toContain('✓ Generated project summary')
            expect(renderedOutput).toContain('Project memory ready')
            expect(renderedOutput).toContain('Files indexed        2')
            expect(renderedOutput).toContain('Vectors indexed      4')
            expect(renderedOutput).not.toContain('"mode": "rebuild"')
        } finally {
            extractorSpy.mockRestore()
            progressSpy?.mockRestore()
            stdinSpy.mockRestore()
            stderrSpy.mockRestore()
            logSpy.mockRestore()
            errorSpy.mockRestore()
        }

        function renderStdoutMessage(message: ConsoleOutputMessage): string {
            return isOutputFormatter(message)
                ? message(consoleOutput.colorPalette)
                : String(message)
        }

        function renderStderrMessage(
            message: string | ((color: ConsoleColorPalette) => string),
        ): string {
            return typeof message === 'function'
                ? message(consoleOutput.colorPalette)
                : message
        }

        function isOutputFormatter(
            message: ConsoleOutputMessage,
        ): message is (color: ConsoleColorPalette) => string {
            return typeof message === 'function'
        }
    })
})
