import { settingsManager } from '~~/server/services/settings/settingsManager'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', async (event) => {
    if (event.path === '/api/photos/upload') {
      const maxSizeMb =
        (await settingsManager.get<number>('storage', 'upload.maxSizeMb', 512)) ??
        512
      const maxBytes = maxSizeMb * 1024 * 1024
      event.node.req.headers['content-length-limit'] = String(maxBytes)
    }
  })
})
