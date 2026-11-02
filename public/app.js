const $ = id => document.getElementById(id);
let jobId = null, items = [], working = false;
const selected = new Set();
function status(message, error = false) { $('status').textContent = message; $('status').dataset.kind = error ? 'error' : 'info'; $('status').hidden = !message; }
function controls() {
  $('resolve').disabled = working; $('urls').disabled = working; $('paste').disabled = working;
  $('clear').disabled = working || !items.length;
  $('zip').disabled = working || !selected.size;
  $('select-all').disabled = working || !items.length;
  $('select-all').checked = !!items.length && selected.size === items.length;
  $('select-all').indeterminate = selected.size > 0 && selected.size < items.length;
  $('selected-count').textContent = `${selected.size} 個已選取`;
  $('count').textContent = items.length;
  document.querySelectorAll('.download-one, .preview-button, .row-checkbox').forEach(el => { el.disabled = working; });
}
async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) { const data = await response.json().catch(() => ({})); const error = new Error(data.error || `請求失敗 (${response.status})`); error.status = response.status; throw error; }
  return response;
}
function save(blob, name) {
  const href = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = href; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
async function download(item) {
  working = true; controls(); status('正在產生檔案，請稍候…');
  try {
    const response = await request(item.downloadUrl);
    const name = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || `${item.code}_${item.position}.${item.extension}`;
    save(await response.blob(), name); status('檔案已準備完成，已交由瀏覽器下載。');
  } catch (error) { status(error.message, true); } finally { working = false; controls(); }
}
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function render() {
  $('results').replaceChildren(); $('empty').hidden = !!items.length;
  for (const item of items) {
    const row = node('article', 'media-row'), check = node('input', 'row-checkbox');
    check.type = 'checkbox'; check.checked = selected.has(item.id); check.setAttribute('aria-label', `選取 ${item.code} 第 ${item.position} 個媒體`);
    check.addEventListener('change', () => { check.checked ? selected.add(item.id) : selected.delete(item.id); controls(); });
    const preview = node('div', 'media-preview'), play = node('button', 'preview-button', item.type === 'video' ? '▷ 預覽影片' : '▧ 預覽圖片'); play.type = 'button';
    play.addEventListener('click', async () => {
      working = true; controls(); status('正在載入預覽…');
      try {
        const response = await request(`${item.downloadUrl}?preview=1`), href = URL.createObjectURL(await response.blob());
        const media = node(item.type === 'video' ? 'video' : 'img');
        media.src = href;
        if (item.type === 'video') { media.controls = true; media.playsInline = true; media.preload = 'metadata'; } else media.alt = `${item.code} 第 ${item.position} 張圖片`;
        item.previewObjectUrl = href; preview.replaceChildren(media); status('');
      } catch (error) { status(error.message, true); } finally { working = false; controls(); }
    });
    preview.append(play);
    const info = node('div', 'media-info');
    info.append(node('h3', '', `${item.code}_${String(item.position).padStart(2, '0')}.${item.extension}`));
    const detail = node('p'); detail.append(node('span', 'badge', item.type === 'video' ? '影片 · MP4' : '圖片'), document.createTextNode(`${item.width && item.height ? `${item.width} × ${item.height} · ` : ''}${item.author ? `@${item.author}` : 'Threads'}`));
    info.append(detail); if (item.caption) info.append(node('p', 'caption', item.caption));
    const button = node('button', 'button download-one', '↓ 下載'); button.type = 'button'; button.addEventListener('click', () => download(item));
    row.append(check, preview, info, button); $('results').append(row);
  }
  controls();
}
function clearLocal() { for (const item of items) if (item.previewObjectUrl) URL.revokeObjectURL(item.previewObjectUrl); items = []; selected.clear(); jobId = null; render(); }
$('resolve-form').addEventListener('submit', async event => {
  event.preventDefault(); if (working) return;
  const urls = [...new Set($('urls').value.split(/\s+/).map(v => v.trim()).filter(Boolean))];
  if (!urls.length || urls.length > 10) { status('每次請貼上 1–10 個網址，以換行分隔。', true); return; }
  working = true; controls(); status(`正在解析 ${urls.length} 個網址，請稍候…`); $('errors').hidden = true;
  try {
    if (jobId) { try { await request(`/api/jobs/${jobId}`, { method: 'DELETE' }); } catch (error) { if (error.status !== 404) throw error; } }
    clearLocal();
    const response = await request('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }) });
    const data = await response.json(); jobId = data.jobId;
    const errors = [];
    for (const result of data.results) {
      if (result.error) errors.push(result); else for (const media of result.media) { items.push({ ...media, caption: result.caption }); selected.add(media.id); }
    }
    $('errors').replaceChildren(...errors.map(e => node('p', '', `${e.url} — ${e.error}`))); $('errors').hidden = !errors.length;
    render(); status(items.length ? `解析完成：${items.filter(i => i.type === 'video').length} 段影片、${items.filter(i => i.type === 'image').length} 張圖片。可逐項下載，或勾選後打包。` : '沒有解析到可下載的媒體，請查看下方原因。', !items.length);
  } catch (error) { status(error.message, true); } finally { working = false; controls(); }
});
$('select-all').addEventListener('change', () => { selected.clear(); if ($('select-all').checked) items.forEach(i => selected.add(i.id)); document.querySelectorAll('.row-checkbox').forEach(el => { el.checked = $('select-all').checked; }); controls(); });
$('paste').addEventListener('click', async () => { try { $('urls').value = await navigator.clipboard.readText(); $('urls').focus(); } catch { status('無法讀取剪貼簿，請在輸入框使用 Ctrl+V 或 ⌘V 貼上。', true); $('urls').focus(); } });
$('clear').addEventListener('click', async () => {
  working = true; controls();
  try { if (jobId) await request(`/api/jobs/${jobId}`, { method: 'DELETE' }); clearLocal(); $('errors').hidden = true; status('列表與伺服器暫存已清除。'); }
  catch (error) { if (error.message.includes('已過期')) { clearLocal(); status('列表已清除。'); } else status(error.message, true); }
  finally { working = false; controls(); }
});
$('zip').addEventListener('click', async () => {
  if (!jobId || !selected.size || working) return; working = true; controls(); status('正在下載來源檔案並打包 ZIP，檔案較大時需要一些時間…');
  try { const response = await request(`/api/jobs/${jobId}/zip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...selected] }) }); save(await response.blob(), 'threads-media.zip'); status('ZIP 已準備完成，已交由瀏覽器下載。'); }
  catch (error) { status(error.message, true); } finally { working = false; controls(); }
});
render();
