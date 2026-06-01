import type { MemorySearchResult } from '@/types/memory'

export type SearchMode = 'recall' | 'search'

export type SearchIntent = {
    allowsDiary: boolean
    conceptualTask: boolean
    implementationTask: boolean
    prefersAgentReference: boolean
}

export function tokenize(query: string): string[] {
    return [
        ...new Set(
            query
                .toLowerCase()
                .split(/[^a-z0-9_./-]+/u)
                .map(term => term.trim())
                .filter(term => term.length >= 2),
        ),
    ].slice(0, 12)
}

export function toFtsQuery(terms: string[]): string | undefined {
    const ftsTerms = terms
        .map(term => term.replaceAll(/[^a-z0-9_]/gu, ''))
        .filter(Boolean)
        .map(term => `"${term}"`)

    return ftsTerms.length > 0 ? ftsTerms.join(' OR ') : undefined
}

export function compareSearchResults(
    left: MemorySearchResult,
    right: MemorySearchResult,
): number {
    if (right.score !== left.score) {
        return right.score - left.score
    }

    return right.createdAt.localeCompare(left.createdAt)
}

export function detectIntent(query: string): SearchIntent {
    const normalized = query.toLowerCase()
    return {
        allowsDiary:
            /\b(continue|resume|history|previous|last time|already tried|debug|blocked|why failed|follow up)\b/iu.test(
                normalized,
            ),
        conceptualTask:
            /\b(why|how|behavior|behaviour|convention|policy|rationale|usage|docs?|comment|comments|plan|explain|overview|architecture|guidance)\b/iu.test(
                normalized,
            ),
        implementationTask:
            /\b(add|build|change|fix|implement|improve|patch|refactor|test|update)\b/iu.test(
                normalized,
            ),
        prefersAgentReference:
            /\b(agent|skill|prompt|mcp|reference|docs?)\b/iu.test(normalized),
    }
}

export function allowResult(
    result: MemorySearchResult,
    mode: SearchMode,
    intent: SearchIntent,
): boolean {
    if (mode === 'search') {
        return true
    }
    if (result.type === 'diary' && !intent.allowsDiary) {
        return false
    }
    return true
}

export function applyRolePolicy(
    result: MemorySearchResult,
    mode: SearchMode,
    intent: SearchIntent,
): MemorySearchResult {
    const role = result.sourceRole ?? result.kind
    const proseKind = result.metadata?.proseKind
    const isProseSection = result.metadata?.contentType === 'prose'
    let scoreDelta = 0
    if (mode === 'recall') {
        if (
            role === 'agent_reference' ||
            role === 'generated' ||
            role === 'agent_config'
        ) {
            scoreDelta += intent.prefersAgentReference ? 20 : -60
        }
        if (
            role === 'app_code' ||
            role === 'test_code' ||
            role === 'package_config'
        ) {
            scoreDelta += 15
        }
        if (role === 'product_doc') {
            scoreDelta +=
                intent.implementationTask && !intent.conceptualTask ? -10 : 10
        }
        if (role === 'implementation_plan') {
            scoreDelta += intent.conceptualTask ? 20 : 0
        }
        if (isProseSection) {
            scoreDelta += intent.conceptualTask
                ? 30
                : intent.implementationTask
                  ? -45
                  : 0
        }
        if (proseKind === 'comment') {
            scoreDelta += intent.conceptualTask ? 15 : -5
        }
        if (intent.implementationTask && result.path?.startsWith('src/')) {
            scoreDelta += 25
        }
        if (intent.implementationTask && result.path?.endsWith('.test.ts')) {
            scoreDelta += 10
        }
    }

    if (scoreDelta === 0) {
        return result
    }
    return {
        ...result,
        score: result.score + scoreDelta,
    }
}

export function applyGroupAwarePruning(
    results: MemorySearchResult[],
    mode: SearchMode,
    limit: number,
): MemorySearchResult[] {
    const maxPerType = mode === 'recall' ? 4 : 6
    const perType = new Map<string, number>()
    const selected: MemorySearchResult[] = []
    const sorted = [...results].sort(compareSearchResults)

    for (const item of sorted) {
        const key = item.type
        const count = perType.get(key) ?? 0
        if (count >= maxPerType) {
            continue
        }
        selected.push(item)
        perType.set(key, count + 1)
        if (selected.length >= limit * 2) {
            break
        }
    }

    return selected
}
