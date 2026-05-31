import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import getDb from '@/database/actions/_db'
import { targetEmbeddings, vectorIndexEntries } from '@/database/schema'
import {
    saveKonteksDiary,
    saveKonteksMemories,
} from '@/database/services/save-memory'
import {
    getExtractionFreshness,
    readExtractionManifest,
} from '@/modules/extraction/engine/manifest'
import { extractProject } from '@/modules/extraction/extract-project'
import { loadProjectContext } from '@/modules/project/context'
import { mkdir, rm } from '@/support/file-manager'
import type { EmbeddingProviderContract } from '@/types/embedding-provider'
import FakeEmbeddingProvider from '../../../../fake/fake-embedding-provider'

const tempDirs: string[] = []
const originalCwd = process.cwd()

class ThrowingEmbeddingProvider implements EmbeddingProviderContract {
    public readonly dimensions = 8
    public readonly model = 'fake/throwing'

    public async embed(): Promise<Float32Array[]> {
        throw new Error('embedding provider failed')
    }
}

class ThrowingReuseEmbeddingProvider implements EmbeddingProviderContract {
    public readonly dimensions = 8
    public readonly model = 'fake/all-MiniLM-L6-v2'

    public async prepare(): Promise<void> {
        throw new Error('embedding provider prepare should not be called')
    }

    public async embed(): Promise<Float32Array[]> {
        throw new Error('embedding provider embed should not be called')
    }
}

class CountingEmbeddingProvider extends FakeEmbeddingProvider {
    public embeddedTexts: string[] = []

    public override async embed(texts: string[]): Promise<Float32Array[]> {
        this.embeddedTexts.push(...texts)
        return await super.embed(texts)
    }
}

async function extractTestProject(
    context: Awaited<ReturnType<typeof loadProjectContext>>,
    mode: Parameters<typeof extractProject>[1],
    options: Parameters<typeof extractProject>[2] = {},
) {
    return await withProjectRoot(context.projectRoot, () =>
        extractProject(context, mode, options),
    )
}

async function makeTempProject(): Promise<string> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-extract-test-'))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, '.git'))
    await mkdir(join(projectRoot, 'src'))
    await mkdir(join(projectRoot, '.konteks'))
    await writeFile(join(projectRoot, '.konteks', 'config.json'), '{}\n')
    await writeFile(join(projectRoot, 'README.md'), '# Fixture\n')
    await writeFile(
        join(projectRoot, 'src', 'index.txt'),
        'Konteks fixture notes for extraction tests.\n',
    )
    await writeFile(join(projectRoot, '.env.local'), 'SECRET=hidden\n')

    process.chdir(projectRoot)
    return projectRoot
}

