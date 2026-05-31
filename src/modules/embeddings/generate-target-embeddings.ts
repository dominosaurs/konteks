import { and, eq, inArray, or, sql } from 'drizzle-orm'
import getDb from '@/database/actions/_db'
import { retrievalDocuments, targetEmbeddings } from '@/database/schema'
import {
    reconcileVectorIndexGroup,
    upsertVectorIndexTargets,
    type VectorIndexTarget,
} from '@/database/services/vector-index'
import { adaptiveBatchSize } from '@/support/adaptive-batch-size'
import contentHash from '@/support/content-hash'
import type { EmbeddingProviderContract } from '@/types/embedding-provider'
import type { ExtractionProgressReporter } from '@/types/progress'

type TargetType = 'section' | 'diary' | 'memory' | 'module'

type RetrievalDocumentRow = {
    target_id: string
    target_type: TargetType
    embedding_text: string
}

type EmbeddingWorkItem = {
    embeddingHash: string
    existingEmbedding?: ExistingEmbeddingRow
    status: 'fresh' | 'needs-embedding' | 'needs-vector-index'
    row: RetrievalDocumentRow
}

type ExistingEmbeddingRow = {
    embedding_hash: string
    target_id: string
    target_type: TargetType
    vector_blob: ArrayBuffer | Uint8Array
    vector_index_dimensions: number | null
    vector_index_hash: string | null
    vector_index_table: string | null
}

type EmbeddingRunResult = {
    embeddedCount: number
    reusedCount: number
}

type EmbeddingRunState = EmbeddingRunResult & {
    prepared: boolean
    processedCount: number
    total: number
}

type RetrievalDocumentCursor = Pick<
    RetrievalDocumentRow,
    'target_id' | 'target_type'
>

const SQLITE_TARGET_LOOKUP_BIND_BATCH_SIZE = 400
const RETRIEVAL_DOCUMENT_ROW_OVERHEAD_BYTES = 4096

export type EmbeddingTarget = {
    targetId: string
    targetType: TargetType
}

export default async function generateTargetEmbeddings(
    provider: EmbeddingProviderContract,
    targetTypes: TargetType[],
    createdAt: string,
    options: {
        onProgress?: ExtractionProgressReporter
    } = {},
): Promise<EmbeddingRunResult> {
    if (targetTypes.length === 0) {
        return { embeddedCount: 0, reusedCount: 0 }
    }

    await reconcileVectorIndexGroup({
        dimensions: provider.dimensions,
        model: provider.model,
    })
    const state = embeddingRunState(
        await countRetrievalDocuments(targetTypes),
        options,
    )
    const batchSize = retrievalDocumentBatchSize(state.total)
    let cursor: RetrievalDocumentCursor | undefined
    while (true) {
        const rows = await loadRetrievalDocumentPage(
            targetTypes,
            cursor,
            batchSize,
        )
        await embedRetrievalDocumentRows(
            provider,
            rows,
            createdAt,
            state,
            options,
        )
        if (rows.length < batchSize) {
            break
        }
        cursor = rows.at(-1)
    }
    return finishEmbeddingRun(state, options)
}

export async function generateEmbeddingsForTargets(
    provider: EmbeddingProviderContract,
    targets: EmbeddingTarget[],
    createdAt: string,
    options: {
        onProgress?: ExtractionProgressReporter
    } = {},
): Promise<EmbeddingRunResult> {
    if (targets.length === 0) {
        return { embeddedCount: 0, reusedCount: 0 }
    }

    const state = embeddingRunState(targets.length, options)
    for (const targetChunk of chunks(
        targets,
        SQLITE_TARGET_LOOKUP_BIND_BATCH_SIZE,
    )) {
        const rows = await loadTargetRetrievalDocuments(targetChunk)
        await embedRetrievalDocumentRows(
            provider,
            rows,
            createdAt,
            state,
            options,
        )
    }
    return finishEmbeddingRun(state, options)
}

