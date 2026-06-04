import { withReadDatabase } from '@/database/actions/_db'
import queryProjectMemoryStats from '@/database/actions/query-project-memory-stats'

export type ProjectMemoryStats = {
    files: number
    sections: number
    modules: number
    memories: number
    diaryEntries: number
    retrievalDocuments: number
    embeddings: number
    events: number
}

export async function readProjectMemoryStats(): Promise<ProjectMemoryStats> {
    return await withReadDatabase(() => queryProjectMemoryStats())
}
