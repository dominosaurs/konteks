import { join } from 'node:path'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getLoadablePath } from 'sqlite-vec'
import getDb from '@/database/actions/_db'
import { vectorIndexEntries } from '@/database/schema'
import { isSqliteTestRuntime } from '@/database/support/test-runtime'
import { loadProjectContext } from '@/modules/project/context'
import { appendProjectErrorLog } from '@/support/error-log'

type TargetType = 'section' | 'diary' | 'memory' | 'module'

export type VectorIndexTarget = {
    createdAt: string
    dimensions: number
    embeddingHash: string
    model: string
    targetId: string
    targetType: TargetType
    vector: Float32Array
}

export type VectorSearchResult = {
    distance: number
    embeddingHash: string
    model: string
    targetId: string
    targetType: TargetType
}

type StatementResult = {
    lastInsertRowid: bigint | number
}

type StatementSync = {
    all(...values: unknown[]): unknown[]
    finalize?(): void
    get(...values: unknown[]): unknown
    run(...values: unknown[]): StatementResult
}

type DatabaseSync = {
    close?(): void
    exec(sql: string): void
    loadExtension(path: string): void
    prepare(sql: string): StatementSync
}

type BunSqliteModule = {
    Database: new (path: string, options: { create: boolean }) => DatabaseSync
}

type NodeSqliteModule = {
    DatabaseSync: new (
        path: string,
        options: { allowExtension: boolean },
    ) => DatabaseSync
}

type VectorIndexConnection = {
    database: DatabaseSync
    path: string
}

type VectorIndexConnectionFactory = () => Promise<
    VectorIndexConnection | undefined
>

type VectorEmbeddingRow = {
    embedding_hash: string
    model: string
    target_id: string
    target_type: TargetType
    vector_blob: ArrayBuffer | Uint8Array
}

type VectorIndexGroup = {
    dimensions: number
    model: string
}

type VectorIndexRow = {
    embedding_hash: string
    target_id: string
    target_type: TargetType
}

declare global {
    var __konteksVectorIndexConnectionFactoryForTests:
        | VectorIndexConnectionFactory
        | undefined
    var __konteksWaitForVectorIndexRepairsForTests:
        | (() => Promise<void>)
        | undefined
}

const BUN_SQLITE_MODULE = 'bun:sqlite'
const NODE_SQLITE_MODULE = 'node:sqlite'
const SQLITE_BIND_CHUNK_SIZE = 250
let activeConnection: VectorIndexConnection | undefined
let bunSqlitePromise: Promise<BunSqliteModule | undefined> | undefined
let nodeSqlitePromise: Promise<NodeSqliteModule | undefined> | undefined
const healthyGroups = new Set<string>()
const repairPromises = new Map<string, Promise<void>>()
globalThis.__konteksWaitForVectorIndexRepairsForTests = async () => {
    await Promise.all(repairPromises.values())
}

class VectorIndexDependencyError extends Error {
    public constructor(message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = 'VectorIndexDependencyError'
    }
}

export async function upsertVectorIndexTargets(
    targets: VectorIndexTarget[],
): Promise<boolean> {
    if (targets.length === 0) {
        return true
    }

    const connection = await vectorConnection()
    if (!connection) {
        return false
    }
    await upsertVectorIndexTargetsWithConnection(connection, targets)
    return true
}

async function upsertVectorIndexTargetsWithConnection(
    connection: VectorIndexConnection,
    targets: VectorIndexTarget[],
): Promise<void> {
    for (const [dimensions, groupedTargets] of groupTargetsByDimensions(
        targets,
    )) {
        const vecTable = tableNameForDimensions(dimensions)
        ensureVectorTable(connection.database, vecTable, dimensions)
        const deleteStatement = connection.database.prepare(`
delete from ${vecTable}
where target_id = ?
  and target_type = ?
  and model = ?
`)
        const insertStatement = connection.database.prepare(`
insert into ${vecTable} (
    embedding,
    target_id,
    target_type,
    model,
    embedding_hash
) values (?, ?, ?, ?, ?)
`)
        try {
            for (const targetChunk of chunks(groupedTargets)) {
                withNativeTransaction(connection.database, () => {
                    for (const target of targetChunk) {
                        deleteStatement.run(
                            target.targetId,
                            target.targetType,
                            target.model,
                        )
                        insertStatement.run(
                            vectorToBlob(target.vector),
                            target.targetId,
                            target.targetType,
                            target.model,
                            target.embeddingHash,
                        )
                    }
                })
                await upsertVectorIndexEntries(targetChunk, vecTable)
            }
        } finally {
            deleteStatement.finalize?.()
            insertStatement.finalize?.()
        }
        invalidateVectorIndexGroups(connection.path, groupedTargets)
    }
}

