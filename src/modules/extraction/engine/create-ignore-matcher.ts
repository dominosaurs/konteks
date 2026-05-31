import { ignoreRules } from '@/assets/ignore-rules'

export type IgnoreMatcher = {
    explain(relativePath: string): IgnoreReason | undefined
    ignores(relativePath: string): boolean
}

export type IgnoreReason =
    | 'binary'
    | 'generated'
    | 'hard_directory'
    | 'ignored_file'
    | 'konteksignore'
    | 'lockfile'
    | 'minified'
    | 'secret'
    | 'vcs_ignore'

type IgnorePattern = {
    basePath: string
    negated: boolean
    onlyDirectory: boolean
    pattern: string
    rootRelative: boolean
}

export type GitignoreSource = {
    basePath: string
    content: string
}

function getHardIgnoreReason(relativePath: string): IgnoreReason | undefined {
    const normalized = relativePath.replaceAll('\\', '/')
    const parts = normalized.split('/').filter(Boolean)
    const fileName = (parts.at(-1) ?? '').toLowerCase()

    if (
        parts.some(part => ignoreRules.directoryNames.has(part.toLowerCase()))
    ) {
        return 'hard_directory'
    }

    if (parts.some(part => part.startsWith('.konteks-mcp-dry-run-'))) {
        return 'hard_directory'
    }

    const generatedReason = generatedOrMinifiedReason(normalized)
    if (generatedReason) {
        return generatedReason
    }

    if (isLockfile(fileName)) {
        return 'lockfile'
    }

    if (fileName === '.env' || fileName.startsWith('.env.')) {
        return 'secret'
    }

    if (ignoreRules.secretFileNames.has(fileName)) {
        return 'secret'
    }

    if (ignoreRules.fileNames.has(fileName)) {
        return 'ignored_file'
    }

    if (isSecretExtension(fileName)) {
        return 'secret'
    }

    if (ignoreRules.binaryExtensions.has(extensionOf(fileName))) {
        return 'binary'
    }

    return undefined
}

export default function createIgnoreMatcher(input: {
    gitignore?: string | GitignoreSource[]
    konteksignore?: string
}): IgnoreMatcher {
    const gitignorePatterns = gitignoreSources(input.gitignore).flatMap(
        source =>
            parseIgnoreFile(source.content, {
                allowNegation: true,
                basePath: source.basePath,
            }),
    )
    const konteksignorePatterns = parseIgnoreFile(input.konteksignore ?? '', {
        allowNegation: false,
        basePath: '',
    })

    return {
        explain(relativePath) {
            const normalized = relativePath.replaceAll('\\', '/')
            const hardReason = getHardIgnoreReason(normalized)
            if (hardReason) {
                return hardReason
            }
            if (matchesPatterns(normalized, gitignorePatterns)) {
                return 'vcs_ignore'
            }
            if (matchesPatterns(normalized, konteksignorePatterns)) {
                return 'konteksignore'
            }

            return undefined
        },
        ignores(relativePath) {
            return this.explain(relativePath) !== undefined
        },
    }
}

function parseIgnoreFile(
    content: string,
    options: { allowNegation: boolean; basePath: string },
): IgnorePattern[] {
    return content
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .map(line => {
            const negated = options.allowNegation && line.startsWith('!')
            const rawPattern = negated ? line.slice(1) : line
            const rootRelative = rawPattern.startsWith('/')
            const pattern = rawPattern.replace(/^\/+/u, '').replace(/\/+$/u, '')

            return {
                basePath: normalizeRelativePath(options.basePath),
                negated,
                onlyDirectory: rawPattern.endsWith('/'),
                pattern,
                rootRelative,
            }
        })
        .filter(pattern => pattern.pattern.length > 0)
}

function gitignoreSources(
    gitignore: string | GitignoreSource[] | undefined,
): GitignoreSource[] {
    if (Array.isArray(gitignore)) {
        return gitignore.map(source => ({
            basePath: normalizeRelativePath(source.basePath),
            content: source.content,
        }))
    }

    return [
        {
            basePath: '',
            content: gitignore ?? '',
        },
    ]
}

function matchesPatterns(path: string, patterns: IgnorePattern[]): boolean {
    let ignored = false

    for (const pattern of patterns) {
        if (!matchesPattern(path, pattern)) {
            continue
        }
        ignored = !pattern.negated
    }

    return ignored
}

function matchesPattern(path: string, pattern: IgnorePattern): boolean {
    const pathForPattern = pathRelativeToPatternBase(path, pattern)
    if (pathForPattern === undefined) {
        return false
    }

    if (pattern.onlyDirectory) {
        return matchesPathOrDescendant(pathForPattern, pattern)
    }

    if (pattern.pattern.includes('*')) {
        return matchesGlob(pathForPattern, pattern)
    }

    if (pattern.rootRelative || pattern.pattern.includes('/')) {
        return (
            pathForPattern === pattern.pattern ||
            pathForPattern.startsWith(`${pattern.pattern}/`)
        )
    }

    return pathForPattern.split('/').includes(pattern.pattern)
}

function pathRelativeToPatternBase(
    path: string,
    pattern: IgnorePattern,
): string | undefined {
    if (!pattern.basePath) {
        return path
    }
    if (path === pattern.basePath) {
        return ''
    }
    if (!path.startsWith(`${pattern.basePath}/`)) {
        return undefined
    }
    return path.slice(pattern.basePath.length + 1)
}

function matchesPathOrDescendant(
    path: string,
    pattern: IgnorePattern,
): boolean {
    if (pattern.rootRelative || pattern.pattern.includes('/')) {
        return (
            path === pattern.pattern || path.startsWith(`${pattern.pattern}/`)
        )
    }

    return path.split('/').includes(pattern.pattern)
}

function matchesGlob(path: string, pattern: IgnorePattern): boolean {
    const regex = globToRegex(pattern.pattern)

    if (pattern.rootRelative || pattern.pattern.includes('/')) {
        return regex.test(path)
    }

    return path.split('/').some(part => regex.test(part))
}

function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
        .replace(/\*/gu, '[^/]*')
        .replace(/\?/gu, '[^/]')

    return new RegExp(`^${escaped}$`, 'u')
}

function generatedOrMinifiedReason(path: string): IgnoreReason | undefined {
    const lowerPath = path.toLowerCase()
    const fileName = lowerPath.split('/').at(-1) ?? lowerPath

    if (
        ignoreRules.generatedPathFragments.some(fragment =>
            lowerPath.includes(fragment),
        )
    ) {
        return 'generated'
    }

    if (
        ignoreRules.generatedFileSuffixes.some(suffix =>
            fileName.endsWith(suffix),
        )
    ) {
        return 'generated'
    }

    if (
        ignoreRules.minifiedFileSuffixes.some(suffix =>
            fileName.endsWith(suffix),
        )
    ) {
        return 'minified'
    }

    return undefined
}

function isLockfile(fileName: string): boolean {
    return ignoreRules.lockFileNames.has(fileName)
}

function isSecretExtension(fileName: string): boolean {
    const extension = extensionOf(fileName)
    return ignoreRules.secretExtensions.has(extension)
}

function extensionOf(fileName: string): string {
    const dotIndex = fileName.lastIndexOf('.')
    return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

function normalizeRelativePath(path: string): string {
    return path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
}
