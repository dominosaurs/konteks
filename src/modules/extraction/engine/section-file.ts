import contentHash from '@/support/content-hash'
import type { ScannedFile } from './file-scan'
import { getGrammarForPath, isBundledGrammar } from './grammar-loader'
import type TreeSitterEngine from './tree-sitter-engine'
import type { CodeMetadata } from './tree-sitter-engine'

type ExtractedSection = {
    anchor: string
    anchorType: 'comment' | 'file' | 'heading' | 'json_path' | 'symbol'
    content: string
    kind: string
    path: string
    jsonPath?: string
    heading?: string
    summary: string
    symbol?: string
    startLine?: number
    endLine?: number
    metadata?: Record<string, unknown>
}

type CommentBlock = {
    content: string
    endLine: number
    startLine: number
}

type QuoteCharacter = '"' | "'" | '`'

type BlockCommentSyntax = {
    close: string
    docstring?: boolean
    lineStartOnly?: boolean
    open: string
}

type CommentSyntax = {
    blocks: BlockCommentSyntax[]
    lineMarkers: string[]
    quotes: QuoteCharacter[]
}

export default async function sectionFile(
    file: ScannedFile,
    content: string,
    engine?: TreeSitterEngine,
    parsedMetadata?: CodeMetadata,
): Promise<ExtractedSection[]> {
    const trimmed = content.trim()
    if (!trimmed) {
        return []
    }

    if (isMarkdown(file.path)) {
        return sectionMarkdown(file.path, trimmed)
    }

    if (isJson(file.path)) {
        return sectionJson(file.path, trimmed)
    }

    if (isCode(file.path)) {
        if (parsedMetadata) {
            return sectionCodeWithTreeSitter(file.path, trimmed, parsedMetadata)
        }
        if (engine) {
            const metadata = await engine.parse(file.path, content)
            if (metadata) {
                return sectionCodeWithTreeSitter(file.path, trimmed, metadata)
            }
        }
        return sectionCodeHeuristic(file.path, trimmed)
    }

    return sectionByWords(file.path, trimmed, 'text')
}

function sectionCodeWithTreeSitter(
    path: string,
    content: string,
    metadata: CodeMetadata,
): ExtractedSection[] {
    const commentSections = sectionCodeComments(path, content, metadata)

    if (metadata.symbols.length === 0) {
        return [
            ...sectionByWords(path, content, 'code', {
                metadata: {
                    parserEngine: 'tree_sitter',
                    parserStatus: 'ok',
                },
            }),
            ...commentSections,
        ]
    }

    return [
        ...metadata.symbols.flatMap(symbol => {
            return sectionByWords(path, symbol.content, 'code', {
                anchor: symbol.name,
                anchorType: 'symbol',
                endLine: symbol.endLine,
                metadata: {
                    exported: symbol.isExported,
                    nodeKind: symbol.kind,
                    parserEngine: 'tree_sitter',
                    parserStatus: 'ok',
                },
                startLine: symbol.startLine,
                symbol: symbol.name,
            })
        }),
        ...commentSections,
    ]
}

function sectionCodeHeuristic(
    path: string,
    content: string,
): ExtractedSection[] {
    const lines = content.split('\n')
    const sections: ExtractedSection[] = []
    let current: string[] = []
    let currentSymbol: string | undefined

    for (const line of lines) {
        const symbol = extractCodeSymbol(line)
        if (symbol && current.length > 0) {
            sections.push(
                ...sectionByWords(path, current.join('\n'), 'code', {
                    anchor: currentSymbol,
                    anchorType: currentSymbol ? 'symbol' : 'file',
                    symbol: currentSymbol,
                }),
            )
            current = []
        }

        currentSymbol = symbol ?? currentSymbol
        current.push(line)
    }

    if (current.length > 0) {
        sections.push(
            ...sectionByWords(path, current.join('\n'), 'code', {
                anchor: currentSymbol,
                anchorType: currentSymbol ? 'symbol' : 'file',
                symbol: currentSymbol,
            }),
        )
    }

    const codeSections =
        sections.length > 0 ? sections : sectionByWords(path, content, 'code')
    return [...codeSections, ...sectionCodeComments(path, content)]
}

