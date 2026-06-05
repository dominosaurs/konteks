import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import getDb from '@/database/actions/_db'
import appendMemoryEvent from '@/database/actions/append-memory-event'
import deleteRetrievalDocuments from '@/database/actions/delete-retrieval-documents'
import hardDeleteForgetTarget from '@/database/actions/hard-delete-forget-target'
import invalidateRelation from '@/database/actions/invalidate-relation'
import markForgotten from '@/database/actions/mark-forgotten'
import markSuppressed from '@/database/actions/mark-suppressed'
import queryDiaries from '@/database/actions/query-diaries'
import queryObservations from '@/database/actions/query-observations'
import removeFromSearchIndex from '@/database/actions/remove-from-search-index'
import { targetEmbeddings } from '@/database/schema'
import { deleteDurableTargetGraph } from '@/database/services/durable-memory-graph'
import type { ForgetTarget, TargetKind } from '@/database/support/forget-target'

type RetrievalTargetType = 'diary' | 'memory' | 'section'

export type ForgetInput = {
    id?: string
    query?: string
    mode?: 'hard_delete' | 'invalidate' | 'soft_delete'
    reason?: string
}

type ForgetResult = {
    accepted: boolean
    mode: NonNullable<ForgetInput['mode']>
    affectedIds: string[]
}

export default async function forgetMemory(
    input: ForgetInput,
): Promise<ForgetResult> {
    const mode = input.mode ?? 'soft_delete'
    const targets = await resolveTargets(input)
    const affectedIds: string[] = []

    for (const target of targets) {
        const changed = await applyForget(target, mode, input.reason)
        if (!changed) {
            continue
        }

        await removeFromSearchIndex(target.id)
        if (mode === 'hard_delete') {
            await deleteHardDeletedRetrievalArtifacts(target)
        }
        if (target.kind === 'observation' || target.kind === 'diary_entry') {
            await deleteDurableTargetGraph(target.id)
        }

        await appendMemoryEvent({
            actor: 'mcp',
            eventType: `memory_${mode}`,
            id: `event_${randomUUID()}`,
            subjectId: target.id,
            subjectType: target.kind,
            summary: input.reason ?? `Applied ${mode} to ${target.id}.`,
        })
        affectedIds.push(target.id)
    }

    return {
        accepted: affectedIds.length > 0,
        affectedIds,
        mode,
    }
}

async function resolveTargets(input: ForgetInput): Promise<ForgetTarget[]> {
    if (input.id) {
        return [{ id: input.id, kind: inferKind(input.id) }]
    }

    if (!input.query) {
        return []
    }

    const terms = tokenize(input.query)
    if (terms.length === 0) {
        return []
    }

    const [observations, diaries] = await Promise.all([
        queryObservations(terms, 10),
        queryDiaries(terms, 10),
    ])

    return [
        ...observations.map(row => ({
            id: row.id,
            kind: 'observation' as const,
        })),
        ...diaries.map(row => ({
            id: row.id,
            kind: 'diary_entry' as const,
        })),
    ].slice(0, 10)
}

async function applyForget(
    target: ForgetTarget,
    mode: NonNullable<ForgetInput['mode']>,
    reason: string | undefined,
): Promise<boolean> {
    if (target.kind === 'relation') {
        await invalidateRelation(target.id)
        return true
    }

    if (mode === 'invalidate') {
        return markSuppressed(target, reason)
    }

    if (mode === 'hard_delete') {
        return hardDeleteForgetTarget(target)
    }

    return markForgotten(target, reason)
}

async function deleteHardDeletedRetrievalArtifacts(
    target: ForgetTarget,
): Promise<void> {
    const targetType = retrievalTargetType(target.kind)
    if (!targetType) {
        return
    }

    await deleteRetrievalDocuments(targetType, [target.id])
    await deleteTargetEmbeddings(targetType, target.id)
}

async function deleteTargetEmbeddings(
    targetType: RetrievalTargetType,
    targetId: string,
): Promise<void> {
    const db = await getDb()
    await db
        .delete(targetEmbeddings)
        .where(
            and(
                eq(targetEmbeddings.targetType, targetType),
                eq(targetEmbeddings.targetId, targetId),
            ),
        )
}

function retrievalTargetType(
    targetKind: TargetKind,
): RetrievalTargetType | undefined {
    if (targetKind === 'diary_entry') {
        return 'diary'
    }
    if (targetKind === 'observation') {
        return 'memory'
    }
    if (targetKind === 'section') {
        return 'section'
    }
    return undefined
}

function inferKind(id: string): TargetKind {
    if (id.startsWith('section_')) {
        return 'section'
    }
    if (id.startsWith('diary_')) {
        return 'diary_entry'
    }
    if (id.startsWith('rel_')) {
        return 'relation'
    }

    return 'observation'
}

function tokenize(query: string): string[] {
    return [
        ...new Set(
            query
                .toLowerCase()
                .split(/[^a-z0-9_/-]+/u)
                .map(term => term.trim())
                .filter(term => term.length >= 2),
        ),
    ].slice(0, 8)
}
