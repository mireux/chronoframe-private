import { Transform } from 'node:stream'
import { useStorageProvider } from '~~/server/utils/useStorageProvider'
import { logger } from '~~/server/utils/logger'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { safeUseTranslation } from '~~/server/utils/i18n'

export default eventHandler(async (event) => {
  await requireUserSession(event)

  const { storageProvider } = useStorageProvider(event)
  const key = getQuery(event).key as string | undefined
  const t = await safeUseTranslation(event)

  if (!key) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.required.title'),
      data: {
        title: t('upload.error.required.title'),
        message: t('upload.error.required.message', { field: 'key' }),
      },
    })
  }

  const normalizedKey = key
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')

  if (!normalizedKey || normalizedKey.includes('..')) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.required.title'),
      data: {
        title: t('upload.error.required.title'),
        message: t('upload.error.required.message', { field: 'key' }),
      },
    })
  }

  const contentType = getHeader(event, 'content-type') || 'application/octet-stream'
  
  // MIME 类型白名单验证（可通过环境变量配置）
  const config = useRuntimeConfig(event)
  const whitelistEnabled = config.upload.mime.whitelistEnabled
  
  if (whitelistEnabled) {
    const whitelistStr = config.upload.mime.whitelist
    const allowedTypes = whitelistStr
      ? whitelistStr.split(',').map((type: string) => type.trim()).filter(Boolean)
      : []
    
    if (allowedTypes.length > 0 && !allowedTypes.includes(contentType)) {
      throw createError({
        statusCode: 415,
        statusMessage: t('upload.error.invalidType.title'),
        data: {
          title: t('upload.error.invalidType.title'),
          message: t('upload.error.invalidType.message', { type: contentType }),
          suggestion: t('upload.error.invalidType.suggestion', { allowed: allowedTypes.join(', ') }),
        },
      })
    }
  }
  
  const maxSizeMb =
    (await settingsManager.get<number>('storage', 'upload.maxSizeMb', 512)) ??
    512
  const maxBytes = maxSizeMb * 1024 * 1024

  const contentLengthHeader = getHeader(event, 'content-length')
  const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : NaN
  const contentLength =
    Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null

  if (contentLength !== null && contentLength > maxBytes) {
    const sizeInMB = (contentLength / 1024 / 1024).toFixed(2)
    throw createError({
      statusCode: 413,
      statusMessage: t('upload.error.tooLarge.title'),
      data: {
        title: t('upload.error.tooLarge.title'),
        message: t('upload.error.tooLarge.message', { size: sizeInMB }),
        suggestion: t('upload.error.tooLarge.suggestion', { maxSize: maxSizeMb }),
      },
    })
  }

  try {
    let bytesReceived = 0
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : null

        if (!buf) {
          callback(new Error('Invalid upload payload'))
          return
        }

        bytesReceived += buf.length
        if (bytesReceived > maxBytes) {
          callback(
            createError({
              statusCode: 413,
              statusMessage: t('upload.error.tooLarge.title'),
              data: {
                title: t('upload.error.tooLarge.title'),
                message: t('upload.error.tooLarge.message', {
                  size: (bytesReceived / 1024 / 1024).toFixed(2),
                }),
                suggestion: t('upload.error.tooLarge.suggestion', {
                  maxSize: maxSizeMb,
                }),
              },
            }),
          )
          return
        }

        callback(null, buf)
      },
    })

    logger.chrono.info(
      `[upload] Starting file upload: ${normalizedKey}, declared size: ${contentLength ?? 'unknown'}`,
    )

    const result = storageProvider.createFromStream
      ? await storageProvider.createFromStream(
          normalizedKey,
          event.node.req.pipe(limiter),
          contentLength,
          contentType,
        )
      : await (async () => {
          const raw = await readRawBody(event, false)
          if (!raw || !(raw instanceof Buffer)) {
            throw createError({
              statusCode: 400,
              statusMessage: t('upload.error.uploadFailed.title'),
              data: {
                title: t('upload.error.uploadFailed.title'),
                message: t('upload.error.uploadFailed.message'),
              },
            })
          }

          if (raw.byteLength > maxBytes) {
            const sizeInMB = (raw.byteLength / 1024 / 1024).toFixed(2)
            throw createError({
              statusCode: 413,
              statusMessage: t('upload.error.tooLarge.title'),
              data: {
                title: t('upload.error.tooLarge.title'),
                message: t('upload.error.tooLarge.message', { size: sizeInMB }),
                suggestion: t('upload.error.tooLarge.suggestion', {
                  maxSize: maxSizeMb,
                }),
              },
            })
          }

          return await storageProvider.create(normalizedKey, raw, contentType)
        })()

    logger.chrono.success(
      `[upload] File uploaded successfully: ${normalizedKey}, stored key: ${result.key}`,
    )
  } catch (error) {
    logger.chrono.error('Storage provider create error:', error)
    throw createError({
      statusCode: 500,
      statusMessage: t('upload.error.uploadFailed.title'),
      data: {
        title: t('upload.error.uploadFailed.title'),
        message: t('upload.error.uploadFailed.message'),
      },
    })
  }

  return { ok: true, key, needsEncryption: false }
})

