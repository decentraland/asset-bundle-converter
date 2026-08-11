import { AppComponents } from '../types'

/** Cloudflare's purge_cache endpoint accepts at most 30 URLs per call. */
export const CLOUDFLARE_PURGE_BATCH_SIZE = 30

/**
 * Public CDN URLs for a set of uploaded bundle files: each file plus its
 * Brotli sibling (`{key}.br`), which cdn-uploader writes as a separate object.
 */
export function buildPurgeUrls(cdnBaseUrl: string, uploadPath: string, files: string[]): string[] {
  const urls: string[] = []

  for (const file of files) {
    urls.push(`${cdnBaseUrl}/${uploadPath}/${file}`)
    urls.push(`${cdnBaseUrl}/${uploadPath}/${file}.br`)
  }

  return urls
}

export function batchUrls(urls: string[], batchSize: number): string[][] {
  const batches: string[][] = []

  for (let i = 0; i < urls.length; i += batchSize) {
    batches.push(urls.slice(i, i + batchSize))
  }

  return batches
}

/**
 * Purges the given URLs from the Cloudflare edge cache. Bundle objects are
 * uploaded with `immutable` cache-control, so a same-key re-upload (forced
 * re-conversion) keeps serving the previous bytes from warm edges until this
 * purge runs.
 *
 * No-ops with a warning when `CF_ZONE_ID` / `CF_PURGE_API_TOKEN` are not
 * configured, and tolerates per-batch failures — purging is best-effort and
 * the origin already holds the correct bytes.
 */
export async function purgeCdnUrls(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs'>,
  urls: string[]
): Promise<void> {
  const logger = components.logs.getLogger('cdn-purge')

  const zoneId = await components.config.getString('CF_ZONE_ID')
  const apiToken = await components.config.getString('CF_PURGE_API_TOKEN')

  if (!zoneId || !apiToken) {
    logger.warn(
      `CF_ZONE_ID / CF_PURGE_API_TOKEN are not configured — skipping edge purge of ${urls.length} url(s); stale immutable copies may be served until they expire`
    )
    return
  }

  for (const batch of batchUrls(urls, CLOUDFLARE_PURGE_BATCH_SIZE)) {
    try {
      const res = await components.fetch.fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files: batch })
      })

      if (!res.ok) {
        logger.error(`Cloudflare purge responded ${res.status} for a batch of ${batch.length} url(s)`)
      }
    } catch (err: any) {
      logger.error(`Cloudflare purge request failed for a batch of ${batch.length} url(s): ${err.message}`)
    }
  }
}
