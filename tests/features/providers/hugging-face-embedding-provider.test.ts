import { describe, expect, it } from 'bun:test'
import toOwnedEmbeddingVector from '@/modules/embeddings/to-owned-embedding-vector'

describe('HuggingFaceEmbeddingProvider', () => {
    it('copies and disposes transformer tensor outputs', async () => {
        const data = new Float32Array([1, 2, 3])
        let disposed = false
        const vector = toOwnedEmbeddingVector({
            data,
            dispose() {
                disposed = true
            },
        })

        data[0] = 9
        expect(disposed).toBe(true)
        expect(vector).toEqual(new Float32Array([1, 2, 3]))
    })
})
