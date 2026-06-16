import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const PIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_WORD_LENGTH = 15;
const MAX_DANMAKU_LENGTH = 40;
const MAX_DANMAKU_MESSAGES = 120;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4.1-mini";
const BLOCKED_TERMS = ["髒話", "白痴", "笨蛋", "badword", "spam"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

const rooms = new Map();
const clients = new Map();
let nextClientId = 1;

const server = http.createServer((req, res) => {
  serveHttp(req, res).catch((error) => {
    console.error(error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Server error");
  });
});

server.on("upgrade", (req, socket) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n")
  );

  const client = {
    id: `client-${nextClientId++}`,
    role: "guest",
    roomPin: null,
    socket,
    buffer: Buffer.alloc(0)
  };
  clients.set(client.id, client);

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    processFrames(client);
  });
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
});

server.listen(PORT, HOST, () => {
  console.log(`Live interaction server listening on http://${HOST}:${PORT}`);
});

async function serveHttp(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
    return;
  }

  if (requestUrl.pathname === "/qr.svg") {
    const data = requestUrl.searchParams.get("data") || "";
    res.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(createQrSvg(data));
    return;
  }

  const appPaths =
    requestUrl.pathname === "/" ||
    requestUrl.pathname.startsWith("/join") ||
    requestUrl.pathname.startsWith("/screen");
  const requestedPath = appPaths ? "/index.html" : decodeURIComponent(requestUrl.pathname);
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const type =
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon"
    }[ext] || "application/octet-stream";

  const headers = { "content-type": type };
  if ([".html", ".js", ".css"].includes(ext)) {
    headers["cache-control"] = "no-cache";
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function processFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const bigLength = client.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        client.socket.destroy();
        return;
      }
      length = Number(bigLength);
      offset += 8;
    }

    const maskOffset = masked ? 4 : 0;
    if (client.buffer.length < offset + maskOffset + length) return;

    let payload = client.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
    if (masked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    client.buffer = client.buffer.subarray(offset + maskOffset + length);

    if (opcode === 0x8) {
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      writeFrame(client.socket, payload, 0x0a);
      continue;
    }
    if (opcode === 0x1) {
      handleMessage(client, payload.toString("utf8"));
    }
  }
}

function handleMessage(client, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    sendReply(client, null, { ok: false, error: "訊息格式錯誤。" });
    return;
  }

  const { type, payload = {}, requestId = null } = message;
  const reply = (response) => sendReply(client, requestId, response);

  if (type === "host:create-room") return handleCreateRoom(client, reply);
  if (type === "host:restore-room") return handleRestoreRoom(client, payload, reply);
  if (type === "screen:join") return handleScreenJoin(client, payload, reply);
  if (type === "participant:join") return handleParticipantJoin(client, payload, reply);
  if (type === "host:update-activity") return handleUpdateActivity(payload, reply);
  if (type === "host:publish-activity") return handlePublishActivity(payload, reply);
  if (type === "host:go-waiting") return handleGoWaiting(payload, reply);
  if (type === "host:toggle-results") return handleToggleResults(payload, reply);
  if (type === "host:clear-responses") return handleClearResponses(payload, reply);
  if (type === "host:draw-participant") return handleDrawParticipant(payload, reply);
  if (type === "host:clear-draw") return handleClearDraw(payload, reply);
  if (type === "host:summarize-wordcloud") return handleSummarizeWordcloud(payload, reply);
  if (type === "host:reset-room") return handleResetRoom(payload, reply);
  if (type === "host:close-room") return handleCloseRoom(payload, reply);
  if (type === "participant:answer-choice") return handleAnswerChoice(client, payload, reply);
  if (type === "participant:submit-word") return handleSubmitWord(client, payload, reply);
  if (type === "participant:submit-danmaku") return handleSubmitDanmaku(client, payload, reply);
  if (type === "client:ping") return send(client, { type: "pong", now: Date.now() });

  reply({ ok: false, error: "未知操作。" });
}

