import { Worker } from 'node:worker_threads'
import createInlineProgress, { type InlineProgress } from './inline-progress'

export type AnimatedInlineProgress = InlineProgress & {
    writeAnimated(render: (spinnerIndex: number) => string): void
    writeAnimatedBlock(render: (spinnerIndex: number) => string[]): void
}

const DEFAULT_ANIMATION_INTERVAL_MS = 100

export default function createAnimatedInlineProgress(
    write: (value: string) => void,
    options: {
        frameCount?: number
        intervalMs?: number
        isEnabled?: boolean
        workerFileDescriptor?: number
    } = {},
): AnimatedInlineProgress {
    const inline = createInlineProgress(write)
    const frameCount = options.frameCount ?? 10
    const intervalMs = options.intervalMs ?? DEFAULT_ANIMATION_INTERVAL_MS
    const isEnabled = options.isEnabled ?? true
    const workerFileDescriptor = options.workerFileDescriptor
    let spinnerIndex = 0
    let timer: ReturnType<typeof setInterval> | undefined
    let renderAnimated: ((spinnerIndex: number) => void) | undefined
    let worker: Worker | undefined
    let workerHasLine = false

    return {
        clear() {
            stopAnimation()
            if (isWorkerActive()) {
                postWorkerMessageSync({ type: 'clear' })
                workerHasLine = false
                return
            }
            inline.clear()
        },
        complete(output) {
            stopAnimation()
            if (isWorkerActive()) {
                postWorkerMessageSync({ output, type: 'complete' })
                workerHasLine = false
                return
            }
            inline.complete(output)
        },
        done() {
            stopAnimation()
            if (isWorkerActive()) {
                postWorkerMessageSync({ type: 'done' })
                workerHasLine = false
                stopWorker()
                return
            }
            inline.done()
        },
        hasLine() {
            return isWorkerActive() ? workerHasLine : inline.hasLine()
        },
        write(output) {
            stopAnimation()
            if (isWorkerActive()) {
                postWorkerMessageSync({ output, type: 'write' })
                workerHasLine = true
                return
            }
            inline.write(output)
        },
        writeAnimated(render) {
            if (isWorkerAvailable()) {
                postWorkerMessage({
                    frames: renderFrames(index => [render(index)]),
                    intervalMs,
                    type: 'animate',
                })
                workerHasLine = true
                return
            }
            renderAnimated = index => inline.write(render(index))
            renderCurrent()
            startAnimation()
        },
        writeAnimatedBlock(render) {
            if (isWorkerAvailable()) {
                postWorkerMessage({
                    frames: renderFrames(render),
                    intervalMs,
                    type: 'animate',
                })
                workerHasLine = true
                return
            }
            renderAnimated = index => inline.writeBlock(render(index))
            renderCurrent()
            startAnimation()
        },
        writeBlock(output) {
            stopAnimation()
            if (isWorkerActive()) {
                postWorkerMessageSync({ output, type: 'writeBlock' })
                workerHasLine = output.length > 0
                return
            }
            inline.writeBlock(output)
        },
    }

    function startAnimation(): void {
        if (!isEnabled || timer !== undefined) {
            return
        }

        timer = setInterval(tick, intervalMs)
        unrefTimer(timer)
    }

    function stopAnimation(): void {
        if (isWorkerActive()) {
            postWorkerMessage({ type: 'stopAnimation' })
        }
        if (timer !== undefined) {
            clearInterval(timer)
            timer = undefined
        }
        renderAnimated = undefined
    }

    function tick(): void {
        spinnerIndex += 1
        renderCurrent()
    }

    function renderCurrent(): void {
        renderAnimated?.(spinnerIndex)
    }

    function renderFrames(
        render: (spinnerIndex: number) => string[],
    ): string[][] {
        return Array.from({ length: frameCount }, (_, index) => render(index))
    }

    function isWorkerAvailable(): boolean {
        return isEnabled && workerFileDescriptor !== undefined
    }

    function isWorkerActive(): boolean {
        return worker !== undefined
    }

    function postWorkerMessage(message: WorkerMessage): void {
        const activeWorker = ensureWorker()
        if (!activeWorker) {
            return
        }
        activeWorker.postMessage(message)
    }

    function postWorkerMessageSync(message: WorkerMessage): void {
        const activeWorker = ensureWorker()
        if (!activeWorker) {
            return
        }

        const signal = new Int32Array(new SharedArrayBuffer(4))
        activeWorker.postMessage({ ...message, signal })
        Atomics.wait(signal, 0, 0, 1000)
    }

    function ensureWorker(): Worker | undefined {
        if (worker !== undefined) {
            return worker
        }
        if (!isWorkerAvailable()) {
            return undefined
        }

        try {
            worker = new Worker(WORKER_SCRIPT, {
                eval: true,
                workerData: { fd: workerFileDescriptor },
            })
            worker.unref()
            worker.on('exit', () => {
                worker = undefined
                workerHasLine = false
            })
            return worker
        } catch {
            return undefined
        }
    }

    function stopWorker(): void {
        const activeWorker = worker
        worker = undefined
        void activeWorker?.terminate()
    }
}

