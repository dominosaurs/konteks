import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtime = process.argv[2]
const supportedRuntimes = new Set(['bun', 'node'])

if (!supportedRuntimes.has(runtime)) {
    throw new Error('Usage: runtime-smoke.mjs <bun|node>')
}

const projectRoot = process.cwd()
const cliPath = join(projectRoot, 'dist', 'main.js')
const tempRoot = await mkdtemp(join(tmpdir(), 'konteks-runtime-smoke-'))

try {
    await mkdir(join(tempRoot, '.git'))

    await expectCommand({
        args: ['--version'],
        expectedOutput: /\d+\.\d+\.\d+/u,
        name: 'prints version',
    })

    await expectCommand({
        args: ['--help'],
        expectedOutput: ['init', 'status', 'mcp', '--help'],
        name: 'prints root help',
    })

    await expectCommand({
        args: ['mcp', '--help'],
        expectedOutput: ['tools', '--help'],
        name: 'prints MCP help',
    })

    await expectCommand({
        args: ['status'],
        expectedOutput: [
            'Konteks memory is not initialized',
            'Project memory is missing or incomplete.',
            'konteks init',
        ],
        name: 'reports uninitialized projects',
        success: false,
    })
} finally {
    await rm(tempRoot, { force: true, recursive: true })
}

async function expectCommand({ args, expectedOutput, name, success = true }) {
    const result = await runCli(args)
    const expectedExitCode = success ? 0 : 1

    if (result.exitCode !== expectedExitCode) {
        throw new Error(
            `${name} failed: expected exit ${expectedExitCode}, got ${result.exitCode}\n${result.output}`,
        )
    }

    const expectedFragments = Array.isArray(expectedOutput)
        ? expectedOutput
        : [expectedOutput]

    for (const expected of expectedFragments) {
        const matched =
            expected instanceof RegExp
                ? expected.test(result.output)
                : result.output.includes(expected)

        if (!matched) {
            throw new Error(
                `${name} failed: missing ${expected.toString()}\n${result.output}`,
            )
        }
    }

    console.log(`${runtime}: ${name}`)
}

async function runCli(args) {
    const homeDir = await mkdtemp(join(tmpdir(), 'konteks-runtime-home-'))

    try {
        const child = spawn(runtime, [cliPath, ...args], {
            cwd: tempRoot,
            env: {
                ...process.env,
                CI: '1',
                HOME: homeDir,
                KONTEKS_MODEL_CACHE_DIR: join(
                    homeDir,
                    '.cache',
                    'konteks',
                    'models',
                ),
                KONTEKS_SQLITE_TEST_DATABASE: 'file',
                NO_COLOR: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        const [stdout, stderr, exitCode] = await Promise.all([
            readStream(child.stdout),
            readStream(child.stderr),
            waitForExit(child),
        ])

        return {
            exitCode,
            output: `${stdout}\n${stderr}`.trim(),
        }
    } finally {
        await rm(homeDir, { force: true, recursive: true })
    }
}

function readStream(stream) {
    return new Promise((resolve, reject) => {
        let output = ''

        stream.setEncoding('utf8')
        stream.on('data', chunk => {
            output += chunk
        })
        stream.on('error', reject)
        stream.on('end', () => resolve(output))
    })
}

function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', code => resolve(code))
    })
}
