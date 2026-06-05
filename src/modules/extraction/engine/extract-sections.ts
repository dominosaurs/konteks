import { withTransaction } from '@/database/actions/_db'
import appendMemoryEvent from '@/database/actions/append-memory-event'
import reindexRetrievalDocumentFts from '@/database/actions/reindex-retrieval-document-fts'
import { upsertNode } from '@/database/services/taxonomy'
import consoleOutput from '@/support/console-output'
import contentHash from '@/support/content-hash'
import type { ExtractionProgressReporter } from '@/types/progress'
import type { Project } from '@/types/project'
import type { ProjectMetadata } from './extract-project-metadata'
import type { ScannedFile } from './file-scan'
import { initTreeSitterWithSelectedGrammars } from './grammar-loader'
import persistPreparedFileSections from './persist-prepared-file-sections'
import type { PreparedFile } from './prepare-file-sections'
import prepareFileSections from './prepare-file-sections'
import rebuildModuleArtifacts, {
    type ModuleArtifactKey,
    queryModuleArtifactKeysForPaths,
    rebuildChangedModuleArtifacts,
} from './rebuild-module-artifacts'
import {
    clearExtractedSections,
    clearExtractedSectionsForPaths,
    recordExtractedSuppressionsForPaths,
} from './section-cleanup'
import TreeSitterEngine from './tree-sitter-engine'

type ExtractSectionsResult = {
    sectionCount: number
    filesTruncatedBySectionLimit: number
    loadedParserCount: number
    parserFallbackFiles: number
    parserUsedFiles: number
}

