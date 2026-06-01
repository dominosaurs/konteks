import createInlineProgress, { type InlineProgress } from './inline-progress'

export type AnimatedInlineProgress = InlineProgress & {
    writeAnimated(render: (spinnerIndex: number) => string): void
    writeAnimatedBlock(render: (spinnerIndex: number) => string[]): void
}

const DEFAULT_ANIMATION_INTERVAL_MS = 100

export default function createAnimatedInlineProgress(
    write: (value: string) => void,
    options: {
        intervalMs?: number
        isEnabled?: boolean
    } = {},
): AnimatedInlineProgress {
    const inline = createInlineProgress(write)
    const intervalMs = options.intervalMs ?? DEFAULT_ANIMATION_INTERVAL_MS
    const isEnabled = options.isEnabled ?? true
    let spinnerIndex = 0
    let timer: ReturnType<typeof setInterval> | undefined
    let renderAnimated: ((spinnerIndex: number) => void) | undefined

    return {
        clear() {
            stopAnimation()
            inline.clear()
        },
        complete(output) {
            stopAnimation()
            inline.complete(output)
        },
        done() {
            stopAnimation()
            inline.done()
        },
        hasLine() {
            return inline.hasLine()
        },
        write(output) {
            stopAnimation()
            inline.write(output)
        },
        writeAnimated(render) {
            renderAnimated = index => inline.write(render(index))
            renderCurrent()
            startAnimation()
        },
        writeAnimatedBlock(render) {
            renderAnimated = index => inline.writeBlock(render(index))
            renderCurrent()
            startAnimation()
        },
        writeBlock(output) {
            stopAnimation()
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
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
    if (typeof timer !== 'object' || timer === null || !('unref' in timer)) {
        return
    }

    const unrefable = timer as { unref?: unknown }
    if (typeof unrefable.unref === 'function') {
        unrefable.unref()
    }
}
