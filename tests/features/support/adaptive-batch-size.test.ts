import { describe, expect, it } from 'bun:test'
import { adaptiveBatchSize } from '@/support/adaptive-batch-size'

describe('adaptiveBatchSize', () => {
    it('uses the total item count when it is smaller than the calculated batch', () => {
        expect(
            adaptiveBatchSize({
                availableBytes: 8 * 1024 * 1024 * 1024,
                estimatedItemBytes: 1024,
                totalItems: 300,
            }),
        ).toBe(300)
    })

    it('chooses multiple batches under constrained memory', () => {
        expect(
            adaptiveBatchSize({
                availableBytes: 64 * 1024 * 1024,
                estimatedItemBytes: 4096,
                totalItems: 20_000,
            }),
        ).toBe(2457)
    })

    it('caps high-memory batches', () => {
        expect(
            adaptiveBatchSize({
                availableBytes: 64 * 1024 * 1024 * 1024,
                estimatedItemBytes: 1024,
                totalItems: 20_000,
            }),
        ).toBe(5000)
    })
})
