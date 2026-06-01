export type ObservationKind =
    | 'blocker'
    | 'code_insight'
    | 'constraint'
    | 'decision'
    | 'fact'
    | 'note'
    | 'preference'

type MemoryType = 'section' | 'diary' | 'memory' | 'module'

export type MemoryEntity = {
    id: string
    type: string
    name: string
    canonicalName: string
    summary?: string
    properties?: Record<string, unknown>
}

export type MemorySearchResult = {
    id: string
    type: MemoryType
    kind?: string
    path?: string
    anchor?: string
    embeddingDimensions?: number
    embeddingModel?: string
    sourceId?: string
    sourceRole?: string
    excerpt: string
    score: number
    scoreDetails?: {
        confidence: number
        lexical: number
        recency: number
        tokenCostPenalty: number
        vector?: number
    }
    targetType?: MemoryType
    task?: string
    tokenCost?: number
    vectorScore?: number
    createdAt: string
    metadata?: Record<string, unknown>
}

export type SaveResult = {
    id: string
    accepted: boolean
    duplicateOf?: string
    diaryId?: string
    memoryIds?: string[]
    skippedMemories?: number
}

export type RecallGraphItem = {
    entityId: string
    entityName: string
    entityType: string
    relationId: string
    predicate: string
    direction: 'incoming' | 'outgoing'
    depth: number
    score: number
    relatedEntityId: string
    relatedEntityName: string
    relatedEntityType: string
}

export type RecallHistoryItem = {
    relationId: string
    predicate: string
    status: 'invalidated' | 'superseded'
    subjectEntityId: string
    subjectEntityName: string
    objectEntityId: string
    objectEntityName: string
    validFrom?: string
    validTo?: string
    reason: string
}

export type RecallPackage = {
    brief: string[]
    focus: string[]
    graph: RecallGraphItem[]
    history: RecallHistoryItem[]
    memories: MemorySearchResult[]
    primaryTargets: string[]
    quality: 'partial' | 'strong' | 'weak'
    sourceCount: number
}

export type WarmUpHighlight = {
    anchor?: string
    excerpt: string
    id: string
    path?: string
    score: number
    scoreDetails: {
        importance: number
        recency: number
        role: number
        tokenCostPenalty: number
    }
    sourceRole?: string
    tokenCost: number
    type: 'section' | 'diary' | 'memory' | 'module'
}

export type WarmUpGuidance = {
    id?: string
    kind: 'constraint' | 'convention' | 'decision'
    text: string
}

export type WarmUpContext = {
    architecture: string[]
    description?: string
    entryPoints: string[]
    guidance: WarmUpGuidance[]
    highlights: WarmUpHighlight[]
    keyFiles: string[]
    taxonomy: string[]
    technologies: string[]
}
