# Threadsave — Threads 影片下載

Node.js 伺服器 + 原生靜態 HTML / CSS / JavaScript，無 npm 外部依賴、無需編譯。支援公開 Threads 貼文的 MP4 影片與圖片；多段影片會各自列在 HTML 下載列表。

## 啟動

需要 Node.js 22 或更新版本：

```sh
cd /Users/liaoyihan/Documents/threads-video-downloader
npm start
```

開啟 **http://127.0.0.1:3000**。開發時可使用 `npm run dev`，執行測試用 `npm test`。不需要 `npm install`。

預設僅監聽本機；可用 `PORT=3001 npm start` 修改埠號，或 `HOST=0.0.0.0 npm start` 允許區域網路存取。若對外部署，請自行於反向代理配置 HTTPS、身分驗證與每 IP 限流；目前為本機使用設計，工作 UUID 是下載存取憑證。

## 使用方式

1. 貼上公開貼文完整網址，每行一個，最多 10 個。例如：
   `https://www.threads.com/@braincell404notfound/post/DfOyLOwE-9C`
2. 點擊「解析網址」。同篇貼文的各段影片、各張圖片會分別列出；不會抓取留言或推薦貼文。
3. 點「預覽影片」或「下載」，也可勾選多筆「打包下載 ZIP」。影片預覽不會自動開始下載整個列表。
4. 「清除列表」會刪除伺服器上的該工作暫存。

支援 `threads.com` / `threads.net` 的 `/@帳號/post/代碼` 與 `/t/代碼`。不支援個人頁面、分享短網址、私人貼文、需要登入的內容或僅提供 DASH 的影片。選取可取得的最高解析度 MP4，不做重新編碼。

## 檔案與限制

- `server.js`：靜態檔案伺服器、解析 API、按需產生檔案與 ZIP。
- `lib/extractor.js`：網址驗證、擷取指定 shortcode 的嵌入 JSON、來源大小限制、重新導向檢查。
- `lib/zip.js`：原生 ZIP STORE 產生器。
- `public/`：HTML、CSS、JS，無框架與第三方 CDN。
- `test/app.test.js`：解析、下載請求處理、暫存重用、ZIP、輸入與來源限制測試。
- `.cache/<執行個體>/<工作 UUID>/`：下載時才產生的原始檔。工作建立後 30 分鐘到期，閒置清理每分鐘一次；下載中會延後至完成後清理。正常關機會清除本次執行個體的暫存。強制終止留下的舊 `.cache` 可在伺服器停止時手動刪除。

單檔最多 100 MB，每工作 200 MB、50 個媒體項目。最多保留 10 個工作，同時最多 3 個 API 工作；同一工作逐一下載，避免重複抓取。為簡化部署，下載及 ZIP 在記憶體內有界緩衝，較大的部署應改用串流與佇列。

## API

- `POST /api/resolve`，JSON `{ "urls": ["https://www.threads.com/@user/post/CODE"] }`：回傳 `jobId`、`expiresAt`、每網址的 `results`；單篇失敗會有 `error`，其他貼文可繼續。
- `GET /api/jobs/:jobId/files/:mediaId`：產生、暫存並下載檔案；加 `?preview=1` 使用 inline 回應。
- `POST /api/jobs/:jobId/zip`，JSON `{ "ids": ["mediaId"] }`：產生勾選項目的 ZIP。
- `DELETE /api/jobs/:jobId`：清除工作與檔案。
- `GET /api/health`：健康檢查。

伺服器不接受任意下載 URL；僅向 Threads 網域取得貼文，媒體限 Meta CDN 的 HTTPS 來源，每次重新導向均驗證。預設拒絕跨站 API 請求。

## 驗證狀態與來源限制

`npm test` 使用可控的 Threads 格式測試資料與模擬來源，涵蓋單篇多影片、圖片、推薦內容排除、下載請求處理、預覽、ZIP 與清除流程。測試直接呼叫實際 Node.js request handler，不綁定網路埠；測試用媒體位元組不是真實可播放影片。

本次執行環境對 `www.threads.com` 的 DNS 查詢失敗，且禁止本機監聽埠（`listen EPERM`），因此**尚未驗證上述真實貼文能成功解析、播放及下載，也未完成瀏覽器視覺驗證**；請在可連線至 Threads 的電腦啟動後，用該網址測試。Threads 可能封鎖資料中心 IP、要求登入或改變頁面結構，屆時會顯示錯誤，不會以推薦影片冒充結果。目前從公開頁面的 `application/json` 資料擷取，不使用付費解析服務或登入 Cookie。

介面流程參考 [Bulk Threads Downloader](https://www.bulkthreadsdownloader.com/)，擷取策略參考 [Threads extractor 原始碼](https://github.com/tribixbite/yt-dlp-threads/blob/main/yt_dlp_plugins/extractor/threads.py) 對頁面資料結構的說明；本專案為獨立 Node.js 實作。
