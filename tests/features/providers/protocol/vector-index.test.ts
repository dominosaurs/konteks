import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import getDb from '@/database/actions/_db'
import { targetEmbeddings, vectorIndexEntries } from '@/database/schema'
import {
    deleteVectorIndexTargets,
    searchVectorIndex,
    upsertVectorIndexTargets,
} from '@/database/services/vector-index'
import { extractProject } from '@/modules/extraction/extract-project'
import { loadProjectContext } from '@/modules/project/context'
import { mkdir, rm } from '@/support/file-manager'
import type { EmbeddingProviderContract } from '@/types/embedding-provider'
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

    it('keeps exact fallback search bounded across durable vector pages', async () => {
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

    it('falls back immediately and repairs partial sqlite-vec metadata', async () => {
        await makeTempProject()
        const db = await getDb()
        const createdAt = new Date().toISOString()
        const targets = Array.from({ length: 2 }, (_, index) => ({
            createdAt,
            dimensions: 4,
            embeddingHash: `repair-hash-${index}`,
            model: 'fake/repair',
            targetId: `section-${index}`,
            targetType: 'section' as const,
            vector: new Float32Array([index, 1, 0, 0]),
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
            .where(eq(vectorIndexEntries.targetId, 'section-1'))

        await expect(
            searchVectorIndex({
                dimensions: 4,
                limit: 1,
                model: 'fake/repair',
                vector: new Float32Array([1, 1, 0, 0]),
            }),
        ).resolves.toMatchObject([{ targetId: 'section-1' }])

        await waitForVectorIndexRepairs()
        const repairedEntries = await db
            .select()
            .from(vectorIndexEntries)
            .where(eq(vectorIndexEntries.model, 'fake/repair'))
        expect(repairedEntries).toHaveLength(2)
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
