import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import historicalRelations from '@/database/actions/historical-relations'
import traverseNeighbors from '@/database/actions/traverse-neighbors'
import forgetMemory from '@/database/services/forget-memory'
import { entityIdFor } from '@/database/services/graph'
import {
    saveKonteksDiary,
    saveKonteksMemories,
} from '@/database/services/save-memory'
import { extractProject } from '@/modules/extraction/extract-project'
import recallRepositoryMemory from '@/modules/memory/recall-repository-memory'
import { loadProjectContext } from '@/modules/project/context'
import { mkdir, rm } from '@/support/file-manager'
import FakeEmbeddingProvider from '../../fake/fake-embedding-provider'

const tempDirs: string[] = []
const originalCwd = process.cwd()

afterEach(async () => {
    process.chdir(originalCwd)
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

describe('durable memory graph projection', () => {
    it('projects constraint memories to source graph entities and recall evidence', async () => {
        const projectRoot = await makeExtractedProject()
        process.chdir(projectRoot)
        const context = await loadProjectContext()

        const result = await saveKonteksMemories(
            context,
            {
                memories: [
                    {
                        content:
                            'Cycle five durable policy requires graph evidence to stay attached to src/durable-policy.txt during recall.',
                        importance: 5,
                        kind: 'constraint',
                        source: 'src/durable-policy.txt',
                        tags: ['durable-policy'],
                    },
                ],
            },
            { embeddingProvider: new FakeEmbeddingProvider() },
        )

        const memoryId = result.memoryIds?.[0]
        if (!memoryId) {
            throw new Error('expected memory id')
        }

        const neighbors = await traverseNeighbors(
            entityIdFor('memory', memoryId),
        )
        expect(neighbors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entity: expect.objectContaining({
                        name: 'durable-policy.txt',
                        type: 'file',
                    }),
                    predicate: 'applies_to',
                }),
            ]),
        )

        const recall = await recallRepositoryMemory({
            focus: ['cycle five durable policy graph evidence'],
        })
        expect(recall.graph).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entityName: 'durable-policy.txt',
                    predicate: 'applies_to',
                    relatedEntityName: expect.stringContaining(memoryId),
                }),
            ]),
        )
    })

    it('projects code insight and diary mentions with idempotent relation writes', async () => {
        const projectRoot = await makeExtractedProject()
        process.chdir(projectRoot)
        const context = await loadProjectContext()
        const memoryInput = {
            memories: [
                {
                    content:
                        'The `durable-policy.txt` implementation documents cycle five durable graph behavior.',
                    importance: 4 as const,
                    kind: 'code_insight' as const,
                },
            ],
        }

        const first = await saveKonteksMemories(context, memoryInput, {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
        const second = await saveKonteksMemories(context, memoryInput, {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
        const diary = await saveKonteksDiary(
            context,
            {
                subject: 'durable graph diary',
                summary:
                    'Diary summary mentions `src/durable-policy.txt` as the durable graph recall fixture.',
                tags: ['durable-policy'],
            },
            { embeddingProvider: new FakeEmbeddingProvider() },
        )

        const memoryId = first.memoryIds?.[0]
        if (!memoryId || !diary.diaryId) {
            throw new Error('expected durable ids')
        }

        expect(second.memoryIds).toEqual(first.memoryIds)
        await expect(
            traverseNeighbors(entityIdFor('memory', memoryId)),
        ).resolves.toEqual([
            expect.objectContaining({
                entity: expect.objectContaining({
                    name: 'durable-policy.txt',
                    type: 'file',
                }),
                predicate: 'concerns',
            }),
        ])
        await expect(
            traverseNeighbors(entityIdFor('diary', diary.diaryId)),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entity: expect.objectContaining({
                        name: 'durable-policy.txt',
                        type: 'file',
                    }),
                    predicate: 'concerns',
                }),
            ]),
        )
    })

    it('removes durable graph rows when memory is forgotten', async () => {
        const projectRoot = await makeExtractedProject()
        process.chdir(projectRoot)
        const context = await loadProjectContext()
        const result = await saveKonteksMemories(
            context,
            {
                memories: [
                    {
                        content:
                            'Forget cleanup should remove graph evidence attached to src/durable-policy.txt.',
                        importance: 3,
                        kind: 'note',
                        source: 'src/durable-policy.txt',
                    },
                ],
            },
            { embeddingProvider: new FakeEmbeddingProvider() },
        )
        const memoryId = result.memoryIds?.[0]
        if (!memoryId) {
            throw new Error('expected memory id')
        }

        await expect(
            traverseNeighbors(entityIdFor('memory', memoryId)),
        ).resolves.not.toEqual([])

        await forgetMemory({
            id: memoryId,
            mode: 'soft_delete',
            reason: 'durable graph cleanup test',
        })

        await expect(
            traverseNeighbors(entityIdFor('memory', memoryId)),
        ).resolves.toEqual([])
    })

    it('supersedes prior decision graph claims and recalls them as history', async () => {
        const projectRoot = await makeExtractedProject()
        process.chdir(projectRoot)
        const context = await loadProjectContext()
        const original = await saveKonteksMemories(
            context,
            {
                memories: [
                    {
                        content:
                            'Original durable policy decision keeps the legacy graph attachment for src/durable-policy.txt.',
                        importance: 4,
                        kind: 'decision',
                        source: 'src/durable-policy.txt',
                    },
                ],
            },
            { embeddingProvider: new FakeEmbeddingProvider() },
        )
        const originalId = original.memoryIds?.[0]
        if (!originalId) {
            throw new Error('expected original decision id')
        }

        const replacementInput = {
            memories: [
                {
                    content:
                        'Replacement durable policy decision supersedes the legacy graph attachment for src/durable-policy.txt.',
                    importance: 5 as const,
                    kind: 'decision' as const,
                    source: 'src/durable-policy.txt',
                    supersedes: [originalId],
                },
            ],
        }
        const replacement = await saveKonteksMemories(
            context,
            replacementInput,
            { embeddingProvider: new FakeEmbeddingProvider() },
        )
        const duplicateReplacement = await saveKonteksMemories(
            context,
            replacementInput,
            { embeddingProvider: new FakeEmbeddingProvider() },
        )
        const replacementId = replacement.memoryIds?.[0]
        if (!replacementId) {
            throw new Error('expected replacement decision id')
        }

        expect(duplicateReplacement.memoryIds).toEqual(replacement.memoryIds)
        await expect(
            traverseNeighbors(entityIdFor('memory', replacementId), {
                limit: 10,
            }),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entity: expect.objectContaining({
                        name: expect.stringContaining(originalId),
                        type: 'memory',
                    }),
                    predicate: 'supersedes',
                }),
                expect.objectContaining({
                    entity: expect.objectContaining({
                        name: 'durable-policy.txt',
                        type: 'file',
                    }),
                    predicate: 'concerns',
                }),
            ]),
        )

        const originalActiveClaims = await traverseNeighbors(
            entityIdFor('memory', originalId),
            { limit: 10 },
        ).then(neighbors =>
            neighbors.filter(neighbor => neighbor.predicate === 'concerns'),
        )
        expect(originalActiveClaims).toEqual([])

        const history = await historicalRelations(
            entityIdFor('memory', originalId),
            { limit: 10 },
        )
        expect(history).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    object: expect.objectContaining({
                        name: 'durable-policy.txt',
                        type: 'file',
                    }),
                    predicate: 'concerns',
                    status: 'superseded',
                    subject: expect.objectContaining({
                        name: expect.stringContaining(originalId),
                    }),
                    validTo: expect.any(String),
                }),
            ]),
        )

        const recall = await recallRepositoryMemory({
            focus: ['previous decision history for durable policy replacement'],
            includeSources: true,
        })
        expect(recall.history).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    objectEntityName: 'durable-policy.txt',
                    predicate: 'concerns',
                    status: 'superseded',
                    subjectEntityName: expect.stringContaining(originalId),
                    validTo: expect.any(String),
                }),
            ]),
        )
    })

    it('invalidates relation forget targets and recalls invalidated history', async () => {
        const projectRoot = await makeExtractedProject()
        process.chdir(projectRoot)
        const context = await loadProjectContext()
        const saved = await saveKonteksMemories(
            context,
            {
                memories: [
                    {
                        content:
                            'Invalidated durable policy relation should move from active graph evidence to history.',
                        importance: 3,
                        kind: 'note',
                        source: 'src/durable-policy.txt',
                    },
                ],
            },
            { embeddingProvider: new FakeEmbeddingProvider() },
        )
        const memoryId = saved.memoryIds?.[0]
        if (!memoryId) {
            throw new Error('expected memory id')
        }
        const [claim] = await traverseNeighbors(entityIdFor('memory', memoryId))
        if (!claim) {
            throw new Error('expected active relation')
        }

        await forgetMemory({
            id: claim.relationId,
            mode: 'invalidate',
            reason: 'relation invalidation test',
        })

        await expect(
            traverseNeighbors(entityIdFor('memory', memoryId)),
        ).resolves.toEqual([])
        await expect(
            historicalRelations(entityIdFor('memory', memoryId), {
                limit: 10,
            }),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    predicate: 'concerns',
                    status: 'invalidated',
                    validTo: expect.any(String),
                }),
            ]),
        )

        const recall = await recallRepositoryMemory({
            focus: ['invalidated relation history for durable policy'],
            includeSources: true,
        })
        expect(recall.history).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    predicate: 'concerns',
                    status: 'invalidated',
                    validTo: expect.any(String),
                }),
            ]),
        )
    })
})

async function makeExtractedProject(): Promise<string> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-durable-graph-'))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, '.git'))
    await mkdir(join(projectRoot, '.konteks'))
    await mkdir(join(projectRoot, 'src'))
    await writeFile(join(projectRoot, '.konteks', 'config.json'), '{}\n')
    await writeFile(
        join(projectRoot, 'src', 'durable-policy.txt'),
        'Durable policy fixture for graph projection.\n',
    )

    const previous = process.cwd()
    process.chdir(projectRoot)
    try {
        const context = await loadProjectContext()
        await extractProject(context, 'rebuild', {
            embeddingProvider: new FakeEmbeddingProvider(),
        })
    } finally {
        process.chdir(previous)
    }

    return projectRoot
}
