import { encode } from '@toon-format/toon'
import colorPalette from './_support/color-palette'
import getBannerHeader from './_support/get-banner-header'
import highlightToon from './_support/highlight-toon'

export type ConsoleColorPalette = typeof colorPalette

type ConsoleOutputMessage =
    | object
    | string
    | ((palette: ConsoleColorPalette) => string)

type WritableStream = {
    fd?: number
    isTTY?: boolean
    write(section: string): unknown
}

type ReadableStream = {
    isTTY?: boolean
}

class ConsoleOutput {
    public readonly colorPalette = colorPalette
    private readonly nativeWriteError = this.writeError

    public constructor(
        private readonly stderr: WritableStream = process.stderr,
        private readonly stdin: ReadableStream = process.stdin,
    ) {}

    public print(message: ConsoleOutputMessage): this {
        console.log(
            typeof message === 'function'
                ? message(this.colorPalette)
                : message,
        )

        return this
    }

    public error(message: string, detail?: unknown): void {
        if (detail === undefined) {
            console.error(message)
            return
        }

        console.error(message, detail)
    }

    public writeError(
        message: string | ((palette: ConsoleColorPalette) => string),
    ): this {
        this.stderr.write(
            typeof message === 'function'
                ? message(this.colorPalette)
                : message,
        )
        return this
    }

    public toon(value: object | string): this {
        const output = typeof value === 'string' ? value : encode(value)

        return this.print(color => highlightToon(output, color))
    }

    public stderrIsInteractive(): boolean {
        return Boolean(this.stderr.isTTY)
    }

    public stderrFileDescriptor(): number | undefined {
        return this.writeError === this.nativeWriteError
            ? this.stderr.fd
            : undefined
    }

    public stdinIsInteractive(): boolean {
        return Boolean(this.stdin.isTTY)
    }

    public header(): string {
        return getBannerHeader(this.colorPalette)
    }

    public printHeader(): this {
        return this.print(this.header())
    }
}

export default new ConsoleOutput()
