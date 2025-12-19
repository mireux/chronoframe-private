import { z } from 'zod'
import { generateSafePhotoId } from '~~/server/utils/file-utils'

export default defineEventHandler(async (event) => {
  await requireUserSession(event)

  const { storageKey } = await readValidatedBody(
    event,
    z
      .object({
        storageKey: z.string().min(1),
      })
      .parse,
  )

  const photoId = generateSafePhotoId(storageKey)
  return {
    success: true,
    photoId,
    thumbnailKey: `thumbnails/${photoId}.webp`,
  }
})

