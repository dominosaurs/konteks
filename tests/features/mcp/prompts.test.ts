import { describe, expect, it } from 'bun:test'
import {
    getKonteksSkillFiles,
    registerKonteksPrompts,
} from '@/entrypoints/mcp/prompts'

type PromptRegistration = {
    config: {
        argsSchema?: Record<string, unknown>
        description?: string
    }
    handler: (args: Record<string, string>) => {
        messages: Array<{
            content: { text: string; type: 'text' }
            role: 'user'
        }>
    }
    name: string
}

class FakeServer {
    public readonly registrations: PromptRegistration[] = []

    public registerPrompt(
        name: string,
        config: PromptRegistration['config'],
        handler: PromptRegistration['handler'],
    ): void {
        this.registrations.push({ config, handler, name })
    }
}

describe('mcp/prompts', () => {
    it('registers lifecycle prompts in API order', () => {
        const server = new FakeServer()

        registerKonteksPrompts(server as never)

        expect(server.registrations.map(prompt => prompt.name)).toEqual([
            'konteks-recall',
            'konteks-save',
            'konteks-warm-up',
        ])
    })

    it('registers MCP metadata and renders prompt text messages', () => {
        const server = new FakeServer()

        registerKonteksPrompts(server as never)

        const warmUp = server.registrations.find(
            prompt => prompt.name === 'konteks-warm-up',
        )
        const result = warmUp?.handler({ focus: 'cli status command' })

        expect(warmUp?.config.description).toBe(
            'Open a fresh Konteks session with project context.',
        )
        expect(Object.keys(warmUp?.config.argsSchema ?? {})).toEqual(['focus'])
        expect(result?.messages).toEqual([
            {
                content: {
                    text: expect.stringContaining('cli status command'),
                    type: 'text',
                },
                role: 'user',
            },
        ])
        expect(result?.messages[0]?.content.text).toContain('konteks_warm_up')
        expect(result?.messages[0]?.content.text).toContain(
            'If the warm-up result includes an `update` object',
        )
    })

    it('renders missing optional placeholders as empty strings', () => {
        const server = new FakeServer()

        registerKonteksPrompts(server as never)

        const warmUp = server.registrations.find(
            prompt => prompt.name === 'konteks-warm-up',
        )
        const text = warmUp?.handler({}).messages[0]?.content.text

        expect(text).not.toContain('<prompt>')
        expect(text).toContain('Konteks is warmed up and ready for the task.')
    })

    it('converts bundled prompts to skill files', () => {
        const skills = getKonteksSkillFiles()
        const warmUp = skills.find(skill => skill.name === 'konteks-warm-up')
        const save = skills.find(skill => skill.name === 'konteks-save')

        expect(skills.map(skill => skill.name)).toEqual([
            'konteks-recall',
            'konteks-save',
            'konteks-warm-up',
        ])
        expect(warmUp?.content).toContain('name: konteks-warm-up')
        expect(warmUp?.content).toContain('any free-form text provided')
        expect(warmUp?.content).not.toContain('{{focus}}')
        expect(save?.content).toContain('"importance": 3')
    })
})
