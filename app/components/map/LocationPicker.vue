<script lang="ts" setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import type { MapInstance } from '~~/shared/types/map'
import { gcj02ToWgs84, transformCoordinate } from '~/utils/coordinate-transform'

const props = withDefaults(
  defineProps<{
    modelValue?: { latitude: number; longitude: number } | null
    zoom?: number
    class?: string
  }>(),
  {
    modelValue: null,
    zoom: 4,
    class: undefined,
  },
)

const emit = defineEmits<{
  'update:modelValue': [{ latitude: number; longitude: number } | null]
  pick: [{ latitude: number; longitude: number }]
}>()

const mapInstance = ref<MapInstance | null>(null)
const markerCoordinates = ref<[number, number] | null>(null)
const { locale } = useI18n({ useScope: 'global' })

const mapConfig = computed(() => {
  const config = getSetting('map')
  return typeof config === 'object' && config ? config : {}
})

const provider = computed(() => mapConfig.value.provider || 'maplibre')

let clickHandler: ((event: any) => void) | null = null

const syncFromProps = (value: { latitude: number; longitude: number } | null) => {
  if (value) {
    const [lng, lat] = transformCoordinate(
      value.longitude,
      value.latitude,
      provider.value,
    )
    markerCoordinates.value = [lng, lat]
    if (mapInstance.value) {
      const map: any = mapInstance.value
      const zoom = Math.max(props.zoom ?? 4, 4)
      if (typeof map.setZoomAndCenter === 'function') {
        map.setZoomAndCenter(zoom, markerCoordinates.value, true, 0)
      } else if (typeof map.flyTo === 'function') {
        map.flyTo?.({
          center: markerCoordinates.value,
          zoom,
          essential: true,
        })
      } else {
        map.setCenter?.(markerCoordinates.value)
        map.setZoom?.(zoom)
      }
    }
  } else {
    markerCoordinates.value = null
  }
}

watch(
  () => props.modelValue,
  (value) => {
    syncFromProps(value ?? null)
  },
  { immediate: true },
)

const updateValue = (
  latitude: number,
  longitude: number,
  shouldEmitPick = true,
) => {
  markerCoordinates.value = [longitude, latitude]

  let wgsLatitude = latitude
  let wgsLongitude = longitude
  if (provider.value === 'amap') {
    const [lng, lat] = gcj02ToWgs84(longitude, latitude)
    wgsLatitude = lat
    wgsLongitude = lng
  }

  emit('update:modelValue', { latitude: wgsLatitude, longitude: wgsLongitude })
  if (shouldEmitPick) {
    emit('pick', { latitude: wgsLatitude, longitude: wgsLongitude })
  }
}

const handleMapClick = (event: any) => {
  const point =
    event?.lngLat ||
    event?.lnglat ||
    event?.latlng ||
    (Array.isArray(event) ? { lng: event[0], lat: event[1] } : null)
  if (!point) {
    return
  }

  const latitude =
    typeof point.lat === 'number'
      ? point.lat
      : typeof point.getLat === 'function'
        ? point.getLat()
        : point.latitude ?? point[1]
  const longitude =
    typeof point.lng === 'number'
      ? point.lng
      : typeof point.getLng === 'function'
        ? point.getLng()
        : point.longitude ?? point[0]
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return
  }
  updateValue(latitude, longitude)
}

const onMapLoad = (map: MapInstance) => {
  mapInstance.value = map

  if (markerCoordinates.value) {
    const anyMap: any = map
    anyMap.setCenter?.(markerCoordinates.value)
    anyMap.setZoom?.(Math.max(props.zoom ?? 4, 4))
  }

  const anyMap: any = map
  if (typeof anyMap.on === 'function') {
    clickHandler = (event: any) => handleMapClick(event)
    anyMap.on('click', clickHandler)
  }
}

onBeforeUnmount(() => {
  if (mapInstance.value && clickHandler) {
    const anyMap: any = mapInstance.value
    if (typeof anyMap.off === 'function') {
      anyMap.off('click', clickHandler)
    }
  }
})
</script>

<template>
  <div :class="['relative w-full h-64 rounded-xl overflow-hidden', $props.class]">
    <MapProvider
      class="w-full h-full"
      :map-id="'photo-location-picker'"
      :center="markerCoordinates ?? undefined"
      :zoom="markerCoordinates ? Math.max($props.zoom ?? 4, 4) : $props.zoom ?? 2"
      :interactive="true"
      :language="locale"
      @load="onMapLoad"
    >
      <MapProviderMarker
        v-if="markerCoordinates"
        :lnglat="markerCoordinates"
      >
        <template #marker>
          <div class="relative">
            <div class="absolute inset-0 animate-ping rounded-full bg-primary/40" />
            <div class="relative size-4 rounded-full bg-primary border-2 border-white shadow" />
          </div>
        </template>
      </MapProviderMarker>
    </MapProvider>

    <div
      v-if="!markerCoordinates"
      class="absolute inset-0 pointer-events-none flex items-center justify-center text-sm text-neutral-600 dark:text-neutral-400"
    >
      <slot name="empty" />
    </div>
  </div>
</template>
