import { Language, type Node, Parser, Query } from 'web-tree-sitter'
import { runtimeAssetPath } from '@/support/runtime-assets'
import { getGrammarForPath } from './grammar-loader'

type CodeSymbol = {
    name: string
    kind: string
    startLine: number
    endLine: number
    isExported: boolean
    content: string
}

export type CodeMetadata = {
    symbols: CodeSymbol[]
    imports: string[]
    exports: string[]
    language: string
}

export default class TreeSitterEngine {
    private parser: Parser | undefined
    private languages: Map<string, Language> = new Map()

    public async init() {
        if (this.parser) {
            return
        }

        const wasmPath = await runtimeAssetPath('web-tree-sitter')
        await Parser.init({
            locateFile: (scriptName: string) =>
                scriptName === 'web-tree-sitter.wasm' ? wasmPath : scriptName,
        })
        this.parser = new Parser()
    }

    public async loadLanguage(lang: string, wasmPath: string) {
        if (this.languages.has(lang)) {
            return
        }

        const language = await Language.load(wasmPath)
        this.languages.set(lang, language)
    }

    public hasLanguage(lang: string): boolean {
        return this.languages.has(lang)
    }

    public async parse(
        path: string,
        content: string,
    ): Promise<CodeMetadata | undefined> {
        if (!this.parser) {
            await this.init()
        }

        const lang = this.detectLanguage(path)
        if (!lang) {
            return undefined
        }

        const language = this.languages.get(lang)
        if (!language) {
            throw new Error(
                `Tree-sitter grammar is not loaded for ${lang} (${path})`,
            )
        }

        this.parser?.setLanguage(language)
        const tree = this.parser?.parse(content)

        const metadata: CodeMetadata = {
            exports: [],
            imports: [],
            language: lang,
            symbols: [],
        }

        if (tree?.rootNode) {
            this.extractMetadata(tree.rootNode, content, metadata, lang)
        }

        return metadata
    }

    private detectLanguage(path: string): string | undefined {
        return getGrammarForPath(path)?.id
    }

    private extractMetadata(
        root: Node,
        _: string,
        metadata: CodeMetadata,
        lang: string,
    ) {
        if (lang !== 'javascript' && lang !== 'typescript' && lang !== 'tsx') {
            this.extractGenericMetadata(root, metadata)
            return
        }

        const query = this.buildQuery(root.tree.language, lang)
        const captures = query.captures(root)

        for (const capture of captures) {
            const { node, name } = capture

            if (name === 'import') {
                metadata.imports.push(node.text)
            } else if (name === 'export') {
                metadata.exports.push(node.text)
            } else if (name.startsWith('symbol_')) {
                const kind = name.split('_')[1]
                const nameNode = node.childForFieldName('name') || node.child(1)

                if (nameNode) {
                    metadata.symbols.push({
                        content: node.text,
                        endLine: node.endPosition.row,
                        isExported: this.isExported(node),
                        kind,
                        name: nameNode.text,
                        startLine: node.startPosition.row,
                    })
                }
            }
        }
    }

    private buildQuery(
        language: Language,
        lang: 'javascript' | 'typescript' | 'tsx',
    ): Query {
        const baseQueries = `
            (import_statement) @import
            (export_statement) @export
            (function_declaration) @symbol_function
            (method_definition) @symbol_method
            (class_declaration) @symbol_class
        `
        const tsQueries = `
            ${baseQueries}
            (interface_declaration) @symbol_interface
            (type_alias_declaration) @symbol_type
            (enum_declaration) @symbol_enum
        `
        const queryStr =
            lang === 'typescript' || lang === 'tsx' ? tsQueries : baseQueries

        return new Query(language, queryStr)
    }

    private extractGenericMetadata(root: Node, metadata: CodeMetadata) {
        const visit = (node: Node) => {
            const kind = this.genericSymbolKind(node.type)
            const nameNode = kind ? this.findNameNode(node) : undefined
            if (kind) {
                metadata.symbols.push({
                    content: node.text,
                    endLine: node.endPosition.row,
                    isExported: this.isExported(node),
                    kind,
                    name: nameNode?.text || this.fallbackSymbolName(kind, node),
                    startLine: node.startPosition.row,
                })
            }

            for (const child of node.namedChildren) {
                visit(child)
            }
        }

        visit(root)
    }

    private genericSymbolKind(type: string): string | undefined {
        const normalized = type.toLowerCase()
        if (normalized.includes('function')) {
            return 'function'
        }
        if (normalized.includes('method')) {
            return 'method'
        }
        if (normalized.includes('class')) {
            return 'class'
        }
        if (normalized.includes('interface')) {
            return 'interface'
        }
        if (normalized.includes('struct')) {
            return 'struct'
        }
        if (normalized.includes('enum')) {
            return 'enum'
        }
        if (normalized.includes('trait')) {
            return 'trait'
        }
        if (normalized.includes('module')) {
            return 'module'
        }
        if (normalized.includes('type')) {
            return 'type'
        }
        if (
            normalized.includes('declaration') ||
            normalized.includes('definition')
        ) {
            return 'declaration'
        }
        return undefined
    }

    private findNameNode(node: Node): Node | undefined {
        const fieldNameNode = node.childForFieldName('name')
        if (fieldNameNode) {
            return fieldNameNode
        }

        return node.namedChildren.find(child =>
            /^(identifier|type_identifier|field_identifier|property_identifier|constant|word)$/u.test(
                child.type,
            ),
        )
    }

    private fallbackSymbolName(kind: string, node: Node): string {
        return `${kind}_${node.startPosition.row + 1}_${node.startPosition.column + 1}`
    }

    private isExported(node: Node): boolean {
        let current: Node | null = node
        while (current) {
            if (
                current.type === 'export_statement' ||
                current.type === 'export_declaration'
            ) {
                return true
            }
            // Check for TS-style exports or modifiers if needed
            current = current.parent
        }
        return false
    }
}