export async function reconcileVectorIndexGroup(input: {
    dimensions: number
    model: string
}): Promise<boolean> {
    const connection = await vectorConnection()
    if (!connection) {
        return false
    }
    if (await validateVectorIndexGroup(connection, input)) {
        return true
    }

    await resetVectorIndexGroup(connection, input)
    return false
}

export async function deleteVectorIndexTargets(
    targetType: TargetType,
    targetIds?: string[],
): Promise<void> {
    if (targetIds && targetIds.length === 0) {
        return
    }

    await deleteVectorIndexEntries(targetType, targetIds)
    const connection = await vectorConnection()
    if (!connection) {
        return
    }

    const tables = vectorTableNames(connection.database)
    withNativeTransaction(connection.database, () => {
        for (const table of tables) {
            deleteNativeVectorTargets(
                connection.database,
                table,
                targetType,
                targetIds,
            )
        }
    })
    invalidateVectorIndexPath(connection.path)
}

export async function searchVectorIndex(input: {
    dimensions: number
    limit: number
    model: string
    vector: Float32Array
}): Promise<VectorSearchResult[]> {
    const connection = await vectorConnection()
    if (!connection) {
        return exactVectorSearch(input)
    }

    if (!(await validateVectorIndexGroup(connection, input))) {
        scheduleVectorIndexRepair(connection, input)
        return await exactVectorSearch(input)
    }

    const vecTable = tableNameForDimensions(input.dimensions)
    if (!hasVectorTable(connection.database, vecTable)) {
        return await exactVectorSearch(input)
    }
    const results = withStatement(
        connection.database,
        `
select
    distance,
    embedding_hash as embeddingHash,
    model,
    target_id as targetId,
    target_type as targetType
from ${vecTable}
where embedding match ?
  and model = ?
  and k = ?
`,
        statement =>
            statement
                .all(vectorToBlob(input.vector), input.model, input.limit)
                .map(toVectorSearchResult),
    )
    return results.length > 0 ? results : await exactVectorSearch(input)
}

async function validateVectorIndexGroup(
    connection: VectorIndexConnection,
    input: VectorIndexGroup,
    options: { force?: boolean } = {},
): Promise<boolean> {
    const key = vectorIndexGroupKey(connection.path, input)
    if (!options.force && healthyGroups.has(key)) {
        return true
    }

    let cursor: Pick<VectorIndexRow, 'target_id' | 'target_type'> | undefined
    const tableName = tableNameForDimensions(input.dimensions)
    while (true) {
        const durableRows = await loadDurableVectorPage(input, cursor)
        const metadataRows = await loadVectorIndexEntryPage(input, cursor)
        if (!hasVectorTable(connection.database, tableName)) {
            if (durableRows.length > 0 || metadataRows.length > 0) {
                return false
            }
            healthyGroups.add(key)
            return true
        }
        const nativeRows = loadNativeVectorPage(
            connection.database,
            tableName,
            input,
            cursor,
        )
        if (
            !sameVectorIndexRows(durableRows, metadataRows) ||
            !sameVectorIndexRows(durableRows, nativeRows)
        ) {
            return false
        }
        if (durableRows.length < SQLITE_BIND_CHUNK_SIZE) {
            healthyGroups.add(key)
            return true
        }
        cursor = durableRows.at(-1)
    }
}

function scheduleVectorIndexRepair(
    connection: VectorIndexConnection,
    input: VectorIndexGroup,
): void {
    const key = vectorIndexGroupKey(connection.path, input)
    if (repairPromises.has(key)) {
        return
    }

    const repair = Promise.resolve()
        .then(() => repairVectorIndexGroup(connection, input))
        .catch(error => {
            void appendProjectErrorLog({
                error,
                metadata: {
                    dimensions: input.dimensions,
                    model: input.model,
                    operation: 'repair_vector_index',
                    vectorDatabase: connection.path,
                },
                surface: 'background_maintenance',
            })
        })
        .finally(() => {
            repairPromises.delete(key)
        })
    repairPromises.set(key, repair)
}

