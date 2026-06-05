import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Command } from 'commander'
import BaseCommand from '@/entrypoints/cli/commands/_base-command'
import consoleOutput from '@/support/console-output'

class FixtureCommand extends BaseCommand {
    public readonly description = 'Fixture command.'
    public readonly name: string

    public constructor(name = 'status') {
        super()
        this.name = name
    }

    public handle(): void {
        this.consoleOutput.print('command complete')
    }
}

describe('CLI update notices', () => {
    afterEach(() => {
        globalThis.__konteksCheckForUpdateForTests = undefined
    })

    it('prints an update notice after successful human CLI commands', async () => {
        globalThis.__konteksCheckForUpdateForTests = async () => ({
            command: 'bun add -g konteks-cli',
            current: '1.0.0',
            latest: '1.1.0',
        })
        const output = await runFixtureCommand('status')

        expect(output).toContain('command complete')
        expect(output).toContain('Update available')
        expect(output).toContain('konteks-cli 1.0.0 -> 1.1.0')
        expect(output).toContain('bun add -g konteks-cli')
        expect(output.indexOf('command complete')).toBeLessThan(
            output.indexOf('Update available'),
        )
    })

    it('does not print an update notice for the MCP server command', async () => {
        globalThis.__konteksCheckForUpdateForTests = async () => ({
            command: 'bun add -g konteks-cli',
            current: '1.0.0',
            latest: '1.1.0',
        })
        const output = await runFixtureCommand('mcp')

        expect(output).toContain('command complete')
        expect(output).not.toContain('Update available')
    })
})

async function runFixtureCommand(name: string): Promise<string> {
    const messages: string[] = []
    const printSpy = spyOn(consoleOutput, 'print').mockImplementation(
        message => {
            messages.push(
                typeof message === 'function'
                    ? message(consoleOutput.colorPalette)
                    : String(message),
            )
            return consoleOutput
        },
    )

    try {
        const program = new Command()
        new FixtureCommand(name).register(program, {
            runInitializationGuard: async () => {},
        })
        await program.parseAsync([name], { from: 'user' })
    } finally {
        printSpy.mockRestore()
    }

    return messages.join('\n')
}
