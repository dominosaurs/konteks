import type { Command as CommanderCommand } from 'commander'
import consoleOutput from '@/support/console-output'
import getVersion from '@/support/get-version'
import { checkForKonteksUpdate } from '@/support/update-check'

export type Command = CommanderCommand

export type BaseCommandContext = {
    runInitializationGuard: () => Promise<void>
}

export type BaseCommandInput<
    Args extends unknown[] = unknown[],
    Options extends object = Record<string, never>,
> = {
    args?: Args
    options?: Options
}

export default abstract class BaseCommand<
    Args extends unknown[] = unknown[],
    Options extends object = Record<string, never>,
> {
    public abstract readonly description: string
    public abstract readonly name: string

    public readonly args: {
        readonly name: string
        readonly description?: string
    }[] = []
    public readonly children: InstanceType<typeof BaseCommand>[] = []
    public readonly options: {
        readonly flags: string
        readonly description?: string
        readonly parser?: (value: string, previous: unknown) => unknown
    }[] = []
    public readonly printsHeader: boolean = true
    public readonly usesInitializationGuard: boolean = true

    protected readonly consoleOutput = consoleOutput

    public abstract handle(
        input?: BaseCommandInput<Args, Options>,
    ): Promise<void> | void

    public register(parent: Command, context: BaseCommandContext) {
        const command = parent.command(this.name).description(this.description)

        this.registerAction(command, context)
        this.registerArgs(command)
        this.registerChildren(command, context)
        this.registerOptions(command)
    }

    private registerAction(
        command: Command,
        context: BaseCommandContext,
    ): void {
        command.action(async (...values: unknown[]) => {
            const commandOptions = command.opts<Options>()
            const args = stripCommanderActionValues(
                values.slice(0, -1),
                commandOptions,
            ) as Args

            if (this.printsHeader) {
                const version = getVersion()
                this.consoleOutput.print(
                    color =>
                        `${color.primary('Konteks')} ${color.dim(`v${version}`)}`,
                )
            }

            if (this.usesInitializationGuard) {
                await context.runInitializationGuard()
            }

            await this.handle({
                args,
                options: commandOptions,
            })

            if (this.name !== 'mcp') {
                await printUpdateNotice()
            }
        })
    }

    private registerArgs(command: Command): void {
        this.args.forEach(({ name, description }) => {
            command.argument(name, description)
        })
    }

    private registerChildren(
        command: Command,
        context: BaseCommandContext,
    ): void {
        this.children.forEach(child => {
            child.register(command, context)
        })
    }

    private registerOptions(command: Command): void {
        this.options.forEach(({ description, flags, parser }) => {
            if (parser) {
                command.option(flags, description ?? '', parser)
                return
            }

            command.option(flags, description)
        })
    }
}

async function printUpdateNotice(): Promise<void> {
    const update = await checkForKonteksUpdate()
    if (!update) {
        return
    }

    consoleOutput.print(color =>
        [
            '',
            `${color.warning('Update available')}: konteks-cli ${update.current} -> ${update.latest}`,
            `${color.dim('Run')}: ${color.primary(update.command)}`,
        ].join('\n'),
    )
}

function stripCommanderActionValues<Options extends object>(
    values: unknown[],
    options: Options,
): unknown[] {
    const lastValue = values.at(-1)
    if (lastValue === options || isPlainObject(lastValue)) {
        return values.slice(0, -1)
    }

    return values
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    )
}
