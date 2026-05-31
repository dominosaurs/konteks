export default function toOwnedEmbeddingVector(value: unknown): Float32Array {
    try {
        return toFloat32Array(value).slice()
    } finally {
        disposeOutput(value)
    }
}

function toFloat32Array(value: unknown): Float32Array {
    if (
        typeof value === 'object' &&
        value !== null &&
        'data' in value &&
        (value as { data: unknown }).data instanceof Float32Array
    ) {
        return (value as { data: Float32Array }).data
    }

    if (Array.isArray(value)) {
        const numeric = value
            .flat(Infinity)
            .filter(item => typeof item === 'number') as number[]
        return Float32Array.from(numeric)
    }

    throw new Error('Unsupported embedding output format from provider.')
}

function disposeOutput(value: unknown): void {
    if (
        typeof value === 'object' &&
        value !== null &&
        'dispose' in value &&
        typeof (value as { dispose: unknown }).dispose === 'function'
    ) {
        const disposable = value as { dispose(): void }
        disposable.dispose()
    }
}