export async function generateEmbeddingsForUpdatedTargets(
    provider: EmbeddingProviderContract,
    targetTypes: TargetType[],
    updatedAt: string,
    options: {
        onProgress?: ExtractionProgressReporter
    } = {},
): Promise<EmbeddingRunResult> {
    if (targetTypes.length === 0) {
        return { embeddedCount: 0, reusedCount: 0 }
    }

    const db = await getDb()
    const targets = await db
        .select({
            targetId: retrievalDocuments.targetId,
            targetType: retrievalDocuments.targetType,
        })
        .from(retrievalDocuments)
        .where(
            and(
                eq(retrievalDocuments.updatedAt, updatedAt),
                inArray(retrievalDocuments.targetType, targetTypes),
            ),
        )
    return await generateEmbeddingsForTargets(
        provider,
        targets,
        updatedAt,
        options,
    )
}

async function embedRetrievalDocumentRows(
    provider: EmbeddingProviderContract,
    rows: RetrievalDocumentRow[],
    createdAt: string,
    state: EmbeddingRunState,
    options: {
        onProgress?: ExtractionProgressReporter
    } = {},
): Promise<void> {
    const db = await getDb()
    const workItems: EmbeddingWorkItem[] = []
    const vectorIndexTargets: VectorIndexTarget[] = []
    const existingHashes = await loadExistingEmbeddingHashes(provider, rows)

    for (const row of rows) {
        const embeddingHash = contentHash(
            `${provider.model}:${row.embedding_text}`,
        )

        workItems.push({
            embeddingHash,
            existingEmbedding: existingHashes.get(
                targetKey(row.target_type, row.target_id),
            ),
            row,
            status: workItemStatus(
                existingHashes.get(targetKey(row.target_type, row.target_id)),
                embeddingHash,
                provider.dimensions,
            ),
        })
    }

    if (
        !state.prepared &&
        workItems.some(item => item.status === 'needs-embedding')
    ) {
        await provider.prepare?.()
        state.prepared = true
    }

    for (const item of workItems) {
        const { embeddingHash, row } = item
        state.processedCount += 1

        if (item.status === 'fresh') {
            state.reusedCount += 1
            options.onProgress?.({
                current: state.processedCount,
                embeddedCount: state.embeddedCount,
                message: `Reused embedding for ${row.target_type}:${row.target_id}`,
                phase: 'embeddings',
                reusedCount: state.reusedCount,
                stage: 'embed',
                status: 'progress',
                total: state.total,
            })
            continue
        }

        if (item.status === 'needs-vector-index' && item.existingEmbedding) {
            const vector = blobToFloat32Array(
                item.existingEmbedding.vector_blob,
            )
            vectorIndexTargets.push({
                createdAt,
                dimensions: provider.dimensions,
                embeddingHash,
                model: provider.model,
                targetId: row.target_id,
                targetType: row.target_type,
                vector,
            })
            state.reusedCount += 1
            options.onProgress?.({
                current: state.processedCount,
                embeddedCount: state.embeddedCount,
                message: `Repaired vector index for ${row.target_type}:${row.target_id}`,
                phase: 'embeddings',
                reusedCount: state.reusedCount,
                stage: 'embed',
                status: 'progress',
                total: state.total,
            })
            continue
        }

        options.onProgress?.({
            current: state.processedCount,
            embeddedCount: state.embeddedCount,
            message: `Embedding ${row.target_type}:${row.target_id}`,
            phase: 'embeddings',
            reusedCount: state.reusedCount,
            stage: 'embed',
            status: 'progress',
            total: state.total,
        })
        const vectors = await provider.embed([row.embedding_text])
        const vector = vectors[0]
        if (!vector) {
            throw new Error(
                `Embedding provider returned no vector for ${row.target_type}:${row.target_id}.`,
            )
        }
        if (vector.length !== provider.dimensions) {
            throw new Error(
                `Embedding dimensions mismatch for ${row.target_type}:${row.target_id}. Expected ${provider.dimensions}, got ${vector.length}.`,
            )
        }

        await db
            .insert(targetEmbeddings)
            .values({
                createdAt,
                dimensions: provider.dimensions,
                dtype: 'float32',
                embeddingHash,
                model: provider.model,
                normalized: 1,
                targetId: row.target_id,
                targetType: row.target_type,
                vectorBlob: toBlob(vector),
            })
            .onConflictDoUpdate({
                set: {
                    createdAt,
                    dimensions: provider.dimensions,
                    dtype: 'float32',
                    embeddingHash,
                    normalized: 1,
                    vectorBlob: toBlob(vector),
                },
                target: [
                    targetEmbeddings.targetId,
                    targetEmbeddings.targetType,
                    targetEmbeddings.model,
                ],
            })
        vectorIndexTargets.push({
            createdAt,
            dimensions: provider.dimensions,
            embeddingHash,
            model: provider.model,
            targetId: row.target_id,
            targetType: row.target_type,
            vector,
        })
        state.embeddedCount += 1
        options.onProgress?.({
            current: state.processedCount,
            embeddedCount: state.embeddedCount,
            message: `Embedded ${row.target_type}:${row.target_id}`,
            phase: 'embeddings',
            reusedCount: state.reusedCount,
            stage: 'embed',
            status: 'progress',
            total: state.total,
        })
    }

    await upsertVectorIndexTargets(vectorIndexTargets)
}

