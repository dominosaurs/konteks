import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathExists } from '@/modules/project/context'
import type { ExtractionMode, LegacyExtractionMode } from '@/types/extraction'
import type { Project } from '@/types/project'
import type { ProjectMetadata } from './extract-project-metadata'
import {
    type ScanDiagnostics,
    type ScannedFile,
    scanProjectFiles,
} from './file-scan'

export type { ExtractionMode }

export type ExtractionManifest = {
    version: 1
    extractedAt: string
    mode: ExtractionMode | LegacyExtractionMode
    fileCount: number
    sectionCount?: number
    files: ScannedFile[]
    metadata: ProjectMetadata
    summaryRef: string
    summaryHash: string
    diagnostics?: ExtractionDiagnostics
}

type ExtractionDiagnostics = ScanDiagnostics & {
    sectionCount: number
    detectedParserLanguages: string[]
    embeddedCount: number
    embeddingReusedCount: number
    languageCount: number
    loadedParserCount: number
    vectorCount: number
    filesTruncatedBySectionLimit: number
    parserFallbackFiles: number
    parserUsedFiles: number
}

type ExtractionFreshness = {
    status: 'missing' | 'fresh' | 'stale'
    reason: string
    changedFileCount: number
    recommendedCommand?: string
    lastExtractedAt?: string
}

function extractionManifestPath(memoryDir: string): string {
    return join(memoryDir, 'extraction-manifest.json')
}

export async function readExtractionManifest(
    memoryDir: string,
): Promise<ExtractionManifest | undefined> {
    const path = extractionManifestPath(memoryDir)
    if (!(await pathExists(path))) {
        return undefined
    }

    return JSON.parse(await readFile(path, 'utf8')) as ExtractionManifest
}

export async function writeExtractionManifest(
    memoryDir: string,
    manifest: ExtractionManifest,
): Promise<void> {
    const targetPath = extractionManifestPath(memoryDir)
    const tempPath = join(
        memoryDir,
        `.extraction-manifest.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    )

    try {
        await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`)
        await rename(tempPath, targetPath)
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined)
        throw error
    }
}

export async function getExtractionFreshness(
    context: Project,
): Promise<ExtractionFreshness> {
    const manifest = await readExtractionManifest(context.memoryDir)
    if (!manifest) {
        return {
            changedFileCount: 0,
            reason: 'No extraction manifest exists yet.',
            recommendedCommand: 'konteks rebuild',
            status: 'missing',
        }
    }

    const currentFiles = await scanProjectFiles(context.projectRoot, {
        previousFiles: manifest.files,
    })
    const staleReason = findStaleReason(manifest.files, currentFiles)

    if (staleReason) {
        return {
            changedFileCount: countChangedFiles(manifest.files, currentFiles),
            lastExtractedAt: manifest.extractedAt,
            reason: staleReason,
            recommendedCommand: 'konteks rebuild',
            status: 'stale',
        }
    }

    return {
        changedFileCount: 0,
        lastExtractedAt: manifest.extractedAt,
        reason: `Project extraction is current for ${manifest.fileCount} files.`,
        status: 'fresh',
    }
}

function findStaleReason(
    previousFiles: ScannedFile[],
    currentFiles: ScannedFile[],
): string | undefined {
    if (previousFiles.length !== currentFiles.length) {
        return 'Project file set changed since the last extraction.'
    }

    const previousByPath = new Map(previousFiles.map(file => [file.path, file]))

    for (const current of currentFiles) {
        const previous = previousByPath.get(current.path)
        if (!previous) {
            return `New file detected: ${current.path}.`
        }
        if (hasFileChanged(previous, current)) {
            return `Changed file detected: ${current.path}.`
        }
    }

    return undefined
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

function countChangedFiles(
    previousFiles: ScannedFile[],
    currentFiles: ScannedFile[],
): number {
    const previousByPath = new Map(previousFiles.map(file => [file.path, file]))
    const currentByPath = new Map(currentFiles.map(file => [file.path, file]))
    let count = 0

    for (const current of currentFiles) {
        const previous = previousByPath.get(current.path)
        if (!previous || hasFileChanged(previous, current)) {
            count += 1
        }
    }

    for (const previous of previousFiles) {
        if (!currentByPath.has(previous.path)) {
            count += 1
        }
    }

    return count
}
