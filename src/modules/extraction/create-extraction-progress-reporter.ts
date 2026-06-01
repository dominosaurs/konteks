import consoleOutput, {
    type ConsoleColorPalette,
} from '@/support/console-output'
import { formatBytes } from '@/support/format/number'
import {
    createAnimatedInlineProgress,
    createTuiText,
    spinnerFrame,
} from '@/support/tui/components'
import type { TuiText } from '@/support/tui/components/text'
import type { ExtractionProgressEvent } from '@/types/progress'

export default function createExtractionProgressReporter(): {
    done(): void
    report(event: ExtractionProgressEvent): void
} {
    let activeStep = ''
    let lastStep = ''
    let lastCompactMessage = ''
    const downloadBuckets = new Map<string, number>()
    const isTty = consoleOutput.stderrIsInteractive()
    const inline = createAnimatedInlineProgress(
        value => consoleOutput.writeError(value),
        { isEnabled: isTty },
    )
    const text = createTuiText(consoleOutput.colorPalette)

    return {
        done() {
            if (isTty) {
                inline.done()
            }
        },
        report(event) {
            const message = formatPlainEvent(event)
            if (!message) {
                return
            }

            if (!isTty) {
                const step = stepKey(event)
                const downloadKey = event.downloadFile ?? step
                const downloadBucket =
                    event.downloadPercent === undefined
                        ? undefined
                        : Math.floor(event.downloadPercent / 10)
                const previousDownloadBucket =
                    downloadBuckets.get(downloadKey) ?? -1
                if (
                    event.status !== 'progress' ||
                    step !== lastStep ||
                    (downloadBucket !== undefined &&
                        downloadBucket > previousDownloadBucket)
                ) {
                    consoleOutput.error(message)
                    lastStep = step
                    if (downloadBucket !== undefined) {
                        downloadBuckets.set(downloadKey, downloadBucket)
                    }
                }
                return
            }

            const step = stepKey(event)
            if (step !== activeStep || event.status === 'start') {
                inline.done()
                activeStep = step
                lastCompactMessage = ''
                consoleOutput.writeError(
                    color => `${formatStepHeader(event, color)}\n`,
                )
            }

            if (event.status === 'progress') {
                const compact = compactMessage(event)
                if (
                    event.phase === 'preparation' &&
                    compact === lastCompactMessage &&
                    event.downloadPercent === undefined
                ) {
                    return
                }
                inline.writeAnimated(spinnerIndex =>
                    formatInlineProgress(
                        event,
                        spinnerIndex,
                        consoleOutput.colorPalette,
                    ),
                )
                lastCompactMessage = compact
                return
            }

            if (event.status === 'done' && event.phase !== 'done') {
                inline.done()
                consoleOutput.writeError(`${formatDoneLine(event, text)}\n`)
                return
            }

            if (event.phase === 'done') {
                inline.done()
                consoleOutput.writeError(`${formatFinalLine(event, text)}\n`)
            }
        },
    }
}

function formatPlainEvent(event: ExtractionProgressEvent): string {
    const progress = formatPercentAndCount(event)
    return [phaseTitle(event.phase), progress, compactMessage(event)]
        .filter(Boolean)
        .join('  ')
}

function formatStepHeader(
    event: ExtractionProgressEvent,
    color: ConsoleColorPalette,
): string {
    return `${color.dim('┌')} ${color.primary(stepTitle(event))}`
}

function formatInlineProgress(
    event: ExtractionProgressEvent,
    spinnerIndex: number,
    color: ConsoleColorPalette,
): string {
    const spinner = color.primary(spinnerFrame(spinnerIndex))
    const progress = color.info(formatPercentAndCount(event).padEnd(20))
    const action = compactMessage(event)
    const detail = formatInlineDetail(event)

    return `  ${spinner} ${progress} ${action}${detail ? color.dim(`  ${detail}`) : ''}`
}

function formatDoneLine(event: ExtractionProgressEvent, text: TuiText): string {
    return `  ${text.checkLine(event.message ?? `${phaseTitle(event.phase)} done`)}`
}

