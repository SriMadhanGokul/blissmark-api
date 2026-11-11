import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { GridFSBucket, MongoClient, ObjectId } from 'mongodb';
import { Readable } from 'node:stream';

import { invalid, notFound } from '../../common/errors';

/** What the panel may upload. Videos stay small: Atlas free tier holds 512 MB in total. */
const LIMITS: Record<string, number> = {
  'image/jpeg': 5 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'image/webp': 5 * 1024 * 1024,
  'image/gif': 5 * 1024 * 1024,
  'video/mp4': 40 * 1024 * 1024,
  'video/webm': 40 * 1024 * 1024,
};
export const MAX_UPLOAD = 40 * 1024 * 1024;
/** Files live in the shared database, so links always point at the hosted API, even for uploads made locally. */
const PUBLIC_API = (process.env.PUBLIC_API_URL ?? 'https://blissmark-api.onrender.com/v1').replace(/\/$/, '');

export type MediaItem = { id: string; url: string; name: string; type: string; kind: 'image' | 'video'; size: number; uploadedAt: Date; uploadedBy: string };

/**
 * Images and videos for app content, stored in MongoDB GridFS (same database as everything else).
 * Served publicly at /v1/media/:id with HTTP range support so phones can stream video.
 */
@Injectable()
export class MediaService implements OnModuleDestroy {
  private client = new MongoClient(process.env.DATABASE_URL!);
  private ready: Promise<GridFSBucket> | null = null;

  private bucket() {
    this.ready ??= this.client.connect().then((c) => new GridFSBucket(c.db(), { bucketName: 'media' }));
    return this.ready;
  }

  async onModuleDestroy() {
    await this.client.close().catch(() => {});
  }

  private dto(f: { _id: ObjectId; filename: string; length: number; uploadDate: Date; metadata?: { type?: string; by?: string } }): MediaItem {
    const type = f.metadata?.type ?? 'application/octet-stream';
    return { id: String(f._id), url: `${PUBLIC_API}/media/${f._id}`, name: f.filename, type, kind: type.startsWith('video/') ? 'video' : 'image', size: f.length, uploadedAt: f.uploadDate, uploadedBy: f.metadata?.by ?? '' };
  }

  async upload(file: Express.Multer.File | undefined, by: string) {
    if (!file) throw invalid('FILE', 'Choose a file to upload', 'file');
    const limit = LIMITS[file.mimetype];
    if (!limit) throw invalid('TYPE', 'Upload a JPG, PNG, WebP or GIF image, or an MP4 or WebM video', 'file');
    if (file.size > limit) throw invalid('SIZE', `That file is too large. ${file.mimetype.startsWith('video/') ? 'Videos' : 'Images'} can be up to ${limit / 1024 / 1024} MB.`, 'file');
    const b = await this.bucket();
    const id = new ObjectId();
    await new Promise<void>((resolve, reject) =>
      Readable.from(file.buffer)
        .pipe(b.openUploadStreamWithId(id, file.originalname.slice(0, 120), { metadata: { type: file.mimetype, by } }))
        .on('finish', () => resolve())
        .on('error', reject),
    );
    const [f] = await b.find({ _id: id }).toArray();
    return this.dto(f as never);
  }

  async list() {
    const b = await this.bucket();
    const files = await b.find({}).sort({ uploadDate: -1 }).limit(500).toArray();
    const items = files.map((f) => this.dto(f as never));
    return { items, totalBytes: items.reduce((s, x) => s + x.size, 0) };
  }

  async remove(id: string) {
    if (!ObjectId.isValid(id)) throw notFound('File');
    const b = await this.bucket();
    try {
      await b.delete(new ObjectId(id));
    } catch {
      throw notFound('File');
    }
    return { ok: true };
  }

  /** Streams a file; honours Range so video players can seek and start fast. */
  async stream(id: string, range: string | undefined, res: Response) {
    if (!ObjectId.isValid(id)) throw notFound('File');
    const b = await this.bucket();
    const [f] = await b.find({ _id: new ObjectId(id) }).toArray();
    if (!f) throw notFound('File');
    const type = (f.metadata as { type?: string } | undefined)?.type ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // ids never change content
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), f.length - 1) : f.length - 1;
      if (start >= f.length || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${f.length}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${f.length}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return b.openDownloadStream(f._id, { start, end: end + 1 }).pipe(res);
    }
    res.setHeader('Content-Length', String(f.length));
    return b.openDownloadStream(f._id).pipe(res);
  }
}