function sectionCodeComments(
    path: string,
    content: string,
    metadata?: CodeMetadata,
): ExtractedSection[] {
    return extractCommentBlocks(path, content).flatMap(comment => {
        const symbol = attachedSymbol(comment, metadata)
        const hash = contentHash(comment.content).slice(0, 8)
        return sectionByWords(path, comment.content, 'comment', {
            anchor: `comment-${comment.startLine + 1}-${hash}`,
            anchorType: 'comment',
            endLine: comment.endLine,
            metadata: {
                attachedSymbol: symbol?.name,
                contentType: 'prose',
                proseKind: 'comment',
            },
            startLine: comment.startLine,
            symbol: symbol?.name,
        })
    })
}

function attachedSymbol(
    comment: CommentBlock,
    metadata?: CodeMetadata,
): { name: string } | undefined {
    const symbols = metadata?.symbols ?? []
    return (
        symbols.find(
            symbol =>
                comment.startLine >= symbol.startLine &&
                comment.endLine <= symbol.endLine,
        ) ?? symbols.find(symbol => symbol.startLine > comment.endLine)
    )
}

function extractCommentBlocks(path: string, content: string): CommentBlock[] {
    const syntax = commentSyntaxFor(path)
    const blocks: CommentBlock[] = []

    for (const marker of syntax.lineMarkers) {
        blocks.push(
            ...extractLineComments(
                content,
                marker,
                syntax.quotes,
                syntax.blocks.map(block => block.open),
            ),
        )
    }
    for (const blockSyntax of syntax.blocks) {
        blocks.push(
            ...(blockSyntax.docstring
                ? extractPythonDocstrings(content, blockSyntax)
                : extractBlockComments(content, blockSyntax, syntax.quotes)),
        )
    }

    return withoutOverlappingCommentBlocks(blocks)
        .map(block => ({
            ...block,
            content: normalizeCommentText(block.content),
        }))
        .filter(block => block.content.length > 0)
        .sort((left, right) => left.startLine - right.startLine)
}

function extractLineComments(
    content: string,
    marker: string,
    quotes: QuoteCharacter[],
    blockOpenMarkers: string[],
): CommentBlock[] {
    const blocks: CommentBlock[] = []
    const lines = content.split('\n')
    let current: string[] = []
    let startLine = 0
    let previousLine = -2
    let quote: QuoteCharacter | undefined
    let escaped = false

    for (const [index, line] of lines.entries()) {
        if (isShebang(line, marker)) {
            continue
        }
        const result = findLineCommentIndex(line, marker, quotes, {
            escaped,
            quote,
        })
        quote = result.quote
        escaped = result.escaped
        const commentIndex = result.index
        if (commentIndex < 0) {
            continue
        }
        if (
            blockOpenMarkers.some(blockOpen =>
                line.startsWith(blockOpen, commentIndex),
            )
        ) {
            continue
        }
        if (index !== previousLine + 1 && current.length > 0) {
            blocks.push({
                content: current.join('\n'),
                endLine: previousLine,
                startLine,
            })
            current = []
        }
        if (current.length === 0) {
            startLine = index
        }
        current.push(line.slice(commentIndex + marker.length))
        previousLine = index
    }

    if (current.length > 0) {
        blocks.push({
            content: current.join('\n'),
            endLine: previousLine,
            startLine,
        })
    }

    return blocks
}

function findLineCommentIndex(
    line: string,
    marker: string,
    quotes: QuoteCharacter[],
    state: {
        escaped: boolean
        quote?: QuoteCharacter
    },
): {
    escaped: boolean
    index: number
    quote?: QuoteCharacter
} {
    let quote = state.quote
    let escaped = state.escaped

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index]

        if (escaped) {
            escaped = false
            continue
        }
        if (character === '\\' && quote) {
            escaped = true
            continue
        }
        if (quote) {
            if (character === quote) {
                quote = undefined
            }
            continue
        }
        if (isQuoteCharacter(character, quotes)) {
            quote = character
            continue
        }
        if (line.startsWith(marker, index)) {
            return { escaped, index, quote }
        }
    }

    return { escaped, index: -1, quote }
}

