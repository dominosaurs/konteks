declare module '*.md?raw' {
    const value: string
    export default value
}

declare module '*.sql?raw' {
    const value: string
    export default value
}
declare module '*.dll' {
    const path: string
    export default path
}

declare module '*.dylib' {
    const path: string
    export default path
}

declare module '*.node' {
    const path: string
    export default path
}

declare module '*.so' {
    const path: string
    export default path
}

declare module '*.wasm' {
    const path: string
    export default path
}

declare var __konteksCheckForUpdateForTests:
    | (() => Promise<
          | {
                command: string
                current: string
                latest: string
            }
          | undefined
      >)
    | undefined
