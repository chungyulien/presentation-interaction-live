# 互動堂 Live

簡報即時互動網站原型。講者可以建立互動房間，觀眾用 6 碼 PIN 或 QR Code 加入，支援選擇題、文字雲、投影模式與即時結果同步。

## 功能

- 講者端：建立、重置、關閉房間，編輯並發布選擇題或文字雲。
- 觀眾端：免登入加入房間，手機或電腦都能作答。
- 投影模式：乾淨的大螢幕畫面，只顯示 PIN、QR Code、題目與即時結果。
- 即時同步：使用原生 WebSocket，講者切題、票數與文字雲會同步到所有裝置。
- 短期狀態：房間資料存在 Node.js 記憶體中，適合現場活動原型。

## 執行

在 PowerShell 進入此資料夾後執行：

```powershell
.\start-site.ps1
```

啟動後開啟：

```text
http://localhost:4000
```

講者建立房間後，可用畫面上的 QR Code 或加入連結進入觀眾端；投影模式可從控制台右上角開啟。

## 臨時公開試用

想立刻用手機或別台電腦連進來測試，可以執行：

```powershell
.\start-public-preview.ps1
```

腳本會啟動本機網站，並透過 Cloudflare Quick Tunnel 產生一個 `trycloudflare.com` 的臨時公開網址。這個網址適合課堂前測試或臨時分享；關閉電腦、停止背景程式或 Tunnel 重啟後，網址可能會失效。

## 免費正式上架

此專案已加入 Render 上架設定：

[用 Render 部署](https://render.com/deploy?repo=https://github.com/chungyulien/presentation-interaction-live)

- `render.yaml`：Render Blueprint，可建立免費 Node.js Web Service。
- `Procfile`：支援其他會讀取 Procfile 的 Node.js 主機。
- `/api/health`：雲端平台健康檢查路徑。
- WebSocket 保活訊號：上課互動時可降低閒置斷線機率。

Render 建議設定：

- Service Type：Web Service
- Runtime：Node
- Build Command：`npm install`
- Start Command：`npm start`
- Instance Type：Free
- Health Check Path：`/api/health`

免費方案適合測試、課堂原型或小型活動。正式長期使用時，房間資料目前仍存在伺服器記憶體中；服務重啟後房間會清空。

## 檔案結構

- `server/index.js`：Node.js 靜態網站與 WebSocket 即時伺服器。
- `public/index.html`：網站入口。
- `public/app.js`：講者端、觀眾端、投影模式與互動邏輯。
- `public/styles.css`：完整視覺樣式與響應式版面。
- `start-site.ps1`：在此電腦上啟動網站的 PowerShell 腳本。
- `start-public-preview.ps1`：產生臨時公開網址的 PowerShell 腳本。
- `render.yaml`：Render 免費 Web Service 上架設定。
