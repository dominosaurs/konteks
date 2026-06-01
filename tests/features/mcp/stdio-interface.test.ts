import { describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractProject } from '@/modules/extraction/extract-project'
import {
    loadProjectContext,
    writeProjectConfig,
} from '@/modules/project/context'
import { mkdir, rm } from '@/support/file-manager'
import getVersion from '@/support/get-version'
import FakeEmbeddingProvider from '../../fake/fake-embedding-provider'
import {
    extractToolText,
    isRecord,
    type Json,
    request,
    resultById,
    runMcpExchange,
} from '../../support/mcp'
import { withWorkingDirectory as withProjectRoot } from '../../support/project'

describe('mcp/stdio interface', () => {
    it('exposes live server metadata and tool registrations over stdio', async () => {
        const fixture = await createInitializedProject('konteks-mcp-stdio-')

        try {
            const responses = await runMcpExchange(fixture.projectRoot, [
                request(2, 'tools/list'),
            ])
            const init = resultById<InitializeResult>(responses, 1)
            const tools = resultById<ToolsListResult>(responses, 2)

            expect(init.serverInfo).toEqual({
                name: 'konteks',
                version: getVersion(),
            })
            expect(init.instructions).toContain('Warm Up -> Build -> Save flow')
            expect(init.capabilities).toMatchObject({
                prompts: {},
                tools: {},
            })

            expect(tools.tools.map(tool => tool.name)).toEqual([
                'konteks_warm_up',
                'konteks_recall',
                'konteks_save_memories',
                'konteks_save_diary',
                'konteks_search',
                'konteks_forget',
            ])
            expect(
                tools.tools.map(tool => [
                    tool.name,
                    tool.annotations?.readOnlyHint,
                    tool.annotations?.destructiveHint,
                ]),
            ).toEqual([
                ['konteks_warm_up', false, false],
                ['konteks_recall', true, false],
                ['konteks_save_memories', false, false],
                ['konteks_save_diary', false, false],
                ['konteks_search', true, false],
                ['konteks_forget', false, true],
            ])

            const warmUpTool = tools.tools.find(
                tool => tool.name === 'konteks_warm_up',
            )
            expect(warmUpTool?.description).toContain(
                'stable project-wide briefing',
            )
            expect(warmUpTool?.inputSchema).toMatchObject({
                properties: {
                    focus: {
                        items: { type: 'string' },
                        type: 'array',
                    },
                },
                type: 'object',
            })

            const recallTool = tools.tools.find(
                tool => tool.name === 'konteks_recall',
            )
            expect(recallTool?.inputSchema).toMatchObject({
                properties: {
                    focus: {
                        items: { type: 'string' },
                        type: 'array',
                    },
                    includeSources: { type: 'boolean' },
                },
                required: ['focus'],
                type: 'object',
            })

            const saveMemoriesTool = tools.tools.find(
                tool => tool.name === 'konteks_save_memories',
            )
            expect(saveMemoriesTool?.description).toContain(
                'Persist one or more structured durable memories',
            )
            expect(saveMemoriesTool?.inputSchema).toMatchObject({
                properties: {
                    memories: {
                        items: {
                            properties: {
                                content: { type: 'string' },
                                importance: {
                                    anyOf: [
                                        { const: 1, type: 'number' },
                                        { const: 2, type: 'number' },
                                        { const: 3, type: 'number' },
                                        { const: 4, type: 'number' },
                                        { const: 5, type: 'number' },
                                    ],
                                },
                                kind: {
                                    enum: [
                                        'blocker',
                                        'code_insight',
                                        'constraint',
                                        'decision',
                                        'fact',
                                        'note',
                                        'preference',
                                    ],
                                    type: 'string',
                                },
                                source: { type: 'string' },
                                tags: {
                                    items: { type: 'string' },
                                    type: 'array',
                                },
                            },
                            required: ['content', 'importance', 'kind'],
                            type: 'object',
                        },
                        type: 'array',
                    },
                },
                required: ['memories'],
                type: 'object',
            })

            const saveDiaryTool = tools.tools.find(
                tool => tool.name === 'konteks_save_diary',
            )
            expect(saveDiaryTool?.description).toContain(
                'Persist one compact session diary entry',
            )
            expect(saveDiaryTool?.inputSchema).toMatchObject({
                properties: {
                    subject: { type: 'string' },
                    summary: { type: 'string' },
                    tags: {
                        items: { type: 'string' },
                        type: 'array',
                    },
                },
                required: ['summary'],
                type: 'object',
            })
        } finally {
            await fixture.cleanup()
        }
    }, 20000)

    it('exposes live prompt registrations and rendered prompt text over stdio', async () => {
        const fixture = await createInitializedProject('konteks-mcp-stdio-')

        try {
            const responses = await runMcpExchange(fixture.projectRoot, [
                request(2, 'prompts/list'),
                request(3, 'prompts/get', {
                    arguments: { focus: 'cli status command' },
                    name: 'konteks-warm-up',
                }),
            ])
            const prompts = resultById<PromptsListResult>(responses, 2)
            const prompt = resultById<PromptResult>(responses, 3)

            expect(prompts.prompts.map(item => item.name)).toEqual([
                'konteks-recall',
                'konteks-save',
                'konteks-warm-up',
            ])

            const warmUpPrompt = prompts.prompts.find(
                item => item.name === 'konteks-warm-up',
            )
            expect(warmUpPrompt).toMatchObject({
                arguments: [
                    {
                        name: 'focus',
                        required: false,
                    },
                ],
                description:
                    'Open a fresh Konteks session with project context.',
            })

            const promptText = extractPromptText(prompt.messages)
            expect(promptText).toContain('cli status command')
            expect(promptText).toContain('konteks_warm_up')
            expect(promptText).toContain(
                'Konteks is warmed up and ready for the task.',
            )
        } finally {
            await fixture.cleanup()
        }
    }, 20000)

    it('executes read-only stdio tool calls and rejects invalid input', async () => {
        const fixture = await createInitializedProject('konteks-mcp-stdio-')

        try {
            const successResponses = await runMcpExchange(fixture.projectRoot, [
                request(2, 'tools/call', {
                    arguments: { focus: ['project entry point'] },
                    name: 'konteks_recall',
                }),
                request(3, 'tools/call', {
                    arguments: {},
                    name: 'konteks_warm_up',
                }),
            ])

            expect(
                extractToolText(
                    resultById<ToolCallResult>(successResponses, 2),
                ),
            ).toContain('memories:')
            expect(
                extractToolText(
                    resultById<ToolCallResult>(successResponses, 3),
                ),
            ).toContain('highlights')

            const invalidRecall = resultById<ToolCallResult>(
                await runMcpExchange(fixture.projectRoot, [
                    request(2, 'tools/call', {
                        arguments: {},
                        name: 'konteks_recall',
                    }),
                ]),
                2,
            )
            expect(invalidRecall.isError).toBe(true)
            expect(extractToolText(invalidRecall)).toContain(
                'Invalid arguments for tool konteks_recall',
            )

            const invalidDiarySave = resultById<ToolCallResult>(
                await runMcpExchange(fixture.projectRoot, [
                    request(2, 'tools/call', {
                        arguments: {},
                        name: 'konteks_save_diary',
                    }),
                ]),
                2,
            )
            expect(invalidDiarySave.isError).toBe(true)
            expect(extractToolText(invalidDiarySave)).toContain(
                'Invalid arguments for tool konteks_save_diary',
            )

            const invalidMemorySave = resultById<ToolCallResult>(
                await runMcpExchange(fixture.projectRoot, [
                    request(2, 'tools/call', {
                        arguments: {},
                        name: 'konteks_save_memories',
                    }),
                ]),
                2,
            )
            expect(invalidMemorySave.isError).toBe(true)
            expect(extractToolText(invalidMemorySave)).toContain(
                'Invalid arguments for tool konteks_save_memories',
            )
        } finally {
            await fixture.cleanup()
        }
    }, 20000)
})

