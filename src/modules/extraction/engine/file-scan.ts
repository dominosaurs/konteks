import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import createIgnoreMatcher, {
    type IgnoreMatcher,
    type IgnoreReason,
} from './create-ignore-matcher'

export type ScannedFile = {
    contentHash: string
    path: string
    sizeBytes: number
    mtimeMs: number
}

export type ScanDiagnostics = {
    filesScanned: number
    filesIncluded: number
    filesSkipped: {
        binary: number
        generated: number
        hardDirectory: number
        ignoredFile: number
        konteksignore: number
        lockfile: number
        minified: number
        oversized: number
        secret: number
        vcsIgnore: number
    }
}

type ScanProjectResult = {
    diagnostics: ScanDiagnostics
    files: ScannedFile[]
}

type ScanProjectOptions = {
    previousFiles?: ScannedFile[]
}

const MAX_EXTRACTED_FILE_SIZE_BYTES = 10 * 1024 * 1024

export async function scanProjectFiles(
    projectRoot: string,
    options: ScanProjectOptions = {},
): Promise<ScannedFile[]> {
    return (await scanProjectFilesWithDiagnostics(projectRoot, options)).files
}

export async function scanProjectFilesWithDiagnostics(
    projectRoot: string,
    options: ScanProjectOptions = {},
): Promise<ScanProjectResult> {
    const files: ScannedFile[] = []
    const ignoreMatcher = await loadIgnoreMatcher(projectRoot)
    const diagnostics = createScanDiagnostics()
    const previousByPath = new Map(
        (options.previousFiles ?? []).map(file => [file.path, file]),
    )

    await scanDirectory(
        projectRoot,
        projectRoot,
        files,
        ignoreMatcher,
        diagnostics,
        previousByPath,
    )

    const sortedFiles = files.sort((left, right) =>
        compareText(left.path, right.path),
    )
    diagnostics.filesIncluded = sortedFiles.length

    return {
        diagnostics,
        files: sortedFiles,
    }
}

async function scanDirectory(
    projectRoot: string,
    directory: string,
    files: ScannedFile[],
    ignoreMatcher: IgnoreMatcher,
    diagnostics: ScanDiagnostics,
    previousByPath: Map<string, ScannedFile>,
): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
        const absolutePath = join(directory, entry.name)
        const relativePath = toRelativeProjectPath(projectRoot, absolutePath)

        const ignoreReason = ignoreMatcher.explain(relativePath)
        if (ignoreReason) {
            incrementSkipped(diagnostics, ignoreReason)
            continue
        }

        if (entry.isDirectory()) {
            await scanDirectory(
                projectRoot,
                absolutePath,
                files,
                ignoreMatcher,
                diagnostics,
                previousByPath,
            )
            continue
        }

        if (!entry.isFile()) {
            continue
        }

        diagnostics.filesScanned += 1
        const fileStat = await stat(absolutePath)
        if (fileStat.size > MAX_EXTRACTED_FILE_SIZE_BYTES) {
            diagnostics.filesSkipped.oversized += 1
            continue
        }
        const previous = previousByPath.get(relativePath)
        if (
            previous &&
            previous.sizeBytes === fileStat.size &&
            previous.mtimeMs === Math.trunc(fileStat.mtimeMs) &&
            previous.contentHash
        ) {
            files.push({
                contentHash: previous.contentHash,
                mtimeMs: previous.mtimeMs,
                path: relativePath,
                sizeBytes: previous.sizeBytes,
            })
            continue
        }

        const bytes = await readFile(absolutePath)
        files.push({
            contentHash: hashBytes(bytes),
            mtimeMs: Math.trunc(fileStat.mtimeMs),
            path: relativePath,
            sizeBytes: fileStat.size,
        })
    }
}

function createScanDiagnostics(): ScanDiagnostics {
    return {
        filesIncluded: 0,
        filesScanned: 0,
        filesSkipped: {
            binary: 0,
            generated: 0,
            hardDirectory: 0,
            ignoredFile: 0,
            konteksignore: 0,
            lockfile: 0,
            minified: 0,
            oversized: 0,
            secret: 0,
            vcsIgnore: 0,
        },
    }
}

function incrementSkipped(
    diagnostics: ScanDiagnostics,
    reason: IgnoreReason,
): void {
    const key = skippedKeyFor(reason)
    diagnostics.filesSkipped[key] += 1
}

function skippedKeyFor(
    reason: IgnoreReason,
): keyof ScanDiagnostics['filesSkipped'] {
    if (reason === 'hard_directory') {
        return 'hardDirectory'
    }
    if (reason === 'ignored_file') {
        return 'ignoredFile'
    }
    if (reason === 'vcs_ignore') {
        return 'vcsIgnore'
    }

    return reason
}

async function loadIgnoreMatcher(projectRoot: string): Promise<IgnoreMatcher> {
    const [gitignore, konteksignore] = await Promise.all([
        readOptionalText(join(projectRoot, '.gitignore')),
        readOptionalText(join(projectRoot, '.konteksignore')),
    ])

    return createIgnoreMatcher({ gitignore, konteksignore })
}

async function readOptionalText(path: string): Promise<string> {
    return readFile(path, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return ''
        }

        throw error
    })
}

function toRelativeProjectPath(
    projectRoot: string,
    absolutePath: string,
): string {
    return relative(projectRoot, absolutePath).split(sep).join('/')
}

function compareText(left: string, right: string): number {
    if (left < right) {
        return -1
    }
    if (left > right) {
        return 1
    }
    return 0
}

function hashBytes(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}
