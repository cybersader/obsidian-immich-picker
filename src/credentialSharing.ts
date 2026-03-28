// Dynamic imports — Node.js modules not available on mobile
let fs: typeof import('fs') | null = null
let os: typeof import('os') | null = null
let pathMod: typeof import('path') | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  fs = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  os = require('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pathMod = require('path')
} catch {
  // Mobile — credential sharing unavailable
}

const HANDOFF_PREFIX = 'immich-picker-share-'

interface HandoffBlob {
  serverUrl: string;
  encryptedApiKey: string;
  salt: string;
  iv: string;
  expiresAt: number;
}

function generatePin (): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

export function isCredentialSharingAvailable (): boolean {
  return fs != null && os != null && pathMod != null
}

function getHandoffDir (): string {
  return os!.tmpdir()
}

function getHandoffFiles (): string[] {
  if (!isCredentialSharingAvailable()) return []
  const dir = getHandoffDir()
  try {
    return fs!.readdirSync(dir)
      .filter(f => f.startsWith(HANDOFF_PREFIX) && f.endsWith('.json'))
      .map(f => pathMod!.join(dir, f))
  } catch {
    return []
  }
}

async function deriveKey (pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(pin) as BufferSource, 'PBKDF2', false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

function toBase64 (buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64 (str: string): Uint8Array {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function shareCredentials (serverUrl: string, apiKey: string, durationMs: number): Promise<string> {
  if (!isCredentialSharingAvailable()) throw new Error('Credential sharing is not available on mobile')
  const pin = generatePin()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(pin, salt)

  const encoder = new TextEncoder()
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoder.encode(apiKey) as BufferSource
  )

  const blob: HandoffBlob = {
    serverUrl,
    encryptedApiKey: toBase64(encrypted),
    salt: toBase64(salt),
    iv: toBase64(iv),
    expiresAt: Date.now() + durationMs
  }

  const filename = `${HANDOFF_PREFIX}${Date.now()}.json`
  const filepath = pathMod!.join(getHandoffDir(), filename)
  fs!.writeFileSync(filepath, JSON.stringify(blob), 'utf-8')

  return pin
}

export async function importCredentials (pin: string): Promise<{ serverUrl: string, apiKey: string } | null> {
  const files = getHandoffFiles()

  for (const filepath of files) {
    try {
      const content = fs!.readFileSync(filepath, 'utf-8')
      const blob: HandoffBlob = JSON.parse(content)

      // Skip expired
      if (blob.expiresAt < Date.now()) {
        fs!.unlinkSync(filepath)
        continue
      }

      // Try to decrypt
      const salt = fromBase64(blob.salt)
      const iv = fromBase64(blob.iv)
      const encrypted = fromBase64(blob.encryptedApiKey)
      const key = await deriveKey(pin, salt)

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
          key,
          encrypted.buffer as ArrayBuffer
        )
        const decoder = new TextDecoder()
        const apiKey = decoder.decode(decrypted)

        // Success — delete the blob
        fs!.unlinkSync(filepath)

        return { serverUrl: blob.serverUrl, apiKey }
      } catch {
        // Wrong PIN for this blob — continue to next
        continue
      }
    } catch {
      // Corrupt file — skip
      continue
    }
  }

  return null
}

export function cleanupExpiredBlobs (): void {
  const files = getHandoffFiles()
  for (const filepath of files) {
    try {
      const content = fs!.readFileSync(filepath, 'utf-8')
      const blob: HandoffBlob = JSON.parse(content)
      if (blob.expiresAt < Date.now()) {
        fs!.unlinkSync(filepath)
      }
    } catch {
      // Corrupt file — try to clean up
      try { fs!.unlinkSync(filepath) } catch { /* ignore */ }
    }
  }
}

export function hasActiveShare (): boolean {
  const files = getHandoffFiles()
  for (const filepath of files) {
    try {
      const content = fs!.readFileSync(filepath, 'utf-8')
      const blob: HandoffBlob = JSON.parse(content)
      if (blob.expiresAt >= Date.now()) return true
    } catch { /* ignore */ }
  }
  return false
}
