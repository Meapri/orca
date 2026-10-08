/** Single-quote a POSIX shell word. Dependency-free so on-host bundles never pull in ssh2. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
