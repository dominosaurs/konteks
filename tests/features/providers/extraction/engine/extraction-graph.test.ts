import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTransaction } from '@/database/actions/_db'
import searchEntities from '@/database/actions/search-entities'
import traverseNeighbors from '@/database/actions/traverse-neighbors'
import {
    deleteAllExtractedGraph,
    upsertEntity,
    upsertEntityAliases,
} from '@/database/services/graph'
import { upsertNode } from '@/database/services/taxonomy'
import persistPreparedFileSections from '@/modules/extraction/engine/persist-prepared-file-sections'
import { extractProject } from '@/modules/extraction/extract-project'
import recallRepositoryMemory from '@/modules/memory/recall-repository-memory'
import { loadProjectContext } from '@/modules/project/context'
import contentHash from '@/support/content-hash'
import { mkdir, rm } from '@/support/file-manager'
import FakeEmbeddingProvider from '../../../../fake/fake-embedding-provider'

const tempDirs: string[] = []
const originalCwd = process.cwd()

afterEach(async () => {
    process.chdir(originalCwd)
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

describe('extraction graph', () => {
    it('persists file and symbol graph rows from prepared sections', async () => {
        const projectRoot = await makeProject()
        process.chdir(projectRoot)

        await withTransaction(async () => {
            const root = await upsertNode({ name: 'Project Files' })
            await persistPreparedFileSections({
                extractedAt: '2026-01-01T00:00:00.000Z',
                preparedFile: preparedSymbolFile(),
                rootNodeId: root.id,
            })
        })

        const [fileEntity] = await searchEntities('widgets.ts', { limit: 5 })
        const [symbolEntity] = await searchEntities('GraphWidget', {
            limit: 5,
        })

        expect(fileEntity).toMatchObject({
            canonicalName: 'src/widgets.ts',
            name: 'widgets.ts',
            type: 'file',
        })
        expect(symbolEntity).toMatchObject({
            canonicalName: 'src/widgets.ts#GraphWidget',
            name: 'GraphWidget',
            type: 'symbol',
        })
        await expect(traverseNeighbors(fileEntity.id)).resolves.toEqual([
            expect.objectContaining({
                direction: 'outgoing',
                entity: expect.objectContaining({
                    id: symbolEntity.id,
                    type: 'symbol',
                }),
                predicate: 'defines',
            }),
        ])

        const recall = await recallRepositoryMemory({
            focus: ['GraphWidget symbol'],
        })
        expect(recall.graph).toEqual([
            expect.objectContaining({
                entityName: 'GraphWidget',
                predicate: 'defines',
                relatedEntityName: 'widgets.ts',
            }),
        ])
    })

    it('creates module graph rows during extraction', async () => {
        const projectRoot = await makeProject()
        await mkdir(join(projectRoot, 'src'))
        await writeFile(
            join(projectRoot, 'src', 'alpha.txt'),
            'Alpha extraction graph fixture.\n',
        )
        await writeFile(
            join(projectRoot, 'src', 'beta.txt'),
            'Beta extraction graph fixture.\n',
        )
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'rebuild', {
                embeddingProvider: new FakeEmbeddingProvider(),
            }),
        )

        const [moduleEntity] = await withProjectRoot(projectRoot, () =>
            searchEntities('src', { limit: 5 }),
        )
        const neighbors = await withProjectRoot(projectRoot, () =>
            traverseNeighbors(moduleEntity.id, {
                limit: 10,
            }),
        )

        expect(moduleEntity).toMatchObject({
            name: 'src',
            type: 'module',
        })
        expect(neighbors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    direction: 'outgoing',
                    entity: expect.objectContaining({
                        name: 'alpha.txt',
                        type: 'file',
                    }),
                    predicate: 'contains',
                }),
                expect.objectContaining({
                    direction: 'outgoing',
                    entity: expect.objectContaining({
                        name: 'beta.txt',
                        type: 'file',
                    }),
                    predicate: 'contains',
                }),
            ]),
        )

        const recall = await withProjectRoot(projectRoot, () =>
            recallRepositoryMemory({
                focus: ['src module alpha'],
            }),
        )
        expect(recall.graph).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entityName: 'src',
                    predicate: 'contains',
                    relatedEntityName: 'alpha.txt',
                }),
            ]),
        )
    })

    it('cleans stale extraction graph rows and preserves durable graph rows', async () => {
        const projectRoot = await makeProject()
        await mkdir(join(projectRoot, 'src'))
        await writeFile(join(projectRoot, 'src', 'old.txt'), 'Old file.\n')
        await writeFile(join(projectRoot, 'src', 'keep.txt'), 'Keep file.\n')
        await writeFile(join(projectRoot, 'biome.json'), '{"extends":[]}\n')
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'rebuild', {
                embeddingProvider: new FakeEmbeddingProvider(),
            }),
        )
        const durable = await withProjectRoot(projectRoot, async () => {
            const entity = await upsertEntity({
                canonicalName: 'durable-cycle-two',
                name: 'durable-cycle-two',
                type: 'memory',
            })
            await upsertEntityAliases(entity.id, ['durable-cycle-two'])
            return entity
        })

        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('old.txt', { limit: 5 }),
            ),
        ).resolves.toEqual([
            expect.objectContaining({
                name: 'old.txt',
                type: 'file',
            }),
        ])
        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('biome.json', { limit: 10 }),
            ).then(matches => matches.filter(match => match.type === 'config')),
        ).resolves.toEqual([
            expect.objectContaining({
                name: 'biome.json',
                type: 'config',
            }),
        ])

        await unlink(join(projectRoot, 'src', 'old.txt'))
        await unlink(join(projectRoot, 'biome.json'))
        await writeFile(join(projectRoot, 'src', 'new.txt'), 'New file.\n')
        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'changed', {
                embeddingProvider: new FakeEmbeddingProvider(),
            }),
        )

        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('old.txt', { limit: 5 }),
            ),
        ).resolves.toEqual([])
        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('new.txt', { limit: 5 }),
            ),
        ).resolves.toEqual([
            expect.objectContaining({
                name: 'new.txt',
                type: 'file',
            }),
        ])
        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('biome.json', { limit: 10 }),
            ).then(matches => matches.filter(match => match.type === 'config')),
        ).resolves.toEqual([])
        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('durable-cycle-two', { limit: 5 }),
            ),
        ).resolves.toEqual([
            expect.objectContaining({
                id: durable.id,
                type: 'memory',
            }),
        ])
    })

    it('recreates missing file entities for unchanged legacy sections during changed extraction', async () => {
        const projectRoot = await makeProject()
        await mkdir(join(projectRoot, 'src'))
        await writeFile(join(projectRoot, 'src', 'legacy.txt'), 'Legacy.\n')
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'rebuild', {
                embeddingProvider: new FakeEmbeddingProvider(),
            }),
        )
        await withProjectRoot(projectRoot, () => deleteAllExtractedGraph())
        await writeFile(join(projectRoot, 'src', 'new.txt'), 'New.\n')

        await expect(
            withProjectRoot(projectRoot, () =>
                extractProject(context, 'changed', {
                    embeddingProvider: new FakeEmbeddingProvider(),
                }),
            ),
        ).resolves.toMatchObject({
            ok: true,
        })

        const [moduleEntity] = await withProjectRoot(projectRoot, () =>
            searchEntities('src', { limit: 5 }),
        )
        const neighbors = await withProjectRoot(projectRoot, () =>
            traverseNeighbors(moduleEntity.id, { limit: 10 }),
        )

        expect(neighbors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entity: expect.objectContaining({
                        name: 'legacy.txt',
                        type: 'file',
                    }),
                    predicate: 'contains',
                }),
                expect.objectContaining({
                    entity: expect.objectContaining({
                        name: 'new.txt',
                        type: 'file',
                    }),
                    predicate: 'contains',
                }),
            ]),
        )
    })

    it('creates package, command, config, and doc metadata graph rows', async () => {
        const projectRoot = await makeProject()
        await writeFile(
            join(projectRoot, 'package.json'),
            JSON.stringify(
                {
                    dependencies: { 'left-pad': '^1.3.0' },
                    name: 'metadata-fixture',
                    packageManager: 'bun@1.3.12',
                    scripts: { graphcycle: 'bun test' },
                },
                null,
                2,
            ),
        )
        await writeFile(join(projectRoot, 'biome.json'), '{"extends":[]}\n')
        await writeFile(join(projectRoot, 'README.md'), '# Metadata Docs\n')
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'rebuild', {
                embeddingProvider: new FakeEmbeddingProvider(),
            }),
        )

        const [projectPackage] = await withProjectRoot(projectRoot, () =>
            searchEntities('metadata-fixture', { limit: 5 }),
        )
        const [dependencyPackage] = await withProjectRoot(projectRoot, () =>
            searchEntities('left-pad', { limit: 5 }),
        )
        const [command] = await withProjectRoot(projectRoot, () =>
            searchEntities('bun graphcycle', { limit: 5 }),
        )
        const config = await withProjectRoot(projectRoot, () =>
            searchEntities('biome.json', { limit: 10 }),
        ).then(matches => matches.find(match => match.type === 'config'))
        const doc = await withProjectRoot(projectRoot, () =>
            searchEntities('README.md', { limit: 10 }),
        ).then(matches => matches.find(match => match.type === 'doc'))

        expect(projectPackage).toMatchObject({
            name: 'metadata-fixture',
            type: 'package',
        })
        expect(dependencyPackage).toMatchObject({
            name: 'left-pad',
            type: 'package',
        })
        expect(command).toMatchObject({
            name: 'graphcycle',
            type: 'command',
        })
        expect(config).toMatchObject({
            name: 'biome.json',
            type: 'config',
        })
        expect(doc).toMatchObject({
            name: 'README.md',
            type: 'doc',
        })

        await expect(
            withProjectRoot(projectRoot, () => traverseNeighbors(command.id)),
        ).resolves.toEqual([
            expect.objectContaining({
                direction: 'outgoing',
                entity: expect.objectContaining({
                    id: projectPackage.id,
                    type: 'package',
                }),
                predicate: 'uses_package',
            }),
        ])
        await expect(
            withProjectRoot(projectRoot, () =>
                traverseNeighbors(projectPackage.id, { limit: 10 }),
            ),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    direction: 'outgoing',
                    entity: expect.objectContaining({
                        id: dependencyPackage.id,
                    }),
                    predicate: 'uses_package',
                }),
            ]),
        )

        const recall = await withProjectRoot(projectRoot, () =>
            recallRepositoryMemory({
                focus: ['graphcycle metadata fixture left pad'],
            }),
        )
        expect(recall.graph).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entityName: 'graphcycle',
                    predicate: 'uses_package',
                    relatedEntityName: 'metadata-fixture',
                }),
            ]),
        )
    })

    it('creates package entities from non-Node manifest metadata', async () => {
        const projectRoot = await makeProject()
        await writeFile(
            join(projectRoot, 'composer.json'),
            JSON.stringify({
                name: 'acme/api',
                require: {
                    'laravel/framework': '^12.0',
                    php: '^8.3',
                },
            }),
        )
        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )

        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'rebuild', {
                embeddingProvider: new FakeEmbeddingProvider(),
            }),
        )

        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('acme api', { limit: 5 }),
            ),
        ).resolves.toEqual([
            expect.objectContaining({
                name: 'acme/api',
                type: 'package',
            }),
        ])
        await expect(
            withProjectRoot(projectRoot, () =>
                searchEntities('laravel/framework', { limit: 5 }),
            ),
        ).resolves.toEqual([
            expect.objectContaining({
                name: 'laravel/framework',
                type: 'package',
            }),
        ])
    })
})

