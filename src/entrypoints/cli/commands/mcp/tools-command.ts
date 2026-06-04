import promptConfirm from '@inquirer/confirm'
import promptInput from '@inquirer/input'
import promptNumber from '@inquirer/number'
import promptSelect from '@inquirer/select'
import z from 'zod'
import MCP_TOOLS from '@/entrypoints/mcp/tools'
import consoleOutput from '@/support/console-output'
import BaseCommand, { type BaseCommandInput } from '../_base-command'

const OMIT_OPTION = '__konteks_omit__' as const

type McpTool = (typeof MCP_TOOLS)[number]

export default class ToolsCommand extends BaseCommand<
    [string | undefined],
    { json: boolean }
> {
    public override readonly args = [
        {
            description:
                'Optional MCP tool name. Omit it to choose interactively.',
            name: '[tool]',
        },
    ]
    public readonly description =
        'Inspect and run MCP tools exposed by Konteks.'
    public readonly name = 'tools'

    public override readonly options = [
        {
            description: 'Print the tool result as JSON.',
            flags: '--json',
        },
    ]

    public async handle(
        input?: BaseCommandInput<[string | undefined], { json: boolean }>,
    ): Promise<void> {
        let loop = true

        while (loop) {
            const directToolName = input?.args?.[0]
            const selectedToolName = directToolName ?? (await selectTool())

            const selectedTool = MCP_TOOLS.find(
                tool => tool.name === selectedToolName,
            )

            if (!selectedTool) {
                throw new Error(`Unknown MCP tool: ${selectedToolName}`)
            }

            printTool(selectedTool)
            this.consoleOutput.print('')

            const isConfirmed = directToolName
                ? true
                : await callToolConfirmation()

            if (!isConfirmed) {
                loop = false
                continue
            }

            const toolInput = await promptForToolInput(selectedTool)
            const result = await selectedTool.handle(toolInput)

            if (input?.options?.json) {
                this.consoleOutput.print(result)
            } else {
                this.consoleOutput.toon(result)
            }

            loop = directToolName
                ? false
                : await promptConfirm({
                      default: true,
                      message: 'Run another MCP tool?',
                  })
        }
    }
}

function selectTool() {
    return promptSelect({
        choices: MCP_TOOLS.map(tool => ({
            name: `${tool.name} - ${tool.description}`,
            value: tool.name,
        })),
        message: 'Select an MCP tool:',
    })
}

function printTool(tool: (typeof MCP_TOOLS)[number]) {
    console.log({
        annotations: tool.annotations,
        description: tool.description,
        inputSchema: summarizeObjectSchema(tool.inputSchema),
        name: tool.name,
    })
}

function callToolConfirmation() {
    return promptConfirm({
        default: true,
        message: 'Run this tool?',
    })
}

async function promptForToolInput(tool: McpTool): Promise<unknown> {
    while (true) {
        const input = await promptForObjectInput(tool.inputSchema)
        const result = tool.inputSchema.safeParse(input)

        if (result.success) {
            return result.data
        }

        consoleOutput.writeError(formatSchemaErrors(result.error))
    }
}

async function promptForObjectInput(
    schema: z.ZodObject,
): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {}

    for (const [key, fieldSchema] of Object.entries(schema.shape)) {
        const value = await promptForField(key, fieldSchema)

        if (value !== undefined) {
            input[key] = value
        }
    }

    return input
}

async function promptForField(
    key: string,
    schema: z.ZodType,
): Promise<unknown> {
    const { innerSchema, optional } = unwrapOptionalSchema(schema)

    if (innerSchema instanceof z.ZodBoolean) {
        return promptForBooleanField(key, optional)
    }

    if (innerSchema instanceof z.ZodEnum) {
        return promptForEnumField(key, innerSchema, optional)
    }

    if (innerSchema instanceof z.ZodNumber) {
        return promptForNumberField(key, schema, optional)
    }

    if (innerSchema instanceof z.ZodString) {
        return promptForStringField(key, schema, optional)
    }

    return promptForJsonField(key, schema, optional)
}

async function promptForBooleanField(
    key: string,
    optional: boolean,
): Promise<boolean | undefined> {
    if (!optional) {
        return promptConfirm({
            default: false,
            message: promptMessage(key, 'boolean', optional),
        })
    }

    const value = await promptSelect<boolean | typeof OMIT_OPTION>({
        choices: [
            { name: 'Skip (leave unset)', value: OMIT_OPTION },
            { name: 'true', value: true },
            { name: 'false', value: false },
        ],
        message: promptMessage(key, 'boolean', optional, {
            blankOmits: false,
        }),
    })

    return value === OMIT_OPTION ? undefined : value
}

