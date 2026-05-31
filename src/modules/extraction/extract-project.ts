import {
    extractProjectSectionsWithDatabase,
    readExtractedProjectPaths,
} from '@/database/services/project-extraction'
import extractProjectMetadata from '@/modules/extraction/engine/extract-project-metadata'
import type { ScannedFile } from '@/modules/extraction/engine/file-scan'
import { scanProjectFilesWithDiagnostics } from '@/modules/extraction/engine/file-scan'
import formatProjectSummaryToon from '@/modules/extraction/engine/format-project-summary-toon'
import {
    getGrammarForPath,
    isBundledGrammar,
} from '@/modules/extraction/engine/grammar-loader'
import type {
    ExtractionManifest,
    ExtractionMode,
} from '@/modules/extraction/engine/manifest'
import {
    readExtractionManifest,
    writeExtractionManifest,
} from '@/modules/extraction/engine/manifest'
import contentHash from '@/support/content-hash'
import { mkdir } from '@/support/file-manager'
import type { EmbeddingProviderContract as EmbeddingProvider } from '@/types/embedding-provider'
import type {
    ExtractProjectRequest,
    ExtractProjectResponse,
} from '@/types/extraction'
import type { ExtractionEngineContract } from '@/types/extraction-engine'
import type { ExtractionProgressReporter } from '@/types/progress'
import type { Project } from '@/types/project'
export async function extractProject(
    project: Project,
    mode: ExtractionMode,
    options: {
        embeddingProvider?: EmbeddingProvider
        onProgress?: ExtractionProgressReporter
    } = {},
): Promise<ExtractProjectResponse> {
    const engine = new KonteksExtractionEngine(options)
    return await engine.extract(project, {
        mode,
        projectRoot: project.projectRoot,
    })
}

export class KonteksExtractionEngine implements ExtractionEngineContract {
    public constructor(
        private readonly options: {
            embeddingProvider?: EmbeddingProvider
            onProgress?: ExtractionProgressReporter
            prepareEmbeddingBeforeExtraction?: boolean
        } = {},
    ) {}

    public async extract(
        project: Project,
        request: ExtractProjectRequest,
    ): Promise<ExtractProjectResponse> {
        const { mode } = request
        const context = project
        const options = this.options
        const progress = options.onProgress
        progress?.({
            message: `Extracting ${context.projectRoot}`,
            phase: 'start',
            status: 'start',
        })
        await mkdir(context.memoryDir)
        const previousManifest =
            mode === 'changed'
                ? await readExtractionManifest(context.memoryDir)
                : undefined

        progress?.({
            message: 'Scanning project files',
            phase: 'scan',
            status: 'start',
        })
        const scan = await scanProjectFilesWithDiagnostics(
            context.projectRoot,
            {
                previousFiles: previousManifest?.files,
            },
        )
        const files = scan.files
        const detectedParserLanguages = detectParserLanguages(files)
        const languageCount = detectedParserLanguages.length
        progress?.({
            detectedParserLanguages,
            languageCount,
            message: `Scanned ${files.length} files`,
            phase: 'scan',
            status: 'done',
            total: files.length,
        })
        const alreadyExtractedPaths =
            mode === 'resume' ? await readExtractedProjectPaths() : undefined
        const { deletedPaths, filesToExtract } = selectFilesForMode(
            files,
            previousManifest,
            mode,
            alreadyExtractedPaths,
        )
        if (
            mode === 'changed' &&
            previousManifest &&
            filesToExtract.length === 0 &&
            deletedPaths.length === 0
        ) {
            return unchangedExtractionResponse({
                detectedParserLanguages,
                embeddedCount: 0,
                embeddingReusedCount: 0,
                files,
                languageCount,
                manifest: previousManifest,
                projectRoot: context.projectRoot,
            })
        }
        progress?.({
            message: 'Extracting project metadata',
            phase: 'metadata',
            status: 'start',
        })
        const metadata = await extractProjectMetadata(
            context.projectRoot,
            files,
        )
        progress?.({
            message: `Detected ${metadata.technologies.length} technologies`,
            phase: 'metadata',
            status: 'done',
        })
        const extractedAt = new Date().toISOString()
        progress?.({
            message: 'Opening local memory database',
            phase: 'database',
            status: 'start',
        })
        progress?.({
            message: 'Local memory database ready',
            phase: 'database',
            status: 'done',
        })
        progress?.({
            message: `Selected ${filesToExtract.length} files to extract`,
            phase: 'select',
            status: 'done',
            total: filesToExtract.length,
        })
        const beforeExtract =
            options.prepareEmbeddingBeforeExtraction &&
            options.embeddingProvider?.prepare
                ? async () => {
                      await options.embeddingProvider?.prepare?.()
                  }
                : undefined
        const extractionPersistence = await extractProjectSectionsWithDatabase({
            beforeExtract,
            deletedPaths,
            embeddingProvider: options.embeddingProvider,
            extractedAt,
            files: filesToExtract,
            metadata,
            mode,
            onProgress: progress,
            project: context,
            totalFileCount: files.length,
        })
        const { extractedSections, totalSectionCount } = extractionPersistence
        const embeddingRun = {
            embeddedCount: extractionPersistence.embeddedCount,
            reusedCount: extractionPersistence.embeddingReusedCount,
        }
        const vectorCount =
            embeddingRun.embeddedCount + embeddingRun.reusedCount
        progress?.({
            message: 'Writing project summary',
            phase: 'summary',
            status: 'start',
        })
        const summaryContent = formatProjectSummaryToon({
            extractedAt: extractedAt,
            fileCount: files.length,
            files,
            metadata,
            mode,
            projectRoot: context.projectRoot,
        })
        const summary = {
            hash: contentHash(summaryContent),
            ref: 'project-summary',
        }
        progress?.({
            message: 'Project summary written',
            phase: 'summary',
            status: 'done',
        })

        const manifest: ExtractionManifest = {
            diagnostics: {
                ...scan.diagnostics,
                detectedParserLanguages,
                embeddedCount: embeddingRun.embeddedCount,
                embeddingReusedCount: embeddingRun.reusedCount,
                filesTruncatedBySectionLimit:
                    extractedSections.filesTruncatedBySectionLimit,
                languageCount,
                loadedParserCount: extractedSections.loadedParserCount,
                parserFallbackFiles: extractedSections.parserFallbackFiles,
                parserUsedFiles: extractedSections.parserUsedFiles,
                sectionCount: totalSectionCount,
                vectorCount,
            },
            extractedAt: extractedAt,
            fileCount: files.length,
            files,
            metadata,
            mode,
            summaryHash: summary.hash,
            summaryRef: summary.ref,
            version: 1,
        }
        progress?.({
            message: 'Writing extraction manifest',
            phase: 'manifest',
            status: 'start',
        })
        await writeExtractionManifest(context.memoryDir, manifest)
        progress?.({
            embeddedCount: embeddingRun.embeddedCount,
            message: `Extraction complete: ${totalSectionCount} sections, ${vectorCount} indexed, ${embeddingRun.reusedCount} unchanged`,
            phase: 'done',
            reusedCount: embeddingRun.reusedCount,
            sectionCount: extractedSections.sectionCount,
            status: 'done',
        })

        return {
            deletedFilePaths: deletedPaths,
            detectedParserLanguages,
            embeddedCount: embeddingRun.embeddedCount,
            embeddingReusedCount: embeddingRun.reusedCount,
            extractedAt,
            fileCount: files.length,
            languageCount,
            loadedParserCount: extractedSections.loadedParserCount,
            mode,
            ok: true,
            projectRoot: context.projectRoot,
            sectionCount: totalSectionCount,
            summaryRef: summary.ref,
            technologies: metadata.technologies,
            updatedFilePaths: filesToExtract.map(file => file.path),
            vectorCount,
        }
    }
}

