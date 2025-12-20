import type { Readable } from 'node:stream'
import type { _Object, S3ClientConfig } from '@aws-sdk/client-s3'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
  StorageObject,
  StorageProvider,
  StorageReadStream,
  UploadOptions,
} from '../interfaces'

const sanitizeKey = (key: string) =>
  key.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '')

const combinePrefixAndKey = (prefix: string | undefined, key: string) => {
  const cleanPrefix = (prefix || '').replace(/\/+$/, '').replace(/^\/+/, '')
  const cleanKey = sanitizeKey(key)
  if (!cleanPrefix) return cleanKey
  return cleanKey === cleanPrefix || cleanKey.startsWith(`${cleanPrefix}/`)
    ? cleanKey
    : `${cleanPrefix}/${cleanKey}`
}

const normalizeEndpoint = (
  endpoint: string,
  bucket: string,
  forcePathStyle?: boolean,
): string => {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return endpoint
  }

  const hadTrailingSlash = endpoint.endsWith('/')

  if (url.hostname.endsWith('.')) {
    url.hostname = url.hostname.slice(0, -1)
  }

  const bucketPrefix = `${bucket}.`
  if (!forcePathStyle && url.hostname.startsWith(bucketPrefix)) {
    url.hostname = url.hostname.slice(bucketPrefix.length)
  }

  let normalized = url.toString()
  if (!hadTrailingSlash && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }

  return normalized
}

const getHttpStatusCode = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const metadata: unknown = Reflect.get(error, '$metadata')
  if (typeof metadata !== 'object' || metadata === null) {
    return undefined
  }
  const httpStatusCode: unknown = Reflect.get(metadata, 'httpStatusCode')
  return typeof httpStatusCode === 'number' ? httpStatusCode : undefined
}

const isNodeReadableStream = (value: unknown): value is NodeJS.ReadableStream => {
  if (typeof value !== 'object' || value === null) return false
  if (!('pipe' in value)) return false
  const pipe = (value as { pipe?: unknown }).pipe
  return typeof pipe === 'function'
}

const createClient = (config: S3StorageConfig): S3Client => {
  if (config.provider !== 's3') {
    throw new Error('Invalid provider for S3 client creation')
  }

  const { accessKeyId, secretAccessKey, region, endpoint } = config
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing required accessKeyId or secretAccessKey')
  }

  const normalizedEndpoint = normalizeEndpoint(
    endpoint,
    config.bucket,
    config.forcePathStyle,
  )

  const clientConfig: S3ClientConfig = {
    endpoint: normalizedEndpoint,
    region,
    forcePathStyle: config.forcePathStyle,
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  }

  return new S3Client(clientConfig)
}

const convertToStorageObject = (s3object: _Object): StorageObject => {
  return {
    key: s3object.Key || '',
    size: s3object.Size,
    lastModified: s3object.LastModified,
    etag: s3object.ETag,
  }
}

export class S3StorageProvider implements StorageProvider {
  config: S3StorageConfig
  private logger?: Logger['storage']
  private client: S3Client

  constructor(config: S3StorageConfig, logger?: Logger['storage']) {
    this.config = config
    this.logger = logger
    this.client = createClient(config)
  }

  private resolveKey(key: string): string {
    return combinePrefixAndKey(this.config.prefix, key)
  }

  async create(
    key: string,
    data: Buffer,
    contentType?: string,
  ): Promise<StorageObject> {
    try {
      const absoluteKey = this.resolveKey(key)
      const cmd = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
        Body: data,
        ContentType: contentType || 'application/octet-stream',
      })

      const resp = await this.client.send(cmd)

      this.logger?.success(`Created object with key: ${absoluteKey}`)

