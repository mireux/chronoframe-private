export const clamp = (value: number, min: number, max: number) => {
  if (value < min) return min
  if (value > max) return max
  return value
}

export const radToDeg = (rad: number) => (rad * 180) / Math.PI
export const degToRad = (deg: number) => (deg * Math.PI) / 180

export const nextPowerOfTwo = (value: number) => {
  let v = 1
  while (v < value) v <<= 1
  return v
}

