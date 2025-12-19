import type { PanoramaFormat } from './types'

const normalizeExt = (name: string): string => {
  const idx = name.lastIndexOf('.')
  if (idx === -1) return ''
  return name.slice(idx + 1).toLowerCase()
}

export const getPanoramaFormatFromName = (name: string): PanoramaFormat | null => {
  const ext = normalizeExt(name)
  if (ext === 'hdr') return 'hdr'
  if (ext === 'exr') return 'exr'
  return null
}

export const isPanoramaFileName = (name: string): boolean => {
  return getPanoramaFormatFromName(name) !== null
}

export const getUploadContentTypeForPanorama = (
  format: PanoramaFormat,
): string => {
  if (format === 'hdr') return 'image/vnd.radiance'
  return 'image/x-exr'
}

export const getStorageKeyExt = (storageKey?: string | null): string => {
  if (!storageKey) return ''
  return normalizeExt(storageKey)
}

export const getPanoramaFormatFromStorageKey = (
  storageKey?: string | null,
): PanoramaFormat | null => {
  if (!storageKey) return null
  return getPanoramaFormatFromName(storageKey)
}

