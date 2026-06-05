import type {
    SaveDiaryInput,
    SaveMemoriesInput,
} from '@/database/services/save-memory'
import {
    saveKonteksDiary,
    saveKonteksMemories,
} from '@/database/services/save-memory'
import sharedEmbeddingProvider from '@/modules/embeddings/shared-embedding-provider'
import { scheduleMemoryMaintenance } from '@/modules/memory/background-maintenance'
import type { EmbeddingProviderContract } from '@/types/embedding-provider'
import type { SaveResult } from '@/types/memory'
import {
    loadMcpProjectContext,
    type McpProjectContext,
    updateChangedProjectMemorySilently,
} from './runtime'

export async function saveMemories(
    input: SaveMemoriesInput,
): Promise<SaveResult> {
    const context = await loadMcpProjectContext()
    const embeddingProvider = context.configExists
        ? sharedEmbeddingProvider()
        : undefined
    const result = await saveKonteksMemories(context, input, {
        embeddingMode: 'background',
        embeddingProvider,
    })
    scheduleChangedProjectMemoryUpdate(context, embeddingProvider)
    return result
}

export async function saveDiary(input: SaveDiaryInput): Promise<SaveResult> {
    const context = await loadMcpProjectContext()
    const embeddingProvider = context.configExists
        ? sharedEmbeddingProvider()
        : undefined
    const result = await saveKonteksDiary(context, input, {
        embeddingMode: 'background',
        embeddingProvider,
    })
    scheduleChangedProjectMemoryUpdate(context, embeddingProvider)
    return result
}

function scheduleChangedProjectMemoryUpdate(
    context: McpProjectContext,
    embeddingProvider: EmbeddingProviderContract | undefined,
): void {
    scheduleMemoryMaintenance(context, {
        dedupeKey: 'changed_project_memory',
        metadata: {
            projectRoot: context.projectRoot,
        },
        operation: async () => {
            await updateChangedProjectMemorySilently(context, embeddingProvider)
        },
        operationName: 'changed_project_memory',
    })
}