type WorkerMessage =
    | { type: 'animate'; frames: string[][]; intervalMs: number }
    | { type: 'clear' }
    | { type: 'complete'; output: string }
    | { type: 'done' }
    | { type: 'stopAnimation' }
    | { type: 'write'; output: string }
    | { type: 'writeBlock'; output: string[] }

const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads')
const { writeSync } = require('node:fs')

const fd = workerData.fd
let frames = []
let frameIndex = 0
let lineLengths = []
let timer

parentPort.on('message', message => {
    try {
        if (message.type === 'animate') {
            const wasAnimating = timer !== undefined
            frames = message.frames
            if (!wasAnimating) {
                frameIndex = 0
            }
            renderFrame()
            if (!wasAnimating) {
                timer = setInterval(tick, message.intervalMs)
                timer.unref?.()
            }
            return
        }
        if (message.type === 'clear') {
            stopAnimation()
            clearLines()
            return
        }
        if (message.type === 'complete') {
            stopAnimation()
            if (lineLengths.length > 1) {
                clearLines()
            }
            writeLine(message.output)
            write('\\n')
            lineLengths = []
            return
        }
        if (message.type === 'done') {
            stopAnimation()
            if (lineLengths.length > 0) {
                write('\\n')
                lineLengths = []
            }
            return
        }
        if (message.type === 'stopAnimation') {
            stopAnimation()
            return
        }
        if (message.type === 'write') {
            stopAnimation()
            if (lineLengths.length > 1) {
                clearLines()
            }
            writeLine(message.output)
            return
        }
        if (message.type === 'writeBlock') {
            stopAnimation()
            writeBlock(message.output)
        }
    } finally {
        if (message.signal) {
            Atomics.store(message.signal, 0, 1)
            Atomics.notify(message.signal, 0)
        }
    }
})

function tick() {
    frameIndex = (frameIndex + 1) % Math.max(1, frames.length)
    renderFrame()
}

function renderFrame() {
    const output = frames[frameIndex] ?? []
    writeBlock(output)
}

function stopAnimation() {
    if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
    }
}

function writeBlock(output) {
    if (output.length === 0) {
        if (lineLengths.length > 0) {
            clearLines()
        }
        return
    }
    if (lineLengths.length > 0) {
        clearLines()
    }
    for (const [index, line] of output.entries()) {
        if (index > 0) {
            write('\\n')
        }
        write(line)
        lineLengths.push(visibleLength(line))
    }
}

function writeLine(output) {
    const outputLength = visibleLength(output)
    const padding = Math.max(0, (lineLengths[0] ?? 0) - outputLength)
    write('\\r' + output + ' '.repeat(padding))
    lineLengths = [outputLength]
}

function clearLines() {
    for (let index = lineLengths.length - 1; index >= 0; index -= 1) {
        write('\\r' + ' '.repeat(lineLengths[index] ?? 0) + '\\r')
        if (index > 0) {
            write('\\x1b[1A')
        }
    }
    lineLengths = []
}

function visibleLength(value) {
    return value.replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '').length
}

function write(value) {
    writeSync(fd, value)
}
`

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
    if (typeof timer !== 'object' || timer === null || !('unref' in timer)) {
        return
    }

    const unrefable = timer as { unref?: unknown }
    if (typeof unrefable.unref === 'function') {
        unrefable.unref()
    }
}
