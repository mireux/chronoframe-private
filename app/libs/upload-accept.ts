const MIME_EXTENSION_MAP: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/bmp': ['.bmp'],
  'image/tiff': ['.tif', '.tiff'],
  'image/heic': ['.heic'],
  'image/heif': ['.heif'],
  'image/vnd.radiance': ['.hdr'],
  'image/x-exr': ['.exr'],
  'video/quicktime': ['.mov'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/x-msvideo': ['.avi'],
  'video/x-matroska': ['.mkv'],
  'video/webm': ['.webm'],
  'video/x-flv': ['.flv'],
  'video/x-ms-wmv': ['.wmv'],
  'video/3gpp': ['.3gp'],
  'video/mpeg': ['.mpeg', '.mpg'],
}

export const UPLOAD_ACCEPT_WHEN_WHITELIST_DISABLED = 'image/*,video/*,.hdr,.exr,.heic,.heif'

export const buildUploadAccept = (mimeWhitelist: string | null | undefined): string => {
  const mimes = (mimeWhitelist ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)

  const acceptParts = new Set<string>()

  for (const mime of mimes) acceptParts.add(mime)

  for (const mime of mimes) {
    const extensions = MIME_EXTENSION_MAP[mime]
    if (!extensions) continue
    for (const ext of extensions) acceptParts.add(ext)
  }

  return Array.from(acceptParts).join(',')
}
