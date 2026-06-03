import z from 'zod'
import type { SaveMemoriesInput } from '@/database/services/save-memory'
import { saveMemories } from '@/modules/memory/save-memory'
import BaseMcpTool from './_base-mcp-tool'
import memoryKindSchema from './schemas/memory-kind-schema'
import saveTextSchema from './schemas/save-input-schema'

const saveBatchMemorySchema = z.object({
    content: saveTextSchema,
    importance: z.number().int().min(1).max(5),
    kind: memoryKindSchema,
    source: z.string().optional(),
    supersedes: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
})

const INPUT_SCHEMA = z.object({
    memories: z
        .array(saveBatchMemorySchema)
        .min(1, 'memories must contain at least one item')
        .describe('Structured durable memories to persist.'),
})

type Input = SaveMemoriesInput

export default class SaveMemoriesMcpTool extends BaseMcpTool<Input> {
    public readonly annotations = {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    }

    public readonly description =
        'Persist one or more structured durable memories.'

    public readonly inputSchema = INPUT_SCHEMA

    public readonly name = 'konteks_save_memories'

    public async handle(input: Input): Promise<string> {
        await saveMemories(input)

        return 'durable memories saved'
    }
}
