/** Storage may be unavailable in private/restricted browsers; joining must still work. */
let displayName = ''
export function readDisplayName(): string {
  try { displayName = window.localStorage.getItem('pico-name') ?? displayName } catch { /* memory fallback */ }
  return displayName
}
export function saveDisplayName(name: string): void {
  displayName = name.trim().slice(0, 24)
  try { window.localStorage.setItem('pico-name', displayName) } catch { /* memory fallback */ }
}
