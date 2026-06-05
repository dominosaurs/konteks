import { and, eq, inArray, sql } from 'drizzle-orm'
import getDb from '@/database/actions/_db'
import clearModules from '@/database/actions/clear-modules'
import deleteRetrievalDocuments from '@/database/actions/delete-retrieval-documents'
import { sectionSuppressions, sections, sources } from '@/database/schema'
import {
    deleteAllExtractedGraph,
    deleteExtractedGraphForPaths,
} from '@/database/services/graph'

export async function isExtractedSectionSuppressed(
    path: string,
    anchor: string,
    contentHashValue: string,
): Promise<boolean> {
    const db = await getDb()
    const rows = await db
        .select({ content_hash: sectionSuppressions.contentHash })
        .from(sectionSuppressions)
        .where(
            and(
                eq(sectionSuppressions.path, path),
                eq(sectionSuppressions.anchor, anchor),
                eq(sectionSuppressions.contentHash, contentHashValue),
            ),
        )
        .limit(1)

    return rows.length > 0
}

export async function clearExtractedSections(): Promise<void> {
    const db = await getDb()
    await recordExtractedSuppressions()
    await deleteAllExtractedGraph()
    await db.run(sql`
delete from memory_fts_indexed
where id in (select id from sections where source_id in (select id from sources where type = 'extracted_file'));
`)
    await db.run(sql`
delete from memory_fts
where id in (select id from sections where source_id in (select id from sources where type = 'extracted_file'));
`)
    await db.run(sql`
delete from taxonomy_links
where target_type = 'section'
  and target_id in (select id from sections where source_id in (select id from sources where type = 'extracted_file'));
`)
    const sectionIds = await db.all<{ id: string }>(sql`
select id from sections where source_id in (select id from sources where type = 'extracted_file');
`)
    await deleteRetrievalDocuments(
        'section',
        sectionIds.map(row => row.id),
    )
    await deleteRetrievalDocuments('module')
    await db.run(sql`
delete from target_embeddings
where target_type = 'section'
  and target_id in (select id from sections where source_id in (select id from sources where type = 'extracted_file'));
`)
    await db.run(sql`
delete from target_embeddings
where target_type = 'module';
`)
    await clearModules()
    await db.run(sql`
delete from sections
where source_id in (select id from sources where type = 'extracted_file');
`)
    await db.run(sql`
delete from sources
where type = 'extracted_file';
`)
}

export async function clearExtractedSectionsForPaths(
    paths: string[],
): Promise<void> {
    const db = await getDb()
    const uniquePaths = [...new Set(paths)].filter(Boolean)
    if (uniquePaths.length === 0) {
        return
    }

    await recordExtractedSuppressions(uniquePaths)
    await deleteExtractedGraphForPaths(uniquePaths)
    const sectionIds = await db
        .select({ id: sections.id })
        .from(sections)
        .where(inArray(sections.path, uniquePaths))

    await db.run(sql`
delete from memory_fts_indexed
where id in (select id from sections where path in (${sql.join(
        uniquePaths.map(path => sql`${path}`),
        sql`, `,
    )}));
`)
    await db.run(sql`
delete from memory_fts
where id in (select id from sections where path in (${sql.join(
        uniquePaths.map(path => sql`${path}`),
        sql`, `,
    )}));
`)
    await db.run(sql`
delete from taxonomy_links
where target_type = 'section'
  and target_id in (select id from sections where path in (${sql.join(
      uniquePaths.map(path => sql`${path}`),
      sql`, `,
  )}));
`)
    await deleteRetrievalDocuments(
        'section',
        sectionIds.map(row => row.id),
    )
    await db.run(sql`
delete from target_embeddings
where target_type = 'section'
  and target_id in (select id from sections where path in (${sql.join(
      uniquePaths.map(path => sql`${path}`),
      sql`, `,
  )}));
`)
    await db.delete(sections).where(inArray(sections.path, uniquePaths))
    await db
        .delete(sources)
        .where(
            and(
                eq(sources.type, 'extracted_file'),
                inArray(sources.uri, uniquePaths),
            ),
        )
}

export async function recordExtractedSuppressionsForPaths(
    paths: string[],
): Promise<void> {
    const uniquePaths = [...new Set(paths)].filter(Boolean)
    if (uniquePaths.length === 0) {
        return
    }

    await recordExtractedSuppressions(uniquePaths)
}

async function recordExtractedSuppressions(paths?: string[]): Promise<void> {
    const db = await getDb()
    await db.run(sql`
insert or ignore into section_suppressions (
    path,
    anchor,
    content_hash,
    reason,
    created_at
)
select
    path,
    coalesce(anchor, ''),
    content_hash,
    forget_reason,
    coalesce(suppressed_at, deleted_at, updated_at)
from sections
where (suppressed_at is not null or deleted_at is not null)
  and path is not null
  ${
      paths && paths.length > 0
          ? sql`and path in (${sql.join(
                paths.map(path => sql`${path}`),
                sql`, `,
            )})`
          : sql``
};
`)
}