function extractBlockComments(
    content: string,
    syntax: BlockCommentSyntax,
    quotes: QuoteCharacter[],
): CommentBlock[] {
    const blocks: CommentBlock[] = []
    let cursor = 0

    while (cursor < content.length) {
        const openIndex = findMarkerOutsideStrings(
            content,
            syntax.open,
            cursor,
            quotes,
        )
        if (openIndex < 0) {
            break
        }
        if (syntax.lineStartOnly && !isLineStartMarker(content, openIndex)) {
            cursor = openIndex + syntax.open.length
            continue
        }
        const closeIndex = content.indexOf(
            syntax.close,
            openIndex + syntax.open.length,
        )
        if (closeIndex < 0) {
            break
        }
        const startLine = lineForIndex(content, openIndex)
        const endLine = lineForIndex(content, closeIndex)
        blocks.push({
            content: content.slice(openIndex + syntax.open.length, closeIndex),
            endLine,
            startLine,
        })
        cursor = closeIndex + syntax.close.length
    }

    return blocks
}

function extractPythonDocstrings(
    content: string,
    syntax: BlockCommentSyntax,
): CommentBlock[] {
    const blocks: CommentBlock[] = []
    let cursor = 0

    while (cursor < content.length) {
        const openIndex = content.indexOf(syntax.open, cursor)
        if (openIndex < 0) {
            break
        }
        if (!isPythonDocstringStart(content, openIndex)) {
            cursor = openIndex + syntax.open.length
            continue
        }
        const closeIndex = content.indexOf(
            syntax.close,
            openIndex + syntax.open.length,
        )
        if (closeIndex < 0) {
            break
        }
        blocks.push({
            content: content.slice(openIndex + syntax.open.length, closeIndex),
            endLine: lineForIndex(content, closeIndex),
            startLine: lineForIndex(content, openIndex),
        })
        cursor = closeIndex + syntax.close.length
    }

    return blocks
}

function withoutOverlappingCommentBlocks(
    blocks: CommentBlock[],
): CommentBlock[] {
    const selected: CommentBlock[] = []
    const sorted = [...blocks].sort(
        (left, right) =>
            left.startLine - right.startLine || right.endLine - left.endLine,
    )

    for (const block of sorted) {
        if (
            selected.some(selectedBlock => rangesOverlap(block, selectedBlock))
        ) {
            continue
        }
        selected.push(block)
    }

    return selected
}

function rangesOverlap(left: CommentBlock, right: CommentBlock): boolean {
    return left.startLine <= right.endLine && right.startLine <= left.endLine
}

function commentSyntaxFor(path: string): CommentSyntax {
    const lowerPath = path.toLowerCase()
    if (lowerPath.endsWith('.py')) {
        return {
            blocks: [
                { close: '"""', docstring: true, open: '"""' },
                { close: "'''", docstring: true, open: "'''" },
            ],
            lineMarkers: ['#'],
            quotes: ['"', "'"],
        }
    }
    if (lowerPath.endsWith('.rb')) {
        return {
            blocks: [{ close: '=end', lineStartOnly: true, open: '=begin' }],
            lineMarkers: ['#'],
            quotes: ['"', "'", '`'],
        }
    }
    if (/\.(sh|bash|zsh)$/u.test(lowerPath)) {
        return {
            blocks: [],
            lineMarkers: ['#'],
            quotes: ['"', "'", '`'],
        }
    }
    if (/\.(html|htm|xml)$/u.test(lowerPath)) {
        return {
            blocks: [{ close: '-->', open: '<!--' }],
            lineMarkers: [],
            quotes: ['"', "'"],
        }
    }
    if (lowerPath.endsWith('.lua')) {
        return {
            blocks: [{ close: ']]', open: '--[[' }],
            lineMarkers: ['--'],
            quotes: ['"', "'"],
        }
    }
    return {
        blocks: [{ close: '*/', open: '/*' }],
        lineMarkers: ['//'],
        quotes: ['"', "'", '`'],
    }
}

