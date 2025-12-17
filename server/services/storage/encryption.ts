import crypto from 'node:crypto'

export const ENCRYPTION_MAGIC = Buffer.from('CFENC1', 'utf8')
export const ENCRYPTION_IV_LENGTH = 12
export const ENCRYPTION_TAG_LENGTH = 16

export const isEncryptedPayload = (payload: Buffer): boolean => {
  if (
    payload.length <
    ENCRYPTION_MAGIC.length + ENCRYPTION_IV_LENGTH + ENCRYPTION_TAG_LENGTH
  ) {
    return false
  }
  return payload.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)
}

export const deriveAes256Key = (rawKey: string): Buffer => {
  const trimmed = rawKey.trim()
  if (!trimmed) {
    throw new Error('Encryption key is empty')
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }

  const maybeBase64 = Buffer.from(trimmed, 'base64')
  if (maybeBase64.length === 32) {
    return maybeBase64
  }

  // Fallback: derive from passphrase (stable but weaker than random 32B key)
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest()
}

export const encryptBuffer = (
  plaintext: Buffer,
  key: Buffer,
  aad?: Buffer,
): Buffer => {
  const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad && aad.length > 0) {
    cipher.setAAD(aad)
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([ENCRYPTION_MAGIC, iv, ciphertext, tag])
}

export const decryptBuffer = (
  encryptedPayload: Buffer,
  key: Buffer,
  aad?: Buffer,
): Buffer => {
  if (!isEncryptedPayload(encryptedPayload)) {
    throw new Error('Payload is not encrypted (missing magic header)')
  }

  const ivStart = ENCRYPTION_MAGIC.length
  const ivEnd = ivStart + ENCRYPTION_IV_LENGTH
  const tagStart = encryptedPayload.length - ENCRYPTION_TAG_LENGTH

  if (tagStart <= ivEnd) {
    throw new Error('Encrypted payload is too short')
  }

  const iv = encryptedPayload.subarray(ivStart, ivEnd)
  const ciphertext = encryptedPayload.subarray(ivEnd, tagStart)
  const tag = encryptedPayload.subarray(tagStart)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  if (aad && aad.length > 0) {
    decipher.setAAD(aad)
  }
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
