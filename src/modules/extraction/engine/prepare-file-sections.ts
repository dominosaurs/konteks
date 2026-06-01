import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSectionRetrievalTexts } from '@/database/support/retrieval-texts'
import {
    classifySourceRole,
    detectLanguage,
    extractTopics,
} from '@/modules/project/source-classification'
import contentHash from '@/support/content-hash'
import { estimateTextTokens } from '@/support/format/tokens'
import type { Project } from '@/types/project'
import type { ScannedFile } from './file-scan'
import { getGrammarForPath, isBundledGrammar } from './grammar-loader'
import { isExtractedSectionSuppressed } from './section-cleanup'
import sectionFile from './section-file'
import type TreeSitterEngine from './tree-sitter-engine'
import type { CodeMetadata } from './tree-sitter-engine'

type PreparedSection = {
    anchor: string
    anchorType: string
    contentInline: string
    contentHash: string
    endLine?: number
    heading?: string
    id: string
    jsonPath?: string
    kind: string
    metadata: Record<string, unknown>
    path: string
    retrievalTexts: {
        embeddingText: string
        ftsText: string
    }
    startLine?: number
    summary: string
    symbol?: string
    tokenCount: number
    topics: string[]
}

export type PreparedFile = {
    sections: PreparedSection[]
    language: string
    parserEngine: string
    parserStatus: string
    path: string
    sourceId: string
    sourceMetadata: Record<string, unknown>
    sourceRole: string
    sourceTopics: string[]
    truncated: boolean
}

export default async function prepareFileSections(input: {
    context: Project
    engine?: TreeSitterEngine
    file: ScannedFile
}): Promise<PreparedFile> {
    const content = await readFile(
        join(input.context.projectRoot, input.file.path),
        'utf8',
    )
    const sourceRole = classifySourceRole(input.file.path)
    const language = detectLanguage(input.file.path)
    let parserEngine = 'heuristic'
    let parserStatus = 'not_applicable'
    let parsedMetadata: CodeMetadata | undefined
    const grammar = getGrammarForPath(input.file.path)

    if (grammar) {
        if (
            !isBundledGrammar(grammar.id) &&
            !input.context.config.extraction.grammars.selected.includes(
                grammar.id,
            )
        ) {
            return emptyPreparedFile({
                file: input.file,
                language,
                parserEngine,
                parserStatus: 'skipped_unselected_grammar',
                sourceRole,
            })
        }

        if (!input.engine?.hasLanguage(grammar.id)) {
            const action = isBundledGrammar(grammar.id)
                ? `Bundled ${grammar.displayName} grammar was not loaded before extraction.`
                : `Select and cache the ${grammar.displayName} grammar before extraction.`
            throw new Error(
                `Tree-sitter grammar "${grammar.id}" is required for ${input.file.path}. ${action}`,
            )
        }

        parserEngine = 'tree_sitter'
        parsedMetadata = await input.engine.parse(input.file.path, content)
        parserStatus = parsedMetadata ? 'ok' : 'unavailable'
    }

    const allSections = await sectionFile(
        input.file,
        content,
        input.engine,
        parsedMetadata,
    )
    const sections = allSections.map(section => ({
        ...section,
        metadata: {
            ...metadataForSectionKind(section.kind),
            parserEngine,
            parserStatus,
            ...section.metadata,
        },
    }))

    const sourceTopics = extractTopics(
        input.file.path,
        sections.map(section => section.summary).join('\n'),
    )
    const preparedSections: PreparedSection[] = []

    for (const [index, section] of sections.entries()) {
        const sectionHash = contentHash(section.content)
        if (
            await isExtractedSectionSuppressed(
                input.file.path,
                section.anchor,
                sectionHash,
            )
        ) {
            continue
        }

        const topics = extractTopics(
            `${input.file.path} ${section.anchor}`,
            `${section.summary}\n${section.content}`,
        )
        const proseKind = proseKindForSection(section.kind)
        const contentType = proseKind
            ? 'prose'
            : contentTypeForSection(section.kind)
        preparedSections.push({
            anchor: section.anchor,
            anchorType: section.anchorType,
            contentHash: sectionHash,
            contentInline: section.content,
            endLine: section.endLine,
            heading: section.heading,
            id: sectionIdFor(
                input.file.path,
                index,
                section.anchor,
                sectionHash,
            ),
            jsonPath: section.jsonPath,
            kind: section.kind,
            metadata: section.metadata ?? {},
            path: section.path,
            retrievalTexts: buildSectionRetrievalTexts({
                anchor: section.anchor,
                content: section.content,
                contentType,
                language,
                path: section.path,
                proseKind,
                sourceRole,
                summary: section.summary,
                topics,
            }),
            startLine: section.startLine,
            summary: section.summary,
            symbol: section.symbol,
            tokenCount: estimateTextTokens(section.content),
            topics,
        })
    }

    return {
        language,
        parserEngine,
        parserStatus,
        path: input.file.path,
        sections: preparedSections,
        sourceId: sourceIdForPath(input.file.path),
        sourceMetadata: {
            exports: parsedMetadata?.exports ?? [],
            imports: parsedMetadata?.imports ?? [],
            parserEngine,
            parserStatus,
        },
        sourceRole,
        sourceTopics,
        truncated: false,
    }
}

function emptyPreparedFile(input: {
    file: ScannedFile
    language: string
    parserEngine: string
    parserStatus: string
    sourceRole: string
}): PreparedFile {
    return {
        language: input.language,
        parserEngine: input.parserEngine,
        parserStatus: input.parserStatus,
        path: input.file.path,
        sections: [],
        sourceId: sourceIdForPath(input.file.path),
        sourceMetadata: {
            parserEngine: input.parserEngine,
            parserStatus: input.parserStatus,
        },
        sourceRole: input.sourceRole,
        sourceTopics: [],
        truncated: false,
    }
}

function sourceIdForPath(path: string): string {
    return `source_${contentHash(path).slice(0, 32)}`
}

function sectionIdFor(
    path: string,
    index: number,
    anchor: string,
    hash: string,
): string {
    return `section_${contentHash(`${path}:${index}:${anchor}:${hash}`).slice(0, 32)}`
}

function proseKindForSection(kind: string): string | undefined {
    if (kind === 'comment' || kind === 'markdown' || kind === 'text') {
        return kind
    }

    return undefined
}

function contentTypeForSection(kind: string): string {
    if (kind === 'json') {
        return 'data'
    }
    if (kind === 'code') {
        return 'code'
    }

    return 'unknown'
}

function metadataForSectionKind(kind: string): Record<string, unknown> {
    const proseKind = proseKindForSection(kind)
    if (proseKind) {
        return {
            contentType: 'prose',
            proseKind,
        }
    }

    return {
        contentType: contentTypeForSection(kind),
    }
}