async function repairVectorIndexGroup(
    connection: VectorIndexConnection,
    input: VectorIndexGroup,
): Promise<void> {
    await resetVectorIndexGroup(connection, input)
    let cursor:
        | Pick<VectorEmbeddingRow, 'target_id' | 'target_type'>
        | undefined

    while (true) {
        const rows = await loadDurableVectorPage(input, cursor)
        await upsertVectorIndexTargetsWithConnection(
            connection,
            rows.map(row => ({
                createdAt: new Date().toISOString(),
                dimensions: input.dimensions,
                embeddingHash: row.embedding_hash,
                model: row.model,
                targetId: row.target_id,
                targetType: row.target_type,
                vector: blobToFloat32Array(row.vector_blob),
            })),
        )
        if (rows.length < SQLITE_BIND_CHUNK_SIZE) {
            break
        }
        cursor = rows.at(-1)
    }

    if (
        !(await validateVectorIndexGroup(connection, input, {
            force: true,
        }))
    ) {
        throw new Error(
            `Background sqlite-vec repair did not produce a healthy index for ${input.model} (${input.dimensions} dimensions).`,
        )
    }
}

async function resetVectorIndexGroup(
    connection: VectorIndexConnection,
    input: VectorIndexGroup,
): Promise<void> {
    healthyGroups.delete(vectorIndexGroupKey(connection.path, input))
    const tableName = tableNameForDimensions(input.dimensions)
    if (hasVectorTable(connection.database, tableName)) {
        withNativeTransaction(connection.database, () => {
            withStatement(
                connection.database,
                `delete from ${tableName} where model = ?`,
                statement => statement.run(input.model),
            )
        })
    }
    await deleteVectorIndexEntriesForGroup(input)
}

function ensureVectorTable(
    database: DatabaseSync,
    tableName: string,
    dimensions: number,
): void {
    database.exec(`
create virtual table if not exists ${tableName} using vec0(
    embedding float[${dimensions}],
    target_id text,
    target_type text,
    model text,
    embedding_hash text
);
`)
}

function hasVectorTable(database: DatabaseSync, tableName: string): boolean {
    const row = withStatement(
        database,
        `
select name
from sqlite_master
where type = 'table'
  and name = ?
limit 1
`,
        statement => statement.get(tableName),
    )

    return Boolean(row)
}

function vectorTableNames(database: DatabaseSync): string[] {
    return withStatement(
        database,
        `
select name
from sqlite_master
where type = 'table'
  and name glob 'vector_index_[0-9]*'
`,
        statement =>
            statement
                .all()
                .map(row => (row as { name: string }).name)
                .filter(safeVectorTableName),
    )
}

function deleteNativeVectorTargets(
    database: DatabaseSync,
    table: string,
    targetType: TargetType,
    targetIds?: string[],
): void {
    if (targetIds && targetIds.length > 0) {
        for (const targetIdChunk of chunks(targetIds)) {
            const placeholders = targetIdChunk.map(() => '?').join(', ')
            withStatement(
                database,
                `
delete from ${table}
where target_type = ?
  and target_id in (${placeholders})
`,
                statement => statement.run(targetType, ...targetIdChunk),
            )
        }
        return
    }

    withStatement(
        database,
        `delete from ${table} where target_type = ?`,
        statement => statement.run(targetType),
    )
}

async function vectorConnection(): Promise<VectorIndexConnection | undefined> {
    if (globalThis.__konteksVectorIndexConnectionFactoryForTests) {
        return globalThis.__konteksVectorIndexConnectionFactoryForTests()
    }

    if (isSqliteTestRuntime()) {
        return undefined
    }

    const context = await loadProjectContext()
    const path = vectorDatabasePath(context)
    if (activeConnection?.path === path) {
        return activeConnection
    }
    if (activeConnection) {
        activeConnection.database.close?.()
        activeConnection = undefined
    }

    const database = await openVectorDatabase(path)
    const connection = { database, path }
    activeConnection = connection
    return connection
}

async function openVectorDatabase(path: string): Promise<DatabaseSync> {
    const errors: unknown[] = []
    const bunSqlite = await loadBunSqlite()
    if (bunSqlite) {
        try {
            return loadVectorExtension(
                new bunSqlite.Database(path, { create: true }),
            )
        } catch (error) {
            errors.push(error)
        }
    }

    const nodeSqlite = await loadNodeSqlite()
    if (nodeSqlite) {
        try {
            return loadVectorExtension(
                new nodeSqlite.DatabaseSync(path, { allowExtension: true }),
            )
        } catch (error) {
            errors.push(error)
        }
    }

    throw new VectorIndexDependencyError(
        'Failed to load the required sqlite-vec native extension with bun:sqlite or node:sqlite. Reinstall project dependencies so the sqlite-vec platform package is available.',
        { cause: new AggregateError(errors) },
    )
}

