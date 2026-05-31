import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { rm } from '@/support/file-manager'

export type Json =
    | boolean
    | null
    | number
    | string
    | Json[]
    | { [key: string]: Json }

export type JsonRpcResponse = {
    error?: {
        code: number
        message: string
    }
    id?: number
    result?: Json
}

export async function runMcpExchange(
    projectRoot: string,
    requests: Array<{ id: number; method: string; params?: Json }>,
): Promise<JsonRpcResponse[]> {
    const exchangeRoot = await mkdtemp(join(tmpdir(), 'konteks-mcp-exchange-'))

    try {
        const input = [
            request(1, 'initialize', {
                capabilities: {},
                clientInfo: {
                    name: 'konteks-stdio-test',
                    version: '0.0.0',
                },
                protocolVersion: LATEST_PROTOCOL_VERSION,
            }),
            notification('notifications/initialized'),
            ...requests,
        ]
            .map(message => JSON.stringify(message))
            .join('\n')

        const proc = Bun.spawn(
            [process.execPath, join(process.cwd(), 'src/main.ts'), 'mcp'],
            {
                cwd: projectRoot,
                env: commandEnv(),
                stderr: 'pipe',
                stdin: new Response(`${input}\n`),
                stdout: 'pipe',
            },
        )
        const [raw, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])

        if (exitCode !== 0) {
            throw new Error(stderr.trim() || `MCP exited with ${exitCode}`)
        }

        return raw
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => JSON.parse(line) as JsonRpcResponse)
    } finally {
        await rm(exchangeRoot)
    }
}

export function request(id: number, method: string, params?: Json) {
    return {
        id,
        jsonrpc: '2.0' as const,
        method,
        params,
    }
}

export function notification(method: string, params?: Json) {
    return {
        jsonrpc: '2.0' as const,
        method,
        params,
    }
}

export function resultById<T>(responses: JsonRpcResponse[], id: number): T {
    const response = responses.find(item => item.id === id)

    if (!response) {
        throw new Error(`Missing MCP response with id ${id}`)
    }
    if (response.error) {
        throw new Error(response.error.message)
    }

    return response.result as T
}

export function extractToolText(result: {
    content: Array<{ text?: string; type: string }>
}): string {
    const firstText = result.content.find(
        item => item.type === 'text' && typeof item.text === 'string',
    )

    if (!firstText?.text) {
        throw new Error('Expected a text tool result')
    }

    return firstText.text
}

export function isRecord(value: Json): value is Record<string, Json> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function commandEnv(): Record<string, string> {
    return {
        ...Object.fromEntries(
            Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                    typeof entry[1] === 'string',
            ),
        ),
        KONTEKS_DISABLE_SHARED_EMBEDDING_PROVIDER: '1',
        KONTEKS_SQLITE_TEST_DATABASE: 'file',
    }
}
