import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'
import type { StorageObject, StorageProvider, UploadOptions } from './interfaces'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import {
  decryptBuffer,
  deriveAes256Key,
  ENCRYPTION_IV_LENGTH,
  ENCRYPTION_MAGIC,
  ENCRYPTION_TAG_LENGTH,
  encryptBuffer,
  isEncryptedPayload,
} from './encryption'

const getEncryptionSettings = async (): Promise<{
  encryptOnWrite: boolean
  key: Buffer | null
}> => {
  const encryptOnWrite = Boolean(
    await settingsManager.get<boolean>('storage', 'encryption.enabled'),
  )
  const rawKey = await settingsManager.get<string>('storage', 'encryption.key')

  if (!rawKey) {
    return { encryptOnWrite, key: null }
  }

  return { encryptOnWrite, key: deriveAes256Key(rawKey) }
}

const createEncryptedStream = (
  plaintextStream: Readable,
  key: Buffer,
  aad?: Buffer,
): { stream: Readable; overheadBytes: number } => {
  const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad && aad.length > 0) {
    cipher.setAAD(aad)
  }

  const out = new PassThrough()
  out.write(Buffer.concat([ENCRYPTION_MAGIC, iv]))

  plaintextStream.on('error', (err) => out.destroy(err))
  cipher.on('error', (err) => out.destroy(err))

  cipher.on('end', () => {
    try {
      out.end(cipher.getAuthTag())
    } catch (err) {
      out.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  })

  plaintextStream.pipe(cipher)
  cipher.pipe(out, { end: false })

  return {
    stream: out,
    overheadBytes:
      ENCRYPTION_MAGIC.length + ENCRYPTION_IV_LENGTH + ENCRYPTION_TAG_LENGTH,
  }
}

export class EncryptedStorageProvider implements StorageProvider {
  config?: StorageProvider['config']
  getSignedUrl?: (
    key: string,
    expiresIn?: number,
    options?: UploadOptions,
  ) => Promise<string>

  constructor(private inner: StorageProvider) {
    this.config = inner.config
    this.getSignedUrl = inner.getSignedUrl?.bind(inner)
  }

  async create(
    key: string,
    fileBuffer: Buffer,
    contentType?: string,
    skipEncryption?: boolean,
  ): Promise<StorageObject> {
    const { encryptOnWrite, key: encryptionKey } = await getEncryptionSettings()
    if (!encryptOnWrite || skipEncryption) {
      return await this.inner.create(key, fileBuffer, contentType)
    }
    if (!encryptionKey) {
      throw new Error('Storage encryption is enabled but encryption key is not set')
    }

    const payload = isEncryptedPayload(fileBuffer)
      ? fileBuffer
      : encryptBuffer(fileBuffer, encryptionKey)

    return await this.inner.create(key, payload, 'application/octet-stream')
  }

  async createFromStream(
    key: string,
    stream: Readable,
    contentLength: number | null,
    contentType?: string,
    skipEncryption?: boolean,
  ): Promise<StorageObject> {
    const { encryptOnWrite, key: encryptionKey } = await getEncryptionSettings()

    if (!encryptOnWrite || skipEncryption) {
      if (this.inner.createFromStream) {
        return await this.inner.createFromStream(
          key,
          stream,
          contentLength,
          contentType,
        )
      }

      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk)
        } else if (chunk instanceof Uint8Array) {
          chunks.push(Buffer.from(chunk))
        } else {
          chunks.push(Buffer.from(String(chunk)))
        }
      }
      return await this.inner.create(
        key,
        Buffer.concat(chunks),
        contentType,
        skipEncryption,
      )
    }

    if (!encryptionKey) {
      throw new Error('Storage encryption is enabled but encryption key is not set')
    }

    if (!this.inner.createFromStream) {
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk)
        } else if (chunk instanceof Uint8Array) {
          chunks.push(Buffer.from(chunk))
        } else {
          chunks.push(Buffer.from(String(chunk)))
        }
      }
      const encrypted = encryptBuffer(Buffer.concat(chunks), encryptionKey)
      return await this.inner.create(key, encrypted, 'application/octet-stream')
    }

    const encrypted = createEncryptedStream(stream, encryptionKey)
    const encryptedLength =
      contentLength === null ? null : contentLength + encrypted.overheadBytes

    return await this.inner.createFromStream(
      key,
      encrypted.stream,
      encryptedLength,
      'application/octet-stream',
      true,
    )
  }

  async encryptFile(key: string): Promise<void> {
    const { key: encryptionKey } = await getEncryptionSettings()
    if (!encryptionKey) {
      throw new Error('Encryption key is not set')
    }

    let fileBuffer: Buffer | null = null
    let retries = 5

    while (retries > 0) {
      const fileMeta = await this.inner.getFileMeta(key)
      logger.chrono.info(`[encryptFile] Checking file: ${key}, exists: ${!!fileMeta}, retries left: ${retries}`)

      fileBuffer = await this.inner.get(key)
      if (fileBuffer) {
        logger.chrono.success(`[encryptFile] File found: ${key}, size: ${fileBuffer.length}`)
        break
      }

      if (retries > 1) {
        logger.chrono.warn(`[encryptFile] File not found, waiting 500ms before retry: ${key}`)
        await new Promise(resolve => setTimeout(resolve, 500))
        retries--
      } else {
        logger.chrono.error(`[encryptFile] File not found after all retries: ${key}`)
        throw new Error(`File not found: ${key}`)
      }
    }

    if (isEncryptedPayload(fileBuffer)) {
      logger.chrono.info(`[encryptFile] File already encrypted, skipping: ${key}`)
      return
    }

    logger.chrono.info(`[encryptFile] Starting encryption: ${key}`)
    const encryptedPayload = encryptBuffer(fileBuffer, encryptionKey)
    await this.inner.create(key, encryptedPayload, 'application/octet-stream')
    logger.chrono.success(`[encryptFile] Encryption completed: ${key}`)
  }

  async delete(key: string): Promise<void> {
    return await this.inner.delete(key)
  }

  async get(key: string): Promise<Buffer | null> {
    const payload = await this.inner.get(key)
    if (!payload) return null
    if (!isEncryptedPayload(payload)) return payload

    const { key: encryptionKey } = await getEncryptionSettings()
    if (!encryptionKey) {
      throw new Error('Encrypted object found but encryption key is not set')
    }
    return decryptBuffer(payload, encryptionKey)
  }

  getPublicUrl(key: string): string {
    return this.inner.getPublicUrl(key)
  }

  async getFileMeta(key: string): Promise<StorageObject | null> {
    return await this.inner.getFileMeta(key)
  }

  async listAll(): Promise<StorageObject[]> {
    return await this.inner.listAll()
  }

  async listImages(): Promise<StorageObject[]> {
    return await this.inner.listImages()
  }
}
