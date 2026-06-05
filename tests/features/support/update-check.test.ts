import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from '@/support/file-manager'
import { checkForKonteksUpdate } from '@/support/update-check'

describe('support/update-check', () => {
    const tempDirs: string[] = []

    afterEach(async () => {
        globalThis.__konteksCheckForUpdateForTests = undefined
        for (const dir of tempDirs) {
            await rm(dir)
        }
        tempDirs.splice(0)
    })

    it('returns an update notice when the registry version is newer', async () => {
        const cacheDir = await makeCacheDir()

        const update = await checkForKonteksUpdate({
            cacheDir,
            currentVersion: '1.2.3',
            fetchLatestVersion: async () => '1.3.0',
            now: new Date('2026-06-05T00:00:00.000Z'),
        })

        expect(update).toEqual({
            command: 'bun add -g konteks-cli',
            current: '1.2.3',
            latest: '1.3.0',
        })
    })

    it('does not return a notice when the registry version is not newer', async () => {
        const cacheDir = await makeCacheDir()

        const update = await checkForKonteksUpdate({
            cacheDir,
            currentVersion: '1.2.3',
            fetchLatestVersion: async () => '1.2.3',
            now: new Date('2026-06-05T00:00:00.000Z'),
        })

        expect(update).toBeUndefined()
    })

    it('uses a fresh cached version without fetching again', async () => {
        const cacheDir = await makeCacheDir()
        await checkForKonteksUpdate({
            cacheDir,
            currentVersion: '1.0.0',
            fetchLatestVersion: async () => '1.1.0',
            now: new Date('2026-06-05T00:00:00.000Z'),
        })

        const update = await checkForKonteksUpdate({
            cacheDir,
            currentVersion: '1.0.0',
            fetchLatestVersion: async () => {
                throw new Error('should not fetch')
            },
            now: new Date('2026-06-05T01:00:00.000Z'),
        })

        expect(update?.latest).toBe('1.1.0')
        expect(
            await readFile(join(cacheDir, 'update-check.json'), 'utf8'),
        ).toContain('"latest":"1.1.0"')
    })

    it('swallows fetch failures', async () => {
        const cacheDir = await makeCacheDir()

        await expect(
            checkForKonteksUpdate({
                cacheDir,
                currentVersion: '1.0.0',
                fetchLatestVersion: async () => {
                    throw new Error('registry unavailable')
                },
                now: new Date('2026-06-05T00:00:00.000Z'),
            }),
        ).resolves.toBeUndefined()
        expect(
            await readFile(join(cacheDir, 'update-check.json'), 'utf8'),
        ).toContain('"checkedAt":"2026-06-05T00:00:00.000Z"')
    })

    it('uses a fresh cached failed check without fetching again', async () => {
        const cacheDir = await makeCacheDir()
        await checkForKonteksUpdate({
            cacheDir,
            currentVersion: '1.0.0',
            fetchLatestVersion: async () => undefined,
            now: new Date('2026-06-05T00:00:00.000Z'),
        })

        const update = await checkForKonteksUpdate({
            cacheDir,
            currentVersion: '1.0.0',
            fetchLatestVersion: async () => {
                throw new Error('should not fetch')
            },
            now: new Date('2026-06-05T01:00:00.000Z'),
        })

        expect(update).toBeUndefined()
    })

    async function makeCacheDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'konteks-update-check-'))
        tempDirs.push(dir)
        return dir
    }
})
