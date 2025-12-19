import type { AsyncDataRequestStatus } from "#app"
import type { DisplayPhoto } from '~/libs/panorama/photo-variants'
import { findDisplayPhotoById } from '~/libs/panorama/photo-variants'

interface PhotosContext {
  photos: Ref<DisplayPhoto[]>
  status: Ref<AsyncDataRequestStatus>
  refresh: () => Promise<void>
  getPhotoById: (id: string) => DisplayPhoto | undefined
  filterPhotos: (predicate: (photo: DisplayPhoto) => boolean) => DisplayPhoto[]
  totalCount: ComputedRef<number>
}

const PhotosContextKey = Symbol('PhotosContext') as InjectionKey<PhotosContext>

export function providePhotos(
  photos: Ref<DisplayPhoto[]>,
  status: Ref<AsyncDataRequestStatus>,
  refresh: () => Promise<void>,
) {
  const context: PhotosContext = {
    photos,
    status,
    refresh,
    getPhotoById: (id: string) => {
      return findDisplayPhotoById(photos.value, id)
    },
    filterPhotos: (predicate: (photo: DisplayPhoto) => boolean) => {
      return photos.value.filter(predicate)
    },
    totalCount: computed(() => photos.value.length),
  }

  provide(PhotosContextKey, context)

  return context
}

export function usePhotos(): PhotosContext {
  const context = inject(PhotosContextKey)

  if (!context) {
    throw new Error('usePhotos must be used within a PhotosProvider')
  }

  return context
}
