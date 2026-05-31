import { describe, expect, it } from 'bun:test'
import HuggingFaceEmbeddingProvider from '@/modules/embeddings/hugging-face-embedding-provider'

describe('HuggingFaceEmbeddingProvider', () => {
    it('copies and disposes transformer tensor outputs', async () => {
        const data = new Float32Array([1, 2, 3])
        let disposed = false
        const provider = new HuggingFaceEmbeddingProvider() as unknown as {
            embed(texts: string[]): Promise<Float32Array[]>
            extractor: () => Promise<{
                data: Float32Array
                dispose(): void
            }>
        }
        provider.extractor = async () => ({
            data,
            dispose() {
                disposed = true
            },
        })

        const [vector] = await provider.embed(['fixture'])

        data[0] = 9
        expect(disposed).toBe(true)
        expect(vector).toEqual(new Float32Array([1, 2, 3]))
    })
})
