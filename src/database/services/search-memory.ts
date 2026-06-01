import { withTransaction } from '@/database/actions/_db'
import hasSearchIndex from '@/database/actions/has-search-index'
import queryDiaries, { type DiaryRow } from '@/database/actions/query-diaries'
import queryFtsRows from '@/database/actions/query-fts-rows'
import queryObservations, {
    type ObservationRow,
} from '@/database/actions/query-observations'
import queryRetrievalDocuments, {
    queryRetrievalDocumentsByTargets,
    type RetrievalDocumentRow,
} from '@/database/actions/query-retrieval-documents'
import {
    buildRetrievalGraphContext,
    resultKey,
} from '@/database/services/graph-context'
import { searchVectorIndex } from '@/database/services/vector-index'
import { classifySourceRole } from '@/modules/project/source-classification'
import { estimateTextTokens } from '@/support/format/tokens'
import type { EmbeddingProviderContract as EmbeddingProvider } from '@/types/embedding-provider'
import type { MemorySearchResult } from '@/types/memory'
import {
    allowResult,
    applyGroupAwarePruning,
    applyRolePolicy,
    compareSearchResults,
    detectIntent,
    type SearchIntent,
    type SearchMode,
    toFtsQuery,
    tokenize,
} from '../support/search-policy'
import {
    computeVectorScore,
    embedSearchQuery,
    makeSearchResult,
} from '../support/search-scoring'

type SearchMemoryOptions = {
    embeddingProvider?: EmbeddingProvider
    includeGraphBoost?: boolean
    limit?: number
}

export type MemorySearchInput = {
    query: string
    limit?: number
}

export type MemoryRecallInput = {
    focus: string[]
    includeSources?: boolean
}

export default async function searchMemory(
    input: MemorySearchInput | MemoryRecallInput,
    options: SearchMemoryOptions = {},
): Promise<MemorySearchResult[]> {
    return withTransaction(() => searchBoundMemory(input, options))
}

async function searchBoundMemory(
    input: MemorySearchInput | MemoryRecallInput,
    options: SearchMemoryOptions,
): Promise<MemorySearchResult[]> {
    const mode: SearchMode = 'query' in input ? 'search' : 'recall'
    const limit = 'limit' in input ? (input.limit ?? 10) : (options.limit ?? 10)
    const query = 'query' in input ? input.query : focusToQuery(input.focus)
    const terms = tokenize(query)
    const intent = detectIntent(query)

    if (terms.length === 0) {
        return []
    }

    const retrievalResults = await searchRetrievalDocuments(
        terms,
        limit,
        mode,
        intent,
        options,
    )
    if (retrievalResults.length > 0) {
        return retrievalResults
    }

    if (await hasSearchIndex()) {
        const ftsResults = await searchFts(terms, limit, mode, intent)
        if (ftsResults.length > 0) {
            return ftsResults
        }
    }

    const observations = await queryObservations(terms, limit * 2)
    const diaries = await queryDiaries(terms, limit * 2)

    return applyGroupAwarePruning(
        [
            ...observations.map(row => observationToResult(row, terms)),
            ...diaries.map(row => diaryToResult(row, terms)),
        ],
        mode,
        limit,
    )
        .filter(result => allowResult(result, mode, intent))
        .sort(compareSearchResults)
        .slice(0, limit)
}

export function focusToQuery(focus: string[]): string {
    return focus
        .map(item => item.trim())
        .filter(Boolean)
        .join('\n')
}

async function searchRetrievalDocuments(
    terms: string[],
    limit: number,
    mode: SearchMode,
    intent: SearchIntent,
    options: SearchMemoryOptions,
): Promise<MemorySearchResult[]> {
    const ftsQuery = toFtsQuery(terms)
    if (!ftsQuery) {
        return []
    }
    const queryVector = await embedSearchQuery(options.embeddingProvider, terms)
    const rows = await queryRetrievalDocuments(
        options.embeddingProvider?.model ?? '',
        options.embeddingProvider?.dimensions ?? 0,
        ftsQuery,
        limit * 4,
    )
    const expandedRows = await expandWithVectorCandidates({
        limit,
        provider: options.embeddingProvider,
        queryVector,
        rows,
    })

    const results = applyGroupAwarePruning(
        expandedRows.map(row =>
            retrievalDocumentToResult(row, terms, {
                provider: options.embeddingProvider,
                queryVector,
            }),
        ),
        mode,
        limit,
    )
        .filter(result => allowResult(result, mode, intent))
        .map(result => applyRolePolicy(result, mode, intent))

    if (options.includeGraphBoost === false) {
        return results.sort(compareSearchResults).slice(0, limit)
    }

    const graphContext = await buildRetrievalGraphContext(
        terms.join(' '),
        results,
    )
    return results
        .map(result => applyGraphBoost(result, graphContext.boosts))
        .sort(compareSearchResults)
        .slice(0, limit)
}

