import { randomBytes, createHash } from 'crypto';

export function generateApiKey(): string {
  return 'qk_' + randomBytes(32).toString('base64url');
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
