import { createRedisComponent as createDclRedisComponent } from '@dcl/redis-component'
import type { ICacheStorageComponent } from '@dcl/core-commons'
import type { AppComponents } from '../../types'
import type { IRedisComponent } from './types'

/**
 * Builds the consumer-server's redis adapter.
 *
 * When `REDIS_URL` is set, delegates to `@dcl/redis-component` (node-redis v5
 * backed). When unset, returns a no-op stand-in that satisfies the same
 * `ICacheStorageComponent` interface — every read returns `null`, every write
 * is a sink. Call sites can then use the component unconditionally without
 * null-checks.
 *
 * Locks are deliberately unsupported in the null stand-in: a caller that
 * silently treated lock acquisition as success in single-pod local dev would
 * mask coordination bugs that only surface in multi-pod deploys. `acquireLock`
 * throws so the misuse is loud at the call site.
 *
 * @param components - Needs `config` (for `REDIS_URL`) and `logs`.
 */
export async function createRedisComponent(
  components: Pick<AppComponents, 'config' | 'logs'>
): Promise<IRedisComponent> {
  const { config, logs } = components
  const logger = logs.getLogger('redis-adapter')

  const redisUrl = await config.getString('REDIS_URL')
  if (!redisUrl) {
    logger.info('REDIS_URL not set — using no-op cache; asset probe hit-cache will run local-LRU-only')
    return createNullRedisComponent()
  }

  return createDclRedisComponent(redisUrl, { logs })
}

function createNullRedisComponent(): ICacheStorageComponent {
  return {
    async get() {
      return null
    },
    async set() {
      /* no-op */
    },
    async remove() {
      /* no-op */
    },
    async keys() {
      return []
    },
    async setInHash() {
      /* no-op */
    },
    async getFromHash() {
      return null
    },
    async removeFromHash() {
      /* no-op */
    },
    async getAllHashFields() {
      return {}
    },
    async acquireLock(key) {
      throw new Error(`acquireLock not supported in null-redis (key=${key}). Configure REDIS_URL.`)
    },
    async releaseLock() {
      /* no-op */
    },
    async tryAcquireLock() {
      return false
    },
    async tryReleaseLock() {
      return false
    }
  }
}
