import { fileURLToPath } from 'node:url'
import treeSitterToml from '../../node_modules/@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm'
import treeSitterYaml from '../../node_modules/@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm'
import treeSitterJson from '../../node_modules/tree-sitter-json/tree-sitter-json.wasm'
import webTreeSitterWasm from '../../node_modules/web-tree-sitter/web-tree-sitter.wasm'

type RuntimeAsset = {
    id: RuntimeAssetId
    path: unknown
}

export type BundledGrammarRuntimeAssetId =
    | 'tree-sitter-json'
    | 'tree-sitter-toml'
    | 'tree-sitter-yaml'

export type RuntimeAssetId = BundledGrammarRuntimeAssetId | 'web-tree-sitter'

const runtimeAssets: Record<RuntimeAssetId, RuntimeAsset> = {
    'tree-sitter-json': {
        id: 'tree-sitter-json',
        path: treeSitterJson,
    },
    'tree-sitter-toml': {
        id: 'tree-sitter-toml',
        path: treeSitterToml,
    },
    'tree-sitter-yaml': {
        id: 'tree-sitter-yaml',
        path: treeSitterYaml,
    },
    'web-tree-sitter': {
        id: 'web-tree-sitter',
        path: webTreeSitterWasm,
    },
}

export async function runtimeAssetPath(id: RuntimeAssetId): Promise<string> {
    return fileURLToPath(
        new URL(
            runtimeAssetImportPath(runtimeAssets[id].path),
            import.meta.url,
        ),
    )
}

function runtimeAssetImportPath(path: unknown): string {
    const resolved = findRuntimeAssetImportPath(path)
    if (resolved) {
        return resolved
    }

    throw new Error('Bundled runtime asset did not resolve to a file path.')
}

function findRuntimeAssetImportPath(
    value: unknown,
    seen = new Set<unknown>(),
): string | undefined {
    if (typeof value === 'string') {
        return value
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) {
        return undefined
    }

    seen.add(value)
    const record = value as Record<string, unknown>
    const defaultValue = findRuntimeAssetImportPath(record.default, seen)
    if (defaultValue) {
        return defaultValue
    }

    return Object.values(record)
        .map(entry => findRuntimeAssetImportPath(entry, seen))
        .find((entry): entry is string => entry !== undefined)
}
