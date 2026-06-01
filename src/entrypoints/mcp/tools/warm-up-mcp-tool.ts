import z from 'zod'
import readWarmUpContext from '@/database/services/read-warm-up-context'
import sharedEmbeddingProvider from '@/modules/embeddings/shared-embedding-provider'
import recallRepositoryMemory from '@/modules/memory/recall-repository-memory'
import {
    loadMcpProjectContext,
    updateChangedProjectMemorySilently,
} from '@/modules/memory/runtime'
import { estimateCharacterTokens } from '@/support/format/tokens'
import type {
    MemorySearchResult,
    RecallPackage,
    WarmUpContext,
    WarmUpGuidance,
    WarmUpHighlight,
} from '@/types/memory'
import BaseMcpTool from './_base-mcp-tool'

const INPUT_ZOD_SCHEMA = z.object({
    focus: z
        .array(z.string().trim().min(1))
        .optional()
        .describe('Short natural-language focus statements for retrieval.'),
})

type Input = z.output<typeof INPUT_ZOD_SCHEMA>

export default class WarmUpMcpTool extends BaseMcpTool<Input> {
    public readonly annotations = {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    }

    public readonly description =
        'Load the stable project-wide briefing for the current repo.'

    public readonly inputSchema = INPUT_ZOD_SCHEMA

    public readonly name = 'konteks_warm_up'

    public async handle(input: Input): Promise<object> {
        const context = await loadMcpProjectContext()
        const embeddingProvider = sharedEmbeddingProvider()
        await updateChangedProjectMemorySilently(context, embeddingProvider)

        const rawWarmUp = await readWarmUpContext(context)
        const warmUp = limitWarmUpContext(rawWarmUp, 2000)

        let recall: RecallPackage | undefined
        if (input.focus && input.focus.length > 0) {
            recall = await recallRepositoryMemory(
                {
                    focus: input.focus,
                },
                {
                    embeddingProvider,
                },
            )
        }

        return toWarmUpOutput({ recall, warmUp })
    }
}

function toWarmUpOutput(input: {
    warmUp: WarmUpContext
    recall?: RecallPackage
}): object {
    const { warmUp, recall } = input
    return {
        description: warmUp.description,
        entryPoints: warmUp.entryPoints,
        guidance: warmUp.guidance.map(toGuidanceOutput),
        highlights: warmUp.highlights.map(toWarmUpHighlightOutput),
        recall: recall ? toFocusedRecallOutput(recall) : undefined,
        technologies: warmUp.technologies,
    }
}

function toWarmUpHighlightOutput(item: WarmUpHighlight): object {
    return {
        excerpt: normalizeExcerpt(item.excerpt),
        role: item.sourceRole,
        score: item.score,
        target: targetFor(item),
        type: item.type,
    }
}

function toGuidanceOutput(item: WarmUpGuidance): object {
    return {
        kind: item.kind,
        text: item.text,
    }
}

function toFocusedRecallOutput(recall: RecallPackage): object {
    return {
        brief: recall.brief,
        evidenceCounts: {
            memories: recall.memories.length,
            sources: recall.sourceCount,
        },
        focus: recall.focus,
        memories: recall.memories.slice(0, 6).map(memory =>
            toMemoryOutput(memory, {
                includeSources: false,
            }),
        ),
        primaryTargets: recall.primaryTargets,
        quality: recall.quality,
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

function limitWarmUpContext(
    context: WarmUpContext,
    contextBudgetTokens: number,
): WarmUpContext {
    const budget = Math.max(80, contextBudgetTokens)
    const baseCost = estimateCharacterTokens([
        context.description ?? '',
        ...context.technologies,
        ...context.entryPoints,
    ])
    let remaining = Math.max(0, budget - baseCost)

    const take = (items: string[], fallbackLimit: number): string[] => {
        const kept: string[] = []
        for (const item of items.slice(0, fallbackLimit)) {
            const cost = estimateCharacterTokens([item])
            if (kept.length > 0 && cost > remaining) {
                break
            }
            kept.push(item)
            remaining -= cost
        }
        return kept
    }

    return {
        ...context,
        architecture: take(context.architecture, 12),
        guidance: context.guidance.slice(0, 8),
        highlights: context.highlights.slice(0, 12),
        keyFiles: take(context.keyFiles, 12),
    }
}
