import { defineConfig } from 'tsup'

export default defineConfig({
    banner: {
        js: [
            "import { createRequire as __konteksCreateRequire } from 'node:module'",
            'const require = __konteksCreateRequire(import.meta.url)',
        ].join('\n'),
    },
    clean: true,
    entry: ['src/main.ts'],
    esbuildOptions: options => {
        options.loader = {
            '.md': 'text',
            '.sql': 'text',
            '.wasm': 'file',
        }

        return options
    },
    external: [
        '@huggingface/transformers',
        '@libsql/client',
        '@libsql/core',
        '@libsql/hrana-client',
        '@libsql/isomorphic-ws',
        'libsql',
        'onnxruntime-common',
        'onnxruntime-node',
        'onnxruntime-web',
        'sharp',
        'sqlite-vec',
    ],
    format: ['esm'],
    minify: true,
    noExternal: [
        '@inquirer/checkbox',
        '@inquirer/confirm',
        '@inquirer/input',
        '@inquirer/number',
        '@inquirer/select',
        '@modelcontextprotocol/sdk',
        '@toon-format/toon',
        '@tree-sitter-grammars/tree-sitter-toml',
        '@tree-sitter-grammars/tree-sitter-yaml',
        '@vercel/detect-agent',
        'commander',
        'drizzle-orm',
        'tree-sitter-json',
        'web-tree-sitter',
        'zod',
    ],
    silent: true,
    splitting: false,
    target: 'node22',
})
