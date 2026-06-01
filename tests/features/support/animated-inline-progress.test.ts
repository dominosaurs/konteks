import { afterEach, describe, expect, it } from 'bun:test'
import { open, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from '@/support/strip-ansi'
import { createAnimatedInlineProgress } from '@/support/tui/components'

const tempFiles: string[] = []

afterEach(async () => {
    await Promise.all(tempFiles.splice(0).map(path => unlink(path).catch()))
})

describe('animated inline progress', () => {
    it('can animate from a worker while the main thread is blocked', async () => {
        const path = join(
            tmpdir(),
            `konteks-worker-progress-${process.pid}-${Date.now()}.log`,
        )
        tempFiles.push(path)
        const handle = await open(path, 'w+')

        try {
            const progress = createAnimatedInlineProgress(() => undefined, {
                intervalMs: 25,
                workerFileDescriptor: handle.fd,
            })

            progress.writeAnimated(index => `spinner-${index}`)
            blockMainThread(95)
            progress.done()
            await new Promise(resolve => setTimeout(resolve, 50))
        } finally {
            await handle.close()
        }

        const output = stripAnsi(await readFile(path, 'utf8'))
        expect(output).toContain('spinner-0')
        expect(output).toContain('spinner-1')
        expect(output).toContain('spinner-2')
    })

    it('preserves worker spinner phase when animated text changes', async () => {
        const path = join(
            tmpdir(),
            `konteks-worker-progress-${process.pid}-${Date.now()}.log`,
        )
        tempFiles.push(path)
        const handle = await open(path, 'w+')

        try {
            const progress = createAnimatedInlineProgress(() => undefined, {
                intervalMs: 25,
                workerFileDescriptor: handle.fd,
            })

            progress.writeAnimated(index => `first-${index}`)
            blockMainThread(60)
            progress.writeAnimated(index => `second-${index}`)
            blockMainThread(35)
            progress.done()
            await new Promise(resolve => setTimeout(resolve, 50))
        } finally {
            await handle.close()
        }

        const output = stripAnsi(await readFile(path, 'utf8'))
        expect(output).toContain('first-0')
        expect(output).toContain('first-1')
        expect(output).toContain('second-2')
        expect(output).not.toContain('second-0')
    })

    it('flushes worker completion before later output is written', async () => {
        const path = join(
            tmpdir(),
            `konteks-worker-progress-${process.pid}-${Date.now()}.log`,
        )
        tempFiles.push(path)
        const handle = await open(path, 'w+')

        try {
            const progress = createAnimatedInlineProgress(() => undefined, {
                intervalMs: 25,
                workerFileDescriptor: handle.fd,
            })

            progress.writeAnimated(index => `spinner-${index}`)
            blockMainThread(35)
            progress.complete('complete-line')
            await handle.write('next-line\n')
        } finally {
            await handle.close()
        }

        const output = stripAnsi(await readFile(path, 'utf8'))
        expect(output.indexOf('complete-line')).toBeGreaterThanOrEqual(0)
        expect(output.indexOf('next-line')).toBeGreaterThan(
            output.indexOf('complete-line'),
        )
    })
})

function blockMainThread(milliseconds: number): void {
    const buffer = new SharedArrayBuffer(4)
    const view = new Int32Array(buffer)
    Atomics.wait(view, 0, 0, milliseconds)
}
