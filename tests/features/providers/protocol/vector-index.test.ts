import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import getDb, { withTransaction } from '@/database/actions/_db'
import {
    retrievalDocuments,
    targetEmbeddings,
    vectorIndexEntries,
} from '@/database/schema'
import {
    deleteVectorIndexTargets,
    searchVectorIndex,
    upsertVectorIndexTargets,
} from '@/database/services/vector-index'
import generateTargetEmbeddings from '@/modules/embeddings/generate-target-embeddings'
import { extractProject } from '@/modules/extraction/extract-project'
import { loadProjectContext } from '@/modules/project/context'
import { mkdir, rm } from '@/support/file-manager'
import type { EmbeddingProviderContract } from '@/types/embedding-provider'
import type { ExtractionProgressEvent } from '@/types/progress'
import FakeEmbeddingProvider from '../../../fake/fake-embedding-provider'

const tempDirs: string[] = []
const originalCwd = process.cwd()
let previousSqliteTestDatabase: string | undefined

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

beforeEach(() => {
    previousSqliteTestDatabase = process.env.KONTEKS_SQLITE_TEST_DATABASE
    process.env.KONTEKS_SQLITE_TEST_DATABASE = 'file'
})

afterEach(async () => {
    await waitForVectorIndexRepairs()
    process.chdir(originalCwd)
    globalThis.__konteksVectorIndexConnectionFactoryForTests = undefined
    if (previousSqliteTestDatabase === undefined) {
        delete process.env.KONTEKS_SQLITE_TEST_DATABASE
    } else {
        process.env.KONTEKS_SQLITE_TEST_DATABASE = previousSqliteTestDatabase
    }
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

describe('vector index', () => {
    it('loads sqlite-vec through Bun and indexes vectors in a batch', async () => {
        await makeTempProject()
        const createdAt = new Date().toISOString()
        const targets = Array.from({ length: 300 }, (_, index) => ({
            createdAt,
            dimensions: 4,
            embeddingHash: `hash-${index}`,
            model: 'fake/batch',
            targetId: `section-${index}`,
            targetType: 'section' as const,
            vector: new Float32Array([index === 42 ? 1 : 0, 1, 0, 0]),
        }))
        const db = await getDb()
        await db.insert(targetEmbeddings).values(
            targets.map(target => ({
                createdAt,
                dimensions: target.dimensions,
                dtype: 'float32',
                embeddingHash: target.embeddingHash,
                model: target.model,
                normalized: 1,
                targetId: target.targetId,
                targetType: target.targetType,
                vectorBlob: toBlob(target.vector),
            })),
        )

        await expect(upsertVectorIndexTargets(targets)).resolves.toBe(true)
        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/batch',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toMatchObject([{ targetId: 'section-42' }])

        await deleteVectorIndexTargets('section')
        await db.delete(targetEmbeddings)
        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/batch',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toEqual([])
    })

    it('does not schedule repair for an up-to-date vector index', async () => {
        await makeTempProject()
        const createdAt = '2024-01-01T00:00:00.000Z'
        const targets = Array.from({ length: 10 }, (_, index) => ({
            createdAt,
            dimensions: 4,
            embeddingHash: `healthy-hash-${index}`,
            model: 'fake/healthy',
            targetId: `section-${index}`,
            targetType: 'section' as const,
            vector: new Float32Array([index === 3 ? 1 : 0, 1, 0, 0]),
        }))
        const db = await getDb()
        await db.insert(targetEmbeddings).values(
            targets.map(target => ({
                createdAt,
                dimensions: target.dimensions,
                dtype: 'float32',
                embeddingHash: target.embeddingHash,
                model: target.model,
                normalized: 1,
                targetId: target.targetId,
                targetType: target.targetType,
                vectorBlob: toBlob(target.vector),
            })),
        )
        await upsertVectorIndexTargets(targets)

        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/healthy',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toMatchObject([{ targetId: 'section-3' }])
        await waitForVectorIndexRepairs()

        const entries = await db
            .select()
            .from(vectorIndexEntries)
            .where(eq(vectorIndexEntries.model, 'fake/healthy'))
        expect(entries).toHaveLength(10)
        expect(new Set(entries.map(entry => entry.updatedAt))).toEqual(
            new Set([createdAt]),
        )
    })

    it('leaves corpus vector repair to explicit extraction jobs', async () => {
        await makeTempProject(30)
        const context = await loadProjectContext()

        await extractProject(context, 'full', {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
        const db = await getDb()
        await db.delete(vectorIndexEntries)

        const unchanged = await extractProject(context, 'changed', {
            embeddingProvider: new ThrowingReuseEmbeddingProvider(),
        })

        expect(unchanged.embeddedCount).toBe(0)
        expect(unchanged.embeddingReusedCount).toBe(0)
    }, 30000)

    it('searches the full durable vector set during exact fallback', async () => {
        await makeTempProject()
        const db = await getDb()
        const createdAt = new Date().toISOString()
        const rows = Array.from({ length: 300 }, (_, index) => ({
            createdAt,
            dimensions: 4,
            dtype: 'float32',
            embeddingHash: `fallback-hash-${index}`,
            model: 'fake/fallback',
            normalized: 1,
            targetId: `section-${index.toString().padStart(3, '0')}`,
            targetType: 'section' as const,
            vectorBlob: toBlob(
                new Float32Array([index === 272 ? 1 : 0, 1, 0, 0]),
            ),
        }))
        await db.insert(targetEmbeddings).values(rows)
        useMissingVectorTableConnection()

        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/fallback',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toMatchObject([{ targetId: 'section-272' }])
    })

    it('keeps exact fallback results capped and sorted by nearest distance', async () => {
        await makeTempProject()
        const db = await getDb()
        const createdAt = new Date().toISOString()
        const rows = Array.from({ length: 300 }, (_, index) => {
            const vector =
                index === 11
                    ? new Float32Array([0.8, 0.6, 0, 0])
                    : index === 172
                      ? new Float32Array([1, 0, 0, 0])
                      : index === 299
                        ? new Float32Array([0.9, 0.4358899, 0, 0])
                        : new Float32Array([0, 1, 0, 0])
            return {
                createdAt,
                dimensions: 4,
                dtype: 'float32',
                embeddingHash: `fallback-top-k-hash-${index}`,
                model: 'fake/fallback-top-k',
                normalized: 1,
                targetId: `section-${index.toString().padStart(3, '0')}`,
                targetType: 'section' as const,
                vectorBlob: toBlob(vector),
            }
        })
        await db.insert(targetEmbeddings).values(rows)
        useMissingVectorTableConnection()

        const results = await searchVectorIndex({
            dimensions: 4,
            limit: 3,
            model: 'fake/fallback-top-k',
            vector: new Float32Array([1, 0, 0, 0]),
        })

        expect(results.map(result => result.targetId)).toEqual([
            'section-172',
            'section-299',
            'section-011',
        ])
        expect(results).toHaveLength(3)
        const [first, second, third] = results
        if (!first || !second || !third) {
            throw new Error('expected three vector search results')
        }
        expect(first.distance).toBeLessThanOrEqual(second.distance)
        expect(second.distance).toBeLessThanOrEqual(third.distance)
    })

    it('falls back immediately and repairs partial sqlite-vec metadata', async () => {
        await makeTempProject()
        const db = await getDb()
        const createdAt = new Date().toISOString()
        const targets = Array.from({ length: 300 }, (_, index) => ({
            createdAt,
            dimensions: 4,
            embeddingHash: `repair-hash-${index}`,
            model: 'fake/repair',
            targetId: `section-${index}`,
            targetType: 'section' as const,
            vector: new Float32Array([index === 299 ? 1 : 0, 1, 0, 0]),
        }))
        await db.insert(targetEmbeddings).values(
            targets.map(target => ({
                createdAt,
                dimensions: target.dimensions,
                dtype: 'float32',
                embeddingHash: target.embeddingHash,
                model: target.model,
                normalized: 1,
                targetId: target.targetId,
                targetType: target.targetType,
                vectorBlob: toBlob(target.vector),
            })),
        )
        await upsertVectorIndexTargets(targets)
        await db
            .delete(vectorIndexEntries)
            .where(eq(vectorIndexEntries.targetId, 'section-299'))

        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/repair',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toMatchObject([{ targetId: 'section-299' }])

        await waitForVectorIndexRepairs()
        const repairedEntries = await db
            .select()
            .from(vectorIndexEntries)
            .where(eq(vectorIndexEntries.model, 'fake/repair'))
        expect(repairedEntries).toHaveLength(300)
    })

    it('prunes stale metadata and native rows during background repair', async () => {
        await makeTempProject()
        const db = await getDb()
        const createdAt = new Date().toISOString()
        const targets = Array.from({ length: 10 }, (_, index) => ({
            createdAt,
            dimensions: 4,
            embeddingHash: `stale-prune-hash-${index}`,
            model: 'fake/stale-prune',
            targetId: `section-${index}`,
            targetType: 'section' as const,
            vector: new Float32Array([index === 7 ? 1 : 0, 1, 0, 0]),
        }))
        const staleTarget = {
            createdAt,
            dimensions: 4,
            embeddingHash: 'stale-prune-extra-hash',
            model: 'fake/stale-prune',
            targetId: 'section-stale',
            targetType: 'section' as const,
            vector: new Float32Array([0, 0, 1, 0]),
        }
        await db.insert(targetEmbeddings).values(
            targets.map(target => ({
                createdAt,
                dimensions: target.dimensions,
                dtype: 'float32',
                embeddingHash: target.embeddingHash,
                model: target.model,
                normalized: 1,
                targetId: target.targetId,
                targetType: target.targetType,
                vectorBlob: toBlob(target.vector),
            })),
        )
        await upsertVectorIndexTargets([...targets, staleTarget])

        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/stale-prune',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toMatchObject([{ targetId: 'section-7' }])

        await waitForVectorIndexRepairs()
        const repairedEntries = await db
            .select()
            .from(vectorIndexEntries)
            .where(eq(vectorIndexEntries.model, 'fake/stale-prune'))
        expect(repairedEntries.map(entry => entry.targetId).sort()).toEqual(
            targets.map(target => target.targetId).sort(),
        )
        const repairedTimestamps = repairedEntries
            .map(entry => ({
                targetId: entry.targetId,
                updatedAt: entry.updatedAt,
            }))
            .sort(compareTimestampRows)

        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/stale-prune',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toMatchObject([{ targetId: 'section-7' }])
        await waitForVectorIndexRepairs()
        const stableEntries = await db
            .select()
            .from(vectorIndexEntries)
            .where(eq(vectorIndexEntries.model, 'fake/stale-prune'))
        expect(
            stableEntries
                .map(entry => ({
                    targetId: entry.targetId,
                    updatedAt: entry.updatedAt,
                }))
                .sort(compareTimestampRows),
        ).toEqual(repairedTimestamps)
    })

    it('runs background vector repair outside foreground transactions', async () => {
        await makeTempProject()
        const db = await getDb()
        const createdAt = new Date().toISOString()
        const targets = Array.from({ length: 10 }, (_, index) => ({
            createdAt,
            dimensions: 4,
            embeddingHash: `transaction-repair-hash-${index}`,
            model: 'fake/transaction-repair',
            targetId: `section-${index}`,
            targetType: 'section' as const,
            vector: new Float32Array([index === 9 ? 1 : 0, 1, 0, 0]),
        }))
        await db.insert(targetEmbeddings).values(
            targets.map(target => ({
                createdAt,
                dimensions: target.dimensions,
                dtype: 'float32',
                embeddingHash: target.embeddingHash,
                model: target.model,
                normalized: 1,
                targetId: target.targetId,
                targetType: target.targetType,
                vectorBlob: toBlob(target.vector),
            })),
        )
        await upsertVectorIndexTargets(targets)
        await db
            .delete(vectorIndexEntries)
            .where(eq(vectorIndexEntries.targetId, 'section-9'))

        await withTransaction(async () => {
            await searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/transaction-repair',
                vector: new Float32Array([1, 1, 0, 0]),
            })
        })

        await waitForVectorIndexRepairs()
        const repairedEntries = await db
            .select()
            .from(vectorIndexEntries)
            .where(eq(vectorIndexEntries.model, 'fake/transaction-repair'))
        expect(repairedEntries).toHaveLength(10)
    })

    it('embeds retrieval documents past the removed 250 row batch boundary', async () => {
        await makeTempProject()
        const db = await getDb()
        const updatedAt = new Date().toISOString()
        const progressEvents: ExtractionProgressEvent[] = []
        await db.insert(retrievalDocuments).values(
            Array.from({ length: 300 }, (_, index) => ({
                embeddingHash: `document-hash-${index}`,
                embeddingText: `document text ${index}`,
                ftsHash: `fts-hash-${index}`,
                ftsText: `document text ${index}`,
                path: `src/document-${index}.txt`,
                targetId: `section-${index.toString().padStart(3, '0')}`,
                targetType: 'section' as const,
                updatedAt,
            })),
        )

        const result = await generateTargetEmbeddings(
            new FakeEmbeddingProvider(),
            ['section'],
            updatedAt,
            {
                onProgress(event) {
                    progressEvents.push(event)
                },
            },
        )

        expect(result).toEqual({ embeddedCount: 300, reusedCount: 0 })
        expect(
            await db
                .select()
                .from(targetEmbeddings)
                .where(eq(targetEmbeddings.targetType, 'section')),
        ).toHaveLength(300)
        expect(
            await db
                .select()
                .from(vectorIndexEntries)
                .where(eq(vectorIndexEntries.targetType, 'section')),
        ).toHaveLength(300)
        expect(
            progressEvents.filter(
                event =>
                    event.phase === 'embeddings' && event.stage === 'index',
            ),
        ).toMatchObject([
            {
                batchCurrent: 1,
                batchSize: 300,
                batchTotal: 1,
                current: 300,
                status: 'start',
                total: 300,
            },
            {
                batchCurrent: 1,
                batchSize: 300,
                batchTotal: 1,
                current: 300,
                status: 'done',
                total: 300,
            },
        ])
        const indexStart = progressEvents.findIndex(
            event =>
                event.phase === 'embeddings' &&
                event.stage === 'index' &&
                event.status === 'start',
        )
        const lastEmbedProgress = lastIndexWhere(
            progressEvents,
            event =>
                event.phase === 'embeddings' &&
                event.stage === 'embed' &&
                event.status === 'progress',
        )
        expect(indexStart).toBeGreaterThan(lastEmbedProgress)
    })

    it('repairs vector metadata hash mismatches with equal row counts', async () => {
        await makeTempProject()
        const db = await getDb()
        const createdAt = new Date().toISOString()
        const target = {
            createdAt,
            dimensions: 4,
            embeddingHash: 'repair-hash',
            model: 'fake/hash-repair',
            targetId: 'section-hash',
            targetType: 'section' as const,
            vector: new Float32Array([1, 1, 0, 0]),
        }
        await db.insert(targetEmbeddings).values({
            createdAt,
            dimensions: target.dimensions,
            dtype: 'float32',
            embeddingHash: target.embeddingHash,
            model: target.model,
            normalized: 1,
            targetId: target.targetId,
            targetType: target.targetType,
            vectorBlob: toBlob(target.vector),
        })
        await upsertVectorIndexTargets([target])
        await db
            .update(vectorIndexEntries)
            .set({ embeddingHash: 'stale-hash' })
            .where(eq(vectorIndexEntries.targetId, target.targetId))

        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: target.model,
                vector: target.vector,
            }),
        ).resolves.toMatchObject([{ targetId: target.targetId }])

        await waitForVectorIndexRepairs()
        const [repairedEntry] = await db
            .select()
            .from(vectorIndexEntries)
            .where(eq(vectorIndexEntries.targetId, target.targetId))
        expect(repairedEntry?.embeddingHash).toBe(target.embeddingHash)
    })
})

