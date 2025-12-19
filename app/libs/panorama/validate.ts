import type { PanoramaFormat } from './types'

const HDR_SIGNATURE = '#?RADIANCE'

export const validatePanoramaBuffer = (
  format: PanoramaFormat,
  buffer: ArrayBuffer,
): { ok: true } | { ok: false; message: string } => {
  if (format === 'hdr') {
    const text = new TextDecoder().decode(buffer.slice(0, 4096))
    if (!text.startsWith(HDR_SIGNATURE)) {
      return { ok: false, message: 'Invalid HDR signature' }
    }
    if (!text.includes('FORMAT=32-bit_rle_rgbe')) {
      return { ok: false, message: 'Unsupported HDR format' }
    }
    return { ok: true }
  }

  if (buffer.byteLength < 8) {
    return { ok: false, message: 'Invalid EXR header' }
  }
  const view = new DataView(buffer)
  const magic = view.getUint32(0, true)
  if (magic !== 20000630) {
    return { ok: false, message: 'Invalid EXR signature' }
  }
  return { ok: true }
}