function loadVectorExtension(database: DatabaseSync): DatabaseSync {
    try {
        database.loadExtension(getLoadablePath())
        database.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;')
        return database
    } catch (error) {
        try {
            database.close?.()
        } catch {
            // Preserve the actionable sqlite-vec load failure.
        }
        throw error
    }
}

function vectorDatabasePath(context: { memoryDir: string }): string {
    return join(context.memoryDir, 'vectors.sqlite')
}

async function loadBunSqlite(): Promise<BunSqliteModule | undefined> {
    bunSqlitePromise ??= import(BUN_SQLITE_MODULE)
        .then(module => module as BunSqliteModule)
        .catch(() => undefined)
    return await bunSqlitePromise
}

async function loadNodeSqlite(): Promise<NodeSqliteModule | undefined> {
    nodeSqlitePromise ??= import(NODE_SQLITE_MODULE)
        .then(module => module as NodeSqliteModule)
        .catch(() => undefined)
    return await nodeSqlitePromise
}

async function loadDurableVectorPage(
    input: VectorIndexGroup,
    cursor?: Pick<VectorIndexRow, 'target_id' | 'target_type'>,
): Promise<VectorEmbeddingRow[]> {
    const db = await getDb()
    return await db.all<VectorEmbeddingRow>(sql`
select
    embedding_hash,
    model,
    target_id,
    target_type,
    vector_blob
from target_embeddings
where model = ${input.model}
  and dimensions = ${input.dimensions}
  ${vectorPageCursor(cursor)}
order by target_type, target_id
limit ${SQLITE_BIND_CHUNK_SIZE}
`)
}

async function loadVectorIndexEntryPage(
    input: VectorIndexGroup,
    cursor?: Pick<VectorIndexRow, 'target_id' | 'target_type'>,
): Promise<VectorIndexRow[]> {
    const db = await getDb()
    return await db.all<VectorIndexRow>(sql`
select
    embedding_hash,
    target_id,
    target_type
from vector_index_entries
where model = ${input.model}
  and dimensions = ${input.dimensions}
  ${vectorPageCursor(cursor)}
order by target_type, target_id
limit ${SQLITE_BIND_CHUNK_SIZE}
`)
}

function loadNativeVectorPage(
    database: DatabaseSync,
    tableName: string,
    input: VectorIndexGroup,
    cursor?: Pick<VectorIndexRow, 'target_id' | 'target_type'>,
): VectorIndexRow[] {
    const values: unknown[] = [input.model]
    const cursorCondition = cursor
        ? `
  and (
        target_type > ?
        or (
            target_type = ?
            and target_id > ?
        )
    )`
        : ''
    if (cursor) {
        values.push(cursor.target_type, cursor.target_type, cursor.target_id)
    }
    values.push(SQLITE_BIND_CHUNK_SIZE)

    return withStatement(
        database,
        `
select
    embedding_hash,
    target_id,
    target_type
from ${tableName}
where model = ?${cursorCondition}
order by target_type, target_id
limit ?
`,
        statement => statement.all(...values) as VectorIndexRow[],
    )
}

function vectorPageCursor(
    cursor?: Pick<VectorIndexRow, 'target_id' | 'target_type'>,
) {
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

function sameVectorIndexRows(
    left: VectorIndexRow[],
    right: VectorIndexRow[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (row, index) =>
                row.embedding_hash === right[index]?.embedding_hash &&
                row.target_id === right[index]?.target_id &&
                row.target_type === right[index]?.target_type,
        )
    )
}

async function exactVectorSearch(input: {
    dimensions: number
    limit: number
    model: string
    vector: Float32Array
}): Promise<VectorSearchResult[]> {
    if (input.limit <= 0) {
        return []
    }

    const results: VectorSearchResult[] = []
    let cursor:
        | Pick<VectorEmbeddingRow, 'target_id' | 'target_type'>
        | undefined

    while (true) {
        const rows = await loadDurableVectorPage(input, cursor)

        for (const row of rows) {
            results.push({
                distance: cosineDistance(
                    input.vector,
                    blobToFloat32Array(row.vector_blob),
                ),
                embeddingHash: row.embedding_hash,
                model: row.model,
                targetId: row.target_id,
                targetType: row.target_type,
            })
            results.sort((left, right) => left.distance - right.distance)
            if (results.length > input.limit) {
                results.pop()
            }
        }

        if (rows.length < SQLITE_BIND_CHUNK_SIZE) {
            return results
        }
        cursor = rows.at(-1)
    }
}

function cosineDistance(left: Float32Array, right: Float32Array): number {
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
        return 1
    }

    return 1 - dot / Math.sqrt(leftNorm * rightNorm)
}