function embeddingRunState(
    total: number,
    options: {
        onProgress?: ExtractionProgressReporter
    },
): EmbeddingRunState {
    options.onProgress?.({
        current: 0,
        message: `Embedding ${total} retrieval documents`,
        phase: 'embeddings',
        stage: 'embed',
        status: 'start',
        total,
    })
    return {
        embeddedCount: 0,
        prepared: false,
        processedCount: 0,
        reusedCount: 0,
        total,
    }
}

function finishEmbeddingRun(
    state: EmbeddingRunState,
    options: {
        onProgress?: ExtractionProgressReporter
    },
): EmbeddingRunResult {
    options.onProgress?.({
        embeddedCount: state.embeddedCount,
        message: `Index ready: ${state.embeddedCount} indexed, ${state.reusedCount} unchanged`,
        phase: 'embeddings',
        reusedCount: state.reusedCount,
        stage: 'embed',
        status: 'done',
        total: state.total,
    })

    return {
        embeddedCount: state.embeddedCount,
        reusedCount: state.reusedCount,
    }
}

async function countRetrievalDocuments(
    targetTypes: TargetType[],
): Promise<number> {
    const db = await getDb()
    const row = await db.get<{ count: bigint | number }>(sql`
select count(*) as count
from retrieval_documents
where target_type in (${sql.join(
        targetTypes.map(type => sql`${type}`),
        sql`, `,
    )})
`)
    return Number(row?.count ?? 0)
}

async function loadRetrievalDocumentPage(
    targetTypes: TargetType[],
    cursor: RetrievalDocumentCursor | undefined,
    limit: number,
): Promise<RetrievalDocumentRow[]> {
    const db = await getDb()
    return await db.all<RetrievalDocumentRow>(sql`
select
    embedding_text,
    target_id,
    target_type
from retrieval_documents
where target_type in (${sql.join(
        targetTypes.map(type => sql`${type}`),
        sql`, `,
    )})
  ${retrievalDocumentCursor(cursor)}
order by target_type, target_id
limit ${limit}
`)
}

