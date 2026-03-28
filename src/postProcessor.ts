import { requestUrl } from 'obsidian'
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
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
  // Code block processor: renders ```immich\nUUID\nwidth=400\n``` as images
  plugin.registerMarkdownCodeBlockProcessor('immich', async (source, el) => {
    const lines = source.trim().split('\n')
    let assetId = ''
    let width = 0

    for (const line of lines) {
      const trimmed = line.trim()
      const widthMatch = trimmed.match(/^width=(\d+)$/i)
      if (widthMatch) {
        width = parseInt(widthMatch[1], 10)
        continue
      }
      if (trimmed.match(/^[a-f0-9-]+$/i)) {
        assetId = trimmed
      }
    }

    if (assetId) {
      renderImmichImage(plugin, el, assetId, width)
    }
  })

  // Post-processor: handles server-url, html-tag, and legacy formats
  plugin.registerMarkdownPostProcessor(async (el: HTMLElement) => {
    const images = el.querySelectorAll('img')
    const serverUrl = plugin.settings.serverUrl

    for (const img of Array.from(images)) {
      // Already processed
      if (img.hasClass('immich-remote-image')) continue

      const src = img.getAttribute('src') || ''
      const alt = img.getAttribute('alt') || ''

      // Format: server-url — src contains Immich server thumbnail URL
      if (serverUrl && src.includes(serverUrl) && src.includes('/api/assets/')) {
        const urlMatch = src.match(/\/api\/assets\/([a-f0-9-]+)\/thumbnail/i)
        if (urlMatch) {
          await replaceImgSrc(plugin, img, urlMatch[1])
          continue
        }
      }

      // Format: html-tag — data-immich-id attribute
      const dataId = img.getAttribute('data-immich-id')
      if (dataId && dataId.match(/^[a-f0-9-]+$/i)) {
        await replaceImgSrc(plugin, img, dataId)
        continue
      }

      // Legacy: alt text marker (immich:UUID)
      const altMatch = alt.match(/^immich:([a-f0-9-]+)$/i)
      if (altMatch) {
        await replaceImgSrc(plugin, img, altMatch[1])
        continue
      }

      // Legacy: immich://UUID in src
      const srcMatch = src.match(/immich:\/\/([a-f0-9-]+)/i)
      if (srcMatch) {
        await replaceImgSrc(plugin, img, srcMatch[1])
      }
    }
  })

  // Editor extension: handles images in Live Preview (edit mode)
  const immichEditorPlugin = ViewPlugin.fromClass(
    class {
      debounceTimer: number | null = null

      constructor (view: EditorView) {
        this.scheduleProcess(view)
      }

      processImages (view: EditorView) {
        if (!plugin.settings.renderInEditMode) return

        const images = view.dom.querySelectorAll('img:not(.immich-remote-image)')

        for (const img of Array.from(images)) {
          // Skip images in the actively-edited line/block (let Obsidian handle toggle)
          const parentLine = img.closest('.cm-line, .cm-embed-block')
          if (parentLine?.classList.contains('cm-active')) continue
          if (parentLine?.querySelector('.cm-active')) continue

          const src = img.getAttribute('src') || ''

          if (src.includes('/api/assets/') && src.includes('/thumbnail')) {
            const urlMatch = src.match(/\/api\/assets\/([a-f0-9-]+)\/thumbnail/i)
            if (urlMatch) {
              void replaceImgSrc(plugin, img as HTMLImageElement, urlMatch[1])
              this.addEditButton(view, img as HTMLImageElement)
              // Hide Obsidian's native edit-block button
              const embedBlock = img.closest('.cm-embed-block')
              const nativeBtn = embedBlock?.querySelector('.edit-block-button')
              if (nativeBtn) nativeBtn.classList.add('immich-hide-native-edit')
            }
          }
        }
      }

      addEditButton (view: EditorView, img: HTMLImageElement) {
        // Don't add if already exists nearby
        if (img.nextElementSibling?.classList.contains('immich-edit-btn')) return
        if (img.parentElement?.querySelector('.immich-edit-btn')) return

        // Wrap img in a positioned container if not already wrapped
        let wrapper = img.parentElement
        if (!wrapper?.classList.contains('immich-img-wrapper')) {
          wrapper = document.createElement('span')
          wrapper.className = 'immich-img-wrapper'
          img.parentElement?.insertBefore(wrapper, img)
          wrapper.appendChild(img)
        }

        const btn = document.createElement('button')
        btn.className = 'immich-edit-btn'
        btn.innerHTML = '&#x270E;' // ✎ pencil
        btn.title = 'Edit source'
        btn.addEventListener('click', e => {
          e.stopPropagation()
          e.preventDefault()
          try {
            // Find the embed block or line containing this image
            const embedBlock = img.closest('.cm-embed-block, .cm-line')
            const targetNode = embedBlock || img
            let pos = view.posAtDOM(targetNode, 0)
            // Offset by 1 to land inside the markdown (past the `!`)
            const docLen = view.state.doc.length
            if (pos < docLen) pos = Math.min(pos + 1, docLen)
            view.dispatch({ selection: { anchor: pos } })
            view.focus()
          } catch {
            // Position not found — ignore
          }
        })
        wrapper.appendChild(btn)
      }

      scheduleProcess (view: EditorView) {
        if (this.debounceTimer) window.clearTimeout(this.debounceTimer)
        this.debounceTimer = window.setTimeout(() => {
          this.processImages(view)
        }, 150)
      }

      update (update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.scheduleProcess(update.view)
        }
        // Continuously hide native edit buttons on our images (Obsidian re-creates them)
        const nativeBtns = update.view.dom.querySelectorAll('.cm-embed-block .edit-block-button')
        for (const btn of Array.from(nativeBtns)) {
          const block = btn.closest('.cm-embed-block')
          if (block?.querySelector('.immich-remote-image')) {
            (btn as HTMLElement).classList.add('immich-hide-native-edit')
          }
        }
      }

      destroy () {
        if (this.debounceTimer) window.clearTimeout(this.debounceTimer)
      }
    }
  )

  plugin.registerEditorExtension(immichEditorPlugin)
}

async function replaceImgSrc (plugin: ImmichPicker, img: HTMLImageElement, assetId: string): Promise<void> {
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

function renderImmichImage (plugin: ImmichPicker, el: HTMLElement, assetId: string, width = 0): void {
  const container = el.createDiv({ cls: 'immich-remote-container' })
  const link = container.createEl('a', {
    href: plugin.immichApi.getAssetUrl(assetId),
    cls: 'external-link'
  })
  link.setAttr('target', '_blank')
  link.setAttr('rel', 'noopener')

  const img = link.createEl('img', { cls: 'immich-remote-image' })
  if (width > 0) img.width = width
  img.alt = 'Loading from Immich...'

  void fetchOrGetCached(plugin, assetId).then(blobUrl => {
    img.src = blobUrl
    img.alt = ''
  }).catch(e => {
    console.error(`Failed to load Immich thumbnail for ${assetId}:`, e)
    img.alt = `[Immich image unavailable: ${assetId}]`
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
