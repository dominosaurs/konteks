import { visibleLength } from './text'

export type InlineProgress = {
    clear(): void
    complete(output: string): void
    done(): void
    hasLine(): boolean
    write(output: string): void
    writeBlock(output: string[]): void
}

export default function createInlineProgress(
    write: (value: string) => void,
): InlineProgress {
    let lineLengths: number[] = []

    return {
        clear() {
            if (lineLengths.length === 0) {
                return
            }

            clearLines()
            lineLengths = []
        },
        complete(output) {
            if (lineLengths.length > 1) {
                clearLines()
                lineLengths = []
            }
            writeLine(output)
            write('\n')
            lineLengths = []
        },
        done() {
            if (lineLengths.length === 0) {
                return
            }

            write('\n')
            lineLengths = []
        },
        hasLine() {
            return lineLengths.length > 0
        },
        write(output) {
            if (lineLengths.length > 1) {
                clearLines()
                lineLengths = []
            }
            writeLine(output)
        },
        writeBlock(output) {
            if (output.length === 0) {
                if (lineLengths.length > 0) {
                    clearLines()
                    lineLengths = []
                }
                return
            }

            if (lineLengths.length > 0) {
                clearLines()
                lineLengths = []
            }

            for (const [index, line] of output.entries()) {
                if (index > 0) {
                    write('\n')
                }
                write(line)
                lineLengths.push(visibleLength(line))
            }
        },
    }

    function writeLine(output: string): void {
        const outputLength = visibleLength(output)
        const padding = Math.max(0, (lineLengths[0] ?? 0) - outputLength)
        write(`\r${output}${' '.repeat(padding)}`)
        lineLengths = [outputLength]
    }

    function clearLines(): void {
        for (let index = lineLengths.length - 1; index >= 0; index -= 1) {
            write(`\r${' '.repeat(lineLengths[index] ?? 0)}\r`)
            if (index > 0) {
                write('\x1b[1A')
            }
        }
    }
}
