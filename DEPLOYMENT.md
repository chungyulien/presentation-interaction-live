# 上架說明

## 建議平台：Render

這個網站需要 Node.js 伺服器與 WebSocket，因此不能只放到 GitHub Pages。Render 的免費 Web Service 可以跑 Node.js，也能處理 WebSocket 連線。

### 方式一：用 `render.yaml`

1. 開啟 Render 部署連結：https://render.com/deploy?repo=https://github.com/chungyulien/presentation-interaction-live
2. 登入 Render。
3. 依畫面建立 Blueprint。
4. Render 會讀取 `render.yaml`，建立 `presentation-interaction-live` 服務。

### 方式二：手動建立 Web Service

在 Render 選 New > Web Service，連接 GitHub repository 後填入：

- Runtime：Node
- Build Command：`npm install`
- Start Command：`npm start`
- Instance Type：Free
- Health Check Path：`/api/health`

部署成功後，Render 會提供一個 `https://...onrender.com` 網址。講者端開啟該網址，建立房間後，觀眾可掃描 QR Code 或輸入 PIN 加入。

## 臨時公開試用：Cloudflare Quick Tunnel

若只是要立刻連網測試，可執行：

```powershell
.\start-public-preview.ps1
```

它會產生 `https://...trycloudflare.com` 臨時網址。這個網址適合測試，不適合當正式長期網址。

## 目前資料保存方式

房間、作答與文字雲目前存在 Node.js 記憶體中。房間關閉、服務重啟、Render 免費服務休眠後，活動資料可能消失。若要保存課後分析資料，下一步可接 MongoDB Atlas 或 Render Postgres。
