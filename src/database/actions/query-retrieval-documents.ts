import { sql } from 'drizzle-orm'
import {
    retrievalDocuments,
    retrievalDocumentsFts,
    sections,
    targetEmbeddings,
} from '@/database/schema'
import contentHash from '@/support/content-hash'
import getDb from './_db'

export type RetrievalDocumentRow = {
    anchor: string | null
    embedding_hash: string
    embedding_text: string
    embedding_dimensions: number | null
    embedding_model: string | null
    path: string | null
    rank: number
    source_id: string | null
    source_role: string | null
    section_kind: string | null
    target_id: string
    target_embedding_hash: string | null
    target_type: 'section' | 'diary' | 'memory' | 'module'
    summary: string | null
    fts_text: string
    updated_at: string
    token_count: number | null
    vector_score?: number
    vector_blob: Uint8Array | null
}

export type RetrievalDocumentTarget = {
    embeddingHash: string
    model: string
    targetId: string
    targetType: 'section' | 'diary' | 'memory' | 'module'
    vectorScore?: number
}

type RetrievalDocumentTargetRow = RetrievalDocumentRow & {
    embedding_text: string
}

export default async function queryRetrievalDocuments(
    model: string,
    dimensions: number,
    ftsQuery: string,
    limit: number,
): Promise<RetrievalDocumentRow[]> {
    const db = await getDb()
    return db
        .select({
            anchor: retrievalDocuments.anchor,
            embedding_dimensions: targetEmbeddings.dimensions,
            embedding_hash: retrievalDocuments.embeddingHash,
            embedding_model: targetEmbeddings.model,
            embedding_text: retrievalDocuments.embeddingText,
            fts_text: retrievalDocuments.ftsText,
            path: retrievalDocuments.path,
            rank: sql<number>`bm25(retrieval_documents_fts)`,
            section_kind: sections.kind,
            source_id: retrievalDocuments.sourceId,
            source_role: retrievalDocuments.sourceRole,
            summary: retrievalDocuments.summary,
            target_embedding_hash: targetEmbeddings.embeddingHash,
            target_id: retrievalDocuments.targetId,
            target_type: retrievalDocuments.targetType,
            token_count: sections.tokenCount,
            updated_at: retrievalDocuments.updatedAt,
            vector_blob: targetEmbeddings.vectorBlob,
        })
        .from(retrievalDocumentsFts)
        .innerJoin(
            retrievalDocuments,
            sql`
                ${retrievalDocuments.targetId} = ${retrievalDocumentsFts.targetId}
                and ${retrievalDocuments.targetType} = ${retrievalDocumentsFts.targetType}
            `,
        )
        .leftJoin(
            sections,
            sql`
                ${sections.id} = ${retrievalDocuments.targetId}
                and ${retrievalDocuments.targetType} = 'section'
            `,
        )
        .leftJoin(
            targetEmbeddings,
            sql`
                ${targetEmbeddings.targetId} = ${retrievalDocuments.targetId}
                and ${targetEmbeddings.targetType} = ${retrievalDocuments.targetType}
                and ${targetEmbeddings.model} = ${model}
                and ${targetEmbeddings.dimensions} = ${dimensions}
            `,
        )
        .where(sql`
            ${retrievalDocuments.targetType} in ('section', 'module', 'memory', 'diary')
            and retrieval_documents_fts match ${ftsQuery}
            and not exists (
                select 1 from sections dc
                where dc.id = ${retrievalDocuments.targetId}
                  and ${retrievalDocuments.targetType} = 'section'
                  and (dc.deleted_at is not null or dc.suppressed_at is not null)
            )
            and not exists (
                select 1 from observations mo
                where mo.id = ${retrievalDocuments.targetId}
                  and ${retrievalDocuments.targetType} = 'memory'
                  and (mo.deleted_at is not null or mo.suppressed_at is not null)
            )
            and not exists (
                select 1 from diary_entries dd
                where dd.id = ${retrievalDocuments.targetId}
                  and ${retrievalDocuments.targetType} = 'diary'
                  and (dd.deleted_at is not null or dd.suppressed_at is not null)
            )
        `)
        .orderBy(sql`rank`)
        .limit(limit)
}

export async function queryRetrievalDocumentsByTargets(
    targets: RetrievalDocumentTarget[],
): Promise<RetrievalDocumentRow[]> {
    if (targets.length === 0) {
        return []
    }

    const db = await getDb()
    const conditions = sql.join(
        targets.map(
            target =>
                sql`(${retrievalDocuments.targetId} = ${target.targetId} and ${retrievalDocuments.targetType} = ${target.targetType})`,
        ),
        sql` or `,
    )
    const rows = await db
        .select({
            anchor: retrievalDocuments.anchor,
            embedding_dimensions: sql<number | null>`null`,
            embedding_hash: retrievalDocuments.embeddingHash,
            embedding_model: sql<string | null>`null`,
            embedding_text: retrievalDocuments.embeddingText,
            fts_text: retrievalDocuments.ftsText,
            path: retrievalDocuments.path,
            rank: sql<number>`0`,
            section_kind: sections.kind,
            source_id: retrievalDocuments.sourceId,
            source_role: retrievalDocuments.sourceRole,
            summary: retrievalDocuments.summary,
            target_embedding_hash: sql<string | null>`null`,
            target_id: retrievalDocuments.targetId,
            target_type: retrievalDocuments.targetType,
            token_count: sections.tokenCount,
            updated_at: retrievalDocuments.updatedAt,
            vector_blob: sql<Uint8Array | null>`null`,
        })
        .from(retrievalDocuments)
        .leftJoin(
            sections,
            sql`
                ${sections.id} = ${retrievalDocuments.targetId}
                and ${retrievalDocuments.targetType} = 'section'
            `,
        )
        .where(sql`
            (${conditions})
            and not exists (
                select 1 from sections dc
                where dc.id = ${retrievalDocuments.targetId}
                  and ${retrievalDocuments.targetType} = 'section'
                  and (dc.deleted_at is not null or dc.suppressed_at is not null)
            )
            and not exists (
                select 1 from observations mo
                where mo.id = ${retrievalDocuments.targetId}
                  and ${retrievalDocuments.targetType} = 'memory'
                  and (mo.deleted_at is not null or mo.suppressed_at is not null)
            )
            and not exists (
                select 1 from diary_entries dd
                where dd.id = ${retrievalDocuments.targetId}
                  and ${retrievalDocuments.targetType} = 'diary'
                  and (dd.deleted_at is not null or dd.suppressed_at is not null)
            )
        `)

    const targetMetadata = new Map(
        targets.map(target => [
            `${target.targetType}:${target.targetId}`,
            target,
        ]),
    )

    return (rows as RetrievalDocumentTargetRow[])
        .filter(row => {
            const target = targetMetadata.get(
                `${row.target_type}:${row.target_id}`,
            )
            return (
                target &&
                contentHash(`${target.model}:${row.embedding_text}`) ===
                    target.embeddingHash
            )
        })
        .map(row => {
            const target = targetMetadata.get(
                `${row.target_type}:${row.target_id}`,
            )
            return {
                ...row,
                vector_score: target?.vectorScore ?? 0,
            }
        })
}
