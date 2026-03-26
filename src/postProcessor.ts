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
    const images = el.querySelectorAll('img')
    for (const img of Array.from(images)) {
      const src = img.getAttribute('src') || ''
      // Match immich://ASSET_ID (UUID format)
      const match = src.match(/immich:\/\/([a-f0-9-]+)/i)
      if (!match) continue

      const assetId = match[1]

      try {
        const blobUrl = await fetchOrGetCached(plugin, assetId)
        img.src = blobUrl
      } catch (e) {
        console.error(`Failed to load Immich thumbnail for ${assetId}:`, e)
        img.alt = `[Immich image unavailable: ${assetId}]`
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
    const response = await requestUrl({
      url,
      headers: { 'x-api-key': plugin.settings.apiKey }
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
