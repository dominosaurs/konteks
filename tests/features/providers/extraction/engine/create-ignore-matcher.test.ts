import { describe, expect, it } from 'bun:test'
import createIgnoreMatcher from '@/modules/extraction/engine/create-ignore-matcher'

describe('extraction ignore rules', () => {
    it('skips Konteks internals, secrets, and noisy fail-safe paths', () => {
        const matcher = createIgnoreMatcher({})

        expect(matcher.ignores('.konteks/config.json')).toBe(true)
        expect(matcher.explain('.konteks/config.json')).toBe('hard_directory')
        expect(
            matcher.ignores(
                '.konteks-mcp-dry-run-abc/original-memory/config.json',
            ),
        ).toBe(true)
        expect(matcher.ignores('.env.local')).toBe(true)
        expect(matcher.explain('.env.local')).toBe('secret')
        expect(matcher.ignores('certs/prod.pem')).toBe(true)
        expect(matcher.explain('certs/prod.pem')).toBe('secret')
        expect(matcher.ignores('assets/logo.png')).toBe(true)
        expect(matcher.explain('assets/logo.png')).toBe('binary')
        expect(matcher.ignores('bun.lock')).toBe(true)
        expect(matcher.explain('bun.lock')).toBe('lockfile')
        expect(matcher.ignores('src/generated/client.ts')).toBe(true)
        expect(matcher.explain('src/generated/client.ts')).toBe('generated')
        expect(matcher.ignores('public/app.min.js')).toBe(true)
        expect(matcher.explain('public/app.min.js')).toBe('minified')
        expect(matcher.explain('.npmrc')).toBe('secret')
        expect(matcher.explain('certs/client.p12')).toBe('secret')
        expect(matcher.explain('documents/report.docx')).toBe('binary')
    })

    it('skips generated, dependency, build, cache, and lock artifacts across ecosystems', () => {
        const matcher = createIgnoreMatcher({})

        const ignoredPaths = [
            '.venv/lib/python3.12/site-packages/pkg/__init__.py',
            '__pycache__/module.cpython-312.pyc',
            '.pytest_cache/v/cache/nodeids',
            'poetry.lock',
            'Pipfile.lock',
            'target/debug/app',
            'Cargo.lock',
            'proto/user.pb.go',
            'go.sum',
            'build/generated/source/kapt/main/User.java',
            'target/generated-sources/protobuf/User.java',
            '.gradle/caches/modules-2/files.bin',
            'gradle.lockfile',
            '.dart_tool/package_config.json',
            'lib/user.freezed.dart',
            'lib/user.g.dart',
            'pubspec.lock',
            '.build/checkouts/package/Sources/File.swift',
            'Package.resolved',
            'cmake-build-debug/CMakeFiles/app.dir/main.o',
            'zig-out/bin/app',
            'bin/Debug/net8.0/App.dll',
            'obj/Debug/project.assets.json',
            'vendor/bundle/ruby/gems/rack/lib/rack.rb',
            'Gemfile.lock',
            'vendor/composer/autoload.php',
            'composer.lock',
            '.parcel-cache/index',
            '.pnpm-store/v3/files/index.json',
            'storybook-static/index.html',
            'npm-shrinkwrap.json',
            '.tox/py312/log.txt',
            '.ipynb_checkpoints/notebook-checkpoint.ipynb',
            'uv.lock',
            'src/protos/user.grpc.pb.go',
            'build/generated/source/proto/main/User.java',
            '.mvn/wrapper/maven-wrapper.jar',
            'TestResults/results.trx',
            'packages.lock.json',
            '.swiftpm/configuration/registries.json',
            'cmake-build-release/CMakeFiles/app.dir/main.o',
            'archive/source.tar.gz',
            'fonts/inter.woff2',
        ]

        expect(ignoredPaths.filter(path => !matcher.ignores(path))).toEqual([])
    })

    it('keeps ordinary source and documentation paths', () => {
        const matcher = createIgnoreMatcher({})

        expect(matcher.ignores('src/index.ts')).toBe(false)
        expect(matcher.ignores('README.md')).toBe(false)
        expect(matcher.ignores('package.json')).toBe(false)
    })

    it('keeps supported source and package manifests across ecosystems', () => {
        const matcher = createIgnoreMatcher({})

        const includedPaths = [
            'scripts/install.sh',
            'src/main.c',
            'src/main.cpp',
            'src/Program.cs',
            'styles/app.css',
            'lib/main.dart',
            'cmd/server/main.go',
            'web/index.html',
            'src/main/java/App.java',
            'src/index.js',
            'src/docs.jsdoc',
            'src/main/kotlin/App.kt',
            'src/init.lua',
            'src/index.php',
            'src/app.py',
            'lib/app.rb',
            'src/lib.rs',
            'src/Main.scala',
            'Sources/App/App.swift',
            'src/App.tsx',
            'src/index.ts',
            'src/main.zig',
            'Cargo.toml',
            'composer.json',
            'go.mod',
            'package.json',
            'Package.swift',
            'pom.xml',
            'pubspec.yaml',
            'pyproject.toml',
            'build.gradle',
            'App.csproj',
            'bin/deploy.sh',
            'packages/workspace/package.json',
            'src/debug/logger.ts',
            'src/release/notes.md',
        ]

        expect(includedPaths.filter(path => matcher.ignores(path))).toEqual([])
    })

    it('respects gitignore patterns and negation', () => {
        const matcher = createIgnoreMatcher({
            gitignore: 'tmp/\n*.log\n!important.log\n/build-output\n',
        })

        expect(matcher.ignores('tmp/cache.txt')).toBe(true)
        expect(matcher.ignores('logs/debug.log')).toBe(true)
        expect(matcher.ignores('important.log')).toBe(false)
        expect(matcher.ignores('build-output/app.js')).toBe(true)
        expect(matcher.ignores('src/index.ts')).toBe(false)
    })

    it('scopes nested gitignore patterns to their directory', () => {
        const matcher = createIgnoreMatcher({
            gitignore: [
                {
                    basePath: '',
                    content: '*.log\n',
                },
                {
                    basePath: 'packages/app',
                    content: '/private-output/\n!important.log\n',
                },
            ],
        })

        expect(matcher.ignores('packages/app/private-output/out.js')).toBe(true)
        expect(matcher.ignores('packages/other/private-output/out.js')).toBe(
            false,
        )
        expect(matcher.ignores('packages/app/important.log')).toBe(false)
        expect(matcher.ignores('packages/other/important.log')).toBe(true)
    })

    it('uses .konteksignore as extra exclusions only', () => {
        const matcher = createIgnoreMatcher({
            gitignore: 'ignored.md\n',
            konteksignore: 'docs/private/\n!ignored.md\n',
        })

        expect(matcher.ignores('ignored.md')).toBe(true)
        expect(matcher.ignores('docs/private/notes.md')).toBe(true)
        expect(matcher.ignores('docs/public/notes.md')).toBe(false)
    })
})