type InitializeResult = {
    capabilities: Json
    instructions?: string
    protocolVersion: string
    serverInfo: { name: string; version: string }
}

type ToolCallResult = {
    content: Array<{ text?: string; type: string }>
    isError?: boolean
}

type ToolsListResult = {
    tools: Array<{
        annotations?: {
            destructiveHint?: boolean
            readOnlyHint?: boolean
        }
        description?: string
        inputSchema: Record<string, Json>
        name: string
    }>
}

type PromptsListResult = {
    prompts: Array<{
        arguments?: Array<{
            description?: string
            name: string
            required?: boolean
        }>
        description?: string
        name: string
    }>
}

type PromptResult = {
    messages: Json
}

async function createInitializedProject(prefix: string): Promise<{
    cleanup(): Promise<void>
    projectRoot: string
}> {
    return withFileBackedSqlite(async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), prefix))

        await mkdir(join(projectRoot, 'src'))
        await mkdir(join(projectRoot, '.git'))
        await writeFile(
            join(projectRoot, 'src', 'index.txt'),
            'export const run = () => "stdio fixture"\n',
        )
        await mkdir(join(projectRoot, '.konteks'))

        const context = await withProjectRoot(projectRoot, () =>
            loadProjectContext(),
        )
        await writeProjectConfig(context, context.config)
        await withProjectRoot(projectRoot, () =>
            extractProject(context, 'full', {
                embeddingProvider: new FakeEmbeddingProvider(),
            }),
        )

        return {
            async cleanup() {
                await rm(projectRoot)
            },
            projectRoot,
        }
    })
}

async function withFileBackedSqlite<T>(
    operation: () => Promise<T>,
): Promise<T> {
    const previous = process.env.KONTEKS_SQLITE_TEST_DATABASE
    process.env.KONTEKS_SQLITE_TEST_DATABASE = 'file'

    try {
        return await operation()
    } finally {
        if (previous === undefined) {
            delete process.env.KONTEKS_SQLITE_TEST_DATABASE
        } else {
            process.env.KONTEKS_SQLITE_TEST_DATABASE = previous
        }
    }
}

function extractPromptText(messages: Json): string {
    if (!Array.isArray(messages)) {
        throw new Error('Expected prompt messages to be an array')
    }

    const firstText = messages.find(
        (
            message,
        ): message is {
            content: { text: string; type: 'text' }
        } => {
            return (
                isRecord(message) &&
                isRecord(message.content) &&
                message.content.type === 'text' &&
                typeof message.content.text === 'string'
            )
        },
    )

    if (!firstText) {
        throw new Error('Expected a text prompt message')
    }

    return firstText.content.text
}
