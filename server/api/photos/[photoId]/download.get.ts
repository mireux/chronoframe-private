import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createDecryptedVideoReadStream, getOrCreateDecryptedVideoCache } from '~~/server/services/storage/decryptedVideoCache'
import { useStorageProvider } from '~~/server/utils/useStorageProvider'

const getDownloadFileName = (title: string | null, storageKey: string): string => {
  const extension = path.extname(storageKey)
  const storedFileName = path.basename(storageKey)
  const trimmedTitle = title?.trim()

  if (!trimmedTitle) return storedFileName
  return path.extname(trimmedTitle) ? trimmedTitle : `${trimmedTitle}${extension}`
}

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing photo ID' })
  }

  const photo = useDB()
    .select({
      title: tables.photos.title,
      storageKey: tables.photos.storageKey,
      isVideo: tables.photos.isVideo,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo?.isVideo || !photo.storageKey) {
    throw createError({ statusCode: 404, statusMessage: 'Video not found' })
  }

  const { storageProvider } = useStorageProvider(event)
  const cached = await getOrCreateDecryptedVideoCache(
    storageProvider,
    photo.storageKey,
  )
  if (!cached) {
    throw createError({ statusCode: 404, statusMessage: 'Video file not found' })
  }

  const fileName = getDownloadFileName(photo.title, photo.storageKey)
  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(
    event,
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  )
  setHeader(event, 'Content-Length', cached.size)
  setHeader(event, 'Cache-Control', 'private, no-store')

  return sendStream(event, createDecryptedVideoReadStream(cached))
})
