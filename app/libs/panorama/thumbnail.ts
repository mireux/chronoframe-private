import { rgbaToThumbHash } from 'thumbhash'
import { compressUint8Array } from '~~/shared/utils/u8array'
import type { PanoramaFormat } from './types'
import { PanoramaDecoderClient } from './decoder-client'
import { validatePanoramaBuffer } from './validate'

const fitWithin = (
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } => {
  const maxDim = Math.max(width, height)
  if (maxDim <= maxSize) return { width, height }
  const scale = maxSize / maxDim
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export const createPanoramaThumbnail = async (args: {
  file: File
  format: PanoramaFormat
  exposure?: number
}): Promise<{
  width: number
  height: number
  thumbnailBlob: Blob
  thumbnailHash: string
}> => {
  const buffer = await args.file.arrayBuffer()
  const validation = validatePanoramaBuffer(args.format, buffer)
  if (!validation.ok) {
    throw new Error(validation.message)
  }

  const decoder = new PanoramaDecoderClient()
  try {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const result = await decoder.decode({
      id,
      format: args.format,
      buffer,
      quality: 'low',
      maxTextureSize: 2048,
      target: {
        kind: 'rgba8',
        exposure: args.exposure ?? 0,
        toneMapping: 'aces',
        gamma: 2.2,
      },
    })

    if (result.kind !== 'rgba8') {
      throw new Error('Unexpected thumbnail decode output')
    }

    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = result.decodeWidth
    srcCanvas.height = result.decodeHeight
    const ctx = srcCanvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas not available')

    const img = new ImageData(result.data, result.decodeWidth, result.decodeHeight)
    ctx.putImageData(img, 0, 0)

    const thumbSize = fitWithin(result.decodeWidth, result.decodeHeight, 512)
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = thumbSize.width
    thumbCanvas.height = thumbSize.height
    const thumbCtx = thumbCanvas.getContext('2d', { alpha: false })
    if (!thumbCtx) throw new Error('Canvas not available')
    thumbCtx.drawImage(srcCanvas, 0, 0, thumbSize.width, thumbSize.height)

    const thumbnailBlob = await new Promise<Blob>((resolve, reject) => {
      thumbCanvas.toBlob(
        (b) => {
          if (!b) reject(new Error('Failed to create thumbnail'))
          else resolve(b)
        },
        'image/webp',
        0.9,
      )
    })

    const hashSize = fitWithin(thumbSize.width, thumbSize.height, 100)
    const hashCanvas = document.createElement('canvas')
    hashCanvas.width = hashSize.width
    hashCanvas.height = hashSize.height
    const hashCtx = hashCanvas.getContext('2d', { alpha: false })
    if (!hashCtx) throw new Error('Canvas not available')
    hashCtx.drawImage(thumbCanvas, 0, 0, hashSize.width, hashSize.height)
    const hashImageData = hashCtx.getImageData(
      0,
      0,
      hashSize.width,
      hashSize.height,
    )

    const thumbhash = rgbaToThumbHash(hashSize.width, hashSize.height, hashImageData.data)

    return {
      width: result.width,
      height: result.height,
      thumbnailBlob,
      thumbnailHash: compressUint8Array(thumbhash),
    }
  } finally {
    decoder.terminate()
  }
}
