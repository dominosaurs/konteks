import { describe, expect, it } from 'bun:test'
import { toOwnedFloat32Array } from '@/modules/embeddings/hugging-face-embedding-provider'

describe('HuggingFaceEmbeddingProvider', () => {
    it('copies and disposes transformer tensor outputs', () => {
        const data = new Float32Array([1, 2, 3])
        let disposed = false

        const vector = toOwnedFloat32Array({
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
