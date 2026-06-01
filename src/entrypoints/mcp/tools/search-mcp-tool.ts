import z from 'zod'
import searchMemory from '@/database/services/search-memory'
import sharedEmbeddingProvider from '@/modules/embeddings/shared-embedding-provider'
import type { MemorySearchResult } from '@/types/memory'
import BaseMcpTool from './_base-mcp-tool'

const INPUT_SCHEMA = z.object({
    limit: z.number().int().min(1).max(50).optional(),
    query: z
        .string()
        .trim()
        .min(1, 'query is required')
        .describe('Direct natural-language or keyword search query.'),
})

type Input = z.output<typeof INPUT_SCHEMA>

export default class SearchMcpTool extends BaseMcpTool<Input> {
    public readonly annotations = {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
    }

    public readonly description =
        'Search stored memory directly and return matching records with IDs, sources, scores, and excerpts.'

    public readonly inputSchema = INPUT_SCHEMA

    public readonly name = 'konteks_search'

    public async handle(input: Input): Promise<object> {
        const results = await searchMemory(input, {
            embeddingProvider: sharedEmbeddingProvider(),
        })

        return toSearchOutput({
            limit: input.limit ?? 10,
            query: input.query,
            results,
        })
    }
}

function toSearchOutput(input: {
    query: string
    limit: number
    results: MemorySearchResult[]
}): object {
    return {
        limit: input.limit,
        query: input.query,
        results: input.results.slice(0, input.limit).map(toSearchResultOutput),
    }
}

function toSearchResultOutput(item: MemorySearchResult): object {
    return {
        excerpt: normalizeExcerpt(item.excerpt),
        id: item.id,
        kind: item.kind,
        role: item.sourceRole ?? item.kind,
        score: item.score,
        sourceId: item.sourceId,
        target: targetFor(item),
        type: item.type,
    }
}

function targetFor(item: {
    anchor?: string
    id: string
    path?: string
}): string {
    const target = item.path ?? item.id
    return item.anchor ? `${target}#${item.anchor}` : target
}

function normalizeExcerpt(excerpt: string): string {
    return excerpt.replaceAll(/\s+/gu, ' ').trim()
}
