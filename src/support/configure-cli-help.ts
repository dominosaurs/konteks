import { encode } from '@toon-format/toon'
import { determineAgent } from '@vercel/detect-agent'
import type { Command, Help } from 'commander'
import consoleOutput, { type ConsoleColorPalette } from './console-output'
import stripAnsi from './strip-ansi'

export async function configureCliHelp(program: Command): Promise<void> {
    const { isAgent } = await determineAgent()

    program.configureHelp({
        formatHelp: (command, helper) => {
            applyHelpTheme(helper, consoleOutput.colorPalette)
            const help = formatCommandHelp(
                command,
                helper,
                consoleOutput.colorPalette,
            )

            if (isAgent) {
                return formatHelpForAgent(help)
            }

            return `${consoleOutput.header()}\n\n${help}`
        },
    })
}

type AgentHelpEntry = {
    term: string
    description?: string
}

type AgentHelpLegend = {
    term: string
    meaning: string
}

type AgentHelpToon = {
    usage?: string
    entries?: AgentHelpEntry[]
    legend?: AgentHelpLegend[]
}

function formatHelpForAgent(help: string): string {
    const output: AgentHelpToon = {}
    const entries: AgentHelpEntry[] = []
    const legend: AgentHelpLegend[] = []

    for (const line of stripAnsi(help).trimEnd().split('\n')) {
        const trimmed = line.trim()

        if (trimmed.length === 0) {
            continue
        }

        if (trimmed.startsWith('USAGE ')) {
            output.usage = trimmed.slice('USAGE '.length)
            continue
        }

        const item = parseHelpItem(trimmed)
        if (!item) {
            continue
        }

        if (isLegendItem(item)) {
            legend.push({
                meaning: item.description ?? '',
                term: item.term,
            })
            continue
        }

        entries.push(item)
    }

    if (entries.length > 0) {
        output.entries = entries
    }

    if (legend.length > 0) {
        output.legend = legend
    }

    return encode(output)
}

function parseHelpItem(line: string): AgentHelpEntry | undefined {
    const [term, description] = line.split(/\s{2,}/u, 2)

    if (!term) {
        return undefined
    }

    return {
        description: description || undefined,
        term,
    }
}

function isLegendItem(item: AgentHelpEntry): boolean {
    return (
        (item.term === '<value>' || item.term === '[value]') &&
        (item.description === 'required' || item.description === 'optional')
    )
}

function applyHelpTheme(helper: Help, color: ConsoleColorPalette): void {
    helper.styleArgumentTerm = argument => color.secondary(argument)
    helper.styleArgumentText = argument => color.secondary(argument)
    helper.styleCommandText = command => color.primary(command)
    helper.styleDescriptionText = description => color.dim(description)
    helper.styleOptionTerm = term => highlightCliSyntax(term, color)
    helper.styleOptionText = option => color.primary(option)
    helper.styleSubcommandTerm = term => highlightCliSyntax(term, color)
    helper.styleTitle = title => color.warning(title.replace(/:$/u, ''))
    helper.styleUsage = usage => highlightCliSyntax(usage, color)
}

function formatCommandHelp(
    command: Command,
    helper: Help,
    color: ConsoleColorPalette,
): string {
    const termWidth = helper.padWidth(command, helper)
    const output = [
        `${color.warning('  USAGE')} ${helper.styleUsage(helper.commandUsage(command))}`,
        '',
    ]

    output.push(...formatArgumentSection(command, helper, termWidth))
    output.push(...formatCommandSection(command, helper, termWidth))
    output.push(...formatOptionSections(command, helper, termWidth))
    output.push(...formatArgumentLegend(command, helper, color))

    return `${output.join('\n')}\n`
}

function formatArgumentSection(
    command: Command,
    helper: Help,
    termWidth: number,
): string[] {
    const argumentsList = helper.visibleArguments(command).map(argument => {
        return helper.formatItem(
            helper.styleArgumentTerm(helper.argumentTerm(argument)),
            termWidth,
            helper.styleArgumentDescription(
                helper.argumentDescription(argument),
            ),
            helper,
        )
    })

    return formatItemRows(argumentsList)
}

function formatCommandSection(
    command: Command,
    helper: Help,
    termWidth: number,
): string[] {
    const commandGroups = helper.groupItems(
        [...command.commands],
        helper.visibleCommands(command),
        subcommand => subcommand.helpGroup() || 'Commands:',
    )
    const output: string[] = []

    commandGroups.forEach(commands => {
        const commandList = commands.map(subcommand => {
            return helper.formatItem(
                helper.styleSubcommandTerm(helper.subcommandTerm(subcommand)),
                termWidth,
                helper.styleSubcommandDescription(
                    helper.subcommandDescription(subcommand),
                ),
                helper,
            )
        })

        output.push(...formatItemRows(commandList))
    })

    return output
}

function formatOptionSections(
    command: Command,
    helper: Help,
    termWidth: number,
): string[] {
    const output: string[] = []

    if (helper.showGlobalOptions) {
        const globalOptionList = helper
            .visibleGlobalOptions(command)
            .map(option => {
                return helper.formatItem(
                    helper.styleOptionTerm(helper.optionTerm(option)),
                    termWidth,
                    helper.styleOptionDescription(
                        helper.optionDescription(option),
                    ),
                    helper,
                )
            })

        output.push(...formatItemRows(globalOptionList))
    }

    const optionGroups = helper.groupItems(
        [...command.options],
        helper.visibleOptions(command),
        option => option.helpGroupHeading ?? 'Options:',
    )

    optionGroups.forEach(options => {
        const optionList = options.map(option => {
            return helper.formatItem(
                helper.styleOptionTerm(helper.optionTerm(option)),
                termWidth,
                helper.styleOptionDescription(helper.optionDescription(option)),
                helper,
            )
        })

        output.push(...formatItemRows(optionList))
    })

    return output
}

function formatItemRows(items: string[]): string[] {
    if (items.length === 0) {
        return []
    }

    return [...items, '']
}

function highlightCliSyntax(value: string, color: ConsoleColorPalette): string {
    return value
        .split(/(\s+)/u)
        .map(part => {
            if (/^\s+$/u.test(part)) {
                return part
            }

            if (part.startsWith('-')) {
                return color.primary(part)
            }

            if (/^(?:\[[^\]]+\]|<[^>]+>)$/u.test(part)) {
                return color.secondary(part)
            }

            return color.primary(part)
        })
        .join('')
}

function formatArgumentLegend(
    command: Command,
    helper: Help,
    color: ConsoleColorPalette,
): string[] {
    const terms = helper.visibleCommands(command).flatMap(child => {
        return helper.subcommandTerm(child).split(/\s+/u)
    })
    const helpTerms = [helper.commandUsage(command), ...terms]

    const hasRequired = helpTerms.some(term => /<[^>]+>/u.test(term))
    const hasOptional = helpTerms.some(term => /\[[^\]]+\]/u.test(term))

    if (!hasRequired && !hasOptional) {
        return []
    }

    const lines: string[] = []

    if (hasRequired) {
        lines.push(`  ${color.secondary('<value>')}  ${color.dim('required')}`)
    }

    if (hasOptional) {
        lines.push(`  ${color.secondary('[value]')}  ${color.dim('optional')}`)
    }

    lines.push('')

    return lines
}
