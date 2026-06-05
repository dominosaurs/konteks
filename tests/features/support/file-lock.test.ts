import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '@/support/file-lock'
import { rm } from '@/support/file-manager'

const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(path => rm(path)))
})

describe('file lock', () => {
    it('does not remove an active long-held lock as stale', async () => {
        const root = await mkdtemp(join(tmpdir(), 'konteks-lock-'))
        tempDirs.push(root)
        const lockDir = join(root, 'active.lock')
        const first = await acquireFileLock({
            lockDir,
            operationName: 'test_active_lock',
            staleMs: 1500,
            timeoutMs: 50,
        })

        expect(first.acquired).toBe(true)
        await sleep(1700)

        const second = await acquireFileLock({
            lockDir,
            operationName: 'test_contender',
            staleMs: 1500,
            timeoutMs: 50,
        })
        expect(second.acquired).toBe(false)

        if (first.acquired) {
            await first.release()
        }
        const third = await acquireFileLock({
            lockDir,
            operationName: 'test_after_release',
            staleMs: 1500,
            timeoutMs: 50,
        })
        expect(third.acquired).toBe(true)
        if (third.acquired) {
            await third.release()
        }
    })

    it('removes abandoned stale locks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'konteks-lock-'))
        tempDirs.push(root)
        const lockDir = join(root, 'stale.lock')
        await mkdir(lockDir)
        const staleTime = new Date(Date.now() - 2000)
        await utimes(lockDir, staleTime, staleTime)

        const lock = await acquireFileLock({
            lockDir,
            operationName: 'test_stale_lock',
            staleMs: 100,
            timeoutMs: 500,
        })

        expect(lock.acquired).toBe(true)
        if (lock.acquired) {
            await lock.release()
        }
    })
})

async function sleep(milliseconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
}
