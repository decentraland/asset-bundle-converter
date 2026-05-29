import * as fs from 'fs'
import * as path from 'path'
import { parseRetryAfterMs } from '../../src/logic/asset-reuse'

/**
 * Cross-side parity check.
 *
 * The Rust catalyst client at `encoder/src/catalyst_client.rs` mirrors the
 * Retry-After parsing policy in `asset-reuse.ts:512-537` line-for-line.
 * This test pins that contract via a JSON fixture that both sides consume:
 *
 *   * TS  : this spec drives `parseRetryAfterMs` (TS impl).
 *   * Rust: `encoder/tests/retry_after_parity.rs` reads the same fixture
 *           and drives `parse_retry_after_ms` (Rust impl).
 *
 * If either side's behaviour drifts, the corresponding spec fails. The
 * fixture is the single source of truth — adding a new case means adding
 * it to `encoder/tests/fixtures/retry-after-cases.json` and both specs
 * pick it up automatically.
 *
 * Scope: timestamp-independent cases only. HTTP-date cases depend on
 * Date.now() and stay in per-side specs (asset-reuse.spec.ts for TS,
 * inline `#[test]`s in `catalyst_client.rs` for Rust).
 */

type ParityCase = {
  name: string
  input: string | null
  expectedMs: number | null
}

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../encoder/tests/fixtures/retry-after-cases.json'
)

describe('Retry-After parity (TS side)', () => {
  let cases: ParityCase[]

  beforeAll(() => {
    if (!fs.existsSync(FIXTURE_PATH)) {
      throw new Error(
        `Parity fixture missing at ${FIXTURE_PATH}. Both encoder/ and consumer-server/ must share it.`
      )
    }
    cases = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
    if (!Array.isArray(cases) || cases.length === 0) {
      throw new Error(`Parity fixture at ${FIXTURE_PATH} is empty or malformed`)
    }
  })

  it('should have at least the minimum coverage', () => {
    // Light guard against an accidentally-emptied fixture; if this drops
    // below 10, the parity coverage is degraded.
    expect(cases.length).toBeGreaterThanOrEqual(10)
  })

  // One it() per case so the test report names each parity scenario
  // individually — when the contract drifts, the failure message
  // points at the specific case rather than dumping a 20-case loop.
  it('should match expected output for each fixture case', () => {
    for (const c of cases) {
      const actual = parseRetryAfterMs(c.input)
      const expected = c.expectedMs === null ? undefined : c.expectedMs
      if (actual !== expected) {
        throw new Error(
          `parity mismatch for case "${c.name}" (input=${JSON.stringify(c.input)}): expected ${expected}, got ${actual}`
        )
      }
    }
  })
})
