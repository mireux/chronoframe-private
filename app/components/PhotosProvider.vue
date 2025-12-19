<script lang="ts" setup>
import type { AsyncDataRequestStatus } from '#app'
import type { DisplayPhoto } from '~/libs/panorama/photo-variants'

const props = defineProps<{
  photos: DisplayPhoto[]
  refresh: () => Promise<void>
  status: AsyncDataRequestStatus
}>()

const photosRef = toRef(props, 'photos')
const status = toRef(props, 'status')
const refresh = props.refresh
providePhotos(photosRef, status, refresh)
</script>

<template>
  <slot />
</template>

<style scoped></style>
