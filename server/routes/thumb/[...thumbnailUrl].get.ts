import sharp from 'sharp'

export default eventHandler(async (event) => {
  let url = getRouterParam(event, 'thumbnailUrl')

  if (!url) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid thumbnailUrl' })
  }

  url = decodeURIComponent(url)

  const abortController = new AbortController()
  const abort = () => abortController.abort()
  event.node.req.on('aborted', abort)
  event.node.req.on('close', abort)

  try {
    const photo = url.startsWith('/')
      ? Buffer.from(
          await $fetch<ArrayBuffer>(url, {
            responseType: 'arrayBuffer',
            signal: abortController.signal,
          }),
        )
      : Buffer.from(
          await fetch(url, { signal: abortController.signal }).then((res) => {
            if (!res.ok) {
              throw createError({
                statusCode: 404,
                statusMessage: 'Photo not found',
              })
            }
            return res.arrayBuffer()
          }),
        )

    const sharpInst = sharp(photo).rotate()
    return await sharpInst.jpeg({ quality: 85 }).toBuffer()
  } catch (error) {
    if (
      event.node.req.aborted ||
      abortController.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return
    }
    throw error
  } finally {
    event.node.req.off('aborted', abort)
    event.node.req.off('close', abort)
  }
})
