import { Editor, MarkdownView, moment, Notice, Plugin, TFile } from 'obsidian'
import { ImmichApi } from './immichApi'
import { ImmichPickerSettingTab, ImmichPickerSettings, DEFAULT_SETTINGS } from './settings'
import { ImmichPickerModal } from './photoModal'
import { handlebarParse } from './handlebars'
import { registerImmichPostProcessor, clearImmichBlobCache } from './postProcessor'

// No placeholder needed — remote mode uses code block syntax rendered by code block processor

// Helper to access SecretStorage (available in Obsidian 1.11.0+)
function getSecretStorage (app: Record<string, unknown>): { getSecret(id: string): string | null, setSecret(id: string, secret: string): void } | null {
  const storage = (app as Record<string, unknown>).secretStorage
  if (storage && typeof storage === 'object' && 'getSecret' in storage && 'setSecret' in storage) {
    return storage as { getSecret(id: string): string | null, setSecret(id: string, secret: string): void }
  }
  return null
}

export default class ImmichPicker extends Plugin {
  settings: ImmichPickerSettings
  immichApi: ImmichApi
  cachedApiKey = ''

  async onload () {
    await this.loadSettings()

    this.immichApi = new ImmichApi(this)

    // Cache API key (migrate from data.json to secretStorage if available)
    await this.initApiKey()

    this.addSettingTab(new ImmichPickerSettingTab(this.app, this))

    // Always register post-processor so remote images render in any mode
    registerImmichPostProcessor(this)

    this.addCommand({
      id: 'insert-immich-photo',
      name: 'Insert image from Immich',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        if (!this.settings.serverUrl || !this.cachedApiKey) {
          new Notice('Please configure Immich server URL and API key in settings')
          return
        }
        new ImmichPickerModal(this.app, this, editor, view).open()
      }
    })

