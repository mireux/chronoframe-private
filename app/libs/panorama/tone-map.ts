import type { ToneMappingMode } from './types'

export const applyToneMapping = (
  linear: number,
  exposureStops: number,
  mode: ToneMappingMode,
): number => {
  if (!Number.isFinite(linear)) return 0
  const x = Math.max(0, linear) * Math.pow(2, exposureStops)

  if (mode === 'linear') {
    return x
  }

  if (mode === 'reinhard') {
    return x / (1 + x)
  }

  const a = 2.51
  const b = 0.03
  const c = 2.43
  const d = 0.59
  const e = 0.14
  return (x * (a * x + b)) / (x * (c * x + d) + e)
}

export const linearToSRGB8 = (
  linear: number,
  exposureStops: number,
  mode: ToneMappingMode,
  gamma: number,
): number => {
  const mapped = applyToneMapping(linear, exposureStops, mode)
  const clamped = Math.min(1, Math.max(0, mapped))
  const g = gamma > 0 ? gamma : 2.2
  const srgb = Math.pow(clamped, 1 / g)
  return Math.min(255, Math.max(0, Math.round(srgb * 255)))
}
