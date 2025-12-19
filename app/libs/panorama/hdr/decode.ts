import type { PanoramaMetadata } from '../types'

type HDRDecodeResult = PanoramaMetadata & {
  decodeWidth: number
  decodeHeight: number
  data: Float32Array
}

const readLine = (bytes: Uint8Array, offset: number) => {
  let end = offset
  while (end < bytes.length && bytes[end] !== 0x0a) end++
  const line = new TextDecoder().decode(bytes.slice(offset, end))
  return { line, next: Math.min(bytes.length, end + 1) }
}

const parseResolution = (line: string) => {
  const parts = line.trim().split(/\s+/)
  if (parts.length !== 4) return null
  const ySign = parts[0]
  const yStr = parts[1]
  const xSign = parts[2]
  const xStr = parts[3]
  if (!ySign || !xSign || !yStr || !xStr) return null
  const height = Number.parseInt(yStr, 10)
  const width = Number.parseInt(xStr, 10)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  if (ySign !== '-Y' && ySign !== '+Y') return null
  if (xSign !== '+X' && xSign !== '-X') return null
  return { width, height, ySign, xSign }
}

export const readHDRMetadata = (buffer: ArrayBuffer): PanoramaMetadata => {
  const bytes = new Uint8Array(buffer)
  let offset = 0
  let formatOk = false
  let resolution: { width: number; height: number } | null = null

  while (offset < bytes.length) {
    const { line, next } = readLine(bytes, offset)
    offset = next
    if (line.startsWith('FORMAT=')) {
      formatOk = line.trim() === 'FORMAT=32-bit_rle_rgbe'
    }
    if (line.trim() === '') {
      const { line: resLine, next: next2 } = readLine(bytes, offset)
      offset = next2
      const res = parseResolution(resLine)
      if (!res) throw new Error('Invalid HDR resolution')
      resolution = { width: res.width, height: res.height }
      break
    }
  }

  if (!formatOk) throw new Error('Unsupported HDR format')
  if (!resolution) throw new Error('Missing HDR resolution')

  return { format: 'hdr', width: resolution.width, height: resolution.height }
}

const rgbeToLinear = (r: number, g: number, b: number, e: number) => {
  if (e === 0) return { r: 0, g: 0, b: 0 }
  const scale = Math.pow(2, e - 136)
  return { r: (r + 0.5) * scale, g: (g + 0.5) * scale, b: (b + 0.5) * scale }
}

const decodeOldPixels = (
  bytes: Uint8Array,
  offset: number,
  width: number,
  out: Uint8Array,
) => {
  const needed = width * 4
  const end = offset + needed
  if (end > bytes.length) {
    throw new Error('Unexpected end of HDR data')
  }
  out.set(bytes.slice(offset, end))
  return end
}

const decodeRLEChannel = (
  bytes: Uint8Array,
  offset: number,
  width: number,
  out: Uint8Array,
) => {
  let x = 0
  let off = offset
  while (x < width) {
    if (off >= bytes.length) throw new Error('Unexpected end of HDR RLE')
    const count = bytes[off]!
    off++
    if (count > 128) {
      const run = count - 128
      if (off >= bytes.length) throw new Error('Unexpected end of HDR RLE')
      const val = bytes[off]!
      off++
      out.fill(val, x, x + run)
      x += run
    } else if (count > 0) {
      const run = count
      const end = off + run
      if (end > bytes.length) throw new Error('Unexpected end of HDR RLE')
      out.set(bytes.slice(off, end), x)
      off = end
      x += run
    }
  }
  return off
}

const decodeScanline = (
  bytes: Uint8Array,
  offset: number,
  width: number,
  scanline: Uint8Array,
) => {
  if (width < 8 || width > 0x7fff) {
    return decodeOldPixels(bytes, offset, width, scanline)
  }

  if (offset + 4 > bytes.length) throw new Error('Unexpected end of HDR data')
  const b0 = bytes[offset]!
  const b1 = bytes[offset + 1]!
  const b2 = bytes[offset + 2]!
  const b3 = bytes[offset + 3]!

  const rleWidth = (b2 << 8) | b3
  const isRle = b0 === 2 && b1 === 2 && rleWidth === width

  if (!isRle) {
    return decodeOldPixels(bytes, offset, width, scanline)
  }

  let off = offset + 4
  const r = scanline.subarray(0, width)
  const g = scanline.subarray(width, width * 2)
  const b = scanline.subarray(width * 2, width * 3)
  const e = scanline.subarray(width * 3, width * 4)

  off = decodeRLEChannel(bytes, off, width, r)
  off = decodeRLEChannel(bytes, off, width, g)
  off = decodeRLEChannel(bytes, off, width, b)
  off = decodeRLEChannel(bytes, off, width, e)

  return off
}

export const decodeHDRToFloatRGB = (
  buffer: ArrayBuffer,
  decodeWidth: number,
  decodeHeight: number,
): HDRDecodeResult => {
  const bytes = new Uint8Array(buffer)

  let offset = 0
  let formatOk = false
  let resolution: { width: number; height: number; ySign: '-Y' | '+Y'; xSign: '+X' | '-X' } | null =
    null

  while (offset < bytes.length) {
    const { line, next } = readLine(bytes, offset)
    offset = next
    if (line.startsWith('FORMAT=')) {
      formatOk = line.trim() === 'FORMAT=32-bit_rle_rgbe'
    }
    if (line.trim() === '') {
      const { line: resLine, next: next2 } = readLine(bytes, offset)
      offset = next2
      const res = parseResolution(resLine)
      if (!res) throw new Error('Invalid HDR resolution')
      resolution = res
      break
    }
  }

  if (!formatOk) throw new Error('Unsupported HDR format')
  if (!resolution) throw new Error('Missing HDR resolution')

  const width = resolution.width
  const height = resolution.height
  const ySign = resolution.ySign
  const xSign = resolution.xSign

  const out = new Float32Array(decodeWidth * decodeHeight * 3)
  const scanline = new Uint8Array(width * 4)

  const stepX = width / decodeWidth
  const stepY = height / decodeHeight

  const selectedSourceY = new Map<number, number[]>()
  for (let y = 0; y < decodeHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor(y * stepY))
    const list = selectedSourceY.get(srcY)
    if (list) list.push(y)
    else selectedSourceY.set(srcY, [y])
  }

  let outRowBase = 0
  for (let fileY = 0; fileY < height; fileY++) {
    offset = decodeScanline(bytes, offset, width, scanline)
    const srcY = ySign === '-Y' ? fileY : height - 1 - fileY
    const targetRows = selectedSourceY.get(srcY)
    if (!targetRows) continue

    for (const y of targetRows) {
      outRowBase = y * decodeWidth * 3
      for (let x = 0; x < decodeWidth; x++) {
        const srcX = Math.min(width - 1, Math.floor(x * stepX))
        const idx = xSign === '+X' ? srcX : width - 1 - srcX
        const r8 = scanline[idx]!
        const g8 = scanline[idx + width]!
        const b8 = scanline[idx + width * 2]!
        const e8 = scanline[idx + width * 3]!
        const rgb = rgbeToLinear(r8, g8, b8, e8)
        const o = outRowBase + x * 3
        out[o] = rgb.r
        out[o + 1] = rgb.g
        out[o + 2] = rgb.b
      }
    }
  }

  return {
    format: 'hdr',
    width,
    height,
    decodeWidth,
    decodeHeight,
    data: out,
  }
}
