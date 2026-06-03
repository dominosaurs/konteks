import type { SaveOptions } from '@/database/services/save-memory'
import { readExtractionManifest } from '@/modules/extraction/engine/manifest'
import { extractProject } from '@/modules/extraction/extract-project'
import { loadProjectContext } from '@/modules/project/context'
import type { EmbeddingProviderContract } from '@/types/embedding-provider'
import type { LoadedProjectContext } from '@/types/project'

type SaveProjectUpdate = NonNullable<SaveOptions['projectUpdate']>
export type McpProjectContext = LoadedProjectContext

export async function loadMcpProjectContext(): Promise<McpProjectContext> {
    return await loadProjectContext()
}

export async function updateChangedProjectMemorySilently(
    context: McpProjectContext,
    embeddingProvider?: EmbeddingProviderContract,
): Promise<SaveProjectUpdate | undefined> {
    if (!(await readExtractionManifest(context.memoryDir))) {
        return undefined
    }

    const result = await extractProject(context, 'changed', {
        embeddingProvider,
    })
    return {
        deletedFilePaths: result.deletedFilePaths,
        updatedFilePaths: result.updatedFilePaths,
    }
}
