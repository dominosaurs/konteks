const ansiColorPattern = new RegExp(
    `${String.fromCharCode(27)}\\[[0-9;]*m`,
    'gu',
)

export default function stripAnsi(value: string): string {
    return value.replaceAll(ansiColorPattern, '')
}
