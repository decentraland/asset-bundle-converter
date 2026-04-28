import { IFetchComponent } from '@well-known-components/interfaces'

/**
 * Build the fetch component on top of the runtime's native `fetch`.
 *
 * `IFetchComponent` types its surface against `node-fetch`'s `Request` /
 * `Response` / `RequestInit` for historical reasons (the package predates
 * Node having native `fetch`), while we want the runtime's native
 * `globalThis.fetch`. The two families describe structurally compatible
 * runtime values but TypeScript treats them as nominally distinct, so the
 * implementation is annotated with the native-fetch parameter types
 * (`RequestInfo | URL`, `RequestInit`) — which is what the body actually
 * accepts — and the entire function is asserted to satisfy
 * `IFetchComponent['fetch']` once at the assignment boundary. This drops
 * the previous `any`-everywhere shape while keeping the implementation
 * honest about what it really takes and returns.
 */
export async function createFetchComponent(): Promise<IFetchComponent> {
  const nativeFetch = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init)

  return {
    fetch: nativeFetch as unknown as IFetchComponent['fetch']
  }
}
