import { test } from '../components'

test('consume status endpoint', function ({ components }) {
  it('responds /status works', async () => {
    const { localFetch } = components

    {
      const r = await localFetch.fetch('/status')

      expect(r.status).toEqual(200)
      expect(await r.json()).toMatchObject({
        commitHash: expect.any(String),
        version: expect.any(String)
      })
    }
  })
})
