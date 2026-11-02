import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { AppError, parsePostUrl, extractPost, limitedFetch } from './lib/extractor.js';
import { makeZip } from './lib/zip.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TTL = 30 * 60_000, MAX_FILE = 100 * 1024 * 1024, MAX_BATCH = 200 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export function createApp({ fetchImpl = fetch, cacheRoot = path.join(ROOT, '.cache', randomUUID()) } = {}) {
  const jobs = new Map(); let busy = 0;
  async function clean() {
    for (const [id, job] of jobs) if (Date.now() - job.created > TTL && !job.active) {
      jobs.delete(id); await rm(path.join(cacheRoot, id), { recursive: true, force: true });
    }
  }
  const timer = setInterval(() => clean().catch(console.error), 60_000).unref();
  async function body(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16_384) throw new AppError('請求過大。', 413); }
    try { return JSON.parse(raw); } catch { throw new AppError('請提供有效 JSON。', 400); }
  }
  function json(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); }
  async function materialize(job, item) {
    if (item.file) return readFile(item.file);
    const { body: data, contentType } = await limitedFetch(item.source, { limit: MAX_FILE, media: true, fetchImpl });
    if (job.bytes + data.length > MAX_BATCH) throw new AppError('此批次總大小超過 200 MB，請分批解析下載。', 413);
    if (item.type === 'video' && !/^(video\/mp4|application\/octet-stream)/i.test(contentType)) throw new AppError('影片來源格式不正確。');
    if (item.type === 'image') {
      if (!/^image\//i.test(contentType)) throw new AppError('圖片來源格式不正確。');
      item.extension = /image\/png/i.test(contentType) ? 'png' : /image\/webp/i.test(contentType) ? 'webp' : 'jpg';
    }
    const folder = path.join(cacheRoot, job.id); await mkdir(folder, { recursive: true });
    const file = path.join(folder, item.id); await writeFile(file, data); item.file = file; job.bytes += data.length;
    return data;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let acquired = false, activeJob;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/','/index.html','/style.css','/app.js'].includes(url.pathname)) {
        const file = url.pathname === '/' ? '/index.html' : url.pathname;
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] }); res.end(await readFile(path.join(ROOT, 'public', file))); return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
      if (!url.pathname.startsWith('/api/')) throw new AppError('找不到此頁面。', 404);
      // Same-origin API: prevents another website from spending the local server's resources.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new AppError('不允許跨站請求。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('不允許跨站請求。', 403);
      if (busy >= 3) throw new AppError('伺服器忙碌中，請稍後重試。', 429);
      busy++; acquired = true; await clean();
      if (url.pathname === '/api/resolve' && req.method === 'POST') {
        const input = await body(req);
        if (!Array.isArray(input.urls) || !input.urls.length || input.urls.length > 10 || input.urls.some(u => typeof u !== 'string')) throw new AppError('每次請提供 1–10 個貼文網址。', 400);
        if (jobs.size >= 10) throw new AppError('暫存工作已滿，請清除現有佇列或稍後重試。', 429);
        const job = { id: randomUUID(), created: Date.now(), media: [], bytes: 0, active: false }; jobs.set(job.id, job);
        const results = [];
        for (const inputUrl of [...new Set(input.urls)]) {
          try {
            const parsed = parsePostUrl(inputUrl);
            const { body: html } = await limitedFetch(parsed.url, { limit: 12 * 1024 * 1024, fetchImpl });
            const post = extractPost(html.toString('utf8'), parsed.code);
            if (job.media.length + post.media.length > 50) throw new AppError('每批次最多 50 個媒體檔案，請分批下載。');
            const media = post.media.map(m => ({ ...m, id: randomUUID(), code: post.code, author: post.author })); job.media.push(...media);
            results.push({ url: parsed.url, code: post.code, author: post.author, caption: post.caption,
              media: media.map(({ source, ...m }) => ({ ...m, downloadUrl: `/api/jobs/${job.id}/files/${m.id}` })) });
          } catch (error) { results.push({ url: inputUrl, error: publicError(error) }); }
        }
        if (!job.media.length) jobs.delete(job.id);
        json(res, 200, { jobId: job.media.length ? job.id : null, expiresAt: job.created + TTL, results }); return;
      }
      const route = url.pathname.match(/^\/api\/jobs\/([\w-]+)(?:\/files\/([\w-]+)|\/(zip))?$/);
      if (!route) throw new AppError('找不到此 API。', 404);
      const job = jobs.get(route[1]); if (!job) throw new AppError('下載工作已過期，請重新解析網址。', 404);
      if (job.active) throw new AppError('此工作正在下載中，請稍候再試。', 429);
      job.active = true; activeJob = job;
      if (req.method === 'DELETE' && !route[2] && !route[3]) {
        jobs.delete(job.id); await rm(path.join(cacheRoot, job.id), { recursive: true, force: true }); json(res, 200, { ok: true }); return;
      }
      const filename = item => `${item.code}_${String(item.position).padStart(2, '0')}.${item.extension}`;
      if (req.method === 'GET' && route[2]) {
        const item = job.media.find(m => m.id === route[2]); if (!item) throw new AppError('找不到此檔案。', 404);
        const data = await materialize(job, item);
        const type = item.type === 'video' ? 'video/mp4' : `image/${item.extension === 'jpg' ? 'jpeg' : item.extension}`;
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length,
          'Content-Disposition': `${url.searchParams.has('preview') ? 'inline' : 'attachment'}; filename="${filename(item)}"`, 'Accept-Ranges': 'none' }); res.end(data); return;
      }
      if (req.method === 'POST' && route[3]) {
        const { ids } = await body(req);
        if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !job.media.some(m => m.id === id))) throw new AppError('請選擇有效的下載項目。', 400);
        const files = [];
        for (const id of new Set(ids)) { const item = job.media.find(m => m.id === id); const data = await materialize(job, item); files.push({ name: filename(item), data }); }
        const data = makeZip(files);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="threads-media.zip"', 'Content-Length': data.length }); res.end(data); return;
      }
      throw new AppError('不支援此請求方法。', 405);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 502, { error: publicError(error) }); else res.destroy();
    } finally { if (acquired) busy--; if (activeJob) activeJob.active = false; }
  });
  server.on('close', () => { clearInterval(timer); rm(cacheRoot, { recursive: true, force: true }).catch(console.error); });
  server.requestTimeout = 120_000;
  return server;
}

function publicError(error) {
  if (error instanceof AppError) return error.message;
  if (['TimeoutError', 'AbortError'].includes(error.name)) return '來源回應逾時，請稍後再試。';
  return '無法連線至 Threads 或媒體來源，請確認伺服器網路後重試。';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  const server = createApp(); server.listen(port, host, () => console.log(`Threads Downloader: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
}
