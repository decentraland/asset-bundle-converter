export async function sleep(ms: number) {
  return new Promise<void>((ok) => setTimeout(ok, ms))
}

export async function timeout(ms: number, message: string) {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}
