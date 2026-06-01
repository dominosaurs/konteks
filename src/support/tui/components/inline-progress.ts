import { visibleLength } from './text'

export type InlineProgress = {
    clear(): void
    complete(output: string): void
    done(): void
    hasLine(): boolean
    write(output: string): void
}

export default function createInlineProgress(
    write: (value: string) => void,
): InlineProgress {
    let lastLineLength = 0

    return {
        clear() {
            if (lastLineLength === 0) {
                return
            }

            write(`\r${' '.repeat(lastLineLength)}\r`)
            lastLineLength = 0
        },
        complete(output) {
            writeLine(output)
            write('\n')
            lastLineLength = 0
        },
        done() {
            if (lastLineLength === 0) {
                return
            }

            write('\n')
            lastLineLength = 0
        },
        hasLine() {
            return lastLineLength > 0
        },
        write(output) {
            writeLine(output)
        },
    }

    function writeLine(output: string): void {
        const outputLength = visibleLength(output)
        const padding = Math.max(0, lastLineLength - outputLength)
        write(`\r${output}${' '.repeat(padding)}`)
        lastLineLength = outputLength
    }
}