function toVectorSearchResult(row: unknown): VectorSearchResult {
    const value = row as {
        distance: number
        embeddingHash: string
        model: string
        targetId: string
        targetType: TargetType
    }
    return {
        distance: value.distance,
        embeddingHash: value.embeddingHash,
        model: value.model,
        targetId: value.targetId,
        targetType: value.targetType,
    }
}

function vectorToBlob(vector: Float32Array): Uint8Array {
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

function tableNameForDimensions(dimensions: number): string {
    return `vector_index_${dimensions}`
}

function safeVectorTableName(tableName: string): boolean {
    return /^vector_index_\d+$/u.test(tableName)
}

async function upsertVectorIndexEntries(
    targets: VectorIndexTarget[],
    indexTable: string,
): Promise<void> {
    const db = await getDb()
    for (const targetChunk of chunks(targets)) {
        await db
            .insert(vectorIndexEntries)
            .values(
                targetChunk.map(target => ({
                    dimensions: target.dimensions,
                    embeddingHash: target.embeddingHash,
                    indexTable,
                    model: target.model,
                    targetId: target.targetId,
                    targetType: target.targetType,
                    updatedAt: target.createdAt,
                })),
            )
            .onConflictDoUpdate({
                set: {
                    dimensions: sql`excluded.dimensions`,
                    embeddingHash: sql`excluded.embedding_hash`,
                    indexTable: sql`excluded.index_table`,
                    updatedAt: sql`excluded.updated_at`,
                },
                target: [
                    vectorIndexEntries.targetId,
                    vectorIndexEntries.targetType,
                    vectorIndexEntries.model,
                ],
            })
    }
}

async function deleteVectorIndexEntries(
    targetType: TargetType,
    targetIds?: string[],
): Promise<void> {
    if (targetIds && targetIds.length === 0) {
        return
    }

    const db = await getDb()

    if (targetIds && targetIds.length > 0) {
        for (const targetIdChunk of chunks(targetIds)) {
            await db
                .delete(vectorIndexEntries)
                .where(
                    and(
                        eq(vectorIndexEntries.targetType, targetType),
                        inArray(vectorIndexEntries.targetId, targetIdChunk),
                    ),
                )
        }
        return
    }

    await db
        .delete(vectorIndexEntries)
        .where(eq(vectorIndexEntries.targetType, targetType))
}

async function deleteVectorIndexEntriesForGroup(input: {
    dimensions: number
    model: string
}): Promise<void> {
    const db = await getDb()
    await db
        .delete(vectorIndexEntries)
        .where(
            and(
                eq(vectorIndexEntries.model, input.model),
                eq(vectorIndexEntries.dimensions, input.dimensions),
            ),
        )
}

function withStatement<T>(
    database: DatabaseSync,
    query: string,
    operation: (statement: StatementSync) => T,
): T {
    const statement = database.prepare(query)
    try {
        return operation(statement)
    } finally {
        statement.finalize?.()
    }
}

function withNativeTransaction(
    database: DatabaseSync,
    operation: () => void,
): void {
    database.exec('begin immediate')
    try {
        operation()
        database.exec('commit')
    } catch (error) {
        database.exec('rollback')
        throw error
    }
}

function groupTargetsByDimensions(
    targets: VectorIndexTarget[],
): Map<number, VectorIndexTarget[]> {
    const grouped = new Map<number, VectorIndexTarget[]>()
    for (const target of targets) {
        const group = grouped.get(target.dimensions) ?? []
        group.push(target)
        grouped.set(target.dimensions, group)
    }
    return grouped
}

function chunks<T>(items: T[]): T[][] {
    const result: T[][] = []
    for (let index = 0; index < items.length; index += SQLITE_BIND_CHUNK_SIZE) {
        result.push(items.slice(index, index + SQLITE_BIND_CHUNK_SIZE))
    }
    return result
}

function invalidateVectorIndexGroups(
    path: string,
    targets: VectorIndexTarget[],
): void {
    for (const target of targets) {
        healthyGroups.delete(
            vectorIndexGroupKey(path, {
                dimensions: target.dimensions,
                model: target.model,
            }),
        )
    }
}

function invalidateVectorIndexPath(path: string): void {
    for (const key of healthyGroups) {
        if (key.startsWith(`${path}:`)) {
            healthyGroups.delete(key)
        }
    }
}

function vectorIndexGroupKey(path: string, input: VectorIndexGroup): string {
    return `${path}:${input.model}:${input.dimensions}`
}
