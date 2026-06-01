type ExtractionProgressPhase =
    | 'sections'
    | 'database'
    | 'done'
    | 'embeddings'
    | 'manifest'
    | 'metadata'
    | 'modules'
    | 'preparation'
    | 'scan'
    | 'select'
    | 'start'
    | 'summary'

type ExtractionProgressStatus = 'done' | 'progress' | 'start'

export type ExtractionProgressEvent = {
    batchCurrent?: number
    batchSize?: number
    batchTotal?: number
    sectionCount?: number
    current?: number
    downloadFile?: string
    downloadLoadedBytes?: number
    downloadPercent?: number
    downloadTotalBytes?: number
    detectedParserLanguages?: string[]
    embeddedCount?: number
    languageCount?: number
    message?: string
    path?: string
    phase: ExtractionProgressPhase
    parserCount?: number
    stage?: 'embed' | 'index' | 'prepare'
    reusedCount?: number
    status: ExtractionProgressStatus
    total?: number
}

export type ExtractionProgressReporter = (
    event: ExtractionProgressEvent,
) => void