afterEach(async () => {
    process.chdir(originalCwd)
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

describe('extractProject', () => {
    it('writes a manifest with project summary metadata', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        const result = await extractTestProject(context, 'rebuild')
        const manifest = await readExtractionManifest(context.memoryDir)

        expect(result.ok).toBe(true)
        expect(result.fileCount).toBe(2)
        expect(result.sectionCount).toBeGreaterThan(1)
        expect(result.technologies).toEqual([])
        expect(manifest?.summaryRef).toBe(result.summaryRef)
        expect(manifest?.diagnostics).toMatchObject({
            detectedParserLanguages: [],
            filesIncluded: 2,
            filesSkipped: {
                secret: 1,
            },
            filesTruncatedBySectionLimit: 0,
            sectionCount: result.sectionCount,
        })
        expect(manifest?.files.map(file => file.path)).toEqual([
            'README.md',
            'src/index.txt',
        ])
        expect(manifest?.summaryHash).toHaveLength(64)
    })

    it('reports fresh status after extraction and stale after a file change', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        await extractTestProject(context, 'rebuild')

        const fresh = await getExtractionFreshness(context)
        expect(fresh.status).toBe('fresh')

        await writeFile(
            join(projectRoot, 'src', 'new.txt'),
            'export const x = 1\n',
        )

        const stale = await getExtractionFreshness(context)
        expect(stale.status).toBe('stale')
        expect(stale.recommendedCommand).toBe('konteks rebuild')
    })

    it('reports section progress for every selected file', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(join(projectRoot, 'src', 'empty.txt'), '')
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        const sectionProgress: Array<{
            current?: number
            path?: string
            total?: number
        }> = []

        const result = await extractTestProject(context, 'rebuild', {
            onProgress(event) {
                if (
                    event.phase === 'sections' &&
                    event.status === 'progress' &&
                    event.path
                ) {
                    sectionProgress.push({
                        current: event.current,
                        path: event.path,
                        total: event.total,
                    })
                }
            },
        })

        expect(result.fileCount).toBe(3)
        expect(sectionProgress.map(event => event.current)).toEqual([1, 2, 3])
        expect(sectionProgress.map(event => event.total)).toEqual([3, 3, 3])
        expect(sectionProgress.map(event => event.path)).toContain(
            'src/empty.txt',
        )
    })

    it('does not cap sections per file', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(
            join(projectRoot, 'src', 'many.md'),
            Array.from({ length: 205 }, (_, index) => [
                `## Section ${index}`,
                `value ${index}`,
            ])
                .flat()
                .join('\n'),
        )
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        const result = await extractTestProject(context, 'rebuild')
        const manifest = await readExtractionManifest(context.memoryDir)

        expect(result.sectionCount).toBeGreaterThan(205)
        expect(manifest?.diagnostics?.filesTruncatedBySectionLimit).toBe(0)
    })

    it('stores the manifest as local JSON', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await extractTestProject(context, 'changed')

        const rawManifest = await readFile(
            join(projectRoot, '.konteks', 'extraction-manifest.json'),
            'utf8',
        )
        expect(JSON.parse(rawManifest).mode).toBe('changed')
    })

    it('reads legacy reindex manifests for compatibility', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        await extractTestProject(context, 'rebuild')
        const manifestPath = join(
            projectRoot,
            '.konteks',
            'extraction-manifest.json',
        )
        const rawManifest = await readFile(manifestPath, 'utf8')
        await writeFile(
            manifestPath,
            rawManifest.replace('"mode": "rebuild"', '"mode": "reindex"'),
        )

        expect((await readExtractionManifest(context.memoryDir))?.mode).toBe(
            'reindex',
        )
        await expect(getExtractionFreshness(context)).resolves.toMatchObject({
            status: 'fresh',
        })

        await writeFile(join(projectRoot, 'src', 'new.txt'), 'changed\n')
        await expect(
            extractTestProject(context, 'changed'),
        ).resolves.toMatchObject({
            ok: true,
        })
    })

    it('extracts package.json with bundled config grammars', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(
            join(projectRoot, 'package.json'),
            '{"name":"fixture","type":"module"}\n',
        )
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        const result = await extractTestProject(context, 'rebuild')
        const manifest = await readExtractionManifest(context.memoryDir)

        expect(result.ok).toBe(true)
        expect(manifest?.files.map(file => file.path)).toContain('package.json')
    })

    it('stores rebuild mode in manifest', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await extractTestProject(context, 'rebuild')
        await extractTestProject(context, 'rebuild')

        const rawManifest = await readFile(
            join(projectRoot, '.konteks', 'extraction-manifest.json'),
            'utf8',
        )
        const manifest = JSON.parse(rawManifest)

        expect(manifest.mode).toBe('rebuild')
        expect(manifest.diagnostics.sectionCount).toBeGreaterThan(0)
    })

    it('repairs missing durable memory and diary embeddings during rebuild', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        const saved = await withProjectRoot(projectRoot, async () => {
            const memory = await saveKonteksMemories(
                context,
                {
                    memories: [
                        {
                            content:
                                'Rebuild should repair missing durable memory vectors.',
                            importance: 4,
                            kind: 'fact',
                        },
                    ],
                },
                { embeddingProvider: new ThrowingEmbeddingProvider() },
            )
            const diary = await saveKonteksDiary(
                context,
                {
                    subject: 'rebuild durable embedding repair',
                    summary:
                        'Rebuild should repair missing durable diary vectors.',
                },
                { embeddingProvider: new ThrowingEmbeddingProvider() },
            )
            return { diaryId: diary.diaryId, memoryId: memory.memoryIds?.[0] }
        })

        if (!saved.memoryId || !saved.diaryId) {
            throw new Error('expected durable memory and diary ids')
        }
        expect(await embeddingRowsFor('memory')).toHaveLength(0)
        expect(await embeddingRowsFor('diary')).toHaveLength(0)

        await extractTestProject(context, 'rebuild', {
            embeddingProvider: new FakeEmbeddingProvider(),
        })

        expect(await embeddingRowsFor('memory')).toMatchObject([
            {
                model: 'fake/all-MiniLM-L6-v2',
                targetId: saved.memoryId,
                targetType: 'memory',
            },
        ])
        expect(await embeddingRowsFor('diary')).toMatchObject([
            {
                model: 'fake/all-MiniLM-L6-v2',
                targetId: saved.diaryId,
                targetType: 'diary',
            },
        ])

        const second = await extractTestProject(context, 'rebuild', {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
        expect(second.embeddingReusedCount).toBeGreaterThanOrEqual(2)
    })

    it('changed mode removes deleted-file sections and preserves unchanged sections', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await extractTestProject(context, 'rebuild')

        await unlink(join(projectRoot, 'README.md'))
        await writeFile(
            join(projectRoot, 'src', 'new.txt'),
            'export const n = 1\n',
        )
        await extractTestProject(context, 'changed')
        const manifest = await readExtractionManifest(context.memoryDir)
        const paths = manifest?.files.map(file => file.path) ?? []

        expect(paths).not.toContain('README.md')
        expect(paths).toContain('src/index.txt')
        expect(paths).toContain('src/new.txt')
    })

    it('changed mode is a no-op when extraction is already current', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await extractTestProject(context, 'rebuild', {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
        const manifestPath = join(
            projectRoot,
            '.konteks',
            'extraction-manifest.json',
        )
        const beforeManifest = await readFile(manifestPath, 'utf8')
        const beforeCounts = await projectStateCounts()
        const beforeParsedManifest = JSON.parse(beforeManifest) as {
            extractedAt: string
        }

        const result = await extractTestProject(context, 'changed')

        expect(result).toMatchObject({
            deletedFilePaths: [],
            extractedAt: beforeParsedManifest.extractedAt,
            ok: true,
            updatedFilePaths: [],
        })
        expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest)
        expect(await projectStateCounts()).toEqual(beforeCounts)
    })

    it('does not run corpus vector repair when changed mode is already current', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await extractTestProject(context, 'rebuild', {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
        await withProjectRoot(projectRoot, async () => {
            const db = await getDb()
            await db.delete(vectorIndexEntries)
        })

        const result = await extractTestProject(context, 'changed', {
            embeddingProvider: new ThrowingReuseEmbeddingProvider(),
        })

        expect(result).toMatchObject({
            deletedFilePaths: [],
            ok: true,
            updatedFilePaths: [],
        })
        expect(result.embeddingReusedCount).toBe(0)
        expect(result.embeddedCount).toBe(0)
    })

    it('embeds only retrieval documents updated by changed extraction', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await extractTestProject(context, 'rebuild', {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
        await writeFile(
            join(projectRoot, 'src', 'new.txt'),
            'Changed extraction should embed this new file only.\n',
        )
        const provider = new CountingEmbeddingProvider()

        const result = await extractTestProject(context, 'changed', {
            embeddingProvider: provider,
        })

        expect(result.updatedFilePaths).toEqual(['src/new.txt'])
        expect(provider.embeddedTexts.length).toBeGreaterThan(0)
        expect(
            provider.embeddedTexts.some(text =>
                text.includes(
                    'Changed extraction should embed this new file only.',
                ),
            ),
        ).toBe(true)
        expect(
            provider.embeddedTexts.some(text => text.includes('# Fixture')),
        ).toBe(false)
    })

    it('extracts repeated anchors with identical content without section ID collisions', async () => {
        const projectRoot = await makeTempProject()
        await writeFile(
            join(projectRoot, 'README.md'),
            ['# Repeat', 'same content', '# Repeat', 'same content'].join('\n'),
        )
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        const result = await extractTestProject(context, 'rebuild')
        const manifest = await readExtractionManifest(context.memoryDir)

        expect(manifest?.diagnostics?.sectionCount).toBe(result.sectionCount)
        expect(result.sectionCount).toBeGreaterThanOrEqual(3)
    })

    it('fails when a required Tree-sitter parser fails', async () => {
        const projectRoot = await makeTempProject()
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await expect(extractProject(context, 'rebuild')).resolves.toMatchObject(
            {
                ok: true,
            },
        )
    })
})

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

async function embeddingRowsFor(
    targetType: 'diary' | 'memory' | 'module' | 'section',
) {
    const db = await getDb()
    return await db
        .select()
        .from(targetEmbeddings)
        .where(eq(targetEmbeddings.targetType, targetType))
}

async function projectStateCounts(): Promise<Record<string, number>> {
    const db = await getDb()
    const rows = await db.all<{ name: string; count: number }>(sql`
select 'memory_events' as name, count(*) as count from memory_events
union all select 'modules', count(*) from modules
union all select 'retrieval_documents_fts', count(*) from retrieval_documents_fts
union all select 'target_embeddings', count(*) from target_embeddings
union all select 'relations', count(*) from relations
`)
    return Object.fromEntries(rows.map(row => [row.name, row.count]))
}
