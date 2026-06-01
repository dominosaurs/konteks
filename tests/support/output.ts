import consoleOutput, {
    type ConsoleColorPalette,
} from '@/support/console-output'
import stripAnsi from '@/support/strip-ansi'

type ConsoleOutputMessage = Parameters<typeof consoleOutput.print>[0]

export function renderStdoutMessage(message: ConsoleOutputMessage): string {
    return isOutputFormatter(message)
        ? message(consoleOutput.colorPalette)
        : String(message)
}

export { stripAnsi }

function isOutputFormatter(
    message: ConsoleOutputMessage,
): message is (color: ConsoleColorPalette) => string {
    return typeof message === 'function'
}
