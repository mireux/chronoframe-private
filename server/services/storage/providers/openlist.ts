import { Readable } from 'node:stream'
import type { Logger } from '../../../utils/logger'
import type { OpenListStorageConfig } from '~~/shared/types/storage'
import type {
  StorageByteRange,
  StorageObject,
  StorageProvider,
  StorageReadResult,
} from '../interfaces'
export class StorageProviderError extends Error {
  provider: string
  statusCode: number
  body?: string

  constructor(params: {
    provider: string
    statusCode: number
    message: string
    body?: string
  }) {
    super(params.message)
    this.name = 'StorageProviderError'
    this.provider = params.provider
    this.statusCode = params.statusCode
    this.body = params.body
  }
}

const toRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null

const isAsyncByteIterable = (
  value: object,
): value is AsyncIterable<Uint8Array> => Symbol.asyncIterator in value

/**
 * OpenListStorageProvider implements StorageProvider for OpenList API.
 * Since OpenList API endpoints may vary by deployment, we keep them configurable.
 */
export class OpenListStorageProvider implements StorageProvider {
  config: OpenListStorageConfig
  private logger?: Logger['storage']
  private token?: string

  constructor(config: OpenListStorageConfig, logger?: Logger['storage']) {
    this.config = config
    this.logger = logger
  }

  private get baseUrl() {
    return this.config.baseUrl.replace(/\/$/, '')
  }

  private get pathField(): string {
    return this.config.pathField || 'path'
  }

