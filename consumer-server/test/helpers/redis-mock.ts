import type { IRedisComponent } from '../../src/adapters/redis'

/**
 * Lightweight redis mock for unit / integration tests that build their own
 * components container instead of going through `initComponents`. Mirrors the
 * production null-object stand-in: every operation is a sink. Tests that need
 * to drive specific Redis behavior (hits, simulated failures) construct their
 * own mock inline rather than extending this.
 */
export function createMockRedisComponent(): IRedisComponent {
  return {
    async get() {
      return null
    },
    async set() {
      /* no-op */
    },
    async remove() {},
    async keys() {
      return []
    },
    async setInHash() {},
    async getFromHash() {
      return null
    },
    async removeFromHash() {},
    async getAllHashFields() {
      return {}
    },
    async acquireLock() {
      throw new Error('acquireLock not supported in mock redis')
    },
    async releaseLock() {},
    async tryAcquireLock() {
      return false
    },
    async tryReleaseLock() {
      return false
    }
  }
}
