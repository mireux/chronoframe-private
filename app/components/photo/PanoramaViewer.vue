<script setup lang="ts">
import type { LoadingIndicatorRef } from './LoadingIndicator.vue'
import type { PanoramaDecodeQuality, PanoramaFormat, ToneMappingMode } from '~/libs/panorama/types'
import { PanoramaDecoderClient } from '~/libs/panorama/decoder-client'
import { PanoramaWebGLRenderer } from '~/libs/panorama/viewer-webgl'
import { clamp, degToRad, radToDeg } from '~/libs/panorama/math'
import { validatePanoramaBuffer } from '~/libs/panorama/validate'

interface Props {
  src: string
  format: PanoramaFormat
  thumbnailSrc?: string
  thumbhash?: string | null
  alt?: string
  isCurrentImage?: boolean
  loadingIndicatorRef: LoadingIndicatorRef | null
}

const props = withDefaults(defineProps<Props>(), {
  thumbnailSrc: '',
  thumbhash: null,
  alt: '',
  isCurrentImage: true,
})

const containerRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()

const isReady = ref(false)
const hasError = ref(false)
const errorMessage = ref<string>()

const toneMapping = ref<ToneMappingMode>('aces')
const exposure = ref(0)
const gamma = ref(2.2)
const quality = ref<PanoramaDecodeQuality>('high')

{
  const cores = navigator.hardwareConcurrency || 4
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (mem && mem <= 2) {
    quality.value = 'low'
  } else if (mem && mem <= 4) {
    quality.value = 'medium'
  } else if (cores <= 4) {
    quality.value = 'medium'
  }
}

const yaw = ref(Math.PI)
const pitch = ref(0)
const fovY = ref(degToRad(70))

let renderer: PanoramaWebGLRenderer | null = null
let decoder: PanoramaDecoderClient | null = null
let xhr: XMLHttpRequest | null = null
let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let sourceBuffer: ArrayBuffer | null = null
let isRgba8Path = false

const scheduleRender = () => {
  if (!renderer) return
  if (rafId != null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    renderer?.render({
      yaw: yaw.value,
      pitch: pitch.value,
      fovY: fovY.value,
      toneMapping: toneMapping.value,
      exposure: exposure.value,
      gamma: gamma.value,
    })
  })
}

const setDefaultView = () => {
  yaw.value = Math.PI
  pitch.value = 0
  fovY.value = degToRad(70)
}

const resetView = () => {
  setDefaultView()
  scheduleRender()
}

const setError = (message: string) => {
  hasError.value = true
  errorMessage.value = message
  props.loadingIndicatorRef?.updateLoadingState({
    isVisible: true,
    isError: true,
    errorMessage: message,
  })
}

const clearError = () => {
  hasError.value = false
  errorMessage.value = undefined
}

const cleanup = () => {
  if (xhr) {
    xhr.abort()
    xhr = null
  }
  sourceBuffer = null
  isRgba8Path = false
  decoder?.terminate()
  decoder = null
  renderer?.dispose()
  renderer = null
  if (rafId != null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  isReady.value = false
  clearError()
}

const initRenderer = () => {
  const canvas = canvasRef.value
  if (!canvas) throw new Error('Canvas not ready')
  renderer = new PanoramaWebGLRenderer(canvas)

  const container = containerRef.value
  if (container) {
    resizeObserver = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      renderer?.resize(rect.width, rect.height, window.devicePixelRatio || 1)
      scheduleRender()
    })
    resizeObserver.observe(container)
  }
}

