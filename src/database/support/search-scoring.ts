import type { RetrievalDocumentRow } from '@/database/actions/query-retrieval-documents'
import contentHash from '@/support/content-hash'
import { estimateTextTokens } from '@/support/format/tokens'
import type { EmbeddingProviderContract as EmbeddingProvider } from '@/types/embedding-provider'
import type { MemorySearchResult } from '@/types/memory'

const excerptBudgetTokens = 120

export function makeSearchResult(input: {
    anchor?: string
    confidence: number
    content: string
    createdAt: string
    embeddingDimensions?: number
    embeddingModel?: string
    id: string
    kind?: string
    metadata?: Record<string, unknown>
    path?: string
    sourceId?: string
    sourceRole?: string
    targetType?: 'section' | 'diary' | 'memory' | 'module'
    task?: string
    terms: string[]
    textForScoring?: string
    tokenCost?: number
    type: MemorySearchResult['type']
    vectorScore?: number
}): MemorySearchResult {
    const tokenCost = input.tokenCost ?? estimateTextTokens(input.content)
    const lexical = scoreText(
        input.textForScoring ?? input.content,
        input.terms,
    )
    const recency = recencyBoost(input.createdAt)
    const tokenCostPenalty = Math.ceil(tokenCost / 120)
    const confidence = Math.max(0, Math.min(input.confidence, 1))
    const score = Math.round(
        lexical * 100 +
            (input.vectorScore ?? 0) * 60 +
            confidence * 20 +
            recency -
            tokenCostPenalty,
    )

    return {
        anchor: input.anchor,
        createdAt: input.createdAt,
        embeddingDimensions: input.embeddingDimensions,
        embeddingModel: input.embeddingModel,
        excerpt: trimToTokenBudget(input.content, excerptBudgetTokens),
        id: input.id,
        kind: input.kind,
        metadata: input.metadata,
        path: input.path,
        score,
        scoreDetails: {
            confidence,
            lexical,
            recency,
            tokenCostPenalty,
            vector: input.vectorScore,
        },
        sourceId: input.sourceId,
        sourceRole: input.sourceRole,
        targetType: input.targetType,
        task: input.task,
        tokenCost: Math.min(tokenCost, excerptBudgetTokens),
        type: input.type,
        vectorScore: input.vectorScore,
    }
}

export async function embedSearchQuery(
    provider: EmbeddingProvider | undefined,
    terms: string[],
): Promise<Float32Array | undefined> {
    if (!provider) {
        return undefined
    }

    try {
        const vectors = await provider.embed([terms.join(' ')])
        const vector = vectors[0]
        return vector?.length === provider.dimensions ? vector : undefined
    } catch {
        return undefined
    }
}

export function computeVectorScore(
    row: RetrievalDocumentRow,
    input: {
        provider?: EmbeddingProvider
        queryVector?: Float32Array
    },
): number | undefined {
    if (
        !input.provider ||
        !input.queryVector ||
        !row.vector_blob ||
        row.target_embedding_hash !==
            contentHash(`${input.provider.model}:${row.embedding_text}`) ||
        row.embedding_model !== input.provider.model ||
        row.embedding_dimensions !== input.provider.dimensions
    ) {
        return undefined
    }

    const vector = blobToFloat32Array(row.vector_blob)
    if (vector.length !== input.provider.dimensions) {
        return undefined
    }

    return cosineSimilarity(input.queryVector, vector)
}

function blobToFloat32Array(blob: Uint8Array): Float32Array {
    const buffer = blob.buffer.slice(
        blob.byteOffset,
        blob.byteOffset + blob.byteLength,
    )
    return new Float32Array(buffer)
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
    let dot = 0
    let leftNorm = 0
    let rightNorm = 0
    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index] ?? 0
        const rightValue = right[index] ?? 0
        dot += leftValue * rightValue
        leftNorm += leftValue * leftValue
        rightNorm += rightValue * rightValue
    }

    if (leftNorm === 0 || rightNorm === 0) {
        return 0
    }

    return dot / Math.sqrt(leftNorm * rightNorm)
}

function scoreText(text: string, terms: string[]): number {
    const lowerText = text.toLowerCase()
    return terms.reduce(
        (score, term) => score + (lowerText.includes(term) ? 1 : 0),
        0,
    )
}

function recencyBoost(createdAt: string): number {
    const timestamp = Date.parse(createdAt)
    if (Number.isNaN(timestamp)) {
        return 0
    }

    const ageDays = (Date.now() - timestamp) / 86_400_000
    return Math.max(0, 20 - Math.floor(ageDays))
}

function trimToTokenBudget(text: string, excerptBudgetTokens: number): string {
    const words = text.trim().split(/\s+/u).filter(Boolean)
    const maxWords = Math.max(1, Math.floor(excerptBudgetTokens / 1.33))

    if (words.length <= maxWords) {
        return text
    }

    return `${words.slice(0, maxWords).join(' ')}...`
}