async function loadTargetRetrievalDocuments(
    targets: EmbeddingTarget[],
): Promise<RetrievalDocumentRow[]> {
    const db = await getDb()
    const clauses = targets.map(target =>
        and(
            eq(retrievalDocuments.targetId, target.targetId),
            eq(retrievalDocuments.targetType, target.targetType),
        ),
    )
    return await db
        .select({
            embedding_text: retrievalDocuments.embeddingText,
            target_id: retrievalDocuments.targetId,
            target_type: retrievalDocuments.targetType,
        })
        .from(retrievalDocuments)
        .where(or(...clauses))
}

async function loadExistingEmbeddingHashes(
    provider: EmbeddingProviderContract,
    rows: RetrievalDocumentRow[],
): Promise<Map<string, ExistingEmbeddingRow>> {
    if (rows.length === 0) {
        return new Map()
    }

    const db = await getDb()
    const hashes = new Map<string, ExistingEmbeddingRow>()
    for (const rowChunk of chunks(rows, SQLITE_TARGET_LOOKUP_BIND_BATCH_SIZE)) {
        const existingRows = await db.all<ExistingEmbeddingRow>(sql`
select
    te.embedding_hash,
    te.target_id,
    te.target_type,
    te.vector_blob,
    vie.dimensions as vector_index_dimensions,
    vie.embedding_hash as vector_index_hash,
    vie.index_table as vector_index_table
from target_embeddings te
left join vector_index_entries vie
  on vie.target_id = te.target_id
 and vie.target_type = te.target_type
 and vie.model = te.model
where te.model = ${provider.model}
  and te.dimensions = ${provider.dimensions}
  and (${sql.join(
      rowChunk.map(
          row =>
              sql`(te.target_id = ${row.target_id} and te.target_type = ${row.target_type})`,
      ),
      sql` or `,
  )})
`)
        for (const row of existingRows) {
            const key = targetKey(row.target_type, row.target_id)
            hashes.set(key, row)
        }
    }
    return hashes
}

function chunks<T>(items: T[], size: number): T[][] {
    const result: T[][] = []
    for (let index = 0; index < items.length; index += size) {
        result.push(items.slice(index, index + size))
    }
    return result
}

function retrievalDocumentBatchSize(total: number): number {
    return (
        adaptiveBatchSize({
            estimatedItemBytes: RETRIEVAL_DOCUMENT_ROW_OVERHEAD_BYTES,
            totalItems: total,
        }) || 500
    )
}

function retrievalDocumentCursor(cursor: RetrievalDocumentCursor | undefined) {
    return cursor
        ? sql`and (
                target_type > ${cursor.target_type}
                or (
                    target_type = ${cursor.target_type}
                    and target_id > ${cursor.target_id}
                )
            )`
        : sql``
}

function workItemStatus(
    existing: ExistingEmbeddingRow | undefined,
    embeddingHash: string,
    dimensions: number,
): EmbeddingWorkItem['status'] {
    if (!existing || existing.embedding_hash !== embeddingHash) {
        return 'needs-embedding'
    }
    if (blobDimensions(existing.vector_blob) !== dimensions) {
        return 'needs-embedding'
    }
    if (
        existing.vector_index_hash !== embeddingHash ||
        existing.vector_index_dimensions !== dimensions ||
        existing.vector_index_table !== `vector_index_${dimensions}`
    ) {
        return 'needs-vector-index'
    }
    return 'fresh'
}

function targetKey(targetType: TargetType, targetId: string): string {
    return `${targetType}:${targetId}`
}

function toBlob(vector: Float32Array): Uint8Array {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function blobToFloat32Array(blob: ArrayBuffer | Uint8Array): Float32Array {
    if (blob instanceof ArrayBuffer) {
        return new Float32Array(blob.slice(0))
    }

    const buffer = blob.buffer.slice(
        blob.byteOffset,
        blob.byteOffset + blob.byteLength,
    )
    return new Float32Array(buffer)
}

function blobDimensions(blob: ArrayBuffer | Uint8Array): number {
    return blob.byteLength / Float32Array.BYTES_PER_ELEMENT
}
