import type { ConsoleColorPalette } from '@/support/console-output'
import stripAnsi from '@/support/strip-ansi'

export type TuiText = {
    checkLine(message: string): string
    count(value: number): string
    progressLine(spinnerIndex: number, message: string): string
    sectionTitle(message: string): string
    statLine(label: string, value: number): string
}

export function createTuiText(color: ConsoleColorPalette): TuiText {
    return {
        checkLine(message) {
            return `${color.success('✓')} ${message}`
        },
        count(value) {
            return color.info(value.toString())
        },
        progressLine(spinnerIndex, message) {
            return `${color.primary(spinnerFrame(spinnerIndex))} ${message}`
        },
        sectionTitle(message) {
            return color.primary(message)
        },
        statLine(label, value) {
            return `${color.dim(label.padEnd(20))} ${color.info(value.toString())}`
        },
    }
}

export function spinnerFrame(index: number): string {
    return ['◐', '◓', '◑', '◒'][index % 4] ?? '◐'
}

export function visibleLength(value: string): number {
    return stripAnsi(value).length
}
