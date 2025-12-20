import { createReadStream } from 'node:fs'
import path from 'node:path'
import { and, eq, inArray, or } from 'drizzle-orm'
import { useStorageProvider } from '~~/server/utils/useStorageProvider'
import { getOrCreateDecryptedVideoCache } from '~~/server/services/storage/decryptedVideoCache'

const guessContentTypeFromKey = (key: string): string => {
  const ext = path.extname(key).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.tif':
    case '.tiff':
      return 'image/tiff'
    case '.heic':
    case '.heif':
    case '.hif':
      return 'image/heic'
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.avi':
      return 'video/x-msvideo'
    case '.mkv':
      return 'video/x-matroska'
    case '.webm':
      return 'video/webm'
    case '.flv':
      return 'video/x-flv'
    case '.wmv':
      return 'video/x-ms-wmv'
    case '.3gp':
      return 'video/3gpp'
    case '.mpeg':
    case '.mpg':
      return 'video/mpeg'
    case '.json':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
}

const normalizeKeyFromParam = (p: string): string => {
  const decoded = decodeURIComponent(p)
  const key = decoded.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '')
  if (!key || key.includes('..')) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid key' })
  }
  return key
}

const toHeicCandidatesFromJpeg = (key: string): string[] => {
  const lower = key.toLowerCase()
  if (!lower.endsWith('.jpeg')) return []
  const base = key.slice(0, -'.jpeg'.length)
  return [`${base}.heic`, `${base}.heif`, `${base}.hif`]
}

const parseByteRange = (
  rangeHeader: string,
  size: number,
): { start: number; end: number } | null => {
  const matches = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (!matches) return null

  const startRaw = matches[1] || ''
  const endRaw = matches[2] || ''
  if (!startRaw && !endRaw) return null

  if (!startRaw) {
    const suffixLen = Number.parseInt(endRaw, 10)
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null
    const start = Math.max(size - suffixLen, 0)
    const end = size - 1
    return { start, end }
  }

  const start = Number.parseInt(startRaw, 10)
  if (!Number.isFinite(start) || start < 0 || start >= size) return null

  const end = endRaw ? Number.parseInt(endRaw, 10) : size - 1
  if (!Number.isFinite(end) || end < start) return null

  return { start, end: Math.min(end, size - 1) }
}

export default eventHandler(async (event) => {
  const rawParam = getRouterParam(event, 'key')
  if (!rawParam) {
    throw createError({ statusCode: 400, statusMessage: 'Missing key' })
  }

  const key = normalizeKeyFromParam(rawParam)
  const { storageProvider } = useStorageProvider(event)

  const session = await getUserSession(event)
  const rangeHeader = getHeader(event, 'range')

  if (!session.user) {
    const db = useDB()

    const heicCandidates = toHeicCandidatesFromJpeg(key)
    const dbKeyCandidates = Array.from(
      new Set([key, `/${key}`, ...heicCandidates, ...heicCandidates.map((k) => `/${k}`)]),
    )
    const dbAssetKeyCandidates = [key, `/${key}`]

    const photo = await db
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(
        or(
          inArray(tables.photos.storageKey, dbKeyCandidates),
          inArray(tables.photos.thumbnailKey, dbAssetKeyCandidates),
          inArray(tables.photos.livePhotoVideoKey, dbAssetKeyCandidates),
        ),
      )
      .get()

    if (!photo) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }

    const hiddenRelation = await db
      .select({ id: tables.albumPhotos.id })
      .from(tables.albumPhotos)
      .innerJoin(tables.albums, eq(tables.albumPhotos.albumId, tables.albums.id))
      .where(and(eq(tables.albumPhotos.photoId, photo.id), eq(tables.albums.isHidden, 1)))
      .get()

    if (hiddenRelation) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
  }

  const contentType = guessContentTypeFromKey(key)

  if (contentType.startsWith('video/')) {
    const cached = await getOrCreateDecryptedVideoCache(storageProvider, key)
    if (!cached) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }

    setHeader(event, 'Content-Type', contentType)
    setHeader(event, 'Accept-Ranges', 'bytes')

    setHeader(
      event,
      'Cache-Control',
      session.user ? 'private, max-age=0, must-revalidate' : 'public, max-age=31536000, immutable',
    )

    const range = rangeHeader ? parseByteRange(rangeHeader, cached.size) : null
    if (range) {
      event.node.res.statusCode = 206
      setHeader(event, 'Content-Range', `bytes ${range.start}-${range.end}/${cached.size}`)
      setHeader(event, 'Content-Length', String(range.end - range.start + 1))
      const stream = createReadStream(cached.filePath, { start: range.start, end: range.end })
      return sendStream(event, stream)
    }

    setHeader(event, 'Content-Length', String(cached.size))
    const stream = createReadStream(cached.filePath)
    return sendStream(event, stream)
  }

  const buffer = await storageProvider.get(key)
  if (!buffer) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  setHeader(event, 'Content-Type', contentType)

  // Public photos are already filtered by DB check; allow long caching for them.
  setHeader(
    event,
    'Cache-Control',
    session.user ? 'private, max-age=0, must-revalidate' : 'public, max-age=31536000, immutable',
  )

  if (rangeHeader) {
    const size = buffer.length
    const parsed = parseByteRange(rangeHeader, size)
    if (parsed) {
      event.node.res.statusCode = 206
      setHeader(event, 'Content-Range', `bytes ${parsed.start}-${parsed.end}/${size}`)
      setHeader(event, 'Content-Length', String(parsed.end - parsed.start + 1))
      return buffer.subarray(parsed.start, parsed.end + 1)
    }
  }

  setHeader(event, 'Content-Length', String(buffer.length))
  return buffer
})
