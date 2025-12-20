import crypto from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { StorageProvider } from './interfaces'

export interface DecryptedVideoCacheEntry {
  filePath: string
  size: number
}

const cacheDir = path.resolve(process.cwd(), 'data', 'cache', 'decrypted-videos')
const inflight = new Map<string, Promise<DecryptedVideoCacheEntry | null>>()

const safeStatFile = async (filePath: string): Promise<number | null> => {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

const renameWithReplace = async (from: string, to: string): Promise<void> => {
  try {
    await fs.rename(from, to)
  } catch (err) {
    if (process.platform !== 'win32') throw err
    try {
      await fs.unlink(to)
    } catch (unlinkErr) {
      void unlinkErr
    }
    await fs.rename(from, to)
  }
}

const getFingerprint = async (provider: StorageProvider, key: string): Promise<string> => {
  const meta = await provider.getFileMeta(key)
  const parts = [
    key,
    meta?.etag ?? '',
    meta?.lastModified?.toISOString() ?? '',
    meta?.size ? String(meta.size) : '',
  ]
  return parts.join('|')
}

export const getOrCreateDecryptedVideoCache = async (
  provider: StorageProvider,
  key: string,
): Promise<DecryptedVideoCacheEntry | null> => {
  const fingerprint = await getFingerprint(provider, key)
  const cacheKey = crypto.createHash('sha1').update(fingerprint).digest('hex')
  const ext = path.extname(key) || '.bin'
  const filePath = path.join(cacheDir, `${cacheKey}${ext}`)

  const existingSize = await safeStatFile(filePath)
  if (existingSize !== null) {
    return { filePath, size: existingSize }
  }

  const existingInflight = inflight.get(filePath)
  if (existingInflight) {
    return await existingInflight
  }

  const promise = (async (): Promise<DecryptedVideoCacheEntry | null> => {
    await fs.mkdir(cacheDir, { recursive: true })
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`

    try {
      const streamResp = provider.getStream ? await provider.getStream(key) : null
      if (streamResp) {
        await pipeline(streamResp.stream, createWriteStream(tempPath))
      } else {
        const buffer = await provider.get(key)
        if (!buffer) return null
        await fs.writeFile(tempPath, buffer)
      }

      await renameWithReplace(tempPath, filePath)
      const size = await safeStatFile(filePath)
      if (size === null) return null
      return { filePath, size }
    } finally {
      await fs.unlink(tempPath).catch(() => {})
    }
  })()

  inflight.set(filePath, promise)
  try {
    return await promise
  } finally {
    inflight.delete(filePath)
  }
}

export const createDecryptedVideoReadStream = (
  entry: DecryptedVideoCacheEntry,
  range?: { start: number; end: number },
) => {
  if (range) {
    return createReadStream(entry.filePath, { start: range.start, end: range.end })
  }
  return createReadStream(entry.filePath)
}
