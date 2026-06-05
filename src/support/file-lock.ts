import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type FileLockInput = {
    lockDir: string
    operationName: string
    pollMs?: number
    staleMs?: number
    timeoutMs?: number
}

type FileLockResult =
    | {
          acquired: false
      }
    | {
          acquired: true
          release: () => Promise<void>
      }

const DEFAULT_POLL_MS = 100
const DEFAULT_STALE_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 2500
const OWNER_FILE = 'owner.json'

export async function acquireFileLock(
    input: FileLockInput,
): Promise<FileLockResult> {
    const pollMs = input.pollMs ?? DEFAULT_POLL_MS
    const staleMs = input.staleMs ?? DEFAULT_STALE_MS
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const heartbeatMs = Math.max(1000, Math.floor(staleMs / 3))
    const deadline = Date.now() + timeoutMs

    await mkdir(dirname(input.lockDir), { recursive: true })

    while (true) {
        try {
            await mkdir(input.lockDir)
            const ownerId = randomUUID()
            await writeLockOwner(input, ownerId)
            const stopHeartbeat = startHeartbeat({
                heartbeatMs,
                input,
                ownerId,
            })
            return {
                acquired: true,
                release: async () => {
                    stopHeartbeat()
                    if (await lockIsOwnedBy(input.lockDir, ownerId)) {
                        await rm(input.lockDir, {
                            force: true,
                            recursive: true,
                        })
                    }
                },
            }
        } catch (error) {
            if (!isFileExistsError(error)) {
                throw error
            }
        }

        await removeStaleLock(input.lockDir, staleMs)

        if (Date.now() >= deadline) {
            return { acquired: false }
        }

        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    }
}

function startHeartbeat(input: {
    heartbeatMs: number
    input: FileLockInput
    ownerId: string
}): () => void {
    const interval = setInterval(() => {
        void refreshLock(input.input, input.ownerId)
    }, input.heartbeatMs)
    interval.unref?.()

    return () => {
        clearInterval(interval)
    }
}

async function refreshLock(
    input: FileLockInput,
    ownerId: string,
): Promise<void> {
    if (!(await lockIsOwnedBy(input.lockDir, ownerId))) {
        return
    }

    const now = new Date()
    try {
        await writeLockOwner(input, ownerId)
        await utimes(input.lockDir, now, now)
    } catch {
        // Stale-lock cleanup remains the recovery path if refresh fails.
    }
}

async function writeLockOwner(
    input: FileLockInput,
    ownerId: string,
): Promise<void> {
    try {
        await writeFile(
            join(input.lockDir, OWNER_FILE),
            `${JSON.stringify(
                {
                    createdAt: new Date().toISOString(),
                    id: ownerId,
                    operation: input.operationName,
                    pid: process.pid,
                },
                null,
                2,
            )}\n`,
        )
    } catch {
        // The lock directory itself is the synchronization primitive.
    }
}

async function lockIsOwnedBy(
    lockDir: string,
    ownerId: string,
): Promise<boolean> {
    try {
        const raw = await readFile(join(lockDir, OWNER_FILE), 'utf8')
        const parsed = JSON.parse(raw) as unknown
        return (
            typeof parsed === 'object' &&
            parsed !== null &&
            'id' in parsed &&
            parsed.id === ownerId
        )
    } catch {
        return true
    }
}

async function removeStaleLock(
    lockDir: string,
    staleMs: number,
): Promise<void> {
    try {
        const metadata = await stat(lockDir)
        if (Date.now() - metadata.mtimeMs < staleMs) {
            return
        }
        await rm(lockDir, { force: true, recursive: true })
    } catch {
        // Another process may have released or replaced the lock already.
    }
}

function isFileExistsError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
    )
}

async function sleep(milliseconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
}
