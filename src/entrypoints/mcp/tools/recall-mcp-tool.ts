import z from 'zod'
import sharedEmbeddingProvider from '@/modules/embeddings/shared-embedding-provider'
import recallRepositoryMemory from '@/modules/memory/recall-repository-memory'
import type {
    MemorySearchResult,
    RecallGraphItem,
    RecallHistoryItem,
    RecallPackage,
} from '@/types/memory'
import BaseMcpTool from './_base-mcp-tool'

const INPUT_SCHEMA = z.object({
    focus: z
        .array(z.string().trim().min(1))
        .min(1, 'focus is required')
        .describe('Short natural-language focus statements for retrieval.'),
    includeSources: z.boolean().optional(),
})

type Input = z.output<typeof INPUT_SCHEMA>

export default class RecallMcpTool extends BaseMcpTool<Input> {
    public readonly annotations = {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
    }

    public readonly description =
        'Recall compact, task-relevant project context before answering or working.'

    public readonly inputSchema = INPUT_SCHEMA

    public readonly name = 'konteks_recall'

    public async handle(input: Input): Promise<object> {
        const result = await recallRepositoryMemory(input, {
            embeddingProvider: sharedEmbeddingProvider(),
        })

        return toRecallOutput({
            includeSources: input.includeSources ?? false,
            recall: result,
        })
    }
}

function toRecallOutput(input: {
    recall: RecallPackage
    includeSources?: boolean
}): object {
    const { recall, includeSources } = input
    return {
        brief: recall.brief,
        evidenceCounts: {
            graph: recall.graph.length,
            history: recall.history.length,
            memories: recall.memories.length,
        },
        focus: recall.focus,
        graphEvidence: recall.graph.slice(0, 6).map(toGraphEvidenceOutput),
        historyEvidence: recall.history
            .slice(0, 6)
            .map(toHistoryEvidenceOutput),
        memories: recall.memories.slice(0, 8).map(memory =>
            toMemoryOutput(memory, {
                includeSources: includeSources ?? false,
            }),
        ),
        primaryTargets: recall.primaryTargets,
    }
}

function toGraphEvidenceOutput(item: RecallGraphItem): object {
    return {
        depth: item.depth,
        entityName: item.entityName,
        predicate: item.predicate,
        relatedEntityName: item.relatedEntityName,
    }
}

function toHistoryEvidenceOutput(item: RecallHistoryItem): object {
    return {
        objectEntityName: item.objectEntityName,
        predicate: item.predicate,
        status: item.status,
        subjectEntityName: item.subjectEntityName,
    }
}

function toMemoryOutput(
    item: MemorySearchResult,
    options: { includeSources: boolean },
): object {
    return {
        excerpt: normalizeExcerpt(item.excerpt),
        id: options.includeSources ? item.id : undefined,
        role: item.sourceRole ?? item.kind,
        score: item.score,
        target: targetFor(item),
        tokenCost: options.includeSources ? item.tokenCost : undefined,
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
