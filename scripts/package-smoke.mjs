import { spawn } from 'node:child_process'
import {
    access,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readStream, waitForExit } from './_smoke-utils.mjs'

const packageBinName = 'konteks-cli'
const manager = process.argv[2]
const tarballPath = process.argv[3] ? resolve(process.argv[3]) : undefined
const supportedManagers = new Set(['bun', 'npm', 'pnpm', 'yarn'])

if (!supportedManagers.has(manager) || !tarballPath) {
    throw new Error('Usage: package-smoke.mjs <bun|npm|pnpm|yarn> <tarball>')
}

const tempRoot = await mkdtemp(join(tmpdir(), 'konteks-package-smoke-'))
const projectRoot = join(tempRoot, 'project')
const homeDir = join(tempRoot, 'home')
const binName =
    process.platform === 'win32' ? `${packageBinName}.cmd` : packageBinName
const cliPath = join(projectRoot, 'node_modules', '.bin', binName)

try {
    await mkdir(projectRoot, { recursive: true })
    await mkdir(homeDir)
    await mkdir(join(projectRoot, '.git'))
    await writeFile(
        join(projectRoot, 'package.json'),
        `${JSON.stringify({ name: 'konteks-package-smoke', private: true }, null, 2)}\n`,
    )

    if (manager === 'yarn') {
        await writeFile(
            join(projectRoot, '.yarnrc.yml'),
            'nodeLinker: node-modules\n',
        )
    }

    await installPackage()
    await assertInstalledBin()

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

async function installPackage() {
    const commands = {
        bun: ['bun', 'add', tarballPath],
        npm: ['npm', 'install', '--no-audit', '--fund=false', tarballPath],
        pnpm: ['pnpm', 'add', '--ignore-scripts', tarballPath],
        yarn: ['yarn', 'add', tarballPath],
    }

    const [command, ...args] = commands[manager]
    const result = await run(command, args, { isolatedHome: false })

    if (result.exitCode !== 0) {
        throw new Error(
            `${manager}: install failed with exit ${result.exitCode}\n${result.output}`,
        )
    }

    console.log(`${manager}: installs packed tarball`)
}

async function assertInstalledBin() {
    try {
        await access(cliPath)
        return
    } catch {
        const binDir = join(projectRoot, 'node_modules', '.bin')
        const availableBins = await readdir(binDir).catch(() => [])

        throw new Error(
            `${manager}: missing installed bin ${binName} at ${cliPath}. Available bins: ${availableBins.join(', ') || 'none'}`,
        )
    }
}

async function expectCommand({ args, expectedOutput, name, success = true }) {
    const result = await run(cliPath, args, { isolatedHome: true })
    const expectedExitCode = success ? 0 : 1

    if (result.exitCode !== expectedExitCode) {
        throw new Error(
            `${manager}: ${name} failed: expected exit ${expectedExitCode}, got ${result.exitCode}\n${result.output}`,
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
                `${manager}: ${name} failed: missing ${expected.toString()}\n${result.output}`,
            )
        }
    }

    console.log(`${manager}: ${name}`)
}

async function run(command, args, options = { isolatedHome: true }) {
    const child = spawn(command, args, {
        cwd: projectRoot,
        env: {
            ...process.env,
            CI: '1',
            ...(options.isolatedHome ? { HOME: homeDir } : {}),
            KONTEKS_MODEL_CACHE_DIR: join(
                homeDir,
                '.cache',
                'konteks',
                'models',
            ),
            KONTEKS_SQLITE_TEST_DATABASE: 'file',
            NO_COLOR: '1',
            YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
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
}
