import { withTransaction } from '@/database/actions/_db'
import historicalRelations, {
    historicalRelationsForEntities,
} from '@/database/actions/historical-relations'
import { buildRetrievalGraphContext } from '@/database/services/graph-context'
import searchMemory, {
    focusToQuery,
    type MemoryRecallInput,
} from '@/database/services/search-memory'
import type { EmbeddingProviderContract } from '@/types/embedding-provider'
import type {
    MemorySearchResult,
    RecallGraphItem,
    RecallHistoryItem,
    RecallPackage,
} from '@/types/memory'

const HISTORICAL_RELATION_LIMIT = 6
const RECALL_OUTPUT_BUDGET_TOKENS = 2000

export default async function recallRepositoryMemory(
    input: MemoryRecallInput,
    options: {
        embeddingProvider?: EmbeddingProviderContract
    } = {},
): Promise<RecallPackage> {
    return await withTransaction(async () => {
        const query = focusToQuery(input.focus)
        const memories = await searchMemory(
            {
                focus: input.focus,
            },
            {
                embeddingProvider: options.embeddingProvider,
                includeGraphBoost: false,
                limit: 20,
            },
        )
        const graphContext = await buildRetrievalGraphContext(query, memories)
        const entities = graphContext.entities

        const historyItems: RecallHistoryItem[] = []

        if (needsHistory(query)) {
            const seenRelations = new Set<string>()
            const relations =
                entities.length === 1
                    ? await historicalRelations(entities[0].id, {
                          limit: HISTORICAL_RELATION_LIMIT,
                      })
                    : await historicalRelationsForEntities(
                          entities.map(entity => entity.id),
                          { limit: HISTORICAL_RELATION_LIMIT },
                      )
            for (const relation of relations) {
                if (seenRelations.has(relation.relationId)) {
                    continue
                }
                seenRelations.add(relation.relationId)

                historyItems.push({
                    objectEntityId: relation.object.id,
                    objectEntityName: relation.object.name,
                    predicate: relation.predicate,
                    reason: `Included because task asks for historical or superseded context.`,
                    relationId: relation.relationId,
                    status: relation.status,
                    subjectEntityId: relation.subject.id,
                    subjectEntityName: relation.subject.name,
                    validFrom: relation.validFrom,
                    validTo: relation.validTo,
                })
            }
        }

        return assembleRecallPackage({
            focus: input.focus,
            graph: graphContext.graph,
            history: historyItems,
            includeSources: input.includeSources ?? false,
            memories,
            outputBudgetTokens: RECALL_OUTPUT_BUDGET_TOKENS,
        })
    })
}

function assembleRecallPackage(input: {
    graph: RecallGraphItem[]
    history: RecallHistoryItem[]
    includeSources: boolean
    focus: string[]
    memories: MemorySearchResult[]
    outputBudgetTokens: number
}): RecallPackage {
    const dedupedMemories = dedupeRecallMemories(input.memories)
    const memories = applyTokenBudget(
        dedupedMemories,
        input.outputBudgetTokens,
    ).map(memory => (input.includeSources ? memory : compactMemory(memory)))
    const primaryTargets = primaryRecallTargets(memories)
    const quality = recallQuality(memories)
    return {
        brief: recallBrief({
            graphCount: input.graph.length,
            historyCount: input.history.length,
            memories,
            primaryTargets,
            quality,
        }),
        focus: input.focus,
        graph: input.includeSources ? input.graph : input.graph.slice(0, 6),
        history: input.includeSources
            ? input.history
            : input.history.slice(0, 4),
        memories,
        primaryTargets,
        quality,
        sourceCount: dedupedMemories.length,
    }
}

function needsHistory(task: string): boolean {
    return /\b(history|historical|previous|prior|old|before|changed|why|superseded|invalidated|replaced|migration|attempt|rollback|decision)\b/iu.test(
        task,
    )
}

function applyTokenBudget(
    memories: MemorySearchResult[],
    outputBudgetTokens: number,
): MemorySearchResult[] {
    const selected: MemorySearchResult[] = []
    let usedTokens = 0

    for (const memory of memories) {
        const tokenCost =
            (memory.metadata?.tokenCost as number) ?? memory.excerpt.length / 4
        if (
            selected.length > 0 &&
            usedTokens + tokenCost > outputBudgetTokens
        ) {
            continue
        }

        selected.push(memory)
        usedTokens += tokenCost
    }

    return selected
}

function dedupeRecallMemories(
    memories: MemorySearchResult[],
): MemorySearchResult[] {
    const deduped: MemorySearchResult[] = []
    const seen = new Set<string>()
    for (const memory of memories) {
        const key = [
            memory.type,
            memory.path ?? '',
            memory.id,
            memory.excerpt.slice(0, 120),
        ].join('\0')
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        deduped.push(memory)
    }
    return deduped
}

function recallQuality(
    memories: MemorySearchResult[],
): RecallPackage['quality'] {
    if (memories.length === 0) {
        return 'weak'
    }
    const topScore = memories[0]?.score ?? 0
    const distinctTargets = new Set(
        memories.map(memory => memory.path ?? memory.id),
    ).size
    if (topScore >= 200 && distinctTargets >= 2) {
        return 'strong'
    }
    if (topScore >= 80) {
        return 'partial'
    }
    return 'weak'
}

function compactMemory(memory: MemorySearchResult): MemorySearchResult {
    return {
        createdAt: memory.createdAt,
        excerpt: memory.excerpt,
        id: memory.id,
        kind: memory.kind,
        path: memory.path,
        score: memory.score,
        type: memory.type,
    }
}

function primaryRecallTargets(memories: MemorySearchResult[]): string[] {
    const targets: string[] = []
    const seen = new Set<string>()
    const ordered = [...memories].sort((a, b) => b.score - a.score)
    for (const memory of ordered) {
        const target = memory.path ?? memory.id
        if (!target || seen.has(target)) {
            continue
        }
        seen.add(target)
        targets.push(target)
        if (targets.length >= 5) {
            break
        }
    }
    return targets
}

function recallBrief(input: {
    graphCount: number
    historyCount: number
    memories: MemorySearchResult[]
    primaryTargets: string[]
    quality: RecallPackage['quality']
}): string[] {
    const lines: string[] = []
    lines.push(`Quality: ${input.quality}.`)
    if (input.primaryTargets.length > 0) {
        lines.push(
            `Inspect first: ${input.primaryTargets.slice(0, 3).join(', ')}`,
        )
    }
    const typeCounts = countBy(input.memories, memory => memory.type)
    const evidence = Object.entries(typeCounts)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ')
    lines.push(evidence ? `Evidence: ${evidence}.` : 'Evidence: none found.')
    if (input.graphCount > 0 || input.historyCount > 0) {
        lines.push(
            `Relations: ${input.graphCount} active, ${input.historyCount} historical.`,
        )
    }
    return lines.slice(0, 4)
}

function countBy<T>(
    items: T[],
    keyFor: (item: T) => string,
): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const item of items) {
        const key = keyFor(item)
        counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
}