  private async ensureAuthToken(): Promise<string> {
    if (this.token) return this.token
    const configuredToken = this.config.token
    if (configuredToken) {
      this.token = configuredToken
      return configuredToken
    }

    throw new Error('OpenList auth requires a token. Please configure NUXT_PROVIDER_OPENLIST_TOKEN.')
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.ensureAuthToken()
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: token,
    }
    return fetch(url, { ...init, headers })
  }

  private normalizedRoot(): string {
    return (this.config.rootPath || '').replace(/\/+$/g, '').replace(/^\/+/, '')
  }

  private withRoot(key: string): string {
    const root = this.normalizedRoot()
    const trimmedKey = key.replace(/^\/+/, '')
    if (!root) {
      return trimmedKey
    }
    if (trimmedKey === root || trimmedKey.startsWith(`${root}/`)) {
      return trimmedKey
    }
    return `${root}/${trimmedKey}`
  }

  private toAbsolutePath(key: string): string {
    if (!key || key === '/') {
      return '/'
    }
    return key.startsWith('/') ? key : `/${key}`
  }

  private encodeUrlPath(key: string): string {
    return key
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/')
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private async waitForMeta(key: string): Promise<StorageObject | null> {
    const delaysMs = [0, 100, 250, 500, 1000]
    let last: StorageObject | null = null

    for (const delayMs of delaysMs) {
      if (delayMs > 0) await this.sleep(delayMs)
      const meta = await this.getFileMetaInternal(key, true)
      if (meta?.rawUrl || typeof meta?.size === 'number') return meta
      last = meta
    }

    return last
  }

  private async getDownloadResponse(
    key: string,
    range?: StorageByteRange,
  ): Promise<Response | null> {
    const headers = range
      ? { Range: `bytes=${range.start}-${range.end}` }
      : undefined
    const downloadPath = this.config.downloadEndpoint

    if (!downloadPath) {
      const delaysMs = [0, 100, 250, 500, 1000]
      const rootedKey = this.withRoot(key)
      for (let attempt = 0; attempt < delaysMs.length; attempt++) {
        const delayMs = delaysMs[attempt] ?? 0
        if (delayMs > 0) await this.sleep(delayMs)

        const meta = await this.getFileMetaInternal(rootedKey, attempt > 0)
        if (meta?.rawUrl) {
          const resp = await fetch(meta.rawUrl, { headers })
          if (resp.ok) return resp
        }

        const publicUrl = this.getPublicUrl(rootedKey)
        if (publicUrl) {
          const resp = await fetch(publicUrl, { headers })
          if (resp.ok) return resp
        }
      }
      return null
    }

    const rootedKey = this.withRoot(key)
    const urlPath = `${downloadPath}?${encodeURIComponent(this.pathField)}=${encodeURIComponent(rootedKey)}`
    return await this.request(urlPath, { method: 'GET', headers })
  }

  async create(key: string, fileBuffer: Buffer, contentType?: string): Promise<StorageObject> {
    const rootedKey = this.withRoot(key)
    const absoluteKey = this.toAbsolutePath(rootedKey)
    const uploadPath = this.config.uploadEndpoint || '/api/fs/put'

    const resp = await this.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(fileBuffer.length),
        'File-Path': encodeURIComponent(absoluteKey),
      },
      body: new Uint8Array(fileBuffer),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      this.logger?.error('OpenList upload failed', { status: resp.status, body: text })
      const statusLabel = resp.status === 413 ? 'Request Entity Too Large' : 'Request Failed'
      throw new StorageProviderError({
        provider: 'openlist',
        statusCode: resp.status,
        message: `OpenList upload failed: ${resp.status} ${statusLabel}`,
        body: text,
      })
    }

    this.logger?.success(`Uploaded object: ${absoluteKey}`)
    this.logger?.debug?.('OpenList upload details', {
      originalKey: key,
      rootedKey,
      absoluteKey,
      rootPath: this.normalizedRoot(),
    })

    const meta = await this.waitForMeta(rootedKey)
    return (
      meta || {
        key: rootedKey,
        size: fileBuffer.length,
        lastModified: new Date(),
      }
    )
  }

  async createFromStream(
    key: string,
    stream: Readable,
    _contentLength: number | null,
    contentType?: string,
  ): Promise<StorageObject> {
    const rootedKey = this.withRoot(key)
    const absoluteKey = this.toAbsolutePath(rootedKey)
    const uploadPath = this.config.uploadEndpoint || '/api/fs/put'

    const headers = new Headers()
    headers.set('Authorization', await this.ensureAuthToken())
    headers.set('Content-Type', contentType || 'application/octet-stream')
    headers.set('File-Path', encodeURIComponent(absoluteKey))

    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const payload = Buffer.concat(chunks)
    headers.set('Content-Length', String(payload.length))

    const resp = await fetch(`${this.baseUrl}${uploadPath}`, {
      method: 'PUT',
      headers,
      body: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      this.logger?.error('OpenList upload failed', { status: resp.status, body: text })
      const statusLabel = resp.status === 413 ? 'Request Entity Too Large' : 'Request Failed'
      throw new StorageProviderError({
        provider: 'openlist',
        statusCode: resp.status,
        message: `OpenList upload failed: ${resp.status} ${statusLabel}`,
        body: text,
      })
    }

    this.logger?.success(`Uploaded object: ${absoluteKey}`)
    this.logger?.debug?.('OpenList upload details', {
      originalKey: key,
      rootedKey,
      absoluteKey,
      rootPath: this.normalizedRoot(),
    })

    const meta = await this.waitForMeta(rootedKey)
    return (
      meta || {
        key: rootedKey,
        lastModified: new Date(),
      }
    )
  }

  async delete(key: string): Promise<void> {
    const deletePath = this.config.deleteEndpoint || '/api/fs/remove'
    const urlPath = `${deletePath}`
    const rootedKey = this.withRoot(key)
    const normalized = rootedKey.replace(/^\/+/, '')
    const slashIdx = normalized.lastIndexOf('/')
    const dir = this.toAbsolutePath(slashIdx >= 0 ? normalized.slice(0, slashIdx) : this.normalizedRoot())
    const name = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized
    const body = { dir, names: [name] }

    const resp = await this.request(urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      this.logger?.error('OpenList delete failed', { status: resp.status, body: text })
      throw new StorageProviderError({
        provider: 'openlist',
        statusCode: resp.status,
        message: `OpenList delete failed: ${resp.status}`,
        body: text,
      })
    }
    this.logger?.success(`Deleted object: ${key}`)
  }

  async get(key: string): Promise<Buffer | null> {
    const result = await this.getStream(key)
    if (!result) return null

    const chunks: Buffer[] = []
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async getStream(
    key: string,
    range?: StorageByteRange,
  ): Promise<StorageReadResult | null> {
    const response = await this.getDownloadResponse(key, range)
    if (!response?.ok || !response.body) return null

    if (range && response.status !== 206) {
      await response.body.cancel()
      throw new Error('OpenList download endpoint does not support byte ranges')
    }

    const contentLengthHeader = response.headers.get('content-length')
    const contentLength = contentLengthHeader
      ? Number.parseInt(contentLengthHeader, 10)
      : range
        ? range.end - range.start + 1
        : 0
    const totalSizeMatch = /\/(\d+)$/.exec(
      response.headers.get('content-range') ?? '',
    )
    const size = totalSizeMatch?.[1]
      ? Number.parseInt(totalSizeMatch[1], 10)
      : contentLength

    if (!isAsyncByteIterable(response.body)) {
      await response.body.cancel()
      return null
    }

    return {
      stream: Readable.from(response.body),
      size,
      contentLength,
    }
  }

  getPublicUrl(key: string): string {
    const rootedKey = this.withRoot(key)
    const { cdnUrl, baseUrl } = this.config
    const base = cdnUrl || (baseUrl ? `${baseUrl.replace(/\/$/, '')}/d` : '')
    if (!base) {
      return ''
    }
    return `${base.replace(/\/$/, '')}/${this.encodeUrlPath(rootedKey)}`
  }

  async getFileMeta(key: string): Promise<StorageObject | null> {
    return await this.getFileMetaInternal(key, false)
  }

  private async getFileMetaInternal(
    key: string,
    refresh: boolean,
  ): Promise<StorageObject | null> {
    const metaPath =
      this.config.metaEndpoint || this.config.downloadEndpoint || '/api/fs/get'
    const rootedKey = this.withRoot(key)
    const payload: Record<string, unknown> = {
      [this.pathField]: this.toAbsolutePath(rootedKey),
      password: '',
      page: 1,
      per_page: 0,
      refresh,
    }
    const resp = await this.request(metaPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      this.logger?.error('OpenList get file meta failed', { status: resp.status, body: text })
      return null
    }

    const data = toRecord(await resp.json().catch(() => null))
    if (!data) return { key: rootedKey }
    const node = toRecord(data.data) ?? data
    const size = node.size
    const modified = node.modified ?? node.lastModified
    const etag = node.etag
    const rawUrl = node.raw_url
    return {
      key: rootedKey,
      size: typeof size === 'number' ? size : undefined,
      lastModified:
        typeof modified === 'string' || typeof modified === 'number'
          ? new Date(modified)
          : undefined,
      etag: typeof etag === 'string' ? etag : undefined,
      rawUrl: typeof rawUrl === 'string' ? rawUrl : undefined,
    }
  }

  async listAll(): Promise<StorageObject[]> {
    const listPath = this.config.listEndpoint
    if (!listPath) return []

    const payload: Record<string, unknown> = {
      [this.pathField]: this.toAbsolutePath(this.normalizedRoot()),
      password: '',
      page: 1,
      per_page: 0,
      refresh: false,
    }
    const resp = await this.request(listPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) return []

    const data = toRecord(await resp.json().catch(() => null))
    const node = data ? toRecord(data.data) : null
    const items = node && Array.isArray(node.content) ? node.content : []
    const results: StorageObject[] = []

    for (const item of items) {
      const record = toRecord(item)
      if (!record) continue
      const rawKey = record.path
      const name = record.name
      if (typeof rawKey !== 'string' && typeof name !== 'string') continue

      const keyValue =
        typeof rawKey === 'string' ? rawKey : `${this.normalizedRoot()}/${name}`
      const rootedKey = this.withRoot(keyValue)
      const size = record.size
      const etag = record.etag
      const modified = record.modified ?? record.lastModified ?? record.mtime
      results.push({
        key: rootedKey,
        size: typeof size === 'number' ? size : undefined,
        lastModified:
          typeof modified === 'string' || typeof modified === 'number'
            ? new Date(modified)
            : undefined,
        etag: typeof etag === 'string' ? etag : undefined,
      })
    }

    return results
  }

  async listImages(): Promise<StorageObject[]> {
    const all = await this.listAll()
    return all.filter((obj) => /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i.test(obj.key))
  }
}
