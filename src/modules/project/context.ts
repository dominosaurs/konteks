import { AsyncLocalStorage } from 'node:async_hooks'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
    KonteksConfig,
    LoadedProjectContext,
    ProjectContext,
} from '@/types/project'

export type { LoadedProjectContext }

const loadedProjectContext = new AsyncLocalStorage<
    LoadedProjectContext | undefined
>()

export function createDefaultConfig(): KonteksConfig {
    return {
        extraction: {
            grammars: {
                selected: [],
                updateTtlHours: 24,
            },
        },
    }
}

export async function writeProjectConfig(
    context: Pick<LoadedProjectContext, 'config' | 'configPath'>,
    config: KonteksConfig,
): Promise<void> {
    await writeFile(context.configPath, `${JSON.stringify(config, null, 2)}\n`)
}

export async function resolveProjectContext(): Promise<ProjectContext> {
    const bound = loadedProjectContext.getStore()
    if (bound) {
        return {
            configPath: bound.configPath,
            memoryDir: bound.memoryDir,
            projectRoot: bound.projectRoot,
        }
    }

    const projectRoot = await findProjectRoot(process.cwd())
    const memoryDir = join(projectRoot, '.konteks')

    return {
        configPath: join(memoryDir, 'config.json'),
        memoryDir,
        projectRoot,
    }
}

export async function loadProjectContext(): Promise<LoadedProjectContext> {
    const bound = loadedProjectContext.getStore()
    if (bound) {
        return bound
    }

    const context = await resolveProjectContext()
    const config = await readConfig(context.configPath)

    return {
        ...context,
        config: config.config,
        configExists: config.exists,
    }
}

export function withLoadedProjectContext<T>(
    context: LoadedProjectContext,
    operation: () => T,
): T {
    return loadedProjectContext.run(context, operation)
}

async function findProjectRoot(start: string): Promise<string> {
    let current = resolve(start)

    while (true) {
        if (
            (await pathExists(join(current, '.git'))) ||
            (await pathExists(join(current, 'package.json')))
        ) {
            return current
        }

        const parent = dirname(current)
        if (parent === current) {
            return resolve(start)
        }
        current = parent
    }
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function readConfig(
    configPath: string,
): Promise<{ config: KonteksConfig; exists: boolean }> {
    if (!(await pathExists(configPath))) {
        return {
            config: createDefaultConfig(),
            exists: false,
        }
    }

    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<KonteksConfig>

    return {
        config: mergeConfig(createDefaultConfig(), parsed),
        exists: true,
    }
}

function mergeConfig(
    defaults: KonteksConfig,
    config: Partial<KonteksConfig>,
): KonteksConfig {
    return {
        extraction: {
            grammars: {
                selected: Array.isArray(config.extraction?.grammars?.selected)
                    ? config.extraction.grammars.selected.filter(
                          value => typeof value === 'string',
                      )
                    : defaults.extraction.grammars.selected,
                updateTtlHours:
                    typeof config.extraction?.grammars?.updateTtlHours ===
                    'number'
                        ? config.extraction.grammars.updateTtlHours
                        : defaults.extraction.grammars.updateTtlHours,
            },
        },
    }
}