function normalizeCommentText(value: string): string {
    return value
        .split('\n')
        .map(line =>
            line
                .replace(/^\s*\*\s?/u, '')
                .replace(/^\s*(?:\/{1,2}|!|#+|-{1,2})\s?/u, '')
                .replace(/^\s+/u, '')
                .replace(/\s+$/u, ''),
        )
        .join('\n')
        .trim()
}

function lineForIndex(content: string, index: number): number {
    return content.slice(0, index).split('\n').length - 1
}

function findMarkerOutsideStrings(
    content: string,
    marker: string,
    start: number,
    quotes: QuoteCharacter[],
): number {
    let quote: QuoteCharacter | undefined
    let escaped = false

    for (let index = start; index < content.length; index += 1) {
        const character = content[index]

        if (escaped) {
            escaped = false
            continue
        }
        if (character === '\\' && quote) {
            escaped = true
            continue
        }
        if (quote) {
            if (character === quote) {
                quote = undefined
            }
            continue
        }
        if (isQuoteCharacter(character, quotes)) {
            quote = character
            continue
        }
        if (content.startsWith(marker, index)) {
            return index
        }
    }

    return -1
}

function isQuoteCharacter(
    value: string | undefined,
    quotes: QuoteCharacter[],
): value is QuoteCharacter {
    return (
        (value === '"' || value === "'" || value === '`') &&
        quotes.includes(value)
    )
}

function isShebang(line: string, marker: string): boolean {
    return marker === '#' && line.startsWith('#!')
}

function isLineStartMarker(content: string, index: number): boolean {
    const lineStart = content.lastIndexOf('\n', index - 1) + 1
    return content.slice(lineStart, index).trim().length === 0
}

function isPythonDocstringStart(content: string, index: number): boolean {
    const lineStart = content.lastIndexOf('\n', index - 1) + 1
    const beforeOnLine = content.slice(lineStart, index)
    if (beforeOnLine.trim().length > 0) {
        return false
    }

    const previousLine = previousNonEmptyLine(content, lineStart)
    return !previousLine || previousLine.endsWith(':')
}

function previousNonEmptyLine(
    content: string,
    lineStart: number,
): string | undefined {
    const before = content.slice(0, Math.max(0, lineStart - 1))
    const lines = before.split('\n')

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim()
        if (line) {
            return line
        }
    }

    return undefined
}

function sectionMarkdown(path: string, content: string): ExtractedSection[] {
    const sections = content.split(/(?=^#{1,6}\s+)/gmu).filter(Boolean)
    const sectionTexts = sections.length > 0 ? sections : [content]

    return sectionTexts.flatMap(section => {
        const heading = section.match(/^#{1,6}\s+(.+)$/mu)?.[1]?.trim()
        return sectionByWords(path, section, 'markdown', {
            anchor: heading ? slugify(heading) : undefined,
            anchorType: heading ? 'heading' : 'file',
            heading,
            symbol: heading,
        })
    })
}

function sectionJson(path: string, content: string): ExtractedSection[] {
    try {
        const parsed = JSON.parse(content) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.entries(parsed).flatMap(([key, value]) =>
                sectionByWords(
                    path,
                    JSON.stringify({ [key]: value }, null, 2),
                    'json',
                    {
                        anchor: key,
                        anchorType: 'json_path',
                        jsonPath: key,
                        symbol: key,
                    },
                ),
            )
        }
    } catch {
        return sectionByWords(path, content, 'json')
    }

    return sectionByWords(path, content, 'json')
}

function sectionByWords(
    path: string,
    content: string,
    kind: string,
    metadata: {
        anchor?: string
        anchorType?: ExtractedSection['anchorType']
        heading?: string
        jsonPath?: string
        symbol?: string
        startLine?: number
        endLine?: number
        metadata?: Record<string, unknown>
    } = {},
): ExtractedSection[] {
    const anchor = metadata.anchor ?? 'file'
    const anchorType = metadata.anchorType ?? 'file'
    return [
        {
            anchor,
            anchorType,
            content,
            endLine: metadata.endLine,
            heading: metadata.heading,
            jsonPath: metadata.jsonPath,
            kind,
            metadata: metadata.metadata,
            path,
            startLine: metadata.startLine,
            summary: summarize(path, kind, content, metadata.symbol),
            symbol: metadata.symbol,
        },
    ]
}

function extractCodeSymbol(line: string): string | undefined {
    return line.match(
        /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z0-9_$]+)/u,
    )?.[1]
}

function summarize(
    path: string,
    kind: string,
    content: string,
    symbol?: string,
): string {
    const firstLine = content
        .trim()
        .split('\n')
        .find(line => line.trim().length > 0)
        ?.trim()
    const label = symbol ? `${path}#${symbol}` : path
    const preview = firstLine ? `: ${firstLine.slice(0, 120)}` : ''
    return `${kind} section from ${label}${preview}`
}

function isMarkdown(path: string): boolean {
    return /\.(md|mdx)$/iu.test(path)
}

function isJson(path: string): boolean {
    return /\.(json|jsonc)$/iu.test(path)
}

function isCode(path: string): boolean {
    const grammar = getGrammarForPath(path)
    return Boolean(grammar && !isBundledGrammar(grammar.id))
}

function slugify(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '')
}
