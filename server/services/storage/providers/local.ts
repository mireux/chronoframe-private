import { createReadStream, createWriteStream, promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  LocalStorageConfig,
  StorageObject,
  StorageProvider,
  StorageReadStream,
} from '../interfaces'

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const getErrnoCode = (err: unknown): string | undefined => {
  if (!err || typeof err !== 'object') return
  if (!('code' in err)) return
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

const isRetryableFsError = (err: unknown): boolean => {
  if (process.platform !== 'win32') return false
  const code = getErrnoCode(err)
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

const retryFsOp = async <T>(
  op: () => Promise<T>,
  retries: number,
  baseDelayMs: number,
  maxDelayMs: number,
): Promise<T> => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await op()
    } catch (err) {
      if (!isRetryableFsError(err) || attempt >= retries - 1) {
        throw err
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
      await sleep(delay)
    }
  }
  throw new Error('retryFsOp: unreachable')
}

const renameWithReplace = async (from: string, to: string): Promise<void> => {
  try {
    await fs.rename(from, to)
  } catch (err) {
    if (process.platform !== 'win32') throw err

    const code = getErrnoCode(err)
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EEXIST') throw err

    try {
      await fs.unlink(to)
    } catch (unlinkErr) {
      if (getErrnoCode(unlinkErr) !== 'ENOENT') throw unlinkErr
    }

    await fs.rename(from, to)
  }
}

const sanitizeKey = (key: string) => key.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '')

const combinePrefixAndKey = (prefix: string | undefined, key: string) => {
  const cleanPrefix = (prefix || '').replace(/\/+$/, '')
  const cleanKey = key.replace(/^\/+/, '')
  if (!cleanPrefix) return cleanKey
  return cleanKey.startsWith(cleanPrefix + '/')
    ? cleanKey
    : `${cleanPrefix}/${cleanKey}`
}

export class LocalStorageProvider implements StorageProvider {
  config: LocalStorageConfig
  private logger?: Logger['storage']

  constructor(config: LocalStorageConfig, logger?: Logger['storage']) {
    this.config = config
    this.logger = logger
  }

  private resolveAbsoluteKey(key: string): { absFile: string; relKey: string } {
    const relKey = sanitizeKey(combinePrefixAndKey(this.config.prefix, key))
    const absFile = path.resolve(this.config.basePath, relKey)
    return { absFile, relKey }
  }

  async create(key: string, fileBuffer: Buffer): Promise<StorageObject> {
    const { absFile, relKey } = this.resolveAbsoluteKey(key)
    await ensureDir(path.dirname(absFile))

    const tempFile = `${absFile}.tmp-${Date.now()}`

    try {
      await retryFsOp(() => fs.writeFile(tempFile, fileBuffer), 3, 200, 1000)
      await retryFsOp(() => renameWithReplace(tempFile, absFile), 60, 200, 2000)
    } catch (err) {
      await fs.unlink(tempFile).catch(() => {})
      throw err
    }

    await sleep(150)
    const stat = await retryFsOp(() => fs.stat(absFile), 5, 100, 1000).catch(() => null)
    this.logger?.success?.(`Saved file: ${absFile}`)
    return {
      key: relKey,
      size: stat?.size ?? fileBuffer.length,
      lastModified: stat?.mtime ?? new Date(),
    }
  }

  async createFromStream(
    key: string,
    stream: Readable,
    contentLength: number | null,
    _contentType?: string,
    _skipEncryption?: boolean,
  ): Promise<StorageObject> {
    const { absFile, relKey } = this.resolveAbsoluteKey(key)
    await ensureDir(path.dirname(absFile))

    const tempFile = `${absFile}.tmp-${Date.now()}`

    try {
      await pipeline(stream, createWriteStream(tempFile))

      await retryFsOp(() => renameWithReplace(tempFile, absFile), 60, 200, 2000)
    } catch (err) {
      await fs.unlink(tempFile).catch(() => {})
      throw err
    }

    await sleep(150)
    const stat = await retryFsOp(() => fs.stat(absFile), 5, 100, 1000).catch(() => null)
    this.logger?.success?.(`Saved file: ${absFile}`)
    return {
      key: relKey,
      size: stat?.size ?? (contentLength ?? undefined),
      lastModified: stat?.mtime ?? new Date(),
    }
  }

  async delete(key: string): Promise<void> {
    const { absFile } = this.resolveAbsoluteKey(key)
    try {
      await retryFsOp(() => fs.unlink(absFile), 10, 200, 2000)
      this.logger?.success?.(`Deleted file: ${absFile}`)
    } catch (err) {
      if (getErrnoCode(err) !== 'ENOENT') throw err
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const { absFile } = this.resolveAbsoluteKey(key)
    try {
      return await retryFsOp(() => fs.readFile(absFile), 10, 200, 2000)
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') return null
      throw err
    }
  }

  async getStream(key: string): Promise<StorageReadStream | null> {
    const { absFile } = this.resolveAbsoluteKey(key)
    try {
      const stat = await retryFsOp(() => fs.stat(absFile), 10, 200, 2000)
      if (!stat.isFile()) return null
      return { stream: createReadStream(absFile), size: stat.size }
    } catch (err) {
      if (getErrnoCode(err) === 'ENOENT') return null
      throw err
    }
  }

  getPublicUrl(key: string): string {
    const relKey = sanitizeKey(combinePrefixAndKey(this.config.prefix, key))
    const base = (this.config.baseUrl || '/storage').replace(/\/+$/, '')
    return `${base}/${relKey}`
  }

  async listAll(): Promise<StorageObject[]> {
    const results: StorageObject[] = []
    const baseDir = this.config.prefix
      ? path.resolve(this.config.basePath, this.config.prefix)
      : this.config.basePath

    const walk = async (dir: string, relBase: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        const rel = sanitizeKey(path.join(relBase, entry.name))
        if (entry.isDirectory()) {
          await walk(abs, rel)
        } else if (entry.isFile()) {
          try {
            const stat = await retryFsOp(() => fs.stat(abs), 5, 100, 1000)
            results.push({ key: rel, size: stat.size, lastModified: stat.mtime })
          } catch {
            continue
          }
        }
      }
    }

    await ensureDir(baseDir)
    await walk(baseDir, this.config.prefix || '')
    return results
  }

  async listImages(): Promise<StorageObject[]> {
    const all = await this.listAll()
    return all.filter((o) => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(o.key))
  }

  async getFileMeta(key: string): Promise<StorageObject | null> {
    const tryGetStat = async (filePath: string): Promise<Stats | null> => {
      try {
        return await retryFsOp(() => fs.stat(filePath), 10, 200, 2000)
      } catch (err) {
        if (getErrnoCode(err) === 'ENOENT') return null
        if (isRetryableFsError(err)) return null
        throw err
      }
    }

    const { absFile, relKey } = this.resolveAbsoluteKey(key)
    const stat1 = await tryGetStat(absFile)
    if (stat1 && stat1.isFile()) {
      return { key: relKey, size: stat1.size, lastModified: stat1.mtime }
    }

    const rawRel = sanitizeKey(key)
    const rawAbs = path.resolve(this.config.basePath, rawRel)
    const stat2 = await tryGetStat(rawAbs)
    if (stat2 && stat2.isFile()) {
      return { key: rawRel, size: stat2.size, lastModified: stat2.mtime }
    }

    return null
  }
}


