export function readStream(stream) {
    return new Promise((resolve, reject) => {
        let output = ''
        stream.setEncoding('utf8')
        stream.on('data', chunk => {
            output += chunk
        })
        stream.on('error', reject)
        stream.on('end', () => resolve(output))
    })
}

export function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', code => resolve(code ?? 1))
    })
}