function handleCreateRoom(client, reply) {
  const room = createRoom();
  joinClientRoom(client, room.pin, "host");
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleRestoreRoom(client, { pin }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到這個房間，請重新建立。" });
  joinClientRoom(client, room.pin, "host");
  reply({ ok: true, snapshot: toSnapshot(room) });
}

function handleScreenJoin(client, { pin }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到這個房間。" });
  joinClientRoom(client, room.pin, "screen");
  reply({ ok: true, snapshot: toSnapshot(room) });
}

function handleParticipantJoin(client, { pin, name }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "房間代碼不存在，請確認 PIN。" });

  joinClientRoom(client, room.pin, "participant");
  const displayName = sanitizeText(name, 18) || `觀眾 ${room.participants.size + 1}`;
  room.participants.set(client.id, {
    id: client.id,
    name: displayName,
    joinedAt: Date.now()
  });

  reply({ ok: true, participantId: client.id, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleUpdateActivity({ pin, activityId, patch }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  const activity = findActivity(room, activityId);
  if (!activity) return reply({ ok: false, error: "找不到活動。" });

  applyActivityPatch(activity, patch);
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handlePublishActivity({ pin, activityId }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  const activity = findActivity(room, activityId);
  if (!activity) return reply({ ok: false, error: "找不到活動。" });

  room.currentActivityId = activity.id;
  room.spotlight = null;
  room.activities.forEach((item) => {
    item.status = item.id === activity.id ? "live" : "draft";
  });
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleGoWaiting({ pin }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  room.currentActivityId = null;
  room.spotlight = null;
  room.activities.forEach((activity) => {
    activity.status = "draft";
  });
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleToggleResults({ pin, activityId }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  const activity = findActivity(room, activityId);
  if (!activity) return reply({ ok: false, error: "找不到活動。" });
  activity.showResults = !activity.showResults;
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleClearResponses({ pin, activityId }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  const activity = findActivity(room, activityId);
  if (!activity) return reply({ ok: false, error: "找不到活動。" });
  clearActivityResponses(activity);
  if (room.spotlight?.activityId === activity.id) room.spotlight = null;
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleDrawParticipant({ pin, activityId }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  const activity = findActivity(room, activityId || room.currentActivityId);
  if (!activity || room.currentActivityId !== activity.id) {
    return reply({ ok: false, error: "請先發布要抽籤的活動。" });
  }

  const candidates = getRespondedParticipants(room, activity);
  if (!candidates.length) return reply({ ok: false, error: "目前還沒有可抽出的答案。" });

  const winner = candidates[Math.floor(Math.random() * candidates.length)];
  room.spotlight = {
    id: randomUUID(),
    activityId: activity.id,
    activityType: activity.type,
    activityTitle: activity.title,
    participantId: winner.participant.id,
    participantName: winner.participant.name,
    answerText: winner.answerText,
    answerItems: winner.answerItems,
    createdAt: Date.now()
  };

  reply({ ok: true, spotlight: room.spotlight, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleClearDraw({ pin }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  room.spotlight = null;
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleSummarizeWordcloud({ pin, activityId }, reply) {
  summarizeWordcloud({ pin, activityId }, reply).catch((error) => {
    console.error(error);
    reply({ ok: false, error: "摘要產生失敗，請稍後再試。" });
  });
}

function handleResetRoom({ pin }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  room.currentActivityId = null;
  room.spotlight = null;
  room.activities = createDefaultActivities();
  reply({ ok: true, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

function handleCloseRoom({ pin }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  broadcast(room.pin, { type: "room:closed" });
  rooms.delete(room.pin);
  for (const client of clients.values()) {
    if (client.roomPin === room.pin) {
      client.roomPin = null;
      client.role = "guest";
    }
  }
  reply({ ok: true });
}

function handleAnswerChoice(client, { pin, activityId, optionIds }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "房間已關閉或不存在。" });
  if (!room.participants.has(client.id)) return reply({ ok: false, error: "請先加入房間。" });

  const activity = findActivity(room, activityId);
  if (!activity || activity.type !== "choice" || room.currentActivityId !== activity.id) {
    return reply({ ok: false, error: "目前沒有開放的選擇題。" });
  }
  if (activity.answers[client.id]) return reply({ ok: false, error: "你已經作答。" });

  const allowedIds = new Set(activity.options.map((option) => option.id));
  const selected = Array.isArray(optionIds)
    ? [...new Set(optionIds)].filter((id) => allowedIds.has(id))
    : [];
  const validSelection =
    activity.mode === "multiple"
      ? selected.length >= 1 && selected.length <= activity.options.length
      : selected.length === 1;

  if (!validSelection) return reply({ ok: false, error: "請選擇有效的選項。" });

  activity.answers[client.id] = selected;
  reply({ ok: true, selected });
  emitSnapshot(room);
}

function handleSubmitWord(client, { pin, activityId, text }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "房間已關閉或不存在。" });
  if (!room.participants.has(client.id)) return reply({ ok: false, error: "請先加入房間。" });

  const activity = findActivity(room, activityId);
  if (!activity || activity.type !== "wordcloud" || room.currentActivityId !== activity.id) {
    return reply({ ok: false, error: "目前沒有開放的文字雲。" });
  }

  const clean = sanitizeText(text, MAX_WORD_LENGTH);
  if (!clean) return reply({ ok: false, error: "請輸入 1 到 15 個字。" });
  if (containsBlockedTerm(clean)) return reply({ ok: false, error: "這個詞無法送出，請換一個說法。" });

  activity.submissions.push({
    id: randomUUID(),
    participantId: client.id,
    text: clean,
    createdAt: Date.now()
  });
  activity.summary = null;
  reply({ ok: true, text: clean });
  emitSnapshot(room);
}

function handleSubmitDanmaku(client, { pin, activityId, text }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "這個房間不存在。" });
  if (!room.participants.has(client.id)) return reply({ ok: false, error: "請先加入房間。" });

  const activity = findActivity(room, activityId);
  if (!activity || activity.type !== "danmaku" || room.currentActivityId !== activity.id) {
    return reply({ ok: false, error: "目前沒有開放彈幕互動。" });
  }

  const clean = sanitizeText(text, MAX_DANMAKU_LENGTH);
  if (!clean) return reply({ ok: false, error: `請輸入 1 到 ${MAX_DANMAKU_LENGTH} 個字。` });
  if (containsBlockedTerm(clean)) return reply({ ok: false, error: "這段文字包含不適合顯示的內容，請換個說法。" });

  activity.messages.push({
    id: randomUUID(),
    participantId: client.id,
    text: clean,
    createdAt: Date.now()
  });
  if (activity.messages.length > MAX_DANMAKU_MESSAGES) {
    activity.messages.splice(0, activity.messages.length - MAX_DANMAKU_MESSAGES);
  }

  reply({ ok: true, text: clean });
  emitSnapshot(room);
}

function getRespondedParticipants(room, activity) {
  return Array.from(room.participants.values())
    .map((participant) => {
      const response = getParticipantResponse(activity, participant.id);
      if (!response) return null;
      return { participant, ...response };
    })
    .filter(Boolean);
}

function getParticipantResponse(activity, participantId) {
  if (activity.type === "choice") {
    const selectedIds = activity.answers[participantId] || [];
    if (!selectedIds.length) return null;
    const selectedOptions = activity.options
      .filter((option) => selectedIds.includes(option.id))
      .map((option) => option.text);
    if (!selectedOptions.length) return null;
    return {
      answerItems: selectedOptions,
      answerText: selectedOptions.join("、")
    };
  }

  if (activity.type === "wordcloud") {
    const words = activity.submissions
      .filter((item) => item.participantId === participantId)
      .map((item) => item.text);
    if (!words.length) return null;
    return {
      answerItems: words,
      answerText: words.join("、")
    };
  }

  if (activity.type === "danmaku") {
    const messages = activity.messages
      .filter((item) => item.participantId === participantId)
      .map((item) => item.text);
    if (!messages.length) return null;
    return {
      answerItems: messages,
      answerText: messages.join("、")
    };
  }

  return null;
}

async function summarizeWordcloud({ pin, activityId }, reply) {
  const room = getRoom(pin);
  if (!room) return reply({ ok: false, error: "找不到房間。" });
  const activity = findActivity(room, activityId || room.currentActivityId);
  if (!activity || activity.type !== "wordcloud") {
    return reply({ ok: false, error: "請先選擇文字雲活動。" });
  }
  if (!activity.submissions.length) {
    return reply({ ok: false, error: "目前還沒有文字雲回應可總結。" });
  }

  activity.summary = await buildWordcloudSummary(activity);
  reply({ ok: true, summary: activity.summary, snapshot: toSnapshot(room) });
  emitSnapshot(room);
}

async function buildWordcloudSummary(activity) {
  const localSummary = buildLocalWordcloudSummary(activity);
  if (!OPENAI_API_KEY) return localSummary;

  try {
    const aiText = await summarizeWithOpenAI(activity);
    if (!aiText) return localSummary;
    return {
      ...localSummary,
      text: aiText,
      mode: "openai",
      model: OPENAI_SUMMARY_MODEL
    };
  } catch (error) {
    console.warn("OpenAI summary fallback:", error.message);
    return localSummary;
  }
}

function buildLocalWordcloudSummary(activity) {
  const texts = activity.submissions.map((item) => item.text);
  const frequency = new Map();
  texts.forEach((text) => frequency.set(text, (frequency.get(text) || 0) + 1));
  const topWords = Array.from(frequency.entries())
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "zh-Hant"))
    .slice(0, 5);
  const examples = [...new Set(texts)].slice(0, 6);
  const keywordText = topWords
    .map((word) => `「${word.text}」${word.count > 1 ? `(${word.count})` : ""}`)
    .join("、");
  const exampleText = examples.map((text) => `「${text}」`).join("、");

  return {
    id: randomUUID(),
    mode: "local",
    model: "內建摘要",
    generatedAt: Date.now(),
    responseCount: texts.length,
    uniqueCount: frequency.size,
    topWords,
    examples,
    text: `共收到 ${texts.length} 則回應，整理出 ${frequency.size} 種不同想法。主要焦點集中在 ${keywordText}；代表回應包括 ${exampleText}。整體來看，觀眾期待 AI 能把重複、耗時或需要靈感整理的工作變得更快、更清楚。`
  };
}

async function summarizeWithOpenAI(activity) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  const responses = activity.submissions
    .slice(-120)
    .map((item, index) => `${index + 1}. ${item.text}`)
    .join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_SUMMARY_MODEL,
        input: [
          {
            role: "system",
            content: "你是活動主持人的即時互動助理。請用繁體中文、台灣用語，將文字雲回應總結成投影畫面可讀的一小段。"
          },
          {
            role: "user",
            content: `題目：${activity.title}\n觀眾回應：\n${responses}\n\n請輸出 2 到 3 句，點出主要期待、共同趨勢與一個可接話的主持提示。`
          }
        ],
        max_output_tokens: 220
      }),
      signal: controller.signal
    });
    if (!response.ok) return "";
    const data = await response.json();
    return extractOpenAIText(data);
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  const chunks = [];
  (data.output || []).forEach((item) => {
    (item.content || []).forEach((content) => {
      if (typeof content.text === "string") chunks.push(content.text);
    });
  });
  return chunks.join("\n").trim();
}

function createRoom() {
  let pin = generatePin();
  while (rooms.has(pin)) pin = generatePin();

  const room = {
    pin,
    createdAt: Date.now(),
    currentActivityId: null,
    spotlight: null,
    participants: new Map(),
    activities: createDefaultActivities()
  };
  rooms.set(pin, room);
  return room;
}

function createDefaultActivities() {
  return [
    {
      id: "choice-main",
      type: "choice",
      status: "draft",
      title: "您常用AI做哪些事情?",
      mode: "single",
      showResults: true,
      responseVersion: 1,
      options: [
        { id: "opt-a", text: "生成圖片", color: "#159e97" },
        { id: "opt-b", text: "製作影片", color: "#2d8bd7" },
        { id: "opt-c", text: "產出音檔", color: "#f5a524" },
        { id: "opt-d", text: "設計遊戲", color: "#ff6f61" }
      ],
      answers: {}
    },
    {
      id: "cloud-main",
      type: "wordcloud",
      status: "draft",
      title: "您期待AI能幫您做到哪件事情?",
      showResults: true,
      responseVersion: 1,
      submissions: [],
      summary: null
    },
    {
      id: "danmaku-main",
      type: "danmaku",
      status: "draft",
      title: "請分享你現在的想法",
      showResults: true,
      responseVersion: 1,
      messages: []
    }
  ];
}

function generatePin() {
  return Array.from({ length: 6 }, () =>
    PIN_ALPHABET[Math.floor(Math.random() * PIN_ALPHABET.length)]
  ).join("");
}

function joinClientRoom(client, pin, role) {
  if (client.role === "participant" && client.roomPin && client.roomPin !== pin) {
    const previousRoom = getRoom(client.roomPin);
    if (previousRoom) {
      previousRoom.participants.delete(client.id);
      emitSnapshot(previousRoom);
    }
  }
  client.roomPin = pin;
  client.role = role;
}

function getRoom(pin) {
  if (!pin) return null;
  return rooms.get(String(pin).trim().toUpperCase()) || null;
}

function findActivity(room, activityId) {
  return room.activities.find((activity) => activity.id === activityId);
}

function applyActivityPatch(activity, patch = {}) {
  if (typeof patch.title === "string") {
    activity.title = sanitizeText(patch.title, 120) || activity.title;
  }
  if (typeof patch.showResults === "boolean") {
    activity.showResults = patch.showResults;
  }
  if (activity.type === "choice") applyChoicePatch(activity, patch);
}

function applyChoicePatch(activity, patch) {
  if (patch.mode === "single" || patch.mode === "multiple") {
    activity.mode = patch.mode;
  }
  if (!Array.isArray(patch.options)) return;

  const nextOptions = patch.options
    .slice(0, 5)
    .map((option, index) => ({
      id: sanitizeId(option.id) || `opt-${index + 1}`,
      text: sanitizeText(option.text, 36) || `選項 ${index + 1}`,
      color: sanitizeColor(option.color) || defaultColor(index)
    }))
    .filter((option) => option.text);

  if (nextOptions.length < 2) return;
  activity.options = nextOptions;

  const allowed = new Set(nextOptions.map((option) => option.id));
  Object.entries(activity.answers).forEach(([participantId, selected]) => {
    const filtered = selected.filter((id) => allowed.has(id));
    if (filtered.length) activity.answers[participantId] = filtered;
    else delete activity.answers[participantId];
  });
}

function clearActivityResponses(activity) {
  activity.responseVersion += 1;
  if (activity.type === "choice") activity.answers = {};
  if (activity.type === "wordcloud") {
    activity.submissions = [];
    activity.summary = null;
  }
  if (activity.type === "danmaku") activity.messages = [];
}

function toSnapshot(room) {
  return {
    pin: room.pin,
    createdAt: room.createdAt,
    currentActivityId: room.currentActivityId,
    spotlight: room.spotlight,
    participants: Array.from(room.participants.values()).map((participant) => ({
      id: participant.id,
      name: participant.name,
      joinedAt: participant.joinedAt
    })),
    activities: room.activities.map(serializeActivity)
  };
}

function serializeActivity(activity) {
  if (activity.type === "choice") {
    const counts = Object.fromEntries(activity.options.map((option) => [option.id, 0]));
    Object.values(activity.answers).forEach((selectedIds) => {
      selectedIds.forEach((id) => {
        if (id in counts) counts[id] += 1;
      });
    });
    const totalResponses = Object.keys(activity.answers).length;
    const totalVotes = Object.values(counts).reduce((sum, value) => sum + value, 0);

    return {
      id: activity.id,
      type: activity.type,
      status: activity.status,
      title: activity.title,
      mode: activity.mode,
      showResults: activity.showResults,
      responseVersion: activity.responseVersion,
      responseCount: totalResponses,
      voteCount: totalVotes,
      options: activity.options.map((option) => ({
        ...option,
        count: counts[option.id] || 0
      }))
    };
  }

  if (activity.type === "wordcloud") {
    const frequency = new Map();
    activity.submissions.forEach((item) => {
      frequency.set(item.text, (frequency.get(item.text) || 0) + 1);
    });

    return {
      id: activity.id,
      type: activity.type,
      status: activity.status,
      title: activity.title,
      showResults: activity.showResults,
      responseVersion: activity.responseVersion,
      responseCount: activity.submissions.length,
      summary: activity.summary,
      words: Array.from(frequency.entries())
        .map(([text, count]) => ({ text, count }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "zh-Hant"))
    };
  }

  if (activity.type === "danmaku") {
    return {
      id: activity.id,
      type: activity.type,
      status: activity.status,
      title: activity.title,
      showResults: activity.showResults,
      responseVersion: activity.responseVersion,
      responseCount: activity.messages.length,
      messages: activity.messages.slice(-60).map((message) => ({
        id: message.id,
        text: message.text,
        createdAt: message.createdAt
      }))
    };
  }

  return {
    id: activity.id,
    type: activity.type,
    status: activity.status,
    title: activity.title,
    showResults: activity.showResults,
    responseVersion: activity.responseVersion,
    responseCount: 0
  };
}

function emitSnapshot(room) {
  broadcast(room.pin, { type: "snapshot", snapshot: toSnapshot(room) });
}

function broadcast(pin, message) {
  for (const client of clients.values()) {
    if (client.roomPin === pin) send(client, message);
  }
}

function sendReply(client, requestId, response) {
  send(client, { type: "reply", requestId, ...response });
}

function send(client, message) {
  if (client.socket.destroyed) return;
  writeFrame(client.socket, Buffer.from(JSON.stringify(message), "utf8"), 0x1);
}

function writeFrame(socket, payload, opcode = 0x1) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function removeClient(client) {
  if (!clients.has(client.id)) return;
  clients.delete(client.id);
  if (client.role !== "participant" || !client.roomPin) return;
  const room = getRoom(client.roomPin);
  if (!room) return;
  room.participants.delete(client.id);
  emitSnapshot(room);
}

function sanitizeText(value, limit) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function sanitizeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48);
}

function sanitizeColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

function defaultColor(index) {
  return ["#159e97", "#2d8bd7", "#f5a524", "#ff6f61", "#7c6ee6"][index % 5];
}

function containsBlockedTerm(value) {
  const lowered = value.toLowerCase();
  return BLOCKED_TERMS.some((term) => lowered.includes(term.toLowerCase()));
}

function createQrSvg(text) {
  const matrix = createQrMatrix(String(text).slice(0, 78));
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const cells = [];

  matrix.forEach((row, y) => {
    row.forEach((cell, x) => {
      if (cell) cells.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
    });
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<path d="${cells.join("")}" fill="#111827"/>`,
    `</svg>`
  ].join("");
}

function createQrMatrix(text) {
  const version = 4;
  const size = version * 4 + 17;
  const dataCodewords = 80;
  const eccCodewords = 20;
  const matrix = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  const set = (x, y, value, reserve = true) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    matrix[y][x] = value;
    if (reserve) reserved[y][x] = true;
  };

  addFinder(matrix, reserved, 0, 0);
  addFinder(matrix, reserved, size - 7, 0);
  addFinder(matrix, reserved, 0, size - 7);
  addTiming(set, reserved, size);
  addAlignment(set, 26, 26);
  set(8, size - 8, true);
  reserveFormat(set, size);

  const data = makeDataCodewords(text, dataCodewords);
  const ecc = makeErrorCorrection(data, eccCodewords);
  const bits = [...data, ...ecc].flatMap((codeword) =>
    Array.from({ length: 8 }, (_item, index) => (codeword >>> (7 - index)) & 1)
  );

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (reserved[y][x]) continue;
        let value = Boolean(bits[bitIndex] || 0);
        bitIndex += 1;
        if ((x + y) % 2 === 0) value = !value;
        set(x, y, value);
      }
    }
    upward = !upward;
  }

  writeFormatBits(set, size, 0);
  return matrix;
}

function addFinder(matrix, reserved, left, top) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const xx = left + x;
      const yy = top + y;
      if (xx < 0 || yy < 0 || yy >= matrix.length || xx >= matrix.length) continue;
      const isSeparator = x === -1 || y === -1 || x === 7 || y === 7;
      const isOuter = x === 0 || y === 0 || x === 6 || y === 6;
      const isCenter = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      matrix[yy][xx] = !isSeparator && (isOuter || isCenter);
      reserved[yy][xx] = true;
    }
  }
}

function addTiming(set, reserved, size) {
  for (let i = 8; i < size - 8; i += 1) {
    const value = i % 2 === 0;
    if (!reserved[6][i]) set(i, 6, value);
    if (!reserved[i][6]) set(6, i, value);
  }
}

function addAlignment(set, centerX, centerY) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      set(centerX + x, centerY + y, distance !== 1);
    }
  }
}

function reserveFormat(set, size) {
  for (let i = 0; i <= 5; i += 1) set(8, i, false);
  set(8, 7, false);
  set(8, 8, false);
  set(7, 8, false);
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, false);
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, false);
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, false);
}

function writeFormatBits(set, size, mask) {
  const ecLevelL = 1;
  const data = (ecLevelL << 3) | mask;
  let bits = data << 10;
  const generator = 0x537;
  for (let i = 14; i >= 10; i -= 1) {
    if (((bits >>> i) & 1) !== 0) bits ^= generator << (i - 10);
  }
  const format = ((data << 10) | bits) ^ 0x5412;
  const bit = (index) => Boolean((format >>> index) & 1);

  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
}

function makeDataCodewords(text, capacity) {
  const bytes = Buffer.from(text, "utf8");
  const bits = [0, 1, 0, 0];
  pushBits(bits, bytes.length, 8);
  for (const byte of bytes) pushBits(bits, byte, 8);
  const remaining = capacity * 8 - bits.length;
  pushBits(bits, 0, Math.min(4, Math.max(0, remaining)));
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(Number.parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  for (let pad = 0; codewords.length < capacity; pad += 1) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return codewords.slice(0, capacity);
}

function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function makeErrorCorrection(data, degree) {
  const generator = makeGeneratorPolynomial(degree);
  const ecc = Array(degree).fill(0);
  for (const codeword of data) {
    const factor = codeword ^ ecc.shift();
    ecc.push(0);
    for (let i = 0; i < degree; i += 1) {
      ecc[i] ^= gfMultiply(generator[i + 1], factor);
    }
  }
  return ecc;
}

function makeGeneratorPolynomial(degree) {
  let polynomial = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array(polynomial.length + 1).fill(0);
    polynomial.forEach((coefficient, index) => {
      next[index] ^= gfMultiply(coefficient, 1);
      next[index + 1] ^= gfMultiply(coefficient, gfPow(i));
    });
    polynomial = next;
  }
  return polynomial;
}

function gfPow(power) {
  let value = 1;
  for (let i = 0; i < power; i += 1) {
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  return value;
}

function gfMultiply(a, b) {
  let result = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) result ^= a;
    const highBit = a & 0x80;
    a = (a << 1) & 0xff;
    if (highBit) a ^= 0x1d;
    b >>>= 1;
  }
  return result;
}

function shutdown() {
  for (const client of clients.values()) {
    client.socket.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