    this.addCommand({
      id: 'convert-remote-format',
      name: 'Convert remote images to current format',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        if (!this.settings.serverUrl) {
          new Notice('Please configure Immich server URL in settings')
          return
        }
        await this.convertRemoteFormat(editor)
      }
    })

    this.addCommand({
      id: 'convert-remote-to-local',
      name: 'Convert remote images to local thumbnails',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        if (!this.settings.serverUrl || !this.cachedApiKey) {
          new Notice('Please configure Immich server URL and API key in settings')
          return
        }
        await this.convertRemoteToLocal(editor, view)
      }
    })

    // Register paste handler for Immich URL conversion
    this.registerEvent(
      this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
        if (!this.settings.convertPastedLink) return
        if (!this.settings.serverUrl || !this.cachedApiKey) return

        const clipboardText = evt.clipboardData?.getData('text/plain')
        if (!clipboardText) return

        const assetId = this.immichApi.extractAssetIdFromUrl(clipboardText)
        if (!assetId) return

        // Prevent default paste
        evt.preventDefault()

        try {
          const loadingNotice = new Notice('Processing Immich link...', 0)

          const noteFile = view.file
          if (!noteFile) {
            loadingNotice.hide()
            new Notice('No active note')
            return
          }

          let linkText: string

          if (this.settings.imageMode === 'remote') {
            linkText = this.generateRemoteMarkdown(assetId)
          } else if (this.settings.imageMode === 'shared') {
            linkText = await this.generateSharedMarkdown({
              assetId,
              originalFilename: '',
              takenDate: moment().format(),
              description: ''
            })
          } else {
            const noteFolder = noteFile.path.split('/').slice(0, -1).join('/')
            const creationTime = moment()
            const filename = creationTime.format(this.settings.filename)

            const { thumbnailFolder, linkPath, savePath } = this.computeThumbnailPaths(noteFolder, filename)
            await this.ensureFolderExists(thumbnailFolder)
            await this.saveThumbnailToVault(assetId, savePath)

            linkText = this.generateThumbnailMarkdown({
              linkPath,
              assetId,
              originalFilename: '',
              takenDate: creationTime.format(),
              description: ''
            })
          }

          const cursorPosition = editor.getCursor()
          editor.replaceRange(linkText, cursorPosition)
          editor.setCursor({ line: cursorPosition.line, ch: cursorPosition.ch + linkText.length })

          loadingNotice.hide()
          new Notice('Image inserted from Immich')
        } catch (e) {
          console.error('Failed to process Immich URL:', e)
          new Notice('Failed to process Immich URL: ' + (e as Error).message)
          // Fall back to pasting the original URL
          editor.replaceSelection(clipboardText)
        }
      })
    )
  }

  onunload () {
    clearImmichBlobCache()
  }

  // --- SecretStorage ---

  hasSecretStorage (): boolean {
    return getSecretStorage(this.app as unknown as Record<string, unknown>) != null
  }

  async getApiKey (): Promise<string> {
    if (this.cachedApiKey) return this.cachedApiKey

    const storage = getSecretStorage(this.app as unknown as Record<string, unknown>)
    if (storage) {
      try {
        const secret = storage.getSecret('immich-api-key')
        if (secret) {
          this.cachedApiKey = secret
          return secret
        }
      } catch {
        // Fall through to settings
      }
    }

    this.cachedApiKey = this.settings.apiKey
    return this.cachedApiKey
  }

  async setApiKey (apiKey: string): Promise<void> {
    this.cachedApiKey = apiKey

    const storage = getSecretStorage(this.app as unknown as Record<string, unknown>)
    if (storage) {
      try {
        storage.setSecret('immich-api-key', apiKey)
        // Clear from plain-text settings
        this.settings.apiKey = ''
        await this.saveSettings()
        return
      } catch {
        // Fall through to settings
      }
    }

    this.settings.apiKey = apiKey
    await this.saveSettings()
  }

  private async initApiKey (): Promise<void> {
    // Migrate from data.json to secretStorage if available
    const storage = getSecretStorage(this.app as unknown as Record<string, unknown>)
    if (storage && this.settings.apiKey) {
      try {
        storage.setSecret('immich-api-key', this.settings.apiKey)
        this.cachedApiKey = this.settings.apiKey
        this.settings.apiKey = ''
        await this.saveSettings()
        return
      } catch {
        // Fall through
      }
    }

    await this.getApiKey()
  }

  // --- Path computation ---

  computeThumbnailPaths (noteFolder: string, filename: string): { thumbnailFolder: string, linkPath: string, savePath: string } {
    let thumbnailFolder = noteFolder
    let linkPath = filename

    switch (this.settings.locationOption) {
      case 'specified':
        thumbnailFolder = this.settings.locationFolder
        linkPath = thumbnailFolder + '/' + filename
        break
      case 'subfolder':
        thumbnailFolder = noteFolder + '/' + this.settings.locationSubfolder
        linkPath = this.settings.locationSubfolder + '/' + filename
        break
    }

    thumbnailFolder = thumbnailFolder.replace(/^\/+/, '').replace(/\/+$/, '')
    linkPath = encodeURI(linkPath)
    const savePath = thumbnailFolder ? thumbnailFolder + '/' + filename : filename

    return { thumbnailFolder, linkPath, savePath }
  }

  async ensureFolderExists (folderPath: string): Promise<void> {
    if (folderPath && !await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.createFolder(folderPath)
    }
  }

  async saveThumbnailToVault (assetId: string, savePath: string): Promise<void> {
    const imageData = await this.immichApi.downloadThumbnail(assetId)
    await this.app.vault.adapter.writeBinary(savePath, imageData)
  }

  // --- Markdown generation ---

  generateThumbnailMarkdown (params: {
    linkPath: string,
    assetId: string,
    originalFilename: string,
    takenDate: string,
    description: string
  }): string {
    return handlebarParse(this.settings.thumbnailMarkdown, {
      local_thumbnail_link: params.linkPath,
      immich_thumbnail_url: this.immichApi.getThumbnailUrl(params.assetId),
      immich_asset_id: params.assetId,
      immich_url: this.immichApi.getAssetUrl(params.assetId),
      original_filename: params.originalFilename,
      taken_date: params.takenDate,
      description: params.description
    })
  }

  /**
   * Remote mode: generates markdown based on the selected remote format.
   */
  generateRemoteMarkdown (assetId: string): string {
    const format = this.settings.remoteFormat || 'server-url'

    switch (format) {
      case 'server-url':
        return `![](${this.immichApi.getThumbnailUrl(assetId)}) `
      case 'code-block':
        return '\n```immich\n' + assetId + '\n```\n'
      default:
        return `![](${this.immichApi.getThumbnailUrl(assetId)}) `
    }
  }

  async generateSharedMarkdown (params: {
    assetId: string,
    originalFilename: string,
    takenDate: string,
    description: string
  }): Promise<string> {
    const sharedLink = await this.immichApi.createSharedLink(params.assetId)
    const sharedThumbnailUrl = this.immichApi.getSharedThumbnailUrl(params.assetId, sharedLink.key)

    return handlebarParse(this.settings.thumbnailMarkdown, {
      local_thumbnail_link: sharedThumbnailUrl,
      immich_thumbnail_url: sharedThumbnailUrl,
      immich_asset_id: params.assetId,
      immich_url: this.immichApi.getAssetUrl(params.assetId),
      original_filename: params.originalFilename,
      taken_date: params.takenDate,
      description: params.description
    })
  }

  // --- Convert between remote formats ---

  /**
   * Finds all remote Immich image references (any format) and returns matches with asset IDs.
   */
  private findRemoteReferences (content: string): { fullMatch: string, assetId: string }[] {
    const serverUrlEscaped = this.settings.serverUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const patterns = [
      /```immich\n([a-f0-9-]+)\n```/gi,
      new RegExp(`!\\[\\]\\(${serverUrlEscaped}/api/assets/([a-f0-9-]+)/thumbnail[^)]*\\)`, 'gi'),
      /<img data-immich-id="([a-f0-9-]+)"[^>]*\/?>/gi,
      /!\[immich:([a-f0-9-]+)\]\(data:image\/[^)]+\)/gi,
      /!\[\]\(immich:\/\/([a-f0-9-]+)\)/gi,
      /!\[immich:([a-f0-9-]+)\]\([^)]*\)/gi
    ]
    const allMatches: { fullMatch: string, assetId: string }[] = []
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (!allMatches.some(m => m.fullMatch === match[0])) {
          allMatches.push({ fullMatch: match[0], assetId: match[1] })
        }
      }
    }
    return allMatches
  }

  async convertRemoteFormat (editor: Editor): Promise<void> {
    const content = editor.getValue()
    const matches = this.findRemoteReferences(content)

    if (matches.length === 0) {
      new Notice('No remote Immich images found in this note')
      return
    }

    let updatedContent = content
    for (const { fullMatch, assetId } of matches) {
      const newMarkdown = this.generateRemoteMarkdown(assetId)
      updatedContent = updatedContent.replace(fullMatch, newMarkdown.trim())
    }

    editor.setValue(updatedContent)
    new Notice(`Converted ${matches.length} images to ${this.settings.remoteFormat} format`)
  }

  // --- Convert remote to local ---

  async convertRemoteToLocal (editor: Editor, view: MarkdownView): Promise<void> {
    const noteFile = view.file
    if (!noteFile) {
      new Notice('No active note')
      return
    }

    const content = editor.getValue()
    const allMatches = this.findRemoteReferences(content)

    if (allMatches.length === 0) {
      new Notice('No remote Immich images found in this note')
      return
    }

    const loadingNotice = new Notice(`Converting ${allMatches.length} remote images to local...`, 0)

    try {
      const noteFolder = noteFile.path.split('/').slice(0, -1).join('/')
      let updatedContent = content

      for (let i = 0; i < allMatches.length; i++) {
        const { fullMatch, assetId } = allMatches[i]
        loadingNotice.setMessage(`Converting image ${i + 1}/${allMatches.length}...`)

        const creationTime = moment()
        const filename = creationTime.format(this.settings.filename)
        const { thumbnailFolder, linkPath, savePath } = this.computeThumbnailPaths(noteFolder, filename)
        await this.ensureFolderExists(thumbnailFolder)
        await this.saveThumbnailToVault(assetId, savePath)

        // Replace the remote image markdown with local path, respecting vault link format
        const useWikilinks = !(this.app.vault as unknown as { getConfig(key: string): unknown }).getConfig('useMarkdownLinks')
        const localImage = useWikilinks ? `![[${linkPath}]]` : `![](${linkPath})`
        updatedContent = updatedContent.replace(fullMatch, localImage)
      }

      editor.setValue(updatedContent)
      loadingNotice.hide()
      new Notice(`Converted ${allMatches.length} images to local thumbnails`)
    } catch (e) {
      loadingNotice.hide()
      console.error('Failed to convert remote images:', e)
      new Notice('Failed to convert images: ' + (e as Error).message)
    }
  }

  getNoteDate (file: TFile): moment.Moment | null {
    if (this.settings.getDateFrom === 'none') {
      return null
    }

    if (this.settings.getDateFrom === 'title') {
      const date = moment(file.basename, this.settings.getDateFromFormat, true)
      return date.isValid() ? date : null
    }

    if (this.settings.getDateFrom === 'frontmatter') {
      const meta = this.app.metadataCache.getFileCache(file)
      const frontMatter = meta?.frontmatter
      if (frontMatter && frontMatter[this.settings.getDateFromFrontMatterKey]) {
        const dateValue = frontMatter[this.settings.getDateFromFrontMatterKey] as string
        const date = moment(dateValue, this.settings.getDateFromFormat, true)
        return date.isValid() ? date : null
      }
    }

    return null
  }

  async loadSettings () {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ImmichPickerSettings>)
  }

  async saveSettings () {
    await this.saveData(this.settings)
  }
}
