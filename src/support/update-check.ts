import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import getVersion from './get-version'

const PACKAGE_NAME = 'konteks-cli'
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 750

export type UpdateNotice = {
    command: string
    current: string
    latest: string
}

type UpdateCache = {
    checkedAt: string
    latest?: string
}

type UpdateCheckOptions = {
    cacheDir?: string
    currentVersion?: string
    fetchLatestVersion?: () => Promise<string | undefined>
    now?: Date
    ttlMs?: number
}

export async function checkForKonteksUpdate(
    options: UpdateCheckOptions = {},
): Promise<UpdateNotice | undefined> {
    if (globalThis.__konteksCheckForUpdateForTests) {
        return globalThis.__konteksCheckForUpdateForTests()
    }
    if (
        process.env.KONTEKS_SQLITE_TEST_DATABASE &&
        !options.fetchLatestVersion
    ) {
        return undefined
    }

    try {
        const current = options.currentVersion ?? getVersion()
        const now = options.now ?? new Date()
        const ttlMs = options.ttlMs ?? CACHE_TTL_MS
        const cacheDir = options.cacheDir ?? updateCacheDir()
        const cached = await readCachedUpdate(cacheDir)

        if (cached && now.getTime() - Date.parse(cached.checkedAt) < ttlMs) {
            return cached.latest
                ? noticeFromVersions(current, cached.latest)
                : undefined
        }

        const latest = await (
            options.fetchLatestVersion ?? fetchLatestVersion
        )().catch(() => undefined)
        if (!latest) {
            await writeCachedUpdate(cacheDir, {
                checkedAt: now.toISOString(),
            })
            return undefined
        }

        await writeCachedUpdate(cacheDir, {
            checkedAt: now.toISOString(),
            latest,
        })

        return noticeFromVersions(current, latest)
    } catch {
        return undefined
    }
}

function noticeFromVersions(
    current: string,
    latest: string,
): UpdateNotice | undefined {
    return isVersionNewer(latest, current)
        ? {
              command: updateCommand(),
              current,
              latest,
          }
        : undefined
}

async function fetchLatestVersion(): Promise<string | undefined> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
        const response = await fetch(REGISTRY_LATEST_URL, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
        })
        if (!response.ok) {
            return undefined
        }

        const payload = (await response.json()) as { version?: unknown }
        return typeof payload.version === 'string' ? payload.version : undefined
    } catch {
        return undefined
    } finally {
        clearTimeout(timeout)
    }
}

async function readCachedUpdate(
    cacheDir: string,
): Promise<UpdateCache | undefined> {
    try {
        const parsed = JSON.parse(
            await readFile(updateCachePath(cacheDir), 'utf8'),
        ) as {
            checkedAt?: unknown
            latest?: unknown
        }

        if (typeof parsed.checkedAt === 'string') {
            return {
                checkedAt: parsed.checkedAt,
                latest:
                    typeof parsed.latest === 'string'
                        ? parsed.latest
                        : undefined,
            }
        }
    } catch {
        return undefined
    }

    return undefined
}

async function writeCachedUpdate(
    cacheDir: string,
    cache: UpdateCache,
): Promise<void> {
    try {
        await mkdir(cacheDir, { recursive: true })
        await writeFile(
            updateCachePath(cacheDir),
            JSON.stringify(cache),
            'utf8',
        )
    } catch {
        // Cache writes are best-effort.
    }
}

function updateCachePath(cacheDir: string): string {
    return join(cacheDir, 'update-check.json')
}

function updateCacheDir(): string {
    const xdgCacheHome = process.env.XDG_CACHE_HOME
    if (xdgCacheHome) {
        return join(xdgCacheHome, 'konteks')
    }

    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
        return join(localAppData, 'konteks', 'cache')
    }

    return join(homedir(), '.cache', 'konteks')
}

function updateCommand(): string {
    const userAgent = process.env.npm_config_user_agent?.toLowerCase() ?? ''
    return userAgent.includes('bun') || process.versions.bun
        ? 'bun add -g konteks-cli'
        : 'npm install -g konteks-cli'
}

function isVersionNewer(candidate: string, current: string): boolean {
    const candidateParts = parseVersion(candidate)
    const currentParts = parseVersion(current)

    if (!candidateParts || !currentParts) {
        return false
    }

    for (let index = 0; index < candidateParts.length; index += 1) {
        if (candidateParts[index] > currentParts[index]) {
            return true
        }
        if (candidateParts[index] < currentParts[index]) {
            return false
        }
    }

    return false
}

function parseVersion(version: string): [number, number, number] | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version)
    if (!match) {
        return undefined
    }

    return [Number(match[1]), Number(match[2]), Number(match[3])]
}
