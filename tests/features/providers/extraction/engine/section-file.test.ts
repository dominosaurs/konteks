import { describe, expect, it } from 'bun:test'
import sectionFile from '@/modules/extraction/engine/section-file'

const file = {
    contentHash: 'hash',
    mtimeMs: 0,
    path: 'src/example.ts',
    sizeBytes: 100,
}

describe('sectionFile', () => {
    it('creates stable symbol anchors for heuristic code sections', async () => {
        const sections = await sectionFile(
            file,
            `
export function alpha() {
  return 1
}

export const beta = 2
`,
        )

        expect(sections.map(section => section.anchor)).toEqual([
            'alpha',
            'beta',
        ])
        expect(sections.every(section => section.anchorType === 'symbol')).toBe(
            true,
        )
    })

    it('creates heading and JSON path anchors', async () => {
        const markdown = await sectionFile(
            { ...file, path: 'README.md' },
            '# Intro\nHello\n\n## Usage\nRun it\n',
        )
        const json = await sectionFile(
            { ...file, path: 'package.json' },
            '{"name":"fixture","scripts":{"test":"bun test"}}',
        )

        expect(markdown.map(section => section.anchor)).toEqual([
            'intro',
            'usage',
        ])
        expect(json.map(section => section.anchor)).toEqual(['name', 'scripts'])
    })

    it('sections Markdown without a loaded Tree-sitter grammar', async () => {
        const sections = await sectionFile(
            { ...file, path: 'README.md' },
            '# Intro\nHello\n\n## Usage\nRun it\n',
        )

        expect(sections).toHaveLength(2)
        expect(sections.map(section => section.kind)).toEqual([
            'markdown',
            'markdown',
        ])
        expect(sections.map(section => section.heading)).toEqual([
            'Intro',
            'Usage',
        ])
    })

    it('sections non-JS Tree-sitter symbols from parsed metadata', async () => {
        const sections = await sectionFile(
            { ...file, path: 'main.py' },
            'def build_user():\n    return {}\n',
            undefined,
            {
                exports: [],
                imports: [],
                language: 'python',
                symbols: [
                    {
                        content: 'def build_user():\n    return {}\n',
                        endLine: 1,
                        isExported: false,
                        kind: 'function',
                        name: 'build_user',
                        startLine: 0,
                    },
                ],
            },
        )

        expect(sections.map(section => section.anchor)).toEqual(['build_user'])
        expect(sections[0]?.metadata).toMatchObject({
            nodeKind: 'function',
            parserEngine: 'tree_sitter',
            parserStatus: 'ok',
        })
    })

    it('treats unsupported code-like extensions as text', async () => {
        const sections = await sectionFile(
            { ...file, path: 'schema.sql' },
            'CREATE TABLE users (id INTEGER PRIMARY KEY);\n',
        )

        expect(sections).toHaveLength(1)
        expect(sections[0]?.kind).toBe('text')
        expect(sections[0]?.anchor).toBe('file')
    })

    it('marks supported code as Tree-sitter processed when no symbols are found', async () => {
        const sections = await sectionFile(
            { ...file, path: 'src/empty.ts' },
            'export {}\n',
            undefined,
            {
                exports: [],
                imports: [],
                language: 'typescript',
                symbols: [],
            },
        )

        expect(sections).toHaveLength(1)
        expect(sections[0]?.anchor).toBe('file')
        expect(sections[0]?.metadata).toMatchObject({
            parserEngine: 'tree_sitter',
            parserStatus: 'ok',
        })
    })

    it('extracts code comments as prose sections with stable anchors', async () => {
        const sections = await sectionFile(
            file,
            [
                '// Explains the payment retry convention.',
                '// Keep retries idempotent for invoices.',
                'export function chargeInvoice() {',
                '  return true',
                '}',
                '/* Settlement comments describe ledger behavior. */',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments).toHaveLength(2)
        expect(comments[0]?.anchor).toMatch(/^comment-1-/u)
        expect(comments[0]?.anchorType).toBe('comment')
        expect(comments[0]?.content).toBe(
            [
                'Explains the payment retry convention.',
                'Keep retries idempotent for invoices.',
            ].join('\n'),
        )
        expect(comments[0]?.metadata).toMatchObject({
            contentType: 'prose',
            proseKind: 'comment',
        })
        expect(comments[1]?.content).toBe(
            'Settlement comments describe ledger behavior.',
        )
    })

    it('ignores URL literals when extracting line comments', async () => {
        const sections = await sectionFile(
            file,
            [
                "const single = 'https://example.com/v1'",
                'const double = "https://example.com/v2"',
                'const template = `https://example.com/v3`',
                "const endpoint = 'https://example.com/v4' // public API endpoint",
                '// retry convention',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            ['public API endpoint', 'retry convention'].join('\n'),
        ])
    })

    it('preserves quote state across multiline URL literals', async () => {
        const sections = await sectionFile(
            file,
            [
                'const template = `',
                'https://example.com/template-path',
                '`',
                "const single = 'https://example.com/single-path\\",
                "continued-value'",
                '// real comment after strings',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            'real comment after strings',
        ])
    })

    it('extracts C-like docblocks without reading markers inside strings', async () => {
        const sections = await sectionFile(
            { ...file, path: 'main.go' },
            [
                'package main',
                'const literal = "/* not a comment */"',
                '/// Public handler contract.',
                '/**',
                ' * Handles invoice settlement.',
                ' */',
                'func main() {}',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            'Public handler contract.',
            'Handles invoice settlement.',
        ])
    })

    it('extracts Python comments and docstrings safely', async () => {
        const sections = await sectionFile(
            { ...file, path: 'main.py' },
            [
                '"""Module explains retry policy."""',
                'literal = """not extracted as a docstring"""',
                'url = "https://example.com/#anchor"',
                '# Inline policy note.',
                'def build_user():',
                '    """Function docstring explains users."""',
                '    return {}',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            'Module explains retry policy.',
            'Inline policy note.',
            'Function docstring explains users.',
        ])
    })

    it('extracts Ruby comments and block comments', async () => {
        const sections = await sectionFile(
            { ...file, path: 'main.rb' },
            [
                "url = 'https://example.com/#anchor'",
                '# Ruby policy note.',
                '=begin',
                'Ruby block comment explains setup.',
                '=end',
                'def build_user',
                'end',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            'Ruby policy note.',
            'Ruby block comment explains setup.',
        ])
    })

    it('extracts Lua comments and long comments', async () => {
        const sections = await sectionFile(
            { ...file, path: 'main.lua' },
            [
                'local url = "https://example.com/path--literal"',
                '-- Lua policy note.',
                '--[[',
                'Lua long comment explains setup.',
                ']]',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            'Lua policy note.',
            'Lua long comment explains setup.',
        ])
    })

    it('extracts markup comments', async () => {
        const sections = await sectionFile(
            { ...file, path: 'index.html' },
            '<main><!-- Render policy note. --></main>',
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            'Render policy note.',
        ])
    })

    it('extracts shell comments while skipping shebangs', async () => {
        const sections = await sectionFile(
            { ...file, path: 'script.sh' },
            [
                '#!/usr/bin/env bash',
                'url="https://example.com/#anchor"',
                '# Shell policy note.',
            ].join('\n'),
        )

        const comments = sections.filter(section => section.kind === 'comment')

        expect(comments.map(section => section.content)).toEqual([
            'Shell policy note.',
        ])
    })

    it('attaches parsed comment prose to the nearest symbol', async () => {
        const sections = await sectionFile(
            { ...file, path: 'src/payments.ts' },
            [
                '// Invoice settlement policy lives with chargeInvoice.',
                'export function chargeInvoice() {',
                '  return true',
                '}',
            ].join('\n'),
            undefined,
            {
                exports: [],
                imports: [],
                language: 'typescript',
                symbols: [
                    {
                        content:
                            'export function chargeInvoice() {\n  return true\n}',
                        endLine: 3,
                        isExported: true,
                        kind: 'function',
                        name: 'chargeInvoice',
                        startLine: 1,
                    },
                ],
            },
        )

        const comment = sections.find(section => section.kind === 'comment')

        expect(comment?.symbol).toBe('chargeInvoice')
        expect(comment?.metadata).toMatchObject({
            attachedSymbol: 'chargeInvoice',
        })
    })
})
