import { withReadDatabase } from '@/database/actions/_db'
import queryExportDiaryRows from '@/database/actions/query-export-diary-rows'
import queryExportObservationRows from '@/database/actions/query-export-observation-rows'
import {
    exportDiaryRow,
    exportObservationRow,
} from '@/database/support/memory-transfer'
import type { DurableMemoryExport } from '@/types/memory-transfer'
import type { Project } from '@/types/project'

export default async function exportDurableMemory(
    context: Project,
    options: { includeInactive?: boolean },
): Promise<DurableMemoryExport> {
    const { diaryRows, memoryRows } = await withReadDatabase(async () => ({
        diaryRows: await queryExportDiaryRows(options),
        memoryRows: await queryExportObservationRows(options),
    }))

    return {
        diaries: diaryRows.map(exportDiaryRow),
        exportedAt: new Date().toISOString(),
        format: 'konteks.durable-memory.v1',
        memories: memoryRows.map(exportObservationRow),
        project: {
            root: context.projectRoot,
        },
    }
}
