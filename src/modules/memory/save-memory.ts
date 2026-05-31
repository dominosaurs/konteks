import type {
    SaveDiaryInput,
    SaveMemoriesInput,
} from '@/database/services/save-memory'
import {
    saveKonteksDiary,
    saveKonteksMemories,
} from '@/database/services/save-memory'
import sharedEmbeddingProvider from '@/modules/embeddings/shared-embedding-provider'
import type { SaveResult } from '@/types/memory'
import {
    loadMcpProjectContext,
    updateChangedProjectMemorySilently,
} from './runtime'

export async function saveMemories(
    input: SaveMemoriesInput,
): Promise<SaveResult> {
    const context = await loadMcpProjectContext()
    const embeddingProvider = sharedEmbeddingProvider()
    const projectUpdate = await updateChangedProjectMemorySilently(
        context,
        embeddingProvider,
    )
    return await saveKonteksMemories(context, input, {
        embeddingProvider,
        projectUpdate,
    })
}

export async function saveDiary(input: SaveDiaryInput): Promise<SaveResult> {
    const context = await loadMcpProjectContext()
    const embeddingProvider = sharedEmbeddingProvider()
    const projectUpdate = await updateChangedProjectMemorySilently(
        context,
        embeddingProvider,
    )
    return await saveKonteksDiary(context, input, {
        embeddingProvider,
        projectUpdate,
    })
}
