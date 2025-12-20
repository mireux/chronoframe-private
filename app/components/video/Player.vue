<script setup lang="ts">
import { motion } from 'motion-v'

interface Props {
  src: string
  poster?: string
  autoplay?: boolean
  muted?: boolean
  loop?: boolean
  controls?: boolean
  class?: string
}

const props = withDefaults(defineProps<Props>(), {
  poster: undefined,
  autoplay: false,
  muted: false,
  loop: false,
  controls: true,
  class: undefined,
})

const videoRef = ref<HTMLVideoElement>()
const isPlaying = ref(false)
const isLoading = ref(true)
const isBuffering = ref(false)
const hasError = ref(false)
const showControls = ref(true)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const isMuted = ref(props.muted)
const isFullscreen = ref(false)
const controlsTimeout = ref<NodeJS.Timeout | null>(null)

const progress = computed(() => {
  if (duration.value === 0) return 0
  return (currentTime.value / duration.value) * 100
})

const formattedCurrentTime = computed(() => {
  return formatTime(currentTime.value)
})

const formattedDuration = computed(() => {
  return formatTime(duration.value)
})

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const togglePlay = () => {
  if (!videoRef.value) return

  if (isPlaying.value) {
    videoRef.value.pause()
  } else {
    videoRef.value.play()
  }
}

const handlePlay = () => {
  isPlaying.value = true
  isBuffering.value = false
}

const handlePause = () => {
  isPlaying.value = false
}

const handleWaiting = () => {
  isBuffering.value = true
}

const handleSeeking = () => {
  isBuffering.value = true
}

const handleCanPlay = () => {
  isBuffering.value = false
}

const handleSeeked = () => {
  isBuffering.value = false
}

const handleTimeUpdate = () => {
  if (!videoRef.value) return
  currentTime.value = videoRef.value.currentTime
}

const handleLoadedMetadata = () => {
  if (!videoRef.value) return
  duration.value = videoRef.value.duration
  isLoading.value = false
}

const handleError = () => {
  hasError.value = true
  isLoading.value = false
  isBuffering.value = false
}

const handleEnded = () => {
  isPlaying.value = false
  if (!props.loop) {
    currentTime.value = 0
  }
}

const seek = (event: MouseEvent) => {
  if (!videoRef.value) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const pos = (event.clientX - rect.left) / rect.width
  isBuffering.value = true
  videoRef.value.currentTime = pos * duration.value
}

const toggleMute = () => {
  if (!videoRef.value) return
  isMuted.value = !isMuted.value
  videoRef.value.muted = isMuted.value
}

const changeVolume = (event: Event) => {
  if (!videoRef.value) return
  const target = event.target as HTMLInputElement
  volume.value = parseFloat(target.value)
  videoRef.value.volume = volume.value
  if (volume.value === 0) {
    isMuted.value = true
  } else if (isMuted.value) {
    isMuted.value = false
  }
}

const toggleFullscreen = () => {
  if (!videoRef.value) return

  if (!document.fullscreenElement) {
    videoRef.value.requestFullscreen()
    isFullscreen.value = true
  } else {
    document.exitFullscreen()
    isFullscreen.value = false
  }
}

const handleMouseMove = () => {
  showControls.value = true
  if (controlsTimeout.value) {
    clearTimeout(controlsTimeout.value)
  }
  if (isPlaying.value) {
    controlsTimeout.value = setTimeout(() => {
      showControls.value = false
    }, 3000)
  }
}

const handleMouseLeave = () => {
  if (isPlaying.value) {
    showControls.value = false
  }
}

onMounted(() => {
  if (videoRef.value) {
    videoRef.value.volume = volume.value
    videoRef.value.muted = isMuted.value
  }
})

onUnmounted(() => {
  if (controlsTimeout.value) {
    clearTimeout(controlsTimeout.value)
  }
})
</script>

<template>
  <div
    class="relative w-full h-full bg-black rounded-lg overflow-hidden group"
    @mousemove="handleMouseMove"
    @mouseleave="handleMouseLeave"
  >
    <video
      ref="videoRef"
      :src="src"
      :poster="poster"
      :autoplay="autoplay"
      :muted="muted"
      :loop="loop"
      class="w-full h-full object-contain"
      playsinline
      @play="handlePlay"
      @pause="handlePause"
      @waiting="handleWaiting"
      @seeking="handleSeeking"
      @seeked="handleSeeked"
      @canplay="handleCanPlay"
      @timeupdate="handleTimeUpdate"
      @loadedmetadata="handleLoadedMetadata"
      @error="handleError"
      @ended="handleEnded"
      @click="togglePlay"
    />

    <div
      v-if="isLoading || isBuffering"
      class="absolute inset-0 flex items-center justify-center bg-black/50"
    >
      <Icon
        name="svg-spinners:ring-resize"
        class="w-12 h-12 text-white"
      />
    </div>

    <div
      v-if="hasError"
      class="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-white"
    >
      <Icon
        name="tabler:alert-circle"
        class="w-16 h-16 mb-4"
      />
      <p class="text-lg">视频加载失败</p>
    </div>

    <motion.div
      v-if="!isLoading && !hasError && controls"
      class="absolute inset-0 pointer-events-none"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: showControls || !isPlaying ? 1 : 0 }"
      :transition="{ duration: 0.3 }"
    >
      <div
        class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/30 pointer-events-none"
      />

      <div class="absolute inset-0 flex items-center justify-center pointer-events-auto">
        <button
          class="w-16 h-16 flex items-center justify-center rounded-full bg-white/20 backdrop-blur-md hover:bg-white/30 transition-all duration-200"
          @click.stop="togglePlay"
        >
          <Icon
            :name="isPlaying ? 'tabler:player-pause-filled' : 'tabler:player-play-filled'"
            class="w-8 h-8 text-white"
            :class="{ 'ml-1': !isPlaying }"
          />
        </button>
      </div>

      <div class="absolute bottom-0 left-0 right-0 p-4 pointer-events-auto">
        <div class="flex flex-col gap-2">
          <div
            class="w-full h-1 bg-white/30 rounded-full cursor-pointer group/progress"
            @click="seek"
          >
            <div
              class="h-full bg-white rounded-full transition-all duration-100 group-hover/progress:h-1.5"
              :style="{ width: `${progress}%` }"
            />
          </div>

          <div class="flex items-center justify-between text-white text-sm">
            <div class="flex items-center gap-3">
              <button
                class="hover:scale-110 transition-transform"
                @click.stop="togglePlay"
              >
                <Icon
                  :name="isPlaying ? 'tabler:player-pause' : 'tabler:player-play'"
                  class="w-5 h-5"
                />
              </button>

              <button
                class="hover:scale-110 transition-transform"
                @click.stop="toggleMute"
              >
                <Icon
                  :name="isMuted || volume === 0 ? 'tabler:volume-off' : volume < 0.5 ? 'tabler:volume-2' : 'tabler:volume'"
                  class="w-5 h-5"
                />
              </button>

              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="volume"
                class="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                @input="changeVolume"
                @click.stop
              />

              <span class="text-xs font-medium">
                {{ formattedCurrentTime }} / {{ formattedDuration }}
              </span>
            </div>

            <button
              class="hover:scale-110 transition-transform"
              @click.stop="toggleFullscreen"
            >
              <Icon
                :name="isFullscreen ? 'tabler:arrows-minimize' : 'tabler:arrows-maximize'"
                class="w-5 h-5"
              />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
video::-webkit-media-controls {
  display: none !important;
}

video::-webkit-media-controls-enclosure {
  display: none !important;
}
</style>
