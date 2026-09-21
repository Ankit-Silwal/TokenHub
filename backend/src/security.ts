import { randomBytes, createHash, createCipheriv, createDecipheriv, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCb);
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, key] = stored.split(':');
  return timingSafeEqual(Buffer.from(key, 'hex'), await scrypt(password, salt, 64) as Buffer);
}
export function vault(key: string) {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('ENCRYPTION_KEY must contain 64 hex characters. See .env.example.');
  const secret = Buffer.from(key, 'hex');
  return {
    encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', secret, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64')).join('.'); },
    decrypt(value: string) { const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64')); const cipher = createDecipheriv('aes-256-gcm', secret, iv); cipher.setAuthTag(tag); return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'); }
  };
}