export default async function extractSections(
    context: Project,
    files: ScannedFile[],
    extractedAt: string,
    options: {
        beforeExtract?: () => Promise<void>
        canUpdateEmbeddings?: boolean
        deletedPaths?: string[]
        metadata?: ProjectMetadata
        mode?: 'changed' | 'full' | 'rebuild' | 'resume'
        onProgress?: ExtractionProgressReporter
    } = {},
): Promise<ExtractSectionsResult> {
    const progress = options.onProgress
    let engine: TreeSitterEngine | undefined
    let loadedParserCount = 0

    if (files.length > 0) {
        progress?.({
            message: 'Loading Tree-sitter grammars',
            phase: 'sections',
            status: 'start',
        })
        engine = new TreeSitterEngine()
        const loaded = await initTreeSitterWithSelectedGrammars(
            engine,
            context,
            {
                onProgress: progress,
                paths: files.map(file => file.path),
            },
        )
        if (loaded.loaded.length === 0) {
            engine = undefined
        }
        loadedParserCount = loaded.loaded.length
        for (const warning of loaded.warnings) {
            consoleOutput.error(warning)
        }
        progress?.({
            message: 'Tree-sitter grammars ready',
            phase: 'sections',
            status: 'progress',
        })
    }

    await options.beforeExtract?.()

    let sectionCount = 0
    let filesTruncatedBySectionLimit = 0
    let parserFallbackFiles = 0
    let parserUsedFiles = 0
    const changedPaths = files.map(file => file.path)
    const affectedPaths = [...changedPaths, ...(options.deletedPaths ?? [])]
    const previousModuleKeys =
        options.mode === 'changed'
            ? await queryModuleArtifactKeysForPaths(affectedPaths)
            : []

    let rootNodeId = ''
    progress?.({
        message: 'Preparing extraction tables',
        phase: 'database',
        status: 'progress',
    })
    if (options.mode === 'changed') {
        const preparedFiles: PreparedFile[] = []
        await recordExtractedSuppressionsForPaths(affectedPaths)
        if (files.length > 0) {
            progress?.({
                message: `Extracting ${files.length} files`,
                phase: 'sections',
                status: 'start',
                total: files.length,
            })
            await yieldToProgressRenderer()
        }

        for (const [fileIndex, file] of files.entries()) {
            const preparedFile = await prepareFileSections({
                context,
                engine,
                file,
            })
            preparedFiles.push(preparedFile)

            if (
                preparedFile.parserEngine === 'tree_sitter' &&
                preparedFile.parserStatus === 'ok'
            ) {
                parserUsedFiles += 1
            } else if (
                preparedFile.sections.some(section => section.kind === 'code')
            ) {
                parserFallbackFiles += 1
            }

            if (preparedFile.truncated) {
                filesTruncatedBySectionLimit += 1
            }

            sectionCount += preparedFile.sections.length
            progress?.({
                current: fileIndex + 1,
                message: `Extracted ${file.path} (${preparedFile.sections.length} sections)`,
                path: file.path,
                phase: 'sections',
                sectionCount: sectionCount,
                status: 'progress',
                total: files.length,
            })
            await yieldToProgressRenderer()
        }

        if (files.length > 0) {
            progress?.({
                current: files.length,
                message: `Extracted ${sectionCount} sections`,
                parserCount: loadedParserCount,
                phase: 'sections',
                sectionCount: sectionCount,
                status: 'done',
                total: files.length,
            })
        }
        progress?.({
            message: 'Rebuilding module artifacts and retrieval index',
            phase: 'modules',
            status: 'start',
        })

        await withTransaction(async () => {
            await clearExtractedSectionsForPaths(affectedPaths)
            const rootNode = await upsertNode({
                name: 'Project Files',
                summary: 'Files extracted from the current project.',
            })
            rootNodeId = rootNode.id

            for (const preparedFile of preparedFiles) {
                if (preparedFile.sections.length > 0) {
                    await persistPreparedFileSections({
                        extractedAt,
                        preparedFile,
                        rootNodeId,
                    })
                }
            }

            const currentModuleKeys =
                await queryModuleArtifactKeysForPaths(changedPaths)
            await rebuildChangedModuleArtifacts(extractedAt, {
                canUpdateEmbeddings: options.canUpdateEmbeddings ?? false,
                metadata: options.metadata,
                metadataChanged: hasMetadataRelevantPath(affectedPaths),
                moduleKeys: dedupeModuleKeys([
                    ...previousModuleKeys,
                    ...currentModuleKeys,
                ]),
            })

            await appendMemoryEvent({
                actor: 'cli',
                eventType: 'project_extracted',
                id: `event_${contentHash(`${context.projectRoot}:${extractedAt}`).slice(0, 32)}`,
                subjectType: 'project',
                summary: `Extracted ${files.length} files into ${sectionCount} sections.`,
            })
        })
        progress?.({
            message: 'Module artifacts and retrieval index ready',
            phase: 'modules',
            status: 'done',
        })

        return {
            filesTruncatedBySectionLimit,
            loadedParserCount,
            parserFallbackFiles,
            parserUsedFiles,
            sectionCount: sectionCount,
        }
    }

    await withTransaction(async () => {
        if (options.mode !== 'resume') {
            await clearExtractedSections()
        }
        const rootNode = await upsertNode({
            name: 'Project Files',
            summary: 'Files extracted from the current project.',
        })
        rootNodeId = rootNode.id
    })

    if (files.length > 0) {
        progress?.({
            message: `Extracting ${files.length} files`,
            phase: 'sections',
            status: 'start',
            total: files.length,
        })
        await yieldToProgressRenderer()
    }
    for (const [fileIndex, file] of files.entries()) {
        const preparedFile = await prepareFileSections({
            context,
            engine,
            file,
        })

        if (
            preparedFile.parserEngine === 'tree_sitter' &&
            preparedFile.parserStatus === 'ok'
        ) {
            parserUsedFiles += 1
        } else if (
            preparedFile.sections.some(section => section.kind === 'code')
        ) {
            parserFallbackFiles += 1
        }

        if (preparedFile.truncated) {
            filesTruncatedBySectionLimit += 1
        }

        if (preparedFile.sections.length > 0) {
            await withTransaction(async () => {
                sectionCount += await persistPreparedFileSections({
                    extractedAt,
                    preparedFile,
                    rootNodeId,
                })
            })
        }

        progress?.({
            current: fileIndex + 1,
            message: `Extracted ${file.path} (${preparedFile.sections.length} sections)`,
            path: file.path,
            phase: 'sections',
            sectionCount: sectionCount,
            status: 'progress',
            total: files.length,
        })
        await yieldToProgressRenderer()
    }

    if (files.length > 0) {
        progress?.({
            current: files.length,
            message: `Extracted ${sectionCount} sections`,
            parserCount: loadedParserCount,
            phase: 'sections',
            sectionCount: sectionCount,
            status: 'done',
            total: files.length,
        })
    }
    progress?.({
        message: 'Rebuilding module artifacts and retrieval index',
        phase: 'modules',
        status: 'start',
    })
    await withTransaction(async () => {
        await rebuildModuleArtifacts(extractedAt, options.metadata)
        await reindexRetrievalDocumentFts()

        await appendMemoryEvent({
            actor: 'cli',
            eventType: 'project_extracted',
            id: `event_${contentHash(`${context.projectRoot}:${extractedAt}`).slice(0, 32)}`,
            subjectType: 'project',
            summary: `Extracted ${files.length} files into ${sectionCount} sections.`,
        })
    })
    progress?.({
        message: 'Module artifacts and retrieval index ready',
        phase: 'modules',
        status: 'done',
    })

    return {
        filesTruncatedBySectionLimit,
        loadedParserCount,
        parserFallbackFiles,
        parserUsedFiles,
        sectionCount: sectionCount,
    }
}

async function yieldToProgressRenderer(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0))
}

function dedupeModuleKeys(keys: ModuleArtifactKey[]): ModuleArtifactKey[] {
    const seen = new Set<string>()
    const deduped: ModuleArtifactKey[] = []
    for (const key of keys) {
        const value = `${key.modulePath}:${key.sourceRole}`
        if (seen.has(value)) {
            continue
        }
        seen.add(value)
        deduped.push(key)
    }
    return deduped
}

function hasMetadataRelevantPath(paths: string[]): boolean {
    return paths.some(path => {
        const filename = path.split('/').at(-1)?.toLowerCase() ?? path
        return (
            /^readme(\..+)?$/iu.test(filename) ||
            filename === 'package.json' ||
            filename === 'composer.json' ||
            filename === 'pubspec.yaml' ||
            filename === 'pyproject.toml' ||
            filename === 'go.mod' ||
            filename === 'cargo.toml' ||
            filename === 'pom.xml' ||
            filename.endsWith('.csproj') ||
            filename === 'gemfile' ||
            filename === 'package.swift' ||
            path.startsWith('.agents/') ||
            path.startsWith('.codex/') ||
            path.startsWith('docs/')
        )
    })
}