async function makeTempProject(fileCount = 1): Promise<string> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-vector-index-'))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, '.git'))
    await mkdir(join(projectRoot, '.konteks'))
    await mkdir(join(projectRoot, 'src'))
    await writeFile(join(projectRoot, '.konteks', 'config.json'), '{}\n')
    await Promise.all(
        Array.from({ length: fileCount }, (_, index) =>
            writeFile(
                join(projectRoot, 'src', `index-${index}.txt`),
                `vector fixture ${index}\n`,
            ),
        ),
    )
    process.chdir(projectRoot)
    return projectRoot
}

function toBlob(vector: Float32Array): Uint8Array {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function useMissingVectorTableConnection(): void {
    globalThis.__konteksVectorIndexConnectionFactoryForTests = async () => ({
        database: {
            exec() {},
            loadExtension() {},
            prepare() {
                return {
                    all() {
                        return []
                    },
                    get() {
                        return undefined
                    },
                    run() {
                        return { lastInsertRowid: 0 }
                    },
                }
            },
        },
        path: 'missing-vector-table.sqlite',
    })
}

async function waitForVectorIndexRepairs(): Promise<void> {
    await globalThis.__konteksWaitForVectorIndexRepairsForTests?.()
}

function lastIndexWhere<T>(
    items: T[],
    predicate: (item: T) => boolean,
): number {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index]
        if (item !== undefined && predicate(item)) {
            return index
        }
    }
    return -1
}

function compareTimestampRows(
    left: { targetId: string },
    right: { targetId: string },
): number {
    return left.targetId.localeCompare(right.targetId)
}
