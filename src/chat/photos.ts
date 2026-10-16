/**
 * Storage for photos sent for photo help: a private S3 bucket (no public access, encrypted, deleted after the
 * retention period by a lifecycle rule). Keys are per farm and day; nothing else reads them yet.
 */
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { ulid } from 'ulid';
import type { ImageFormat } from '../agent/photo-help.js';

export interface PhotoStore {
  /** Saves the photo and returns its id (the object key). */
  put(farmId: string, userId: string, bytes: Uint8Array, format: ImageFormat, today: string): Promise<string>;
}

const CONTENT_TYPE: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXTENSION: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

export class S3PhotoStore implements PhotoStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(farmId: string, userId: string, bytes: Uint8Array, format: ImageFormat, today: string): Promise<string> {
    const key = `photos/${farmId}/${today}/${ulid()}.${EXTENSION[format]}`;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: CONTENT_TYPE[format], Metadata: { 'farm-id': farmId, 'user-id': userId } }),
    );
    return key;
  }
}

export class InMemoryPhotoStore implements PhotoStore {
  readonly photos = new Map<string, Uint8Array>();

  async put(farmId: string, _userId: string, bytes: Uint8Array, format: ImageFormat, today: string): Promise<string> {
    const key = `photos/${farmId}/${today}/${ulid()}.${EXTENSION[format]}`;
    this.photos.set(key, bytes);
    return key;
  }
}

/** Largest photo accepted (after the browser shrinks it, a phone photo is usually 100 to 400 KB). */
export const MAX_PHOTO_BYTES = 1_500_000;

/** Checks the file really is the image type it claims to be (by its first bytes, not its name). */
export function looksLike(bytes: Uint8Array, format: ImageFormat): boolean {
  const b = (i: number) => bytes[i] ?? -1;
  if (format === 'jpeg') return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  if (format === 'png') return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
  return String.fromCharCode(b(0), b(1), b(2), b(3)) === 'RIFF' && String.fromCharCode(b(8), b(9), b(10), b(11)) === 'WEBP';
}
