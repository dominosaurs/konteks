import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExtractionManifest } from '@/modules/extraction/engine/manifest'
import { extractProject } from '@/modules/extraction/extract-project'
import {
    loadMcpProjectContext,
    updateChangedProjectMemorySilently,
} from '@/modules/memory/runtime'

import { mkdir, rm } from '@/support/file-manager'

const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

async function withWorkingDirectory<T>(
    cwd: string,
    operation: () => Promise<T>,
): Promise<T> {
    const previous = process.cwd()
    process.chdir(cwd)

    try {
        return await operation()
    } finally {
        process.chdir(previous)
    }
}

describe('memory/runtime', () => {
    it('loads project context from the current project directory', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-runtime-'))
        tempDirs.push(projectRoot)
        await writeFile(
            join(projectRoot, 'package.json'),
            '{"name":"fixture"}\n',
        )
        await mkdir(join(projectRoot, '.konteks'))

        const context = await withWorkingDirectory(projectRoot, () =>
            loadMcpProjectContext(),
        )

        expect(context.projectRoot).toBe(projectRoot)
        expect(context.memoryDir).toBe(join(projectRoot, '.konteks'))
        expect(context.configPath).toBe(
            join(projectRoot, '.konteks', 'config.json'),
        )
        expect(context.configExists).toBe(false)
    })

    it('skips changed-project extraction when memory is not initialized', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-runtime-'))
        tempDirs.push(projectRoot)
        await writeFile(
            join(projectRoot, 'package.json'),
            '{"name":"fixture"}\n',
        )
        const context = await withWorkingDirectory(projectRoot, () =>
            loadMcpProjectContext(),
        )

        await expect(
            updateChangedProjectMemorySilently(context),
        ).resolves.toBeUndefined()
    })

    it('updates changed project memory when a manifest exists without config', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-runtime-'))
        tempDirs.push(projectRoot)
        await mkdir(join(projectRoot, 'src'))
        await writeFile(
            join(projectRoot, 'package.json'),
            '{"name":"fixture"}\n',
        )
        await writeFile(
            join(projectRoot, 'src', 'index.txt'),
            'export const first = true\n',
        )
        const context = await withWorkingDirectory(projectRoot, () =>
            loadMcpProjectContext(),
        )
        await withWorkingDirectory(projectRoot, () =>
            extractProject(context, 'full'),
        )
        await writeFile(
            join(projectRoot, 'src', 'later.txt'),
            'export const later = true\n',
        )

        await expect(
            withWorkingDirectory(projectRoot, () =>
                updateChangedProjectMemorySilently(context),
            ),
        ).resolves.toMatchObject({
            updatedFilePaths: ['src/later.txt'],
        })
        await expect(
            readExtractionManifest(context.memoryDir),
        ).resolves.toMatchObject({
            mode: 'changed',
        })
    })

    it('skips changed project memory when another process holds the lock', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-runtime-'))
        tempDirs.push(projectRoot)
        await mkdir(join(projectRoot, 'src'))
        await writeFile(
            join(projectRoot, 'package.json'),
            '{"name":"fixture"}\n',
        )
        await writeFile(
            join(projectRoot, 'src', 'index.txt'),
            'export const first = true\n',
        )
        const context = await withWorkingDirectory(projectRoot, () =>
            loadMcpProjectContext(),
        )
        await withWorkingDirectory(projectRoot, () =>
            extractProject(context, 'full'),
        )
        await writeFile(
            join(projectRoot, 'src', 'later.txt'),
            'export const later = true\n',
        )
        await mkdir(
            join(context.memoryDir, 'locks', 'changed-project-memory.lock'),
        )

        await expect(
            withWorkingDirectory(projectRoot, () =>
                updateChangedProjectMemorySilently(context),
            ),
        ).resolves.toBeUndefined()
        await expect(
            readExtractionManifest(context.memoryDir),
        ).resolves.toMatchObject({
            mode: 'full',
        })
    })

    it('removes stale changed project memory locks and updates memory', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'konteks-runtime-'))
        tempDirs.push(projectRoot)
        await mkdir(join(projectRoot, 'src'))
        await writeFile(
            join(projectRoot, 'package.json'),
            '{"name":"fixture"}\n',
        )
        await writeFile(
            join(projectRoot, 'src', 'index.txt'),
            'export const first = true\n',
        )
        const context = await withWorkingDirectory(projectRoot, () =>
            loadMcpProjectContext(),
        )
        await withWorkingDirectory(projectRoot, () =>
            extractProject(context, 'full'),
        )
        await writeFile(
            join(projectRoot, 'src', 'later.txt'),
            'export const later = true\n',
        )
        const lockDir = join(
            context.memoryDir,
            'locks',
            'changed-project-memory.lock',
        )
        await mkdir(lockDir)
        const staleTime = new Date(Date.now() - 11 * 60 * 1000)
        await utimes(lockDir, staleTime, staleTime)

        await expect(
            withWorkingDirectory(projectRoot, () =>
                updateChangedProjectMemorySilently(context),
            ),
        ).resolves.toMatchObject({
            updatedFilePaths: ['src/later.txt'],
        })
        await expect(
            readExtractionManifest(context.memoryDir),
        ).resolves.toMatchObject({
            mode: 'changed',
        })
    })
})