async function promptForEnumField(
    key: string,
    schema: z.ZodEnum,
    optional: boolean,
): Promise<string | undefined> {
    const enumChoices = schema.options.map(value => ({
        name: String(value),
        value: String(value),
    }))
    const value = await promptSelect<string | typeof OMIT_OPTION>({
        choices: optional
            ? [
                  { name: 'Skip (leave unset)', value: OMIT_OPTION },
                  ...enumChoices,
              ]
            : enumChoices,
        message: promptMessage(key, 'enum', optional, {
            blankOmits: false,
        }),
    })

    return value === OMIT_OPTION ? undefined : value
}

async function promptForNumberField(
    key: string,
    schema: z.ZodType,
    optional: boolean,
): Promise<number | undefined> {
    return promptNumber({
        message: promptMessage(key, 'number', optional),
        required: !optional,
        validate: value => {
            if (value === undefined && optional) {
                return true
            }

            const result = schema.safeParse(value)

            return result.success ? true : formatSchemaIssue(result.error)
        },
    })
}

async function promptForStringField(
    key: string,
    schema: z.ZodType,
    optional: boolean,
): Promise<string | undefined> {
    const value = await promptInput({
        message: promptMessage(key, 'string', optional),
        validate: value => {
            if (value === '' && optional) {
                return true
            }

            const result = schema.safeParse(value)

            return result.success ? true : formatSchemaIssue(result.error)
        },
    })

    return value === '' && optional ? undefined : value
}

async function promptForJsonField(
    key: string,
    schema: z.ZodType,
    optional: boolean,
): Promise<unknown> {
    const value = await promptInput({
        message: promptMessage(key, 'JSON', optional),
        validate: value => {
            if (value === '' && optional) {
                return true
            }

            const parsed = parsePromptJson(value)

            if (!parsed.ok) {
                return parsed.error
            }

            const result = schema.safeParse(parsed.value)

            return result.success ? true : formatSchemaIssue(result.error)
        },
    })

    if (value === '' && optional) {
        return undefined
    }

    const parsed = parsePromptJson(value)

    if (!parsed.ok) {
        throw new Error(parsed.error)
    }

    return parsed.value
}

function unwrapOptionalSchema(schema: z.ZodType): {
    innerSchema: z.ZodType
    optional: boolean
} {
    if (schema instanceof z.ZodOptional) {
        return {
            innerSchema: schema.unwrap() as unknown as z.ZodType,
            optional: true,
        }
    }

    return {
        innerSchema: schema,
        optional: false,
    }
}

function parsePromptJson(
    value: string,
): { ok: true; value: unknown } | { error: string; ok: false } {
    try {
        return {
            ok: true,
            value: JSON.parse(value) as unknown,
        }
    } catch (error) {
        return {
            error: `Invalid JSON: ${
                error instanceof Error ? error.message : String(error)
            }`,
            ok: false,
        }
    }
}

function promptMessage(
    key: string,
    type: string,
    optional: boolean,
    options: { blankOmits?: boolean } = {},
): string {
    const requirement = optional
        ? options.blankOmits === false
            ? 'optional'
            : 'optional - leave blank to omit'
        : 'required'

    return `${key} (${type}, ${requirement}):`
}

function formatSchemaErrors(error: z.ZodError): string {
    return `Input did not match this tool schema. Update the fields and try again:\n${error.issues.map(formatIssue).join('\n')}\n`
}

function formatSchemaIssue(error: z.ZodError): string {
    return error.issues.map(formatIssue).join('\n')
}

function formatIssue(issue: z.core.$ZodIssue): string {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''

    return `${path}${issue.message}`
}

function summarizeObjectSchema(schema: z.ZodObject): object {
    return Object.fromEntries(
        Object.entries(schema.shape).map(([key, fieldSchema]) => [
            key,
            summarizeSchema(fieldSchema),
        ]),
    )
}

function summarizeSchema(schema: z.ZodType): object {
    const { innerSchema, optional } = unwrapOptionalSchema(schema)

    return {
        optional,
        type: schemaTypeName(innerSchema),
    }
}

function schemaTypeName(schema: z.ZodType): string {
    if (schema instanceof z.ZodArray) {
        return 'array'
    }

    if (schema instanceof z.ZodBoolean) {
        return 'boolean'
    }

    if (schema instanceof z.ZodEnum) {
        return `enum(${schema.options.join(', ')})`
    }

    if (schema instanceof z.ZodNumber) {
        return 'number'
    }

    if (schema instanceof z.ZodObject) {
        return 'object'
    }

    if (schema instanceof z.ZodString) {
        return 'string'
    }

    return 'JSON'
}
