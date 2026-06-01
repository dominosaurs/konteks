import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
import type { Prompt, PromptArgument } from '@modelcontextprotocol/sdk/types.js'
import z from 'zod'
import recallMd from '@/assets/prompts/konteks-recall.md?raw'
import saveMd from '@/assets/prompts/konteks-save.md?raw'
import warmUpMd from '@/assets/prompts/konteks-warm-up.md?raw'
import { appendProjectErrorLog } from '@/support/error-log'
import { createMcpPromptError, isUnexpectedMcpError } from './error-handling'

type PromptTemplate = {
    body: string
    fileName: string
    prompt: Prompt
    raw: string
}

type RawPrompt = {
    fileName: string
    raw: string
}

type SkillFile = {
    content: string
    name: string
}

const rawPrompts: RawPrompt[] = [
    {
        fileName: 'konteks-recall.md',
        raw: recallMd,
    },
    {
        fileName: 'konteks-save.md',
        raw: saveMd,
    },
    {
        fileName: 'konteks-warm-up.md',
        raw: warmUpMd,
    },
]

export function registerKonteksPrompts(server: McpServer): void {
    for (const template of getPromptTemplates()) {
        server.registerPrompt(
            template.prompt.name,
            {
                // biome-ignore lint/suspicious/noExplicitAny: compatibility cast
                argsSchema: promptArgsSchema(template.prompt) as any,
                description: template.prompt.description,
            },
            (args: Record<string, string>) => {
                try {
                    return renderPromptMessage(template, args)
                } catch (error) {
                    if (isUnexpectedMcpError(error)) {
                        void appendProjectErrorLog({
                            error,
                            metadata: { promptName: template.prompt.name },
                            surface: 'mcp_prompt',
                        })
                    }
                    throw createMcpPromptError({
                        error,
                        promptName: template.prompt.name,
                    })
                }
            },
        )
    }
}

export function getKonteksSkillFiles(): SkillFile[] {
    return getPromptTemplates().map(promptTemplateToSkillFile)
}

function getPromptTemplates(): PromptTemplate[] {
    return rawPrompts.map(rawPrompt =>
        readPromptMarkdown(rawPrompt.raw, rawPrompt.fileName),
    )
}

function readPromptMarkdown(raw: string, fileName: string): PromptTemplate {
    const match =
        /^---\n(?<frontmatter>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(raw)

    if (!match?.groups) {
        throw new Error(`Prompt file is missing frontmatter: ${fileName}`)
    }

    const frontmatter = parseFrontmatter(match.groups.frontmatter)
    validateFrontmatter(frontmatter, fileName)

    const prompt: Prompt = {
        description: frontmatter.description,
        name: frontmatter.name,
        title: frontmatter.title,
    }

    const args = readPromptArguments(frontmatter)
    if (args.length > 0) {
        prompt.arguments = args
    }

    return {
        body: match.groups.body.trim(),
        fileName,
        prompt,
        raw,
    }
}

function validateFrontmatter(
    frontmatter: Record<string, string>,
    fileName: string,
): void {
    for (const field of ['name', 'title', 'description']) {
        if (!frontmatter[field]) {
            throw new Error(`Prompt file is missing "${field}": ${fileName}`)
        }
    }
}

function readPromptArguments(
    frontmatter: Record<string, string>,
): PromptArgument[] {
    const names = new Set<string>()
    for (const key of Object.keys(frontmatter)) {
        const match = /^argument\.([a-zA-Z0-9_-]+)\.description$/u.exec(key)
        if (match?.[1]) {
            names.add(match[1])
        }
    }

    return [...names].sort().map(name => ({
        description: frontmatter[`argument.${name}.description`] ?? '',
        name,
        required: frontmatter[`argument.${name}.required`] === 'true',
    }))
}

function promptArgsSchema(prompt: Prompt): Record<string, z.ZodTypeAny> {
    const schema: Record<string, z.ZodTypeAny> = {}

    for (const arg of prompt.arguments ?? []) {
        let argSchema: z.ZodTypeAny = z.string().describe(arg.description ?? '')
        if (!arg.required) {
            argSchema = argSchema.optional()
        }
        schema[arg.name] = argSchema
    }

    return schema
}

function renderPromptMessage(
    template: PromptTemplate,
    args: Record<string, string>,
): {
    messages: Array<{
        content: { text: string; type: 'text' }
        role: 'user'
    }>
} {
    return {
        messages: [
            {
                content: {
                    text: renderPromptTemplate(template, args),
                    type: 'text',
                },
                role: 'user',
            },
        ],
    }
}

function renderPromptTemplate(
    template: PromptTemplate,
    args: Record<string, string>,
): string {
    return template.body.replaceAll(
        /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g,
        (_, key: string) => renderArgumentValue(template.prompt, args, key),
    )
}

function renderArgumentValue(
    prompt: Prompt,
    args: Record<string, string>,
    key: string,
): string {
    const value = args[key]?.trim()
    if (value) {
        return value
    }

    const argument = prompt.arguments?.find(item => item.name === key)
    return argument?.required === false ? '' : `<${key}>`
}

function promptTemplateToSkillFile(template: PromptTemplate): SkillFile {
    const focusPlaceholder =
        template.prompt.name === 'konteks-warm-up'
            ? 'any free-form text provided after `$konteks-warm-up`, if any'
            : 'the focus'
    const body = template.body.replaceAll('{{focus}}', focusPlaceholder)

    return {
        content: `---\nname: ${template.prompt.name}\ndescription: Use when working with Konteks MCP memory. ${template.prompt.description}\n---\n\n# ${template.prompt.title}\n\n${body}`,
        name: template.prompt.name,
    }
}

function parseFrontmatter(value: string): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const line of value.split('\n')) {
        const separator = line.indexOf(':')
        if (separator === -1) {
            continue
        }
        const key = line.slice(0, separator).trim()
        const fieldValue = line.slice(separator + 1).trim()
        fields[key] = fieldValue
    }
    return fields
}
