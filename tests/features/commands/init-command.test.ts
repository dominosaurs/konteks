import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import consoleOutput from '@/support/console-output'
import {
    primaryColorHex,
    secondaryColorHex,
} from '@/support/console-output/_support/color-palette'
import hexToRgb from '@/support/console-output/_support/hex-to-rgb'
import { mkdir, rm } from '@/support/file-manager'
import stripAnsi from '@/support/strip-ansi'
import FakeEmbeddingProvider from '../../fake/fake-embedding-provider'

const checkboxCalls: unknown[] = []
let checkboxResult: string[] = []
const selectCalls: unknown[] = []
let selectResult = 'CONTINUE'

class MockHuggingFaceEmbeddingProvider extends FakeEmbeddingProvider {
    private readonly options?: {
        onProgress?: (event: {
            message: string
            phase: 'preparation'
            stage: 'prepare'
            status: 'progress'
        }) => void
    }

    public constructor(options?: {
        onProgress?: (event: {
            message: string
            phase: 'preparation'
            stage: 'prepare'
            status: 'progress'
        }) => void
    }) {
        super()
        this.options = options
    }

    public async prepare(): Promise<void> {
        this.options?.onProgress?.({
            message: 'Loading embedding model fake/all-MiniLM-L6-v2',
            phase: 'preparation',
            stage: 'prepare',
            status: 'progress',
        })
        this.options?.onProgress?.({
            message: 'Embedding model ready: fake/all-MiniLM-L6-v2',
            phase: 'preparation',
            stage: 'prepare',
            status: 'progress',
        })
    }
}

mock.module('@/modules/embeddings/hugging-face-embedding-provider', () => ({
    default: MockHuggingFaceEmbeddingProvider,
}))

mock.module('@inquirer/checkbox', () => ({
    default: async (options: unknown) => {
        checkboxCalls.push(options)
        return checkboxResult
    },
}))

mock.module('@inquirer/confirm', () => ({
    default: async () => true,
}))

mock.module('@inquirer/input', () => ({
    default: async () => '',
}))

mock.module('@inquirer/number', () => ({
    default: async () => undefined,
}))

mock.module('@inquirer/select', () => ({
    default: async (options: unknown) => {
        selectCalls.push(options)
        return selectResult
    },
}))

const tempDirs: string[] = []

async function makeTempProject(): Promise<string> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-init-test-'))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, '.git'))
    await writeFile(join(projectRoot, 'README.md'), '# Fixture\n')
    return projectRoot
}

