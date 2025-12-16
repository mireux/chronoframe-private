<script lang="ts" setup>
import type { AMapMap } from '~~/shared/types/map'

const props = withDefaults(
  defineProps<{
    markerId?: string
    lnglat?: [number, number]
    map?: AMapMap
  }>(),
  {
    markerId: undefined,
    lnglat: undefined,
    map: undefined,
  },
)

const markerInstance = shallowRef<any>()
const markerMap = shallowRef<AMapMap | undefined>()
const markerContainer = shallowRef<HTMLDivElement | null>(null)

const injectedMap = inject<Ref<AMapMap | undefined>>('amap', ref(undefined))
const mapToUse = computed(() => props.map || injectedMap.value)

const removeMarker = () => {
  if (markerInstance.value && markerMap.value) {
    markerMap.value.remove(markerInstance.value)
  }
  markerInstance.value = null
  markerMap.value = undefined
  markerContainer.value = null
}

const createMarker = (map: AMapMap, lnglat: [number, number]) => {
  if (!window.AMap?.Marker || !window.AMap?.Pixel) return

  removeMarker()

  const container = document.createElement('div')
  if (props.markerId) container.dataset.markerId = props.markerId

  markerContainer.value = container
  markerMap.value = map
  markerInstance.value = new window.AMap.Marker({
    position: lnglat,
    content: container,
    offset: new window.AMap.Pixel(-20, -20),
  })

  map.add(markerInstance.value)
}

watch(
  () => [mapToUse.value, props.lnglat] as const,
  ([map, lnglat], previous) => {
    const prevMap = previous?.[0]
    const prevLnglat = previous?.[1]
    if (!map || !lnglat) {
      removeMarker()
      return
    }

    if (!markerInstance.value || map !== prevMap || !prevLnglat) {
      nextTick(() => createMarker(map, lnglat))
      return
    }

    markerInstance.value.setPosition(lnglat)
  },
  { immediate: true },
)

watch(() => props.markerId, (newMarkerId) => {
  if (!markerContainer.value) return
  if (newMarkerId) markerContainer.value.dataset.markerId = newMarkerId
  else delete markerContainer.value.dataset.markerId
})

onBeforeUnmount(() => {
  removeMarker()
})
</script>

<template>
  <Teleport
    v-if="markerContainer"
    :to="markerContainer"
  >
    <slot name="marker" />
  </Teleport>
</template>

<style scoped></style>
