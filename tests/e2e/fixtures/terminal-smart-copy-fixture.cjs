// Prints a TUI-style box for smart-copy checks; `kitty` mode then enables kitty
// release reporting (as Codex does) and records every byte the terminal sends.
const fs = require('node:fs')

const ESC = '\x1b'
const mode = process.argv[2] ?? 'box'
const inputLogPath = process.argv[3]
const rule = '─'.repeat(22)
const framed = (text) => `│ ${text.padEnd(20)} │`

if (mode === 'box') {
  process.stdout.write(
    [
      `╭${rule}╮`,
      framed('The quick brown fox'),
      framed('jumps over the lazy'),
      framed('dog.'),
      `╰${rule}╯`,
      'SMART_COPY_BOX_READY',
      ''
    ].join('\r\n')
  )
  process.exit(0)
}

const lines = Array.from({ length: 300 }, (_value, index) => `scrollback line ${index + 1}`)
process.stdout.write(`${lines.join('\r\n')}\r\n`)
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()
// CSI > 3 u: push DISAMBIGUATE_ESCAPE_CODES | REPORT_EVENT_TYPES.
process.stdout.write(`${ESC}[>3uSMART_COPY_KITTY_READY`)
process.stdin.on('data', (chunk) => {
  if (inputLogPath) {
    fs.appendFileSync(inputLogPath, chunk)
  }
  if (chunk.includes('\x03') || chunk.includes(`${ESC}[99;5u`)) {
    process.stdout.write(`${ESC}[<u\r\n`)
    process.exit(0)
  }
})
