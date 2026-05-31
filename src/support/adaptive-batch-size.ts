import { freemem } from 'node:os'

const MEBIBYTE = 1024 * 1024
const DEFAULT_MEMORY_FRACTION = 0.15
const DEFAULT_MAX_BUDGET_BYTES = 256 * MEBIBYTE
const DEFAULT_MIN_BATCH_SIZE = 500
const DEFAULT_MAX_BATCH_SIZE = 5000

type AdaptiveBatchSizeInput = {
    availableBytes?: number
    estimatedItemBytes: number
    maxBatchSize?: number
    maxBudgetBytes?: number
    memoryFraction?: number
    minBatchSize?: number
    totalItems?: number
}

export function adaptiveBatchSize(input: AdaptiveBatchSizeInput): number {
    if (input.totalItems !== undefined && input.totalItems <= 0) {
        return 0
    }

    const minBatchSize = input.minBatchSize ?? DEFAULT_MIN_BATCH_SIZE
    const maxBatchSize = input.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    const memoryFraction = input.memoryFraction ?? DEFAULT_MEMORY_FRACTION
    const maxBudgetBytes = input.maxBudgetBytes ?? DEFAULT_MAX_BUDGET_BYTES
    const estimatedItemBytes = Math.max(1, input.estimatedItemBytes)
    const availableBytes = input.availableBytes ?? freemem()
    const memoryBudgetBytes = Math.max(
        0,
        Math.min(availableBytes * memoryFraction, maxBudgetBytes),
    )
    const memoryBatchSize = Math.floor(memoryBudgetBytes / estimatedItemBytes)
    const clampedBatchSize = Math.max(
        minBatchSize,
        Math.min(maxBatchSize, memoryBatchSize),
    )

    if (input.totalItems === undefined) {
        return clampedBatchSize
    }

    return Math.min(input.totalItems, clampedBatchSize)
}
