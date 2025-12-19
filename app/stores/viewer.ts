import type { DisplayPhoto } from '~/libs/panorama/photo-variants'

export const useViewerState = defineStore('photo-viewer-state', () => {
  const currentPhotoIndex = ref(0)
  const isViewerOpen = ref(false)
  const returnRoute = ref<string | null>(null)
  const isDirectAccess = ref(false)
  const albumContext = ref<{ albumId: string; photos: DisplayPhoto[] } | null>(null)

  const openViewer = (
    index: number,
    route?: string | null,
    album?: { albumId: string; photos: DisplayPhoto[] },
  ) => {
    currentPhotoIndex.value = index
    isViewerOpen.value = true
    if (route) {
      returnRoute.value = route
      isDirectAccess.value = false
    } else {
      isDirectAccess.value = true
    }
    if (album) {
      albumContext.value = album
    } else {
      albumContext.value = null
    }
  }

  const switchToIndex = (index: number) => {
    currentPhotoIndex.value = index
  }

  const closeViewer = () => {
    isViewerOpen.value = false
    albumContext.value = null
  }

  const clearReturnRoute = () => {
    returnRoute.value = null
  }

  return {
    currentPhotoIndex,
    isViewerOpen,
    returnRoute,
    isDirectAccess,
    albumContext,
    openViewer,
    switchToIndex,
    closeViewer,
    clearReturnRoute,
  }
})
