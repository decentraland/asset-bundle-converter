import {
  batchUrls,
  buildPurgeUrls,
  CLOUDFLARE_PURGE_BATCH_SIZE,
  purgeCdnUrls
} from '../../src/logic/cdn-purge'

function makeComponents(config: Record<string, string | undefined>) {
  const logger = { log: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 })

  const components = {
    config: { getString: jest.fn(async (key: string) => config[key]) } as any,
    fetch: { fetch: fetchFn } as any,
    logs: { getLogger: () => logger } as any
  }

  return { components, fetchFn, logger }
}

describe('when building purge urls', () => {
  it('should emit the file and its brotli sibling for every entry', () => {
    const urls = buildPurgeUrls('https://ab-cdn.decentraland.org', 'v49/QmEntity', ['Qmay4_mac', 'QmbcV_mac'])

    expect(urls).toEqual([
      'https://ab-cdn.decentraland.org/v49/QmEntity/Qmay4_mac',
      'https://ab-cdn.decentraland.org/v49/QmEntity/Qmay4_mac.br',
      'https://ab-cdn.decentraland.org/v49/QmEntity/QmbcV_mac',
      'https://ab-cdn.decentraland.org/v49/QmEntity/QmbcV_mac.br'
    ])
  })
})

describe('when batching urls', () => {
  it('should split into batches of the given size with a smaller tail', () => {
    const urls = Array.from({ length: 65 }, (_, i) => `url-${i}`)

    const batches = batchUrls(urls, 30)

    expect(batches.map((b) => b.length)).toEqual([30, 30, 5])
    expect(batches[2][4]).toBe('url-64')
  })

  it('should return no batches for an empty list', () => {
    expect(batchUrls([], 30)).toEqual([])
  })
})

describe('when purging cdn urls', () => {
  describe('and the cloudflare credentials are not configured', () => {
    it('should warn and not call the api', async () => {
      const { components, fetchFn, logger } = makeComponents({})

      await purgeCdnUrls(components, ['https://ab-cdn.decentraland.org/v49/e/f_mac'])

      expect(fetchFn).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the cloudflare credentials are configured', () => {
    const CONFIG = { CF_ZONE_ID: 'zone123', CF_PURGE_API_TOKEN: 'token-abc' }

    it('should post the urls to the zone purge endpoint with a bearer token', async () => {
      const { components, fetchFn } = makeComponents(CONFIG)
      const urls = ['https://ab-cdn.decentraland.org/v49/e/a_mac', 'https://ab-cdn.decentraland.org/v49/e/a_mac.br']

      await purgeCdnUrls(components, urls)

      expect(fetchFn).toHaveBeenCalledTimes(1)
      const [endpoint, init] = fetchFn.mock.calls[0]
      expect(endpoint).toBe('https://api.cloudflare.com/client/v4/zones/zone123/purge_cache')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer token-abc')
      expect(JSON.parse(init.body)).toEqual({ files: urls })
    })

    it('should split large url sets into api-sized batches', async () => {
      const { components, fetchFn } = makeComponents(CONFIG)
      const urls = Array.from({ length: CLOUDFLARE_PURGE_BATCH_SIZE * 2 + 1 }, (_, i) => `url-${i}`)

      await purgeCdnUrls(components, urls)

      expect(fetchFn).toHaveBeenCalledTimes(3)
      expect(JSON.parse(fetchFn.mock.calls[2][1].body).files).toEqual([`url-${CLOUDFLARE_PURGE_BATCH_SIZE * 2}`])
    })

    it('should log and continue when the api responds with an error status', async () => {
      const { components, fetchFn, logger } = makeComponents(CONFIG)
      fetchFn.mockResolvedValueOnce({ ok: false, status: 429 })
      const urls = Array.from({ length: CLOUDFLARE_PURGE_BATCH_SIZE + 1 }, (_, i) => `url-${i}`)

      await purgeCdnUrls(components, urls)

      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('should log and continue when the request itself rejects', async () => {
      const { components, fetchFn, logger } = makeComponents(CONFIG)
      fetchFn.mockRejectedValueOnce(new Error('connection reset'))
      const urls = Array.from({ length: CLOUDFLARE_PURGE_BATCH_SIZE + 1 }, (_, i) => `url-${i}`)

      await expect(purgeCdnUrls(components, urls)).resolves.toBeUndefined()

      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })
  })
})
