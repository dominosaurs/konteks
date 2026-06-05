import { withoutDatabaseTransactionContext } from '@/database/actions/_db'
import { withLoadedProjectContext } from '@/modules/project/context'
import { appendProjectErrorLog } from '@/support/error-log'
import type { LoadedProjectContext } from '@/types/project'

type MemoryMaintenanceInput = {
    dedupeKey?: string
    metadata?: Record<string, unknown>
    operation: () => Promise<void>
    operationName: string
}

declare global {
    var __konteksWaitForMemoryMaintenanceForTests:
        | (() => Promise<void>)
        | undefined
}

const queues = new Map<string, Promise<void>>()
const activeDedupeKeys = new Set<string>()

globalThis.__konteksWaitForMemoryMaintenanceForTests = async () => {
    await Promise.all(queues.values())
}

export function scheduleMemoryMaintenance(
    context: LoadedProjectContext,
    input: MemoryMaintenanceInput,
): void {
    const dedupeKey = input.dedupeKey
        ? `${context.projectRoot}:${input.dedupeKey}`
        : undefined
    if (dedupeKey && activeDedupeKeys.has(dedupeKey)) {
        return
    }
    if (dedupeKey) {
        activeDedupeKeys.add(dedupeKey)
    }

    const previous = queues.get(context.projectRoot) ?? Promise.resolve()
    const queued = previous
        .catch(() => undefined)
        .then(() =>
            withoutDatabaseTransactionContext(() =>
                withLoadedProjectContext(context, () =>
                    Promise.resolve().then(input.operation),
                ),
            ),
        )
        .catch(async error => {
            await withLoadedProjectContext(context, () =>
                appendProjectErrorLog({
                    error,
                    metadata: {
                        ...input.metadata,
                        operation: input.operationName,
                    },
                    surface: 'background_maintenance',
                }),
            )
        })

    const tracked = queued.finally(() => {
        if (queues.get(context.projectRoot) === tracked) {
            queues.delete(context.projectRoot)
        }
        if (dedupeKey) {
            activeDedupeKeys.delete(dedupeKey)
        }
    })
    queues.set(context.projectRoot, tracked)
}
