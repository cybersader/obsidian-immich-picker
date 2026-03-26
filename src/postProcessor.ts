import { requestUrl } from 'obsidian'
import ImmichPicker from './main'

// Module-level cache: assetId -> blob URL
const blobCache = new Map<string, string>()
// Track in-flight fetches to avoid duplicate requests
const pendingFetches = new Map<string, Promise<string>>()

export function clearImmichBlobCache (): void {
  for (const blobUrl of blobCache.values()) {
    URL.revokeObjectURL(blobUrl)
  }
  blobCache.clear()
  pendingFetches.clear()
}

export function registerImmichPostProcessor (plugin: ImmichPicker): void {
  plugin.registerMarkdownPostProcessor(async (el: HTMLElement) => {
    // Check both img elements and any elements with immich alt text
    const images = el.querySelectorAll('img')
    for (const img of Array.from(images)) {
      const alt = img.getAttribute('alt') || ''
      const match = alt.match(/^immich:([a-f0-9-]+)$/i)
      if (!match) continue

      const assetId = match[1]

      try {
        const blobUrl = await fetchOrGetCached(plugin, assetId)
        img.src = blobUrl
        img.alt = ''
        img.addClass('immich-remote-image')
      } catch (e) {
        console.error(`Failed to load Immich thumbnail for ${assetId}:`, e)
        img.alt = `[Immich image unavailable: ${assetId}]`
      }
    }

    // Also check for spans/links that contain the immich: pattern
    // (Obsidian may not create an img for data URIs in some views)
    const links = el.querySelectorAll('a')
    for (const link of Array.from(links)) {
      const innerImg = link.querySelector('img')
      if (innerImg) continue // Already handled above

      // Check if the link contains text matching our pattern
      const text = link.textContent || ''
      const match = text.match(/immich:([a-f0-9-]+)/i)
      if (!match) continue

      const assetId = match[1]

      try {
        const blobUrl = await fetchOrGetCached(plugin, assetId)
        const img = document.createElement('img')
        img.src = blobUrl
        img.addClass('immich-remote-image')
        link.empty()
        link.appendChild(img)
      } catch (e) {
        console.error(`Failed to load Immich thumbnail for ${assetId}:`, e)
      }
    }
  })
}

async function fetchOrGetCached (plugin: ImmichPicker, assetId: string): Promise<string> {
  // Check cache first
  if (blobCache.has(assetId)) {
    return blobCache.get(assetId)!
  }

  // Check if already fetching
  if (pendingFetches.has(assetId)) {
    return pendingFetches.get(assetId)!
  }

  // Fetch and cache
  const fetchPromise = (async () => {
    const url = plugin.immichApi.getThumbnailUrl(assetId)
    const apiKey = await plugin.getApiKey()
    const response = await requestUrl({
      url,
      headers: { 'x-api-key': apiKey }
    })
    const blob = new Blob([response.arrayBuffer], { type: 'image/jpeg' })
    const blobUrl = URL.createObjectURL(blob)
    blobCache.set(assetId, blobUrl)
    pendingFetches.delete(assetId)
    return blobUrl
  })()

  pendingFetches.set(assetId, fetchPromise)
  return fetchPromise
}
