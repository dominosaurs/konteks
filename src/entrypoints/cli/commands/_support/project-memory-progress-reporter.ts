import consoleOutput from '@/support/console-output'
import {
    createAnimatedInlineProgress,
    createTuiText,
} from '@/support/tui/components'
import type { ExtractProjectResponse } from '@/types/extraction'
import type { ExtractionProgressEvent } from '@/types/progress'

type ProjectMemoryProgressReporter = {
    done(): void
    report(event: ExtractionProgressEvent): void
    summary(result: ExtractProjectResponse): void
}

export default function createProjectMemoryProgressReporter(): ProjectMemoryProgressReporter {
    let printedDocumentLine = false
    let printedPreparation = false
    let generatedSummary = false
    let fileCount = 0
    let sectionCount = 0
    let modelPercent: number | undefined
    let vectorIndexSyncLines: [string, string] | undefined
    const inline = createAnimatedInlineProgress(value =>
        consoleOutput.writeError(value),
    )
    const text = createTuiText(consoleOutput.colorPalette)

    return {
        done() {
            if (vectorIndexSyncLines !== undefined) {
                clearVectorIndexSync()
                return
            }

            inline.done()
        },
        report(event) {
            if (event.phase === 'preparation') {
                printPreparation(event)
                return
            }

            if (
                event.phase === 'sections' &&
                event.status === 'start' &&
                event.total !== undefined
            ) {
                finishPreparation()
                printExtractionProgress({
                    ...event,
                    current: event.current ?? 0,
                })
                return
            }

            if (
                event.phase === 'sections' &&
                event.status === 'progress' &&
                event.total !== undefined
            ) {
                finishPreparation()
                sectionCount = event.sectionCount ?? sectionCount
                fileCount = event.current ?? fileCount
                printExtractionProgress(event)
                return
            }

            if (event.phase === 'sections' && event.status === 'done') {
                finishPreparation()
                sectionCount = event.sectionCount ?? 0
                fileCount = event.current ?? event.total ?? 0
                return
            }

            if (
                event.phase === 'embeddings' &&
                event.stage === 'embed' &&
                event.status === 'start'
            ) {
                printEmbeddingStart(event.total ?? 0)
                return
            }

            if (
                event.phase === 'embeddings' &&
                event.stage === 'embed' &&
                event.status === 'progress'
            ) {
                printVectorProgress(event)
                return
            }

            if (
                event.phase === 'embeddings' &&
                event.stage === 'index' &&
                event.status === 'start'
            ) {
                printVectorIndexSyncStart(event)
                return
            }

            if (
                event.phase === 'embeddings' &&
                event.stage === 'index' &&
                event.status === 'done'
            ) {
                clearVectorIndexSync()
                return
            }

            if (event.phase === 'embeddings' && event.status === 'done') {
                printVectorProgress({
                    ...event,
                    current: event.total,
                })
                return
            }

            if (event.phase === 'summary' && event.status === 'done') {
                generatedSummary = true
                clearVectorIndexSync()
                inline.done()
            }
        },
        summary(result) {
            clearVectorIndexSync()
            if (!printedDocumentLine) {
                sectionCount = result.sectionCount
                fileCount = result.fileCount
                completeInlineProgress(
                    preparedDocumentsMessage(result.vectorCount),
                )
            } else {
                inline.done()
            }
            if (generatedSummary || result.summaryRef) {
                printCheck('Generated project summary')
            }

            consoleOutput.print('')
            consoleOutput.print(text.sectionTitle('Project memory ready'))
            consoleOutput.print('')
            consoleOutput.print(
                text.statLine('Files indexed', result.fileCount),
            )
            consoleOutput.print(
                text.statLine('Vectors indexed', result.vectorCount),
            )
        },
    }

    function printExtractionProgress(event: ExtractionProgressEvent): void {
        const current = event.current ?? 0
        const total = event.total ?? current
        const message = `Extracting files: ${text.count(current)}/${text.count(total)}`

        writeProgress(message)
    }

    function printVectorProgress(event: ExtractionProgressEvent): void {
        const current = event.current ?? 0
        const total = event.total ?? current
        const message = `${text.count(current)}/${text.count(total)} vectors indexed`

        if (current === total) {
            inline.write(text.checkLine(message))
            return
        }

        writeProgress(message)
    }

    function printVectorIndexSyncStart(event: ExtractionProgressEvent): void {
        const current = event.current ?? 0
        const total = event.total ?? current
        vectorIndexSyncLines = [
            pausedVectorLine(current, total),
            vectorIndexSyncMessage(event),
        ]
        startVectorIndexSync()
    }

    function printPreparation(event: ExtractionProgressEvent): void {
        if (!event.message) {
            return
        }

        if (isModelReadyEvent(event)) {
            finishPreparation()
            return
        }

        if (event.status === 'done') {
            printCombinedPreparation()
            return
        }

        if (event.stage === 'prepare' && event.downloadPercent !== undefined) {
            modelPercent = event.downloadPercent
        }

        printCombinedPreparation()
    }

    function printCombinedPreparation(): void {
        if (printedPreparation) {
            return
        }

        printInlineProgress(preparationMessage())
    }

    function preparationMessage(): string {
        if (modelPercent === undefined) {
            return 'Preparing dependencies'
        }

        const percent = modelPercent
        return `Preparing dependencies: ${consoleOutput.colorPalette.primary(percent.toFixed(1))}%`
    }

    function printInlineProgress(message: string): void {
        writeProgress(message)
    }

    function writeProgress(message: string): void {
        clearVectorIndexSync()
        inline.writeAnimated(spinnerIndex =>
            text.progressLine(spinnerIndex, message),
        )
    }

    function printCheck(message: string): void {
        consoleOutput.print(text.checkLine(message))
    }

    function finishPreparation(): void {
        if (printedPreparation) {
            return
        }

        printedPreparation = true
        completeInlineProgress(
            `Preparing dependencies: ${consoleOutput.colorPalette.primary('100')}%`,
        )
    }

    function printEmbeddingStart(documentCount: number): void {
        finishPreparation()
        printedDocumentLine = true
        completeInlineProgress(preparedDocumentsMessage(documentCount))
        consoleOutput.print('')
        consoleOutput.print(text.sectionTitle('Building project memory...'))
    }

    function completeInlineProgress(message: string): void {
        if (!inline.hasLine()) {
            printCheck(message)
            return
        }

        inline.complete(text.checkLine(message))
    }

    function preparedDocumentsMessage(documentCount: number): string {
        const moduleCount = Math.max(0, documentCount - sectionCount)

        return `Extracted ${text.count(moduleCount)} modules and ${text.count(sectionCount)} sections from ${text.count(fileCount)} files`
    }

    function pausedVectorLine(current: number, total: number): string {
        return `${consoleOutput.colorPalette.warning('⏸')} ${text.count(current)}/${text.count(total)} vectors indexed`
    }

    function vectorIndexSyncMessage(event: ExtractionProgressEvent): string {
        if (
            event.batchCurrent !== undefined &&
            event.batchTotal !== undefined &&
            event.batchSize !== undefined
        ) {
            return `Syncing vector index: batch ${event.batchCurrent}/${event.batchTotal}, writing ${text.count(event.batchSize)} vectors...`
        }

        return event.message ?? 'Syncing vector index...'
    }

    function startVectorIndexSync(): void {
        inline.writeAnimatedBlock(spinnerIndex =>
            renderVectorIndexSync(spinnerIndex),
        )
    }

    function clearVectorIndexSync(): void {
        if (vectorIndexSyncLines === undefined) {
            return
        }

        vectorIndexSyncLines = undefined
        inline.clear()
    }

    function renderVectorIndexSync(spinnerIndex: number): string[] {
        if (vectorIndexSyncLines === undefined) {
            return []
        }

        const [pausedLine, syncMessage] = vectorIndexSyncLines
        return [pausedLine, text.progressLine(spinnerIndex, syncMessage)]
    }
}

function isModelReadyEvent(event: ExtractionProgressEvent): boolean {
    return (
        event.stage === 'prepare' &&
        /Embedding model ready/u.test(event.message ?? '')
    )
}
