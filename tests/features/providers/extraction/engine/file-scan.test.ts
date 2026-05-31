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

    it('respects .gitignore files inside directories', async () => {
        const projectRoot = await makeProject()
        await mkdir(join(projectRoot, 'packages', 'app', 'private-output'))
        await mkdir(join(projectRoot, 'packages', 'app', 'src'))
        await mkdir(join(projectRoot, 'packages', 'other', 'private-output'))
        await writeFile(join(projectRoot, '.gitignore'), '*.log\n')
        await writeFile(
            join(projectRoot, 'packages', 'app', '.gitignore'),
            'private-output/\n!important.log\n',
        )
        await writeFile(
            join(projectRoot, 'packages', 'app', 'private-output', 'out.js'),
            'ignored\n',
        )
        await writeFile(
            join(projectRoot, 'packages', 'app', 'src', 'index.ts'),
            'export {}\n',
        )
        await writeFile(
            join(projectRoot, 'packages', 'app', 'important.log'),
            'included\n',
        )
        await writeFile(
            join(projectRoot, 'packages', 'other', 'private-output', 'out.js'),
            'included\n',
        )
        await writeFile(join(projectRoot, 'debug.log'), 'ignored\n')

        const scan = await scanProjectFilesWithDiagnostics(projectRoot)

        expect(scan.files.map(file => file.path)).toEqual([
            '.gitignore',
            'package.json',
            'packages/app/.gitignore',
            'packages/app/important.log',
            'packages/app/src/index.ts',
            'packages/other/private-output/out.js',
        ])
        expect(scan.diagnostics.filesSkipped.vcsIgnore).toBe(2)
    })

    it('does not skip files by size', async () => {
        const projectRoot = await makeProject()
        await writeFile(join(projectRoot, 'README.md'), '# Fixture\n')
        await writeFile(join(projectRoot, 'huge.txt'), 'x'.repeat(20))

        const files = await scanProjectFiles(projectRoot)

        expect(files.map(file => file.path)).toEqual([
            'README.md',
            'huge.txt',
            'package.json',
        ])
    })
})
