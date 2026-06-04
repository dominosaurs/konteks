import { projectMemoryDatabasePath } from '@/database/services/project-memory'
import {
    type ProjectMemoryStats,
    readProjectMemoryStats,
} from '@/database/services/project-status'
import { getExtractionFreshness } from '@/modules/extraction/engine/manifest'
import { loadProjectContext, pathExists } from '@/modules/project/context'
import type { ConsoleColorPalette } from '@/support/console-output'
import { formatInteger } from '@/support/format/number'
import type { Project } from '@/types/project'
import BaseCommand from './_base-command'

export default class StatusCommand extends BaseCommand {
    public readonly description =
        'Print Konteks project memory status for humans.'
    public readonly name = 'status'
    public override readonly printsHeader = false

    public async handle(): Promise<void> {
        const context = await loadProjectContext()
        const statusReader = new ProjectStatusReader()

        const status = await statusReader.read(context)

        this.consoleOutput
            .printHeader()
            .print(color => formatStatus(status, color))
    }
}

type ProjectStatus = {
    projectRoot: string
    memoryDir: string
    memoryDirExists: boolean
    configExists: boolean
    databasePath: string
    databaseExists: boolean
    databaseBusy: boolean
    memoryStats: ProjectMemoryStats
    freshness: {
        status: 'missing' | 'fresh' | 'stale'
        reason: string
        changedFileCount: number
        lastExtractedAt?: string
        recommendedCommand?: string
    }
}

interface ProjectStatusReaderContract {
    read(project: Project): Promise<ProjectStatus>
}

function formatStatus(
    status: ProjectStatus,
    color: ConsoleColorPalette,
): string {
    const statusDetail = formatStatusDetail(status, color)

    const lines = [
        '',
        row('Project', status.projectRoot, color),
        row('Memory', status.memoryDir, color),
        '',
        row('Status', statusDetail, color),
        row('Last indexed', formatLastIndexed(status), color),
        '',
        row('Source files', formatInteger(status.memoryStats.files), color),
        row('Vectors', formatInteger(status.memoryStats.embeddings), color),
        status.databaseBusy
            ? row(
                  'Database',
                  color.warning(
                      'busy: background maintenance or extraction is running',
                  ),
                  color,
              )
            : undefined,
        '',
        color.warning('  DERIVED MEMORY'),
        nestedRow('Modules', formatInteger(status.memoryStats.modules), color),
        nestedRow(
            'Sections',
            formatInteger(status.memoryStats.sections),
            color,
        ),
        '',
        color.warning('  DURABLE MEMORY'),
        nestedRow(
            'Memories',
            formatInteger(status.memoryStats.memories),
            color,
        ),
        nestedRow(
            'Diary entries',
            formatInteger(status.memoryStats.diaryEntries),
            color,
        ),
        '',
    ].filter(line => line !== undefined)

    return lines.join('\n')
}

function row(label: string, value: string, color: ConsoleColorPalette): string {
    return `  ${color.primary(label.padEnd(13))} ${value}`
}

function nestedRow(
    label: string,
    value: string,
    color: ConsoleColorPalette,
): string {
    return `  ${color.primary(label.padEnd(13))} ${value}`
}

function formatStatusDetail(
    status: ProjectStatus,
    color: ConsoleColorPalette,
): string {
    if (status.freshness.status === 'missing') {
        return color.error('NOT INITIALIZED')
    }

    if (
        status.freshness.status === 'stale' ||
        status.freshness.changedFileCount > 0
    ) {
        return color.warning('STALE')
    }

    return 'up-to-date'
}

function formatLastIndexed(status: ProjectStatus): string {
    return status.freshness.lastExtractedAt
        ? formatDate(status.freshness.lastExtractedAt)
        : 'Not indexed yet'
}

function formatDate(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        return value
    }
    return date.toLocaleString()
}

class ProjectStatusReader implements ProjectStatusReaderContract {
    public async read(context: Project): Promise<ProjectStatus> {
        const databasePath = projectMemoryDatabasePath(context)
        const memoryDirExists = await pathExists(context.memoryDir)
        const databaseExists = await pathExists(databasePath)
        const initialized = memoryDirExists && context.configExists
        const memoryStats = await readStatusMemoryStats(databaseExists)

        return {
            configExists: context.configExists,
            databaseBusy: memoryStats.databaseBusy,
            databaseExists,
            databasePath,
            freshness: initialized
                ? await getExtractionFreshness(context)
                : {
                      changedFileCount: 0,
                      reason: 'Konteks project memory is not initialized.',
                      recommendedCommand: 'konteks init',
                      status: 'missing',
                  },
            memoryDir: context.memoryDir,
            memoryDirExists,
            memoryStats: memoryStats.value,
            projectRoot: context.projectRoot,
        }
    }
}

async function readStatusMemoryStats(
    databaseExists: boolean,
): Promise<{ databaseBusy: boolean; value: ProjectStatus['memoryStats'] }> {
    if (!databaseExists) {
        return { databaseBusy: false, value: emptyMemoryStats() }
    }

    try {
        return {
            databaseBusy: false,
            value: await readProjectMemoryStats(),
        }
    } catch (error) {
        if (isSqliteBusyError(error)) {
            return { databaseBusy: true, value: emptyMemoryStats() }
        }
        throw error
    }
}

function isSqliteBusyError(error: unknown): boolean {
    let current: unknown = error
    while (current instanceof Error) {
        if (
            current.message.includes('SQLITE_BUSY') ||
            current.message.includes('database is locked')
        ) {
            return true
        }
        current = current.cause
    }
    return false
}

function emptyMemoryStats(): ProjectStatus['memoryStats'] {
    return {
        diaryEntries: 0,
        embeddings: 0,
        events: 0,
        files: 0,
        memories: 0,
        modules: 0,
        retrievalDocuments: 0,
        sections: 0,
    }
}