async function makeProject(): Promise<string> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-graph-extract-'))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, '.git'))
    await mkdir(join(projectRoot, '.konteks'))
    await writeFile(join(projectRoot, '.konteks', 'config.json'), '{}\n')
    return projectRoot
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

function preparedSymbolFile() {
    const content = 'export class GraphWidget {}\n'
    const hash = contentHash(content)
    return {
        language: 'typescript',
        parserEngine: 'test',
        parserStatus: 'ok',
        path: 'src/widgets.ts',
        sections: [
            {
                anchor: 'GraphWidget',
                anchorType: 'symbol',
                contentHash: hash,
                contentInline: content,
                endLine: 1,
                id: 'section_graph_widget',
                kind: 'code',
                metadata: {
                    exported: true,
                    parserEngine: 'test',
                    parserStatus: 'ok',
                },
                path: 'src/widgets.ts',
                retrievalTexts: {
                    embeddingText: content,
                    ftsText: content,
                },
                startLine: 1,
                summary: 'code section from src/widgets.ts#GraphWidget',
                symbol: 'GraphWidget',
                tokenCount: 8,
                topics: ['graph', 'widget'],
            },
        ],
        sourceId: 'source_widgets',
        sourceMetadata: {
            exports: ['GraphWidget'],
            imports: [],
            parserEngine: 'test',
            parserStatus: 'ok',
        },
        sourceRole: 'app_code',
        sourceTopics: ['graph', 'widget'],
        truncated: false,
    }
}
