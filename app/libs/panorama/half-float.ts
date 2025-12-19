const floatView = new Float32Array(1)
const intView = new Uint32Array(floatView.buffer)

export const floatToHalf = (value: number): number => {
  floatView[0] = value
  const x = intView[0]!

  const sign = (x >>> 31) & 0x1
  let exp = (x >>> 23) & 0xff
  let mantissa = x & 0x7fffff

  if (exp === 255) {
    if (mantissa !== 0) {
      return (sign << 15) | 0x7e00
    }
    return (sign << 15) | 0x7c00
  }

  exp -= 127

  if (exp < -14) {
    if (exp < -24) {
      return sign << 15
    }
    mantissa |= 0x800000
    const shift = -exp - 14
    const halfMantissa = mantissa >>> (shift + 13)
    const roundBit = (mantissa >>> (shift + 12)) & 1
    return (sign << 15) | (halfMantissa + roundBit)
  }

  if (exp > 15) {
    return (sign << 15) | 0x7c00
  }

  const halfExp = (exp + 15) & 0x1f
  const halfMantissa = mantissa >>> 13
  const roundBit = (mantissa >>> 12) & 1
  return (sign << 15) | (halfExp << 10) | (halfMantissa + roundBit)
}

export const halfToFloat = (half: number): number => {
  const sign = (half >>> 15) & 1
  const exp = (half >>> 10) & 0x1f
  const mantissa = half & 0x3ff

  if (exp === 0) {
    if (mantissa === 0) {
      return sign ? -0 : 0
    }
    return (sign ? -1 : 1) * Math.pow(2, -14) * (mantissa / 1024)
  }

  if (exp === 31) {
    return mantissa === 0 ? (sign ? -Infinity : Infinity) : NaN
  }

  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + mantissa / 1024)
}