afterEach(async () => {
    checkboxCalls.splice(0)
    checkboxResult = []
    selectCalls.splice(0)
    selectResult = 'CONTINUE'
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

async function withWorkingDirectory<T>(
    cwd: string,
    operation: () => Promise<T>,
): Promise<T> {
    const previous = process.cwd()
    process.chdir(cwd)

    try {
        return await operation()
    } finally {
        process.chdir(previous)
    }
}

describe('InitCommand', () => {
    const init = async (project: string) =>
        await withWorkingDirectory(project, async () => {
            const output: string[] = []
            const logSpy = spyOn(consoleOutput, 'print').mockImplementation(
                message => {
                    output.push(String(message))
                    return consoleOutput
                },
            )
            const errorSpy = spyOn(
                consoleOutput,
                'writeError',
            ).mockImplementation(message => {
                output.push(String(message))
                return consoleOutput
            })

            try {
                const command = await createCommand()
                await command.handle()
            } finally {
                logSpy.mockRestore()
                errorSpy.mockRestore()
            }

            return output.join('\n')
        })

    it('creates a local .konteks/.gitignore during init', async () => {
        const projectRoot = await makeTempProject()

        await init(projectRoot)

        await expect(
            readFile(join(projectRoot, '.konteks', '.gitignore'), 'utf8'),
        ).resolves.toBe('*\n')
        await expect(
            readFile(join(projectRoot, '.gitignore'), 'utf8'),
        ).rejects.toHaveProperty('code', 'ENOENT')
    })

    it('preserves existing root .gitignore entries', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(join(projectRoot, '.gitignore'), 'node_modules\n')

        await init(projectRoot)

        await expect(
            readFile(join(projectRoot, '.gitignore'), 'utf8'),
        ).resolves.toBe('node_modules\n')
        await expect(
            readFile(join(projectRoot, '.konteks', '.gitignore'), 'utf8'),
        ).resolves.toBe('*\n')
    })

    it('adds a catch-all to an existing local .konteks/.gitignore', async () => {
        const projectRoot = await makeTempProject()
        await mkdir(join(projectRoot, '.konteks'))
        await writeFile(
            join(projectRoot, '.konteks', '.gitignore'),
            'memory.sqlite\n',
        )

        await init(projectRoot)

        await expect(
            readFile(join(projectRoot, '.konteks', '.gitignore'), 'utf8'),
        ).resolves.toBe('memory.sqlite\n*\n')
    })

    it('does not duplicate an existing local catch-all .konteks/.gitignore', async () => {
        const projectRoot = await makeTempProject()
        await mkdir(join(projectRoot, '.konteks'))
        await writeFile(
            join(projectRoot, '.konteks', '.gitignore'),
            '# Konteks memory\n*\n',
        )

        await init(projectRoot)

        await expect(
            readFile(join(projectRoot, '.konteks', '.gitignore'), 'utf8'),
        ).resolves.toBe('# Konteks memory\n*\n')
    })

    it('skips when the project is already initialized', async () => {
        const projectRoot = await makeTempProject()

        await init(projectRoot)
        const manifestPath = join(
            projectRoot,
            '.konteks',
            'extraction-manifest.json',
        )
        const firstManifest = await readFile(manifestPath, 'utf8')

        await init(projectRoot)

        const secondManifest = await readFile(manifestPath, 'utf8')
        expect(secondManifest).toBe(firstManifest)
    })

    it('prints the redesigned init progress and summary', async () => {
        const projectRoot = await makeTempProject()

        const output = await init(projectRoot)

        const plainOutput = stripAnsi(output)

        expect(plainOutput).toContain('██████')
        expect(plainOutput).toContain('Konteks  v')
        expect(plainOutput).toContain('Initializing project memory')

        expect(plainOutput).toContain(
            '✓ Extracted 1 modules and 1 sections from 1 files',
        )
        expect(plainOutput).not.toContain('Loaded 0 language parsers')
        expect(plainOutput).toContain('✓ Preparing dependencies')
        expect(plainOutput).not.toContain('Loading embedding model')
        expect(plainOutput).not.toContain('Embedding model ready')
        expect(plainOutput).toContain('Extracting files:')
        expect(plainOutput).toContain('Building project memory...')
        expect(plainOutput.indexOf('Extracting files:')).toBeLessThan(
            plainOutput.indexOf('Building project memory...'),
        )
        expect(plainOutput).toContain('vectors indexed')
        expect(plainOutput).toContain('✓ Generated project summary')
        expect(plainOutput).toContain('Project memory ready')
        expect(plainOutput).toContain('Files indexed        1')
        expect(plainOutput).toContain('Vectors indexed      2')
        expect(plainOutput).not.toContain('Documents extracted')
        expect(plainOutput).not.toContain('Initialized Konteks at')
        expect(plainOutput).not.toContain('Extracted 2 files into 2 sections')
        expect(plainOutput).not.toContain('Extracted 2 semantic sections')
    })

    it('colors init progress when color is supported', async () => {
        const projectRoot = await makeTempProject()
        const previousForceColor = process.env.FORCE_COLOR
        const previousNoColor = process.env.NO_COLOR
        delete process.env.NO_COLOR
        process.env.FORCE_COLOR = '1'

        try {
            const output = await init(projectRoot)

            expect(output).toContain('\u001b[38;2;')
            expect(output).toContain(ansiForeground(secondaryColorHex))
            expect(output).toContain(ansiBackground(primaryColorHex))
            expect(output).toContain(consoleOutput.colorPalette.success('✓'))
            expect(output).toContain(
                consoleOutput.colorPalette.primary('Project memory ready'),
            )
        } finally {
            if (previousForceColor === undefined) {
                delete process.env.FORCE_COLOR
            } else {
                process.env.FORCE_COLOR = previousForceColor
            }
            if (previousNoColor === undefined) {
                delete process.env.NO_COLOR
            } else {
                process.env.NO_COLOR = previousNoColor
            }
        }
    })

    it('excludes bundled parser detections from the language review', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}')

        const output = await withInteractiveTerminal(() => init(projectRoot))
        const manifest = JSON.parse(
            await readFile(
                join(projectRoot, '.konteks', 'extraction-manifest.json'),
                'utf8',
            ),
        )
        const config = JSON.parse(
            await readFile(
                join(projectRoot, '.konteks', 'config.json'),
                'utf8',
            ),
        )

        const plainOutput = stripAnsi(output)

        expect(plainOutput).not.toContain('Bundled required')
        expect(plainOutput).not.toContain('Detected languages: json')
        expect(plainOutput).not.toContain('✓ Detected 1 languages')
        expect(plainOutput).toContain('✓ Preparing dependencies')
        expect(plainOutput).not.toContain('language parsers ready')
        expect(plainOutput).not.toContain('Loaded 1 language parsers')
        expect(manifest.diagnostics.detectedParserLanguages).toEqual([])
        expect(config.extraction.grammars.selected).toEqual([])
        expect(selectCalls).toHaveLength(0)
        expect(checkboxCalls).toHaveLength(0)
    })

    it('opens registry grammar checkboxes when detected languages are rejected', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(join(projectRoot, 'src.ts'), 'export const value = 1\n')
        selectResult = 'EDIT'
        checkboxResult = []

        await withInteractiveTerminal(() => init(projectRoot))
        const config = JSON.parse(
            await readFile(
                join(projectRoot, '.konteks', 'config.json'),
                'utf8',
            ),
        )
        const choices = (
            checkboxCalls[0] as {
                choices: Array<{ checked: boolean; value: string }>
            }
        ).choices

        expect(selectCalls).toHaveLength(1)
        expect(checkboxCalls).toHaveLength(1)
        expect(
            choices.find(choice => choice.value === 'typescript')?.checked,
        ).toBe(true)
        expect(config.extraction.grammars.selected).toEqual([])
    })

    it('keeps parser and model preparation output compact', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}')

        const output = stripAnsi(
            await withInteractiveTerminal(() => init(projectRoot)),
        )

        expect(output).toContain('✓ Preparing dependencies')
        expect(output).not.toContain('language parsers ready')
        expect(output).not.toContain('Downloading JSON grammar')
        expect(output).not.toContain('Loaded JSON grammar')
        expect(output).not.toContain('Preparing config.json')
        expect(output).not.toContain('Loading embedding model')
        expect(output).not.toContain('Loading tokenizer.json')
        expect(output).not.toContain('Loaded 1 language parsers')
        expect(output).toContain(
            '✓ Extracted 3 modules and 2 sections from 2 files',
        )
    })

    it('finishes setup when a previous init stopped before extraction', async () => {
        const projectRoot = await makeTempProject()
        await mkdir(join(projectRoot, '.konteks'))
        await writeFile(join(projectRoot, '.konteks', 'config.json'), '{}\n')

        await init(projectRoot)

        await expect(
            readFile(
                join(projectRoot, '.konteks', 'extraction-manifest.json'),
                'utf8',
            ),
        ).resolves.toContain('"version": 1')
        await expect(
            readFile(join(projectRoot, '.konteks', '.gitignore'), 'utf8'),
        ).resolves.toBe('*\n')
    })

    it('continues from existing sections when the manifest is missing', async () => {
        const projectRoot = await makeTempProject()

        await init(projectRoot)
        const manifestPath = join(
            projectRoot,
            '.konteks',
            'extraction-manifest.json',
        )
        const firstManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        await rm(manifestPath)

        const output = stripAnsi(await init(projectRoot))

        const resumedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        expect(output).toContain(
            '✓ Extracted 1 modules and 1 sections from 1 files',
        )
        expect(output).not.toContain('Documents extracted')
        expect(output).not.toContain('Extracted 5 documents from 0 files')
        expect(resumedManifest.diagnostics.sectionCount).toBe(
            firstManifest.diagnostics.sectionCount,
        )
        expect(
            resumedManifest.diagnostics.embeddingReusedCount,
        ).toBeGreaterThan(0)
        expect(resumedManifest.diagnostics.vectorCount).toBe(
            resumedManifest.diagnostics.embeddedCount +
                resumedManifest.diagnostics.embeddingReusedCount,
        )
    })
})

async function createCommand() {
    const { default: InitCommand } = await import(
        '@/entrypoints/cli/commands/init-command'
    )
    return new InitCommand()
}

async function withInteractiveTerminal<T>(operation: () => Promise<T>) {
    const stdinSpy = spyOn(consoleOutput, 'stdinIsInteractive').mockReturnValue(
        true,
    )
    const stderrSpy = spyOn(
        consoleOutput,
        'stderrIsInteractive',
    ).mockReturnValue(true)

    try {
        return await operation()
    } finally {
        stdinSpy.mockRestore()
        stderrSpy.mockRestore()
    }
}

function ansiForeground(hex: string): string {
    const color = hexToRgb(hex)

    return `\u001b[38;2;${color.red};${color.green};${color.blue}m`
}

function ansiBackground(hex: string): string {
    const color = hexToRgb(hex)

    return `\u001b[48;2;${color.red};${color.green};${color.blue}m`
}
