import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    scanProjectFiles,
    scanProjectFilesWithDiagnostics,
} from '@/modules/extraction/engine/file-scan'

import { mkdir, rm } from '@/support/file-manager'

const tempDirs: string[] = []
const maxExtractedFileSizeBytes = 10 * 1024 * 1024

async function makeProject(): Promise<string> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-scan-test-'))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, 'src'))
    await mkdir(join(projectRoot, 'docs', 'private'))
    await mkdir(join(projectRoot, 'tmp'))
    await writeFile(join(projectRoot, 'package.json'), '{"name":"fixture"}\n')
    return projectRoot
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

describe('scanProjectFiles', () => {
    it('respects .gitignore and .konteksignore while keeping safe files', async () => {
        const projectRoot = await makeProject()
        await writeFile(join(projectRoot, '.gitignore'), 'tmp/\n*.log\n')
        await writeFile(join(projectRoot, '.konteksignore'), 'docs/private/\n')
        await writeFile(join(projectRoot, 'src', 'index.ts'), 'export {}\n')
        await writeFile(join(projectRoot, 'tmp', 'cache.ts'), 'ignored\n')
        await writeFile(join(projectRoot, 'debug.log'), 'ignored\n')
        await writeFile(
            join(projectRoot, 'docs', 'private', 'notes.md'),
            'ignored\n',
        )

        const scan = await scanProjectFilesWithDiagnostics(projectRoot)

        expect(scan.files.map(file => file.path)).toEqual([
            '.gitignore',
            '.konteksignore',
            'package.json',
            'src/index.ts',
        ])
        expect(scan.files.every(file => file.contentHash.length === 64)).toBe(
            true,
        )
        expect(scan.diagnostics.filesIncluded).toBe(4)
        expect(scan.diagnostics.filesSkipped.vcsIgnore).toBe(2)
        expect(scan.diagnostics.filesSkipped.konteksignore).toBe(1)
    })

    it('skips oversized files before they enter extraction', async () => {
        const projectRoot = await makeProject()
        await writeFile(join(projectRoot, 'README.md'), '# Fixture\n')
        await writeFile(
            join(projectRoot, 'limit.txt'),
            'x'.repeat(maxExtractedFileSizeBytes),
        )
        await writeFile(
            join(projectRoot, 'huge.txt'),
            'x'.repeat(maxExtractedFileSizeBytes + 1),
        )

        const scan = await scanProjectFilesWithDiagnostics(projectRoot)

        expect(scan.files.map(file => file.path)).toEqual([
            'README.md',
            'limit.txt',
            'package.json',
        ])
        expect(scan.diagnostics.filesSkipped.oversized).toBe(1)
        await expect(scanProjectFiles(projectRoot)).resolves.toHaveLength(3)
    })
})