const loadPanorama = async () => {
  cleanup()
  if (!props.isCurrentImage) return
  setDefaultView()

  try {
    initRenderer()
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err))
    return
  }

  props.loadingIndicatorRef?.updateLoadingState({
    isVisible: true,
    isWebGLLoading: true,
    webglMessage: 'Downloading',
    webglQuality: quality.value,
    progress: 0,
  })

  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const request = new XMLHttpRequest()
    xhr = request
    request.open('GET', props.src, true)
    request.responseType = 'arraybuffer'
    request.onprogress = (event) => {
      if (!event.lengthComputable) return
      const progress = Math.round((event.loaded / event.total) * 100)
      props.loadingIndicatorRef?.updateLoadingState({
        isVisible: true,
        isWebGLLoading: true,
        webglMessage: 'Downloading',
        webglQuality: quality.value,
        progress,
        bytesLoaded: event.loaded,
        bytesTotal: event.total,
      })
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300 && request.response) {
        resolve(request.response as ArrayBuffer)
        return
      }
      reject(new Error(`Failed to load panorama (${request.status})`))
    }
    request.onerror = () => reject(new Error('Failed to load panorama'))
    request.send()
  })

  xhr = null
  sourceBuffer = buffer

  const validation = validatePanoramaBuffer(props.format, buffer)
  if (!validation.ok) {
    setError(validation.message)
    return
  }

  const maxTextureSize = renderer?.getMaxTextureSize() || 4096
  const wantsFloat = renderer?.supportsRGB16F() ?? false
  isRgba8Path = !wantsFloat

  decoder = new PanoramaDecoderClient()
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`

  props.loadingIndicatorRef?.updateLoadingState({
    isVisible: true,
    isWebGLLoading: true,
    webglMessage: 'Decoding',
    webglQuality: quality.value,
    progress: 0,
  })

  const decode = async (
    target: 'rgb16f' | 'rgba8',
    q: PanoramaDecodeQuality,
  ) => {
    return await decoder!.decode({
      id: `${id}-${target}-${q}`,
      format: props.format,
      buffer: buffer.slice(0),
      quality: q,
      maxTextureSize,
      target:
        target === 'rgb16f'
          ? { kind: 'rgb16f' }
          : {
              kind: 'rgba8',
              exposure: exposure.value,
              toneMapping: toneMapping.value,
              gamma: gamma.value,
            },
    })
  }

  const setTexture = (result: Awaited<ReturnType<typeof decode>>) => {
    if (result.kind === 'rgb16f') {
      renderer?.setTextureRGB16F(result.decodeWidth, result.decodeHeight, result.data)
      return
    }
    renderer?.setTextureRGBA8(result.decodeWidth, result.decodeHeight, result.data)
  }

  const targetKind: 'rgb16f' | 'rgba8' = wantsFloat ? 'rgb16f' : 'rgba8'

  const lowResult = await decode(targetKind, 'low')
  try {
    setTexture(lowResult)
  } catch {
    if (targetKind === 'rgb16f') {
      const fallback = await decode('rgba8', 'low')
      setTexture(fallback)
      isRgba8Path = true
    } else {
      throw new Error('Failed to upload panorama texture')
    }
  }

  isReady.value = true
  props.loadingIndicatorRef?.updateLoadingState({ isVisible: false })
  scheduleRender()

  if (quality.value === 'low') {
    return
  }

  const localDecoder = decoder
  const localRenderer = renderer
  const runRefine = async () => {
    if (!localDecoder || !localRenderer) return
    props.loadingIndicatorRef?.updateLoadingState({
      isVisible: true,
      isWebGLLoading: true,
      webglMessage: 'Refining',
      webglQuality: quality.value,
    })
    try {
      const hiResult = await decode(targetKind, quality.value)
      if (decoder !== localDecoder || renderer !== localRenderer) return
      setTexture(hiResult)
      scheduleRender()
    } catch {
      /* empty */
    } finally {
      if (decoder === localDecoder) {
        props.loadingIndicatorRef?.updateLoadingState({ isVisible: false })
      }
    }
  }

  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number
  }).requestIdleCallback

  if (ric) {
    ric(() => {
      runRefine().catch(() => {})
    }, { timeout: 1500 })
    return
  }

  setTimeout(() => {
    runRefine().catch(() => {})
  }, 0)
}

const isDragging = ref(false)
const lastPos = ref<{ x: number; y: number } | null>(null)

const onPointerDown = (event: PointerEvent) => {
  if (!props.isCurrentImage) return
  if (!isReady.value) return
  isDragging.value = true
  lastPos.value = { x: event.clientX, y: event.clientY }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

const onPointerMove = (event: PointerEvent) => {
  if (!isDragging.value || !lastPos.value) return
  const dx = event.clientX - lastPos.value.x
  const dy = event.clientY - lastPos.value.y
  lastPos.value = { x: event.clientX, y: event.clientY }

  const sensitivity = 0.003
  yaw.value -= dx * sensitivity
  pitch.value -= dy * sensitivity
  pitch.value = clamp(pitch.value, -1.45, 1.45)
  scheduleRender()
}

const onPointerUp = (event: PointerEvent) => {
  if (!isDragging.value) return
  isDragging.value = false
  lastPos.value = null
  try {
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  } catch {
    /* empty */
  }
}

const onWheel = (event: WheelEvent) => {
  if (!props.isCurrentImage) return
  if (!isReady.value) return
  event.preventDefault()
  const delta = Math.sign(event.deltaY)
  const step = degToRad(5)
  fovY.value = clamp(fovY.value + delta * step, degToRad(20), degToRad(100))
  scheduleRender()
}

watch(
  () => [props.src, props.isCurrentImage, props.format] as const,
  ([newSrc, isCurrent]) => {
    if (!newSrc || !isCurrent) {
      cleanup()
      return
    }
    loadPanorama().catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  },
  { immediate: false },
)

watch([toneMapping, exposure, gamma], () => {
  if (!isReady.value) return
  if (!isRgba8Path) {
    scheduleRender()
    return
  }
  if (!sourceBuffer || !renderer) {
    return
  }

  const localBuffer = sourceBuffer
  const localRenderer = renderer

  const run = async () => {
    if (!decoder) {
      decoder = new PanoramaDecoderClient()
    }
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const maxTextureSize = localRenderer.getMaxTextureSize()

    props.loadingIndicatorRef?.updateLoadingState({
      isVisible: true,
      isWebGLLoading: true,
      webglMessage: 'Updating',
      webglQuality: quality.value,
    })

    try {
      const result = await decoder.decode({
        id,
        format: props.format,
        buffer: localBuffer.slice(0),
        quality: 'low',
        maxTextureSize,
        target: {
          kind: 'rgba8',
          exposure: exposure.value,
          toneMapping: toneMapping.value,
          gamma: gamma.value,
        },
      })
      if (!renderer || renderer !== localRenderer) return
      if (result.kind !== 'rgba8') return
      renderer.setTextureRGBA8(result.decodeWidth, result.decodeHeight, result.data)
      scheduleRender()
    } catch {
      /* empty */
    } finally {
      props.loadingIndicatorRef?.updateLoadingState({ isVisible: false })
    }
  }

  if (typeof window !== 'undefined') {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number
    }).requestIdleCallback
    if (ric) {
      ric(() => {
        run().catch(() => {})
      }, { timeout: 500 })
      return
    }
  }

  setTimeout(() => {
    run().catch(() => {})
  }, 0)
})

watch(quality, () => {
  if (!props.isCurrentImage) return
  loadPanorama().catch((err) => {
    setError(err instanceof Error ? err.message : String(err))
  })
})

watch(
  [() => props.src, () => props.format],
  () => {
    if (!props.src || !props.isCurrentImage) return
    loadPanorama().catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  },
)

onMounted(() => {
  if (!props.src || !props.isCurrentImage) return
  loadPanorama().catch((err) => {
    setError(err instanceof Error ? err.message : String(err))
  })
})

onUnmounted(() => {
  cleanup()
})
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full h-full flex items-center justify-center touch-none select-none"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <ThumbImage
      v-if="thumbnailSrc && (!isReady || hasError)"
      :src="thumbnailSrc"
      :thumbhash="thumbhash"
      :alt="alt"
      class="absolute inset-0 w-full h-full object-contain"
      thumbhash-class="opacity-50"
      image-contain
      :lazy="false"
    />

    <canvas
      v-show="isReady && !hasError"
      ref="canvasRef"
      class="absolute inset-0 w-full h-full"
    />

    <div
      v-if="hasError"
      class="absolute inset-0 flex flex-col items-center justify-center text-white/80 gap-2"
    >
      <Icon
        name="tabler:alert-circle"
        class="w-10 h-10"
      />
      <p class="text-sm">{{ errorMessage || 'Panorama load failed' }}</p>
    </div>

    <div
      v-if="isReady && !hasError"
      class="absolute top-3 left-3 z-20 flex flex-col gap-2"
    >
      <div class="bg-black/40 backdrop-blur-xl rounded-lg border border-white/10 p-2">
        <div class="flex items-center gap-2">
          <span class="text-xs text-white/80 tabular-nums">
            {{ radToDeg(fovY).toFixed(0) }}°
          </span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="tabler:refresh"
            @click="resetView"
          />
        </div>
      </div>
    </div>
  </div>
</template>
