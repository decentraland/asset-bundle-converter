import { Entity } from '@dcl/schemas'
import { IFetchComponent } from '@well-known-components/interfaces'
import fetch from 'node-fetch'

export async function getEntities(
  fetcher: IFetchComponent,
  pointers: string[],
  sourceServer: string
): Promise<Entity[]> {
  const url = `${sourceServer}/entities/active`
  const res = await fetcher.fetch(url, {
    method: 'post',
    body: JSON.stringify({ pointers }),
    headers: { 'content-type': 'application/json' }
  })

  const response = await res.text()

  if (!res.ok) {
    throw new Error('Error fetching list of active entities: ' + response)
  }

  return JSON.parse(response)
}

export async function getActiveEntity(id: string, contentServer: string): Promise<Entity> {
  const url = `${contentServer}/entities/active`

  const res = await fetch(url, {
    method: 'post',
    body: JSON.stringify({ ids: [ids] }),
    headers: { 'content-type': 'application/json' }
  })

  const response = await res.text()

  if (!res.ok) {
    throw new Error('Error fetching list of active entities: ' + response)
  }

  return JSON.parse(response)[0]
}
