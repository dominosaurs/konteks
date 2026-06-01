import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { eq } from 'drizzle-orm'
import getDb from '@/database/actions/_db'
import { targetEmbeddings } from '@/database/schema'
import mcpTools from '@/entrypoints/mcp/tools'
import { extractProject } from '@/modules/extraction/extract-project'
import { loadProjectContext } from '@/modules/project/context'
import { mkdir, rm } from '@/support/file-manager'
import FakeEmbeddingProvider from '../../../fake/fake-embedding-provider'

function extractionOptions() {
    return {
        embeddingProvider: new FakeEmbeddingProvider(),
    }
}

async function withProjectRoot<T>(
    projectRoot: string,
    operation: () => Promise<T>,
): Promise<T> {
    const previous = process.cwd()
    process.chdir(projectRoot)

    try {
        return await operation()
    } finally {
        process.chdir(previous)
    }
}

describe('konteks_warm_up', () => {
    let tempDirs: string[] = []

    afterEach(async () => {
        for (const dir of tempDirs) {
            await rm(dir)
        }
        tempDirs = []
    })

    it('returns stable project context assembled from stored artifacts', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-warm-up-'))
        tempDirs.push(projectRoot)
        await mkdir(join(projectRoot, 'src'))
        await mkdir(join(projectRoot, '.git'))
        await writeFile(
            join(projectRoot, 'src', 'index.txt'),
            'export const version = "1.0.0"\n',
        )

        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'full', extractionOptions()),
        )

        // Seed some durable memories
        await withProjectRoot(projectRoot, () =>
            callKonteksTool('konteks_save_memories', {
                memories: [
                    {
                        content: 'Use Bun test for project verification.',
                        importance: 3,
                        kind: 'preference',
                    },
                    {
                        content:
                            'Konteks save must preserve explicit constraints.',
                        importance: 4,
                        kind: 'constraint',
                    },
                    {
                        content:
                            'Use structured save payloads for session memory.',
                        importance: 5,
                        kind: 'decision',
                    },
                    {
                        content:
                            'Patched warm-up formatter to collapse old sections.',
                        importance: 2,
                        kind: 'fact',
                    },
                ],
            }),
        )

        const result = await withProjectRoot(projectRoot, () =>
            callKonteksTool('konteks_warm_up', {}),
        )
        const text = extractText(result)

        expect(text).not.toContain('warm_up:')
        expect(text).not.toContain('summary:')
        expect(text).toContain('guidance')
        expect(text).toContain('highlights')
        expect(text).toContain('Use Bun test for project verification.')
        expect(text).toContain(
            'Konteks save must preserve explicit constraints.',
        )
        expect(text).toContain(
            'Use structured save payloads for session memory.',
        )
    })

    it('updates changed project memory before warming up', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-warm-up-'))
        tempDirs.push(projectRoot)
        await mkdir(join(projectRoot, 'src'))
        await mkdir(join(projectRoot, '.git'))
        await writeFile(
            join(projectRoot, 'src', 'index.txt'),
            'export const first = true\n',
        )

        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'full', extractionOptions()),
        )
        await writeFile(
            join(projectRoot, 'src', 'later.txt'),
            'export const later = true\n',
        )

        const result = await withProjectRoot(projectRoot, () =>
            callKonteksTool('konteks_warm_up', {}),
        )
        const text = extractText(result)
        const manifest = await readExtractionManifest(context.memoryDir)

        expect(manifest?.mode).toBe('changed')
        expect(manifest?.files.map(file => file.path)).toContain(
            'src/later.txt',
        )
        expect(text).not.toContain('mode:')
        expect(text).not.toContain('extracted_at:')
        expect(text).not.toContain('Selected')
        expect(text).not.toContain('Extraction complete')
    })

    it('does not delete module embeddings during warm-up changed extraction', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-warm-up-'))
        tempDirs.push(projectRoot)
        await mkdir(join(projectRoot, 'src'))
        await mkdir(join(projectRoot, '.git'))
        await writeFile(
            join(projectRoot, 'src', 'index.txt'),
            'export const first = true\n',
        )

        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'full', extractionOptions()),
        )
        const beforeCount = await withProjectRoot(projectRoot, () =>
            moduleEmbeddingCount(),
        )
        await writeFile(
            join(projectRoot, 'src', 'later.txt'),
            'export const later = true\n',
        )

        await withProjectRoot(projectRoot, () =>
            callKonteksTool('konteks_warm_up', {}),
        )

        await expect(
            withProjectRoot(projectRoot, () => moduleEmbeddingCount()),
        ).resolves.toBe(beforeCount)
    })

    it('returns quality-labeled focused recall without duplicate targets', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-warm-up-'))
        tempDirs.push(projectRoot)
        await mkdir(join(projectRoot, 'src', 'mcp'))
        await mkdir(join(projectRoot, '.git'))
        await writeFile(
            join(projectRoot, 'src', 'mcp', 'server.txt'),
            'export const warmUpServer = () => "focused recall"\n',
        )
        await writeFile(
            join(projectRoot, 'src', 'mcp', 'retrieval-format.txt'),
            'export const formatWarmUpText = () => "focused recall"\n',
        )

        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'full', extractionOptions()),
        )

        const result = await withProjectRoot(projectRoot, () =>
            callKonteksTool('konteks_warm_up', {
                focus: ['focused recall warm up'],
            }),
        )
        const text = extractText(result)

        expect(text).toContain('recall:')
        expect(text).toContain('quality:')
        expect(text).toContain('primaryTargets')
    })
})

async function readExtractionManifest(memoryDir: string) {
    const { readExtractionManifest: read } = await import(
        '@/modules/extraction/engine/manifest'
    )
    return read(memoryDir)
}

async function callKonteksTool(
    name: string,
    input: unknown,
): Promise<CallToolResult> {
    const tool = mcpTools.find(item => item.name === name)

    if (!tool) {
        throw new Error(`Unknown tool: ${name}`)
    }

    return await registeredHandlerFor(tool)(input)
}

function registeredHandlerFor(inputTool: (typeof mcpTools)[number]) {
    let handler: ((input: unknown) => Promise<CallToolResult>) | undefined
    const server = {
        registerTool: (...args: unknown[]) => {
            handler = args[2] as (input: unknown) => Promise<CallToolResult>
        },
    } as McpServer

    inputTool.register(server)

    if (!handler) {
        throw new Error('Tool did not register a handler.')
    }

    return handler
}

function extractText(result: CallToolResult): string {
    return (
        result.content.find(
            (
                item,
            ): item is Extract<
                CallToolResult['content'][number],
                { type: 'text' }
            > => item.type === 'text',
        )?.text ?? ''
    )
}

async function moduleEmbeddingCount(): Promise<number> {
    const db = await getDb()
    const rows = await db
        .select()
        .from(targetEmbeddings)
        .where(eq(targetEmbeddings.targetType, 'module'))
    return rows.length
}
