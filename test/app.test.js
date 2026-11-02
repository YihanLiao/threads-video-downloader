import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { parsePostUrl, extractPost, isMediaUrl, limitedFetch } from '../lib/extractor.js';
import { makeZip } from '../lib/zip.js';

const cdn = 'https://scontent.cdninstagram.com';
const video = (position, width = 1080) => ({ media_type: 2, video_versions: [{ url: `${cdn}/${position}.mp4`, width, height: 1920 }] });
function page(post) { return `<script nonce="abc" type="application/json" data-sjs>${JSON.stringify({ data: { posts: [{ code: 'recommended', ...video('wrong') }, post] } }).replaceAll('<', '\\u003c')}</script>`; }
const fixture = { code: 'DfOyLOwE-9C', user: { username: 'braincell404notfound' }, caption: { text: '<script>alert(1)</script>' }, carousel_media: [video('one'), video('two'), { media_type: 1, image_versions2: { candidates: [{ url: `${cdn}/three.jpg`, width: 800, height: 600 }] } }] };
const sampleUrl = 'https://www.threads.com/@braincell404notfound/post/DfOyLOwE-9C';

test('validates Threads URLs, normalizes aliases and strips tracking', () => {
  assert.equal(parsePostUrl('https://threads.net/@user/post/ABC?x=1#h').url, 'https://www.threads.com/@user/post/ABC');
  assert.equal(parsePostUrl('https://threads.com/t/ABC').code, 'ABC');
  for (const url of ['http://threads.com/t/A', 'https://threads.com.evil.test/t/A', 'https://threads.com/@user', 'https://user:pass@threads.com/t/A', 'https://threads.com:444/t/A', 'file:///etc/passwd', 'https://127.0.0.1/t/A']) assert.throws(() => parsePostUrl(url));
});
test('multiple videos become distinct entries; recommendations are excluded', () => {
  const post = extractPost(page(fixture), fixture.code);
  assert.equal(post.media.length, 3);
  assert.deepEqual(post.media.map(m => m.type), ['video', 'video', 'image']);
  assert.deepEqual(post.media.map(m => m.position), [1, 2, 3]);
  assert.ok(!post.media.some(m => m.source.includes('wrong')));
  assert.throws(() => extractPost(page(fixture), 'missing'), /找不到/);
  const single = extractPost(page({ code: 'single', ...video('single') }), 'single');
  assert.equal(single.media.length, 1);
  assert.equal(single.media[0].type, 'video');
});
test('chooses highest available progressive resolution; excludes untrusted media and DASH thumbnails', () => {
  const post = { code: 'A', ...video('low', 360) };
  post.video_versions.push({ url: `${cdn}/high.mp4`, width: 1080, height: 1920 }, { url: 'http://localhost/private', width: 9000, height: 9000 });
  assert.equal(extractPost(page(post), 'A').media[0].source, `${cdn}/high.mp4`);
  assert.throws(() => extractPost(page({ code: 'A', media_type: 2, video_versions: [], image_versions2: { candidates: [{ url: `${cdn}/thumb.jpg` }] } }), 'A'), /沒有可下載/);
  assert.ok(!isMediaUrl('https://cdninstagram.com.evil.test/a.mp4'));
});
test('rejects redirects to internal addresses and oversized responses', async () => {
  await assert.rejects(limitedFetch(sampleUrl, { limit: 1024, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), /不支援/);
  await assert.rejects(limitedFetch(sampleUrl, { limit: 3, fetchImpl: async () => new Response('1234') }), /大小限制/);
  await assert.rejects(limitedFetch(`${cdn}/a.mp4`, { limit: 1024, media: true, fetchImpl: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }), /媒體檔案/);
});
test('ZIP has valid central directory, filenames and stored payload', () => {
  const zip = makeZip([{ name: 'video.mp4', data: Buffer.from('123456789') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
  assert.equal(zip.subarray(30, 39).toString(), 'video.mp4');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 1);
  assert.equal(zip.readUInt32LE(zip.readUInt32LE(zip.length - 6)), 0x02014b50);
});
test('request handler flow: static page → resolve → preview/download → ZIP → delete', async t => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'threadsave-test-')); let mediaFetches = 0;
  const server = createApp({ cacheRoot, fetchImpl: async url => {
    if (String(url).includes('threads.com')) return new Response(page(fixture), { headers: { 'content-type': 'text/html' } });
    mediaFetches++;
    return new Response(String(url).endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff]) : Buffer.from('test-video-bytes'), { headers: { 'content-type': String(url).endsWith('.jpg') ? 'image/jpeg' : 'video/mp4' } });
  } });
  t.after(async () => { server.emit('close'); await rm(cacheRoot, { recursive: true, force: true }); });
  // Exercise the real Node request handler without binding a port (sandbox forbids listen).
  const localFetch = (url, options = {}) => new Promise((resolve, reject) => {
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    req.url = url || '/'; req.method = options.method || 'GET';
    req.headers = Object.fromEntries(Object.entries({ host: 'localhost', ...options.headers }).map(([k, v]) => [k.toLowerCase(), v]));
    const chunks = [], headers = new Headers(); let status = 200;
    const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    res.setHeader = (key, value) => headers.set(key, value);
    res.writeHead = (code, fields) => { status = code; for (const [key, value] of Object.entries(fields || {})) headers.set(key, String(value)); res.headersSent = true; };
    res.on('error', reject); res.on('finish', () => resolve(new Response(Buffer.concat(chunks), { status, headers })));
    server.emit('request', req, res);
  });
  const send = (url, payload) => localFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const index = await localFetch('/'); assert.equal(index.status, 200); assert.match(await index.text(), /下載列表/);
  const resolve = await send('/api/resolve', { urls: [sampleUrl, 'https://evil.test/a'] }); const data = await resolve.json();
  assert.equal(data.results[0].media.length, 3); assert.ok(data.results[1].error);
  assert.ok(!JSON.stringify(data).includes(cdn));
  const item = data.results[0].media[0];
  const preview = await localFetch(item.downloadUrl + '?preview=1'); assert.equal(preview.status, 200); assert.match(preview.headers.get('content-disposition'), /^inline/); assert.equal(await preview.text(), 'test-video-bytes');
  const download = await localFetch(item.downloadUrl); assert.match(download.headers.get('content-disposition'), /attachment; filename="DfOyLOwE-9C_01.mp4"/); await download.arrayBuffer();
  assert.equal(mediaFetches, 1, 'download reuses generated file');
  const zipResponse = await send(`/api/jobs/${data.jobId}/zip`, { ids: data.results[0].media.map(m => m.id) });
  assert.equal(zipResponse.status, 200); assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await zipResponse.arrayBuffer()); assert.equal(zip.readUInt16LE(zip.length - 12), 3);
  assert.equal((await send(`/api/jobs/${data.jobId}/zip`, { ids: ['invalid'] })).status, 400);
  assert.equal((await localFetch('/api/resolve', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await send('/api/resolve', { urls: [] })).status, 400);
  assert.equal((await localFetch('/api/jobs/' + data.jobId, { method: 'DELETE' })).status, 200);
  assert.equal((await localFetch(item.downloadUrl)).status, 404);
});
