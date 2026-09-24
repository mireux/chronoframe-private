import { StorageProviderError } from './providers/openlist'

export { StorageProviderError }

export const isStorageProviderError = (
  error: unknown,
): error is StorageProviderError => {
  return error instanceof StorageProviderError
}