function unchangedExtractionResponse(input: {
    detectedParserLanguages: string[]
    embeddedCount: number
    embeddingReusedCount: number
    files: ScannedFile[]
    languageCount: number
    manifest: ExtractionManifest
    projectRoot: string
}): ExtractProjectResponse {
    const diagnostics = input.manifest.diagnostics
    return {
        deletedFilePaths: [],
        detectedParserLanguages:
            diagnostics?.detectedParserLanguages ??
            input.detectedParserLanguages,
        embeddedCount: input.embeddedCount,
        embeddingReusedCount: input.embeddingReusedCount,
        extractedAt: input.manifest.extractedAt,
        fileCount: input.files.length,
        languageCount: diagnostics?.languageCount ?? input.languageCount,
        loadedParserCount: diagnostics?.loadedParserCount ?? 0,
        mode: 'changed',
        ok: true,
        projectRoot: input.projectRoot,
        sectionCount:
            diagnostics?.sectionCount ?? input.manifest.sectionCount ?? 0,
        summaryRef: input.manifest.summaryRef,
        technologies: input.manifest.metadata.technologies,
        updatedFilePaths: [],
        vectorCount:
            input.embeddedCount + input.embeddingReusedCount ||
            diagnostics?.vectorCount ||
            0,
    }
}

function detectParserLanguages(files: ScannedFile[]): string[] {
    return [
        ...new Set(
            files.flatMap(file => {
                const grammar = getGrammarForPath(file.path)
                return grammar && !isBundledGrammar(grammar.id)
                    ? [grammar.id]
                    : []
            }),
        ),
    ].sort((left, right) => left.localeCompare(right))
}

function selectFilesForMode(
    currentFiles: ScannedFile[],
    previousManifest: ExtractionManifest | undefined,
    mode: ExtractionMode,
    alreadyExtractedPaths?: Set<string>,
): { deletedPaths: string[]; filesToExtract: ScannedFile[] } {
    if (mode === 'rebuild') {
        return { deletedPaths: [], filesToExtract: currentFiles }
    }

    if (mode === 'resume') {
        return {
            deletedPaths: [],
            filesToExtract: currentFiles.filter(
                file => !alreadyExtractedPaths?.has(file.path),
            ),
        }
    }

    if (mode !== 'changed' || !previousManifest) {
        return { deletedPaths: [], filesToExtract: currentFiles }
    }

    const previousByPath = new Map(
        previousManifest.files.map(file => [file.path, file]),
    )
    const currentByPath = new Map(currentFiles.map(file => [file.path, file]))

    const filesToExtract = currentFiles.filter(file => {
        const previous = previousByPath.get(file.path)
        if (!previous) {
            return true
        }
        return hasFileChanged(previous, file)
    })

    const deletedPaths = previousManifest.files
        .filter(file => !currentByPath.has(file.path))
        .map(file => file.path)

    return { deletedPaths, filesToExtract }
}

function hasFileChanged(previous: ScannedFile, current: ScannedFile): boolean {
    if (previous.contentHash && current.contentHash) {
        return previous.contentHash !== current.contentHash
    }

    return (
        previous.sizeBytes !== current.sizeBytes ||
        previous.mtimeMs !== current.mtimeMs
    )
}
