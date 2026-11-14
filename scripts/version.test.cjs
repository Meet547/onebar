/* Offline tests for the version handshake + one-time auto-reload guard
 * (src/lib/version.ts), compiled to CJS by scripts/run-version-tests.sh. */
const {
  versionMismatch,
  shouldAutoReload,
  checkAndMarkReload,
  AUTO_RELOAD_MIN_INTERVAL_MS,
} = require(process.env.VERSION_CJS)

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ''}`)
  }
}
function eq(name, got, want) {
  ok(name, got === want, { got, want })
}

/* ---- 1. versionMismatch ---- */
eq('mismatch: equal versions → false', versionMismatch('abc123', 'abc123'), false)
eq('mismatch: different versions → true', versionMismatch('abc123', 'def456'), true)
eq('mismatch: missing client → false (no reload loop)', versionMismatch(undefined, 'def456'), false)
eq('mismatch: missing server → false', versionMismatch('abc123', null), false)
eq('mismatch: both missing → false', versionMismatch(null, undefined), false)
eq('mismatch: empty string counts as missing', versionMismatch('', 'def456'), false)

/* ---- 2. one-time reload guard ---- */
eq('guard: no previous reload → allowed', shouldAutoReload(1000, null), true)
eq('guard: within 60 s → blocked', shouldAutoReload(30_000, 0), false)
eq('guard: exactly at the interval → allowed', shouldAutoReload(AUTO_RELOAD_MIN_INTERVAL_MS, 0), true)
eq('guard: NaN previous → allowed (storage junk)', shouldAutoReload(1000, NaN), true)
eq('guard: far in the past → allowed', shouldAutoReload(1_000_000, 0), true)
ok('guard: interval is 60 s', AUTO_RELOAD_MIN_INTERVAL_MS === 60_000)

/* ---- 3. checkAndMarkReload records on decision ---- */
{
  let stored = null
  const read = () => stored
  const mark = () => {
    stored = 1000
  }
  eq('combo: first trigger reloads and marks', checkAndMarkReload(1000, read, mark), true)
  eq('combo: second trigger inside the window is blocked', checkAndMarkReload(2000, read, mark), false)
  eq('combo: after the window it reloads again', checkAndMarkReload(61_500, read, mark), true)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