      return {
        key: absoluteKey,
        size: data.length,
        lastModified: new Date(),
        etag: resp.ETag,
      }
    } catch (error) {
      this.logger?.error(`Failed to create object with key: ${key}`, error)
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const absoluteKey = this.resolveKey(key)
      const cmd = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      await this.client.send(cmd)
      this.logger?.success(`Deleted object with key: ${absoluteKey}`)
    } catch (error) {
      this.logger?.error(`Failed to delete object with key: ${key}`, error)
      throw error
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const absoluteKey = this.resolveKey(key)
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      const resp = await this.client.send(cmd)

      if (!resp.Body) {
        return null
      }

      if (resp.Body instanceof Buffer) {
        return resp.Body
      }

      const chunks: Uint8Array[] = []
      const stream = resp.Body as NodeJS.ReadableStream

      return new Promise<Buffer>((resolve, reject) => {
        stream.on('data', (chunk: Uint8Array) => {
          chunks.push(chunk)
        })

        stream.on('end', () => {
          resolve(Buffer.concat(chunks))
        })

        stream.on('error', (err) => {
          reject(err)
        })
      })
    } catch {
      return null
    }
  }

  async getStream(key: string): Promise<StorageReadStream | null> {
    const absoluteKey = this.resolveKey(key)
    const cmd = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: absoluteKey,
    })

    try {
      const resp = await this.client.send(cmd)
      if (!resp.Body) return null
      if (!isNodeReadableStream(resp.Body)) return null
      return {
        stream: resp.Body,
        size: resp.ContentLength ?? undefined,
      }
    } catch {
      return null
    }
  }

  getPublicUrl(key: string): string {
    const { cdnUrl, bucket, region, endpoint } = this.config
    const absoluteKey = this.resolveKey(key)

    // CDN URL
    if (cdnUrl) {
      return `${cdnUrl.replace(/\/$/, '')}/${absoluteKey}`
    }

    // Default AWS S3 endpoint
    if (!endpoint) {
      return `https://${bucket}.s3.${region}.amazonaws.com/${absoluteKey}`
    } else if (endpoint.includes('amazonaws.com')) {
      return `https://${bucket}.s3.${region}.amazonaws.com/${absoluteKey}`
    }

    // Alibaba Cloud OSS
    if (endpoint.includes('aliyuncs.com')) {
      const baseUrl = endpoint.replace(/\/$/, '')
      if (baseUrl.indexOf('//') === -1) {
        throw new Error('Invalid endpoint URL')
      }
      const protocol = baseUrl.split('//')[0]
      const remainder = baseUrl.split('//')[1]
      return `${protocol}//${bucket}.${remainder}/${absoluteKey}`
    }

    // Custom endpoint
    return `${endpoint.replace(/\/$/, '')}/${bucket}/${absoluteKey}`
  }

  async getSignedUrl(
    key: string,
    expiresIn: number = 3600,
    options?: UploadOptions,
  ): Promise<string> {
    const absoluteKey = this.resolveKey(key)
    const cmd = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: absoluteKey,
      ContentType: options?.contentType || 'application/octet-stream',
    })

    const url = await getSignedUrl(this.client, cmd, {
      expiresIn,
      // 为了更好的 CORS 支持，添加一些额外参数
      unhoistableHeaders: new Set(['Content-Type']),
    })
    return url
  }

  async getFileMeta(key: string): Promise<StorageObject | null> {
    try {
      const absoluteKey = this.resolveKey(key)
      const cmd = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      const resp = await this.client.send(cmd)

      if (!resp.ETag) {
        return null
      }

      return {
        key: absoluteKey,
        size: resp.ContentLength || 0,
        lastModified: resp.LastModified,
        etag: resp.ETag,
      }
    } catch (error) {
      if (getHttpStatusCode(error) === 404) {
        return null
      }
      this.logger?.error(`Failed to get metadata for key: ${key}`, error)
      throw error
    }
  }

  async createFromStream(
    key: string,
    stream: Readable,
    contentLength: number | null,
    contentType?: string,
  ): Promise<StorageObject> {
    try {
      const absoluteKey = combinePrefixAndKey(this.config.prefix, key)
      const cmd = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
        Body: stream,
        ContentType: contentType || 'application/octet-stream',
        ContentLength: contentLength ?? undefined,
      })

      const resp = await this.client.send(cmd)

      this.logger?.success(`Created object with key: ${absoluteKey}`)

      return {
        key: absoluteKey,
        size: contentLength ?? undefined,
        lastModified: new Date(),
        etag: resp.ETag,
      }
    } catch (error) {
      this.logger?.error(`Failed to create object with key: ${key}`, error)
      throw error
    }
  }

  async listAll(): Promise<StorageObject[]> {
    const cmd = new ListObjectsCommand({
      Bucket: this.config.bucket,
      Prefix: this.config.prefix,
      MaxKeys: this.config.maxKeys,
    })

    const resp = await this.client.send(cmd)
    this.logger?.log(resp.Contents?.map(convertToStorageObject))
    return resp.Contents?.map(convertToStorageObject) || []
  }

  async listImages(): Promise<StorageObject[]> {
    const cmd = new ListObjectsCommand({
      Bucket: this.config.bucket,
      Prefix: this.config.prefix,
      MaxKeys: this.config.maxKeys,
    })

    const resp = await this.client.send(cmd)
    // TODO: filter supported image format
    return resp.Contents?.map(convertToStorageObject) || []
  }
}
