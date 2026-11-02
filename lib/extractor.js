export class AppError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

export function parsePostUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new AppError('請輸入完整的 Threads 貼文網址。', 400); }
  if (url.protocol !== 'https:' || !/^(www\.)?threads\.(com|net)$/.test(url.hostname) || url.port || url.username || url.password) {
    throw new AppError('僅支援 https://www.threads.com 或 threads.net 的公開貼文網址。', 400);
  }
  const match = url.pathname.match(/^\/@([^/]+)\/post\/([\w-]+)\/?$/) || url.pathname.match(/^\/t\/([\w-]+)\/?$/);
  if (!match) throw new AppError('請貼上貼文網址（/@帳號/post/代碼），不支援個人頁面或分享短網址。', 400);
  const code = match.at(-1);
  url.hostname = 'www.threads.com'; url.search = ''; url.hash = '';
  return { url: url.href, code };
}

export function isMediaUrl(input) {
  try {
    const u = new URL(input);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && /\.(cdninstagram\.com|fbcdn\.net)$/.test(u.hostname);
  } catch { return false; }
}

function best(versions) {
  return (Array.isArray(versions) ? versions : []).filter(v => isMediaUrl(v?.url))
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
}

export function extractPost(html, code) {
  const posts = [];
  function walk(root) {
    const stack = [root];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (value.code === code && ('video_versions' in value || 'carousel_media' in value || 'image_versions2' in value)) posts.push(value);
      for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
    }
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']application\/json["']/i.test(match[1])) continue;
    try { walk(JSON.parse(match[2])); } catch { /* Unrelated scripts may not contain valid JSON. */ }
  }
  // Only the requested shortcode is accepted: replies/recommendations must never become results.
  const post = posts.find(p => p.carousel_media?.length || p.video_versions?.length) || posts[0];
  if (!post) throw new AppError('找不到這篇貼文的媒體資料。可能需要登入、貼文非公開或已刪除，也可能是 Threads 限制存取。');
  const entries = post.carousel_media?.length ? post.carousel_media : [post];
  const media = entries.flatMap((item, index) => {
    const video = best(item.video_versions);
    const image = best(item.image_versions2?.candidates);
    const chosen = video || image;
    if (!chosen) return [];
    // A video with only a thumbnail is not a downloadable image.
    if (!video && (item.media_type === 2 || item.video_dash_manifest)) return [];
    return [{ source: chosen.url, type: video ? 'video' : 'image', extension: video ? 'mp4' : 'jpg',
      width: chosen.width || item.original_width || null, height: chosen.height || item.original_height || null,
      position: index + 1 }];
  });
  if (!media.length) throw new AppError('這篇貼文沒有可下載的 MP4 影片或圖片（目前不支援僅提供 DASH 的影片）。');
  return { code, author: post.user?.username || '', caption: String(post.caption?.text || '').slice(0, 2000), media };
}

export async function limitedFetch(input, { limit, media = false, fetchImpl = fetch } = {}) {
  let url = new URL(input);
  const signal = AbortSignal.timeout(media ? 90_000 : 25_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (media ? !isMediaUrl(url.href) : !/^(www\.)?threads\.(com|net)$/.test(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) {
      throw new AppError('來源重新導向到不支援的網址。');
    }
    const response = await fetchImpl(url, { redirect: 'manual', signal,
      headers: { 'User-Agent': media ? 'Mozilla/5.0' : 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        Accept: media ? '*/*' : 'text/html', ...(media ? { Referer: 'https://www.threads.com/' } : {}) } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (!response.headers.get('location')) throw new AppError('來源重新導向無效。');
      url = new URL(response.headers.get('location'), url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new AppError(`Threads 來源回應 ${response.status}，請稍後重試或確認貼文為公開。`); }
    const contentType = response.headers.get('content-type') || '';
    if (media && !/^(video\/mp4|image\/jpeg|image\/png|image\/webp|application\/octet-stream)(;|$)/i.test(contentType)) {
      await response.body?.cancel(); throw new AppError('來源沒有回傳支援的媒體檔案。');
    }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new AppError('來源檔案超過大小限制。', 413); }
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > limit) throw new AppError('來源檔案超過大小限制。', 413);
        chunks.push(Buffer.from(value));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return { body: Buffer.concat(chunks), contentType };
  }
  throw new AppError('來源重新導向次數過多。');
}