function formatFinalLine(
    event: ExtractionProgressEvent,
    text: TuiText,
): string {
    return text.checkLine(event.message ?? 'Extraction complete')
}

function compactMessage(event: ExtractionProgressEvent): string {
    const message = event.message ?? phaseTitle(event.phase)

    if (event.phase === 'preparation') {
        if (/Tree-sitter grammars ready/u.test(message)) {
            return 'Grammars ready'
        }
        if (/^Preparing \d+ Tree-sitter grammars/u.test(message)) {
            return 'Preparing grammars'
        }
        if (/^Downloading .+ grammar/u.test(message)) {
            return 'Downloading grammar'
        }
        if (/^Loaded .+ grammar/u.test(message)) {
            return 'Loading grammar'
        }
        if (/^Using cached .+ grammar/u.test(message)) {
            return 'Using cached grammar'
        }
        if (event.downloadPercent !== undefined) {
            return 'Loading model files'
        }
        if (/^Embedding model ready:/u.test(message)) {
            return 'Model ready'
        }
        if (/^Loading embedding model/u.test(message)) {
            return 'Loading model'
        }
        if (/^Preparing /u.test(message)) {
            return 'Preparing model'
        }
        if (/^Loading /u.test(message)) {
            return 'Loading model files'
        }
        return message
    }

    if (event.phase === 'embeddings') {
        if (
            /^Embedded section:/u.test(message) ||
            /^Embedding section:/u.test(message)
        ) {
            return 'Embedding section'
        }
        if (
            /^Embedded module:/u.test(message) ||
            /^Embedding module:/u.test(message)
        ) {
            return 'Embedding module'
        }
        if (/^Reused embedding for section:/u.test(message)) {
            return 'Reusing section embedding'
        }
        if (/^Reused embedding for module:/u.test(message)) {
            return 'Reusing module embedding'
        }
    }

    if (event.phase === 'sections' && event.path) {
        return 'Extracting files'
    }

    return message
}

function formatInlineDetail(event: ExtractionProgressEvent): string {
    if (event.phase === 'sections' && event.path) {
        return ''
    }

    if (
        event.phase === 'embeddings' &&
        event.embeddedCount !== undefined &&
        event.total !== undefined
    ) {
        return `${event.embeddedCount} indexed, ${event.reusedCount ?? 0} unchanged`
    }

    if (event.downloadFile) {
        return event.downloadFile
    }

    return ''
}

function formatPercentAndCount(event: ExtractionProgressEvent): string {
    if (event.downloadPercent !== undefined) {
        return `${event.downloadPercent.toFixed(1).padStart(5)}% ${formatBytes(
            event.downloadLoadedBytes ?? 0,
        )}/${formatBytes(event.downloadTotalBytes ?? 0)}`
    }

    if (event.total !== undefined) {
        const current =
            event.current ?? (event.status === 'done' ? event.total : 0)
        const percent = event.total === 0 ? 100 : (current / event.total) * 100
        return `${Math.round(percent).toString().padStart(3)}% ${current}/${event.total}`
    }

    return ''
}

function phaseTitle(phase: ExtractionProgressEvent['phase']): string {
    const labels: Record<ExtractionProgressEvent['phase'], string> = {
        database: 'Database',
        done: 'Complete',
        embeddings: 'Embeddings',
        manifest: 'Manifest',
        metadata: 'Metadata',
        modules: 'Modules',
        preparation: 'Preparation',
        scan: 'Scan',
        sections: 'Extracting files',
        select: 'Selection',
        start: 'Konteks extraction',
        summary: 'Summary',
    }

    return labels[phase]
}

function stepTitle(event: ExtractionProgressEvent): string {
    if (event.phase === 'preparation') {
        if (/grammar/iu.test(event.message ?? '')) {
            return 'Preparation: Tree-sitter Grammars'
        }
        return 'Preparation: Model Load'
    }

    if (event.phase === 'embeddings') {
        return 'Embeddings: Vector Generation'
    }

    return phaseTitle(event.phase)
}

function stepKey(event: ExtractionProgressEvent): string {
    return `${event.phase}:${event.stage ?? 'default'}`
}