async function expandWithVectorCandidates(input: {
    limit: number
    provider?: EmbeddingProvider
    queryVector?: Float32Array
    rows: RetrievalDocumentRow[]
}): Promise<RetrievalDocumentRow[]> {
    if (!input.provider || !input.queryVector) {
        return input.rows
    }

    const existingKeys = new Set(
        input.rows.map(row => `${row.target_type}:${row.target_id}`),
    )
    const vectorRows = await searchVectorIndex({
        dimensions: input.provider.dimensions,
        limit: input.limit * 4,
        model: input.provider.model,
        vector: input.queryVector,
    })
    const vectorTargets = vectorRows
        .filter(row => !existingKeys.has(`${row.targetType}:${row.targetId}`))
        .map(row => ({
            embeddingHash: row.embeddingHash,
            model: row.model,
            targetId: row.targetId,
            targetType: row.targetType,
            vectorScore: vectorDistanceToScore(row.distance),
        }))

    if (vectorTargets.length === 0) {
        return input.rows
    }

    const semanticRows = await queryRetrievalDocumentsByTargets(vectorTargets)
    return [...input.rows, ...semanticRows]
}

function vectorDistanceToScore(distance: number): number {
    return Math.max(0, Math.min(1, 1 - distance / 2))
}

async function searchFts(
    terms: string[],
    limit: number,
    mode: SearchMode,
    intent: SearchIntent,
): Promise<MemorySearchResult[]> {
    const ftsQuery = toFtsQuery(terms)
    if (!ftsQuery) {
        return []
    }

    const rows = await queryFtsRows(ftsQuery, limit)

    return applyGroupAwarePruning(
        rows.map(row =>
            makeSearchResult({
                confidence: row.confidence ?? 1,
                content: row.content,
                createdAt: row.created_at,
                id: row.id,
                kind: row.kind ?? undefined,
                sourceId: row.source_id ?? undefined,
                task: row.task ?? undefined,
                terms,
                tokenCost: row.token_count ?? estimateTextTokens(row.content),
                type: row.type,
            }),
        ),
        mode,
        limit,
    )
        .filter(result => allowResult(result, mode, intent))
        .sort(compareSearchResults)
}

function observationToResult(
    row: ObservationRow,
    terms: string[],
): MemorySearchResult {
    const excerpt = row.text_inline ?? ''
    return makeSearchResult({
        confidence: row.confidence,
        content: excerpt,
        createdAt: row.created_at,
        id: row.id,
        kind: row.kind,
        terms,
        type: 'memory',
    })
}

function diaryToResult(row: DiaryRow, terms: string[]): MemorySearchResult {
    const tags = safeParseTags(row.tags_json)
    const text = [row.subject, row.summary, tags.join(' ')]
        .filter(Boolean)
        .join('\n')
    return makeSearchResult({
        confidence: 1,
        content: row.summary,
        createdAt: row.created_at,
        id: row.id,
        kind: 'diary',
        terms,
        textForScoring: text,
        type: 'diary',
    })
}

function safeParseTags(raw: string | null): string[] {
    if (!raw) {
        return []
    }
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) {
            return []
        }
        return parsed.filter(value => typeof value === 'string')
    } catch {
        return []
    }
}

function retrievalDocumentToResult(
    row: RetrievalDocumentRow,
    terms: string[],
    vectorInput: {
        provider?: EmbeddingProvider
        queryVector?: Float32Array
    },
): MemorySearchResult {
    const sourceRole = resolveSourceRole(row.source_role, row.path)
    const location = row.path
        ? row.anchor
            ? `${row.path}#${row.anchor}`
            : row.path
        : row.target_id
    const type = row.target_type
    const excerpt = row.summary
        ? `${location}\n${row.summary}`
        : `${location}\n${row.fts_text}`

    const vectorScore = row.vector_score ?? computeVectorScore(row, vectorInput)

    return makeSearchResult({
        anchor: row.anchor ?? undefined,
        confidence: 1,
        content: excerpt,
        createdAt: row.updated_at,
        embeddingDimensions: row.embedding_dimensions ?? undefined,
        embeddingModel: row.embedding_model ?? undefined,
        id: row.target_id,
        kind: sourceRole,
        path: row.path ?? undefined,
        sourceId: row.source_id ?? undefined,
        sourceRole,
        targetType: row.target_type,
        terms,
        tokenCost:
            row.token_count ?? estimateTextTokens(row.summary ?? row.fts_text),
        type,
        vectorScore,
    })
}

function applyGraphBoost(
    result: MemorySearchResult,
    boosts: Map<string, number>,
): MemorySearchResult {
    const boost = boosts.get(resultKey(result)) ?? 0
    if (boost === 0) {
        return result
    }

    return {
        ...result,
        metadata: {
            ...result.metadata,
            graphBoost: boost,
        },
        score: result.score + boost,
    }
}

function resolveSourceRole(
    sourceRole: string | null,
    path: string | null,
): string | undefined {
    if (sourceRole) {
        return sourceRole
    }
    if (!path) {
        return undefined
    }
    return classifySourceRole(path)
}
