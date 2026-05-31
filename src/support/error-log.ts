import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveProjectContext } from '@/modules/project/context'

import { mkdir } from '@/support/file-manager'

type ErrorLogSurface =
    | 'background_maintenance'
    | 'cli'
    | 'mcp_prompt'
    | 'mcp_tool'

type ErrorLogInput = {
    error: unknown
    metadata?: Record<string, unknown>
    surface: ErrorLogSurface
}

type ErrorLogResult = {
    path?: string
    written: boolean
}

const MAX_FIELD_LENGTH = 8000
const MAX_CAUSE_DEPTH = 4
const SECRET_PATTERNS: Array<{
    pattern: RegExp
    replacement: string
}> = [
    {
        pattern:
            /(["']?(?:api[_-]?key|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',}]+/giu,
        replacement: '$1[REDACTED]',
    },
    {
        pattern: /(bearer\s+)[a-z0-9._~+/-]+/giu,
        replacement: '$1[REDACTED]',
    },
    {
        pattern: /sk-[a-z0-9_-]{16,}/giu,
        replacement: '[REDACTED]',
    },
]

export async function appendProjectErrorLog(
    input: ErrorLogInput,
): Promise<ErrorLogResult> {
    try {
        const context = await resolveProjectContext()
        const logPath = join(context.memoryDir, 'errors.log')
        await mkdir(context.memoryDir)
        await appendFile(logPath, formatErrorLogEntry(input))

        return {
            path: logPath,
            written: true,
        }
    } catch {
        return { written: false }
    }
}

function errorLogEntry(input: ErrorLogInput): {
    error: Record<string, unknown>
    metadata: Record<string, unknown>
    process: Record<string, unknown>
    surface: ErrorLogSurface
    timestamp: string
} {
    const error = normalizeError(input.error)
    return {
        error,
        metadata: sanitizeRecord(input.metadata ?? {}),
        process: {
            argv: process.argv.slice(0, 4).map(sanitizeString),
            cwd: sanitizeString(process.cwd()),
            node: process.version,
            pid: process.pid,
        },
        surface: input.surface,
        timestamp: new Date().toISOString(),
    }
}

function formatErrorLogEntry(input: ErrorLogInput): string {
    const entry = errorLogEntry(input)
    const lines: string[] = []
    const contextName = entryContextName(entry)

    lines.push('='.repeat(80))
    lines.push(
        [entry.timestamp, entry.surface, contextName]
            .filter(Boolean)
            .join('  '),
    )
    lines.push('-'.repeat(80))
    lines.push(`${entry.error.name}: ${firstLine(entry.error.message)}`)
    lines.push('')
    pushRecordSection(lines, 'Metadata', entry.metadata)
    pushRecordSection(lines, 'Process', entry.process)
    pushStackSection(lines, 'Stack', entry.error.stack)
    pushCauseSections(lines, entry.error.cause, 1)
    lines.push('='.repeat(80))
    lines.push('')

    return `${lines.join('\n')}\n`
}

function normalizeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return {
            cause: error.cause ? sanitizeUnknown(error.cause) : undefined,
            message: sanitizeString(error.message),
            name: error.name,
            stack: error.stack ? sanitizeString(error.stack) : undefined,
        }
    }

    return {
        message: sanitizeString(String(error)),
        name: typeof error,
        value: sanitizeUnknown(error),
    }
}

function sanitizeUnknown(value: unknown): unknown {
    if (typeof value === 'string') {
        return sanitizeString(value)
    }
    if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null ||
        value === undefined
    ) {
        return value
    }
    if (Array.isArray(value)) {
        return value.slice(0, 20).map(sanitizeUnknown)
    }
    if (value instanceof Error) {
        return normalizeError(value)
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).slice(
            0,
            40,
        )
        return Object.fromEntries(
            entries.map(([key, item]) => [
                sanitizeString(key),
                isSensitiveKey(key) ? '[REDACTED]' : sanitizeUnknown(item),
            ]),
        )
    }

    return sanitizeString(String(value))
}

function isSensitiveKey(key: string): boolean {
    return /^(?:api[_-]?key|token|secret|password|passwd|pwd)$/iu.test(key)
}

function sanitizeRecord(
    value: Record<string, unknown>,
): Record<string, unknown> {
    const sanitized = sanitizeUnknown(value)
    return sanitized &&
        typeof sanitized === 'object' &&
        !Array.isArray(sanitized)
        ? (sanitized as Record<string, unknown>)
        : {}
}

function sanitizeString(value: string): string {
    const redacted = SECRET_PATTERNS.reduce(
        (text, secret) => text.replace(secret.pattern, secret.replacement),
        value,
    )

    if (redacted.length <= MAX_FIELD_LENGTH) {
        return redacted
    }

    return `${redacted.slice(0, MAX_FIELD_LENGTH)}... [truncated]`
}

function entryContextName(entry: {
    metadata: Record<string, unknown>
    surface: ErrorLogSurface
}): string | undefined {
    const key =
        entry.surface === 'mcp_tool'
            ? 'toolName'
            : entry.surface === 'mcp_prompt'
              ? 'promptName'
              : 'command'
    const value = entry.metadata[key]
    if (typeof value === 'string' && value.trim()) {
        return value
    }
    if (entry.surface === 'cli') {
        return 'cli'
    }
    return undefined
}

function firstLine(value: unknown): string {
    return (
        String(value ?? '')
            .split('\n')[0]
            ?.trim() || 'Unknown error'
    )
}

function pushRecordSection(
    lines: string[],
    title: string,
    record: Record<string, unknown>,
): void {
    const entries = Object.entries(record)
    if (entries.length === 0) {
        return
    }

    lines.push(`${title}:`)
    for (const [key, value] of entries) {
        lines.push(`  ${key}: ${formatValue(value)}`)
    }
    lines.push('')
}

function pushStackSection(
    lines: string[],
    title: string,
    stack: unknown,
): void {
    if (typeof stack !== 'string' || !stack.trim()) {
        return
    }

    lines.push(`${title}:`)
    for (const line of stack.split('\n')) {
        lines.push(`  ${line.trim()}`)
    }
    lines.push('')
}

function pushCauseSections(
    lines: string[],
    cause: unknown,
    depth: number,
): void {
    if (!cause || depth > MAX_CAUSE_DEPTH) {
        return
    }

    if (typeof cause === 'object' && !Array.isArray(cause)) {
        const causeRecord = cause as Record<string, unknown>
        lines.push(`Cause ${depth}:`)
        lines.push(
            `  ${causeRecord.name ?? 'Error'}: ${firstLine(causeRecord.message)}`,
        )
        lines.push('')
        pushStackSection(lines, `Cause ${depth} Stack`, causeRecord.stack)
        pushCauseSections(lines, causeRecord.cause, depth + 1)
        return
    }

    lines.push(`Cause ${depth}:`)
    lines.push(`  ${formatValue(cause)}`)
    lines.push('')
}

function formatValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(formatValue).join(' ')
    }
    if (value && typeof value === 'object') {
        return JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')
    }
    return String(value ?? '')
}
