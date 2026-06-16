const app = document.getElementById("app");
const state = {
  ws: null,
  connected: false,
  pending: new Map(),
  snapshot: null,
  error: "",
  closed: false,
  selectedActivityId: "",
  joined: false,
  answers: {},
  selectedAnswers: {},
  lastSentWord: "",
  lastSentDanmaku: "",
  summarizingActivityId: "",
  route: getRoute(),
  reconnectTimer: null,
  heartbeatTimer: null,
  audioContext: null,
  audioUnlocked: false,
  pendingWordChimes: 0
};

connect();
render();

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("change", handleChange);
document.addEventListener("input", handleInput);
document.addEventListener("pointerdown", primeAudio, { passive: true });
document.addEventListener("keydown", primeAudio);

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.connected = true;
    state.error = "";
    startHeartbeat();
    render();
    restoreContext();
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "reply") {
      const resolver = state.pending.get(message.requestId);
      if (resolver) {
        state.pending.delete(message.requestId);
        resolver(message);
      }
      return;
    }
    if (message.type === "snapshot") {
      const shouldChime = shouldPlayOperatorTextChime(state.snapshot, message.snapshot);
      state.closed = false;
      state.snapshot = message.snapshot;
      ensureSelectedActivity();
      render();
      if (shouldChime) queueOrPlayWordChime("operator");
      return;
    }
    if (message.type === "room:closed") {
      state.closed = true;
      state.snapshot = null;
      state.joined = false;
      window.localStorage.removeItem("interaction-live-pin");
      render();
    }
  });

  ws.addEventListener("close", () => {
    state.connected = false;
    stopHeartbeat();
    render();
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connect, 900);
  });
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "client:ping" }));
    }
  }, 25000);
}

function stopHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!state.audioContext) state.audioContext = new AudioContextClass();
  return state.audioContext;
}

function primeAudio() {
  const context = getAudioContext();
  if (!context) return;
  const resumePromise = context.resume?.();
  if (resumePromise) resumePromise.catch(() => {});
  state.audioUnlocked = true;
  flushPendingWordChimes();
}

function flushPendingWordChimes() {
  if (!state.audioUnlocked || !state.pendingWordChimes) return;
  const pending = state.pendingWordChimes;
  state.pendingWordChimes = 0;
  for (let index = 0; index < Math.min(pending, 3); index += 1) {
    setTimeout(() => playWordChime("operator"), index * 120);
  }
}

function queueOrPlayWordChime(variant = "operator") {
  if (!state.audioUnlocked) {
    if (variant === "operator") state.pendingWordChimes += 1;
    return;
  }
  playWordChime(variant);
}

function playWordChime(variant = "participant", resumeAttempted = false) {
  const context = getAudioContext();
  if (!context || !state.audioUnlocked) return;
  if (context.state === "suspended" && !resumeAttempted) {
    const resumePromise = context.resume?.();
    if (resumePromise) {
      resumePromise
        .then(() => playWordChime(variant, true))
        .catch(() => {
          if (variant === "operator") state.pendingWordChimes += 1;
        });
      return;
    }
  }
  const now = context.currentTime;
  const frequencies = variant === "operator" ? [523.25, 783.99, 1046.5] : [659.25, 880];
  const volume = variant === "operator" ? 0.14 : 0.11;
  const masterGain = context.createGain();
  masterGain.gain.setValueAtTime(0.0001, now);
  masterGain.gain.exponentialRampToValueAtTime(volume, now + 0.018);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  masterGain.connect(context.destination);

  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now + index * 0.055);
    gain.gain.setValueAtTime(0.0001, now + index * 0.055);
    gain.gain.exponentialRampToValueAtTime(1, now + 0.035 + index * 0.055);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36 + index * 0.055);
    oscillator.connect(gain).connect(masterGain);
    oscillator.start(now + index * 0.055);
    oscillator.stop(now + 0.58 + index * 0.055);
  });
}

function shouldPlayOperatorTextChime(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot || !nextSnapshot || state.route.view === "participant") return false;
  const activeActivity = nextSnapshot.activities.find(
    (activity) =>
      activity.id === nextSnapshot.currentActivityId && (activity.type === "wordcloud" || activity.type === "danmaku")
  );
  if (!activeActivity) return false;
  const previousActivity = previousSnapshot.activities.find((activity) => activity.id === activeActivity.id);
  if (!previousActivity) return false;
  return getTextStreamTotal(activeActivity) > getTextStreamTotal(previousActivity);
}

function getTextStreamTotal(activity) {
  if (activity?.type === "wordcloud") {
    return activity.words?.reduce((sum, word) => sum + word.count, 0) || activity.responseCount || 0;
  }
  if (activity?.type === "danmaku") {
    return activity.responseCount || activity.messages?.length || 0;
  }
  return 0;
}

function getActivityMeta(activityOrType) {
  const type = typeof activityOrType === "string" ? activityOrType : activityOrType?.type;
  if (type === "choice") {
    return { label: "選擇題", icon: "bar", kicker: "Multiple Choice", editorTitle: "選擇題設定" };
  }
  if (type === "danmaku") {
    return { label: "彈幕", icon: "message", kicker: "Danmaku", editorTitle: "彈幕設定" };
  }
  return { label: "文字雲", icon: "cloud", kicker: "Word Cloud", editorTitle: "文字雲設定" };
}

async function restoreContext() {
  if (state.route.view === "presenter") {
    const savedPin = window.localStorage.getItem("interaction-live-pin");
    if (savedPin && !state.snapshot) await request("host:restore-room", { pin: savedPin });
  }
  if (state.route.view === "screen" && state.route.pin) {
    await request("screen:join", { pin: state.route.pin });
  }
}

function request(type, payload = {}) {
  return new Promise((resolve) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      const response = { ok: false, error: "尚未連上即時伺服器。" };
      state.error = response.error;
      render();
      resolve(response);
      return;
    }

    const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    state.pending.set(requestId, (response) => {
      if (!response.ok) state.error = response.error || "操作失敗，請稍後再試。";
      else state.error = "";
      if (response.snapshot) {
        state.closed = false;
        state.snapshot = response.snapshot;
        ensureSelectedActivity();
      }
      render();
      resolve(response);
    });
    state.ws.send(JSON.stringify({ type, payload, requestId }));

    const timeoutMs = type === "host:summarize-wordcloud" ? 16000 : 5000;
    setTimeout(() => {
      if (!state.pending.has(requestId)) return;
      state.pending.delete(requestId);
      const response = { ok: false, error: "即時伺服器沒有回應，請再試一次。" };
      state.error = response.error;
      render();
      resolve(response);
    }, timeoutMs);
  });
}

function render() {
  if (state.route.view === "participant") app.innerHTML = renderAudience();
  else if (state.route.view === "screen") app.innerHTML = renderScreen();
  else app.innerHTML = renderPresenter();
  renderQrImages();
}

function renderPresenter() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return `
      <main class="launch-screen">
        <section class="launch-panel">
          <div class="brand-lockup"><span class="brand-mark">${icon("radio")}</span><span>互動堂 Live</span></div>
          <h1>簡報中，讓觀眾立刻參與。</h1>
          <p>建立房間後，系統會產生 6 碼 PIN 與 QR Code。觀眾無需登入即可加入，即時回答選擇題、送出文字雲或發表彈幕想法。</p>
          <button class="primary-action" data-action="create-room" ${state.connected ? "" : "disabled"}>${icon("plus")}建立房間</button>
          ${state.connected ? "" : `<span class="status-line">正在連接即時伺服器...</span>`}
          ${messageLine()}
        </section>
      </main>
    `;
  }

  ensureSelectedActivity();
  const selectedActivity = getSelectedActivity();
  const activeActivity = getActiveActivity(snapshot);

  return `
    <main class="presenter-shell">
      ${renderRoomSidebar(snapshot)}
      <section class="workbench">
        <div class="topbar">
          <div>
            <p class="eyeless-label">Presenter Mode</p>
            <h1>即時互動控制台</h1>
          </div>
          <div class="topbar-actions">
            <a class="icon-button labeled" href="${screenUrl(snapshot.pin)}" target="_blank" rel="noreferrer">${icon("monitor")}投影模式</a>
            <button class="icon-button labeled" data-action="copy-link" data-value="${attr(joinUrl(snapshot.pin))}">${icon("copy")}複製加入連結</button>
          </div>
        </div>
        ${renderProjectionPreview(snapshot, activeActivity)}
        <div class="workspace-grid">
          ${renderActivityPicker(snapshot)}
          ${renderActivityEditor(snapshot, selectedActivity)}
          <section class="panel results-panel">
            <div class="panel-header">
              <div><p class="panel-kicker">Live Results</p><h2>即時結果</h2></div>
              <span class="response-pill">${selectedActivity?.responseCount || 0} 回覆</span>
            </div>
            ${renderActivityResults(selectedActivity)}
          </section>
        </div>
      </section>
      ${renderRightRail(snapshot, activeActivity)}
    </main>
  `;
}

function renderRoomSidebar(snapshot) {
  return `
    <aside class="room-sidebar">
      <div class="brand-lockup"><span class="brand-mark">${icon("radio")}</span><span>互動堂 Live</span></div>
      <div class="pin-panel">
        <span class="pin-label">Room PIN</span>
        <strong>${escapeHtml(snapshot.pin)}</strong>
        ${qrImg(joinUrl(snapshot.pin), 180, `加入房間 ${snapshot.pin} 的 QR Code`, "qr-image")}
      </div>
      <div class="metric-row">${icon("users")}<span>目前參與人數</span><strong>${snapshot.participants.length}</strong></div>
      <div class="sidebar-actions">
        <button class="sidebar-button" data-action="go-waiting">${icon("monitor")}顯示等待畫面</button>
        <button class="sidebar-button" data-action="reset-room">${icon("rotate")}重置房間狀態</button>
        <button class="sidebar-button danger" data-action="close-room">${icon("x")}關閉房間</button>
      </div>
      <div class="${state.connected ? "connection connected" : "connection"}"><span></span>${state.connected ? "即時連線中" : "重新連線中"}</div>
      ${messageLine()}
    </aside>
  `;
}

function renderProjectionPreview(snapshot, activeActivity) {
  return `
    <section class="projection-preview">
      <div class="projection-join">
        <div><span>加入互動</span><strong>${escapeHtml(snapshot.pin)}</strong><small>${snapshot.participants.length} 人在線</small></div>
        ${qrImg(joinUrl(snapshot.pin), 148, "", "")}
      </div>
      <div class="projection-content">
        <span class="projection-label">Projection Preview</span>
        <h2>${escapeHtml(activeActivity?.title || "等待講者開啟下一題...")}</h2>
        ${renderActivityResults(activeActivity, true)}
        ${renderSpotlight(snapshot.spotlight, true)}
      </div>
    </section>
  `;
}

function renderActivityPicker(snapshot) {
  return `
    <section class="panel activity-list">
      <div class="panel-header"><div><p class="panel-kicker">Activities</p><h2>活動</h2></div></div>
      ${snapshot.activities
        .map((activity) => {
          const selected = state.selectedActivityId === activity.id;
          const current = snapshot.currentActivityId === activity.id;
          const meta = getActivityMeta(activity);
          return `
            <button class="activity-tab ${selected ? "selected" : ""}" data-action="select-activity" data-id="${attr(activity.id)}">
              <span class="tab-icon">${icon(meta.icon)}</span>
              <span><strong>${meta.label}</strong><small>${current ? "發布中" : `${activity.responseCount} 回覆`}</small></span>
            </button>
          `;
        })
        .join("")}
    </section>
  `;
}

function renderActivityEditor(snapshot, activity) {
  if (!activity) return "";
  const isChoice = activity.type === "choice";
  const meta = getActivityMeta(activity);
  const isLive = snapshot.currentActivityId === activity.id;
  const canDraw = isLive && activity.responseCount > 0;
  const isSummarizing = state.summarizingActivityId === activity.id;
  return `
    <section class="panel editor-panel">
      <div class="panel-header">
        <div><p class="panel-kicker">${meta.kicker}</p><h2>${meta.editorTitle}</h2></div>
        <span class="${isLive ? "live-pill" : "draft-pill"}">${isLive ? "發布中" : "草稿"}</span>
      </div>
      <label class="field">
        <span>題目</span>
        <input data-change="activity-title" value="${attr(activity.title)}" maxlength="120" />
      </label>
      ${
        isChoice
          ? `
            <div class="segmented-control" aria-label="選擇題模式">
              <button class="${activity.mode === "single" ? "selected" : ""}" data-action="set-mode" data-mode="single">單選</button>
              <button class="${activity.mode === "multiple" ? "selected" : ""}" data-action="set-mode" data-mode="multiple">多選</button>
            </div>
            <div class="options-editor">
              ${activity.options
                .map(
                  (option, index) => `
                    <div class="option-edit-row">
                      <input class="color-input" type="color" value="${attr(option.color)}" data-change="option-color" data-id="${attr(option.id)}" aria-label="選項 ${index + 1} 顏色" />
                      <input value="${attr(option.text)}" data-change="option-text" data-id="${attr(option.id)}" maxlength="36" aria-label="選項 ${index + 1}" />
                      <button class="icon-button" data-action="remove-option" data-id="${attr(option.id)}" ${activity.options.length <= 2 ? "disabled" : ""} title="刪除選項">${icon("trash")}</button>
                    </div>
                  `
                )
                .join("")}
              <button class="secondary-action" data-action="add-option" ${activity.options.length >= 5 ? "disabled" : ""}>${icon("plus")}新增選項</button>
            </div>
          `
          : `
            ${renderTextActivitySettings(activity)}
          `
      }
      <div class="editor-actions">
        <button class="primary-action" data-action="publish-activity" data-id="${attr(activity.id)}">${icon("send")}發布到觀眾端</button>
        <button class="secondary-action" data-action="draw-participant" data-id="${attr(activity.id)}" ${canDraw ? "" : "disabled"}>${icon("ticket")}抽籤顯示答案</button>
        ${
          activity.type === "wordcloud"
            ? `<button class="secondary-action" data-action="summarize-wordcloud" data-id="${attr(activity.id)}" ${activity.responseCount && !isSummarizing ? "" : "disabled"}>${icon("sparkles")}${isSummarizing ? "總結中..." : activity.summary ? "重新 AI 總結" : "AI 總結"}</button>`
            : ""
        }
        ${snapshot.spotlight ? `<button class="secondary-action" data-action="clear-draw">${icon("eye-off")}清除抽籤顯示</button>` : ""}
        <button class="secondary-action" data-action="toggle-results" data-id="${attr(activity.id)}">${activity.showResults ? "隱藏結果" : "顯示結果"}</button>
        <button class="secondary-action" data-action="clear-responses" data-id="${attr(activity.id)}">${icon("rotate")}清除作答</button>
      </div>
    </section>
  `;
}

function renderTextActivitySettings(activity) {
  if (activity.type === "danmaku") {
    return `
      <div class="word-settings">${icon("message")}<p>觀眾每次最多輸入 40 個字，留言會即時以彈幕方式出現在操作端與投影端。</p></div>
    `;
  }
  return `
    <div class="word-settings">${icon("cloud")}<p>觀眾每次最多輸入 15 個字，系統會過濾不當詞並依頻率放大文字。</p></div>
  `;
}

function renderRightRail(snapshot, activeActivity) {
  return `
    <aside class="right-rail">
      <section class="rail-section">
        <div class="panel-header"><div><p class="panel-kicker">Audience</p><h2>觀眾</h2></div><span class="response-pill">${snapshot.participants.length}</span></div>
        <div class="participant-list">
          ${
            snapshot.participants.length
              ? snapshot.participants
                  .slice(0, 9)
                  .map(
                    (participant) => `
                      <div class="participant-row"><span>${escapeHtml(participant.name.slice(0, 1))}</span><strong>${escapeHtml(participant.name)}</strong></div>
                    `
                  )
                  .join("")
              : `<p class="muted">等待觀眾加入...</p>`
          }
        </div>
      </section>
      <section class="rail-section mobile-frame-section">
        <div class="panel-header"><div><p class="panel-kicker">Participant Preview</p><h2>手機端預覽</h2></div>${icon("phone")}</div>
        <div class="phone-preview">
          <div class="phone-status"></div>
          <div class="phone-body">
            <span class="mini-pin">${escapeHtml(snapshot.pin)}</span>
            <h3>${escapeHtml(activeActivity?.title || "等待講者開啟下一題...")}</h3>
            ${renderPhonePreview(activeActivity)}
          </div>
        </div>
      </section>
    </aside>
  `;
}

function renderPhonePreview(activeActivity) {
  if (!activeActivity) return `<div class="mini-wait">${icon("check")}等待中</div>`;
  if (activeActivity.type === "danmaku") return `<div class="mini-input">發表想法...</div>`;
  if (activeActivity.type === "wordcloud") return `<div class="mini-input">輸入一個詞...</div>`;
  return (activeActivity.options || [])
    .slice(0, 3)
    .map((option) => `<div class="mini-choice" style="border-color:${attr(option.color)}">${escapeHtml(option.text)}</div>`)
    .join("");
}

function renderAudience() {
  const snapshot = state.snapshot;
  if (!state.joined || !snapshot) {
    return `
      <main class="audience-shell">
        <form class="join-card" data-form="join-participant">
          <span class="audience-brand">互動堂 Live</span>
          <h1>${state.closed ? "房間已關閉" : "輸入 PIN 加入互動"}</h1>
          <label class="field"><span>Room PIN</span><input name="pin" value="${attr(state.route.pin || "")}" maxlength="6" placeholder="ABC123" /></label>
          <label class="field"><span>姓名</span><input name="name" maxlength="18" placeholder="例如：小安" autocomplete="name" required /></label>
          <button class="primary-action" ${state.connected ? "" : "disabled"}>${icon("login")}立即加入</button>
          ${state.connected ? "" : `<span class="status-line">正在連接即時伺服器...</span>`}
          ${messageLine()}
        </form>
      </main>
    `;
  }

  const activeActivity = getActiveActivity(snapshot);
  return `
    <main class="audience-shell">
      <section class="audience-card">
        <header class="audience-header">
          <span class="mini-pin">${escapeHtml(snapshot.pin)}</span>
          <span>${icon("users")}${snapshot.participants.length}</span>
        </header>
        ${
          !activeActivity
            ? renderWaitingState()
            : activeActivity.type === "choice"
              ? renderChoiceAnswer(snapshot, activeActivity)
              : activeActivity.type === "danmaku"
                ? renderDanmakuAnswer(activeActivity)
                : renderWordAnswer(activeActivity)
        }
        ${activeActivity ? `<div class="audience-results">${renderActivityResults(activeActivity, true)}</div>` : ""}
        ${messageLine()}
      </section>
    </main>
  `;
}

function renderWaitingState() {
  return `
    <div class="waiting-state">
      <div class="waiting-icon">${icon("cloud")}</div>
      <h1>等待講者開啟下一題...</h1>
      <p>請保持這個頁面開啟，題目會自動出現。</p>
    </div>
  `;
}

function renderChoiceAnswer(snapshot, activity) {
  const activityKey = `${activity.id}:${activity.responseVersion}`;
  const answered = state.answers[activityKey]?.answered;
  const selected = state.selectedAnswers[activityKey] || [];
  return `
    <div class="answer-block">
      <div class="answer-type">${icon("bar")}${activity.mode === "multiple" ? "可複選" : "單選題"}</div>
      <h1>${escapeHtml(activity.title)}</h1>
      <div class="answer-options">
        ${activity.options
          .map(
            (option) => `
              <button class="answer-option ${selected.includes(option.id) ? "selected" : ""}" data-action="select-answer" data-id="${attr(option.id)}" style="--option-color:${attr(option.color)}">
                <span>${escapeHtml(option.text)}</span>${selected.includes(option.id) ? icon("check") : ""}
              </button>
            `
          )
          .join("")}
      </div>
      <button class="primary-action full-width" data-action="submit-choice" ${selected.length && !answered ? "" : "disabled"}>${icon("send")}${answered ? "已作答" : "送出答案"}</button>
    </div>
  `;
}

function renderWordAnswer(activity) {
  return `
    <form class="answer-block" data-form="submit-word">
      <div class="answer-type">${icon("cloud")}文字雲</div>
      <h1>${escapeHtml(activity.title)}</h1>
      <label class="field"><span>輸入 15 字以內</span><input name="word" maxlength="15" placeholder="例如：有趣" /></label>
      <div class="remaining-row"><span data-remaining>15 字可用</span>${state.lastSentWord ? `<strong>「${escapeHtml(state.lastSentWord)}」已送出</strong>` : ""}</div>
      <button class="primary-action full-width">${icon("send")}送出文字</button>
    </form>
  `;
}

function renderDanmakuAnswer(activity) {
  return `
    <form class="answer-block" data-form="submit-danmaku">
      <div class="answer-type">${icon("message")}彈幕</div>
      <h1>${escapeHtml(activity.title)}</h1>
      <label class="field"><span>輸入 40 字以內</span><input name="danmaku" maxlength="40" placeholder="例如：我希望AI幫我整理靈感" /></label>
      <div class="remaining-row"><span data-remaining>40 字可用</span>${state.lastSentDanmaku ? `<strong>「${escapeHtml(state.lastSentDanmaku)}」已送出</strong>` : ""}</div>
      <button class="primary-action full-width">${icon("send")}送出想法</button>
    </form>
  `;
}

function renderScreen() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return `
      <main class="screen-shell setup">
        <form class="join-card" data-form="join-screen">
          ${icon("monitor", 34)}
          <h1>${state.closed ? "房間已關閉" : "開啟投影模式"}</h1>
          <label class="field"><span>Room PIN</span><input name="pin" value="${attr(state.route.pin || "")}" maxlength="6" placeholder="ABC123" /></label>
          <button class="primary-action" ${state.connected ? "" : "disabled"}>開始投影</button>
          ${messageLine()}
        </form>
      </main>
    `;
  }

  const activeActivity = getActiveActivity(snapshot);
  const activeMeta = getActivityMeta(activeActivity);
  return `
    <main class="screen-shell">
      <aside class="screen-join-panel">
        <span>加入互動</span>
        <strong>${escapeHtml(snapshot.pin)}</strong>
        ${qrImg(joinUrl(snapshot.pin), 220, `加入房間 ${snapshot.pin} 的 QR Code`, "")}
        <div class="screen-count">${icon("users")}${snapshot.participants.length} 人在線</div>
      </aside>
      <section class="screen-content">
        ${
          activeActivity
            ? `
              <div class="screen-type">${activeMeta.label}</div>
              <h1>${escapeHtml(activeActivity.title)}</h1>
              ${renderSpotlight(snapshot.spotlight)}
              ${renderActivityResults(activeActivity)}
            `
            : `
              <div class="screen-waiting">
                ${icon("cloud", 74)}
                <h1>等待講者開啟下一題...</h1>
                <p>掃描 QR Code 或輸入 PIN 即可加入。</p>
              </div>
            `
        }
      </section>
    </main>
  `;
}

function renderActivityResults(activity, compact = false) {
  if (!activity) return `<div class="empty-results">${icon("cloud", 30)}<p>等待講者開啟下一題...</p></div>`;
  if (!activity.showResults) return `<div class="empty-results">${icon("eye-off", 30)}<p>結果目前由講者隱藏</p></div>`;
  if (activity.type === "choice") return renderChoiceResults(activity, compact);
  if (activity.type === "danmaku") return renderDanmaku(activity.messages, compact);
  return renderWordCloud(activity.words, compact, activity.summary);
}

function renderChoiceResults(activity, compact = false) {
  const total = activity.mode === "multiple" ? activity.voteCount : activity.responseCount;
  return `
    <div class="choice-results ${compact ? "compact" : ""}">
      <div class="result-meta"><span>${icon("bar")} ${activity.responseCount} 人已作答</span><span>${activity.mode === "multiple" ? "多選" : "單選"}</span></div>
      <div class="choice-grid">
        <div class="pie-wrap" aria-hidden="true">
          <div class="pie-chart" style="background:${attr(buildPieGradient(activity.options, total) || "#edf1f7")}"></div>
          <strong>${activity.responseCount}</strong><span>回覆</span>
        </div>
        <div class="bar-list">
          ${activity.options
            .map((option) => {
              const optionPercent = percent(option.count, total);
              return `
                <div class="bar-row">
                  <div class="bar-row-label"><span>${escapeHtml(option.text)}</span><strong>${option.count}</strong></div>
                  <div class="bar-track"><div class="bar-fill" style="width:${optionPercent}%;background:${attr(option.color)}"></div></div>
                  <span class="bar-percent">${optionPercent}%</span>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    </div>
  `;
}

function renderWordCloud(words = [], compact = false, summary = null) {
  if (!words.length) return `<div class="empty-results">${icon("cloud", 30)}<p>文字會在觀眾送出後即時浮現</p></div>`;
  const colors = ["#159e97", "#2d8bd7", "#f5a524", "#ff6f61", "#3d4758", "#7c6ee6"];
  const topCount = Math.max(...words.map((word) => word.count), 1);
  return `
    <div class="word-result-stack ${compact ? "compact" : ""} ${summary ? "has-summary" : ""}">
      ${renderWordSummary(summary, compact)}
      <div class="word-cloud ${compact ? "compact" : ""}">
        ${words
          .slice(0, compact ? 18 : 40)
          .map((word, index) => {
            const weight = word.count / topCount;
            const size = compact ? 17 + weight * 26 : 21 + weight * 40;
            return `<span class="cloud-word" style="color:${colors[index % colors.length]};font-size:${size}px">${escapeHtml(word.text)}${word.count > 1 ? `<small>${word.count}</small>` : ""}</span>`;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderWordSummary(summary, compact = false) {
  if (!summary) return "";
  const topWords = (summary.topWords || []).slice(0, compact ? 3 : 5);
  return `
    <section class="ai-summary ${compact ? "compact" : ""}">
      <div class="summary-kicker">${icon("sparkles")}AI 總結<span>${escapeHtml(summary.model || "摘要")}</span></div>
      <p>${escapeHtml(summary.text)}</p>
      ${
        topWords.length
          ? `<div class="summary-tags">${topWords
              .map((word) => `<span>${escapeHtml(word.text)}${word.count > 1 ? ` × ${word.count}` : ""}</span>`)
              .join("")}</div>`
          : ""
      }
    </section>
  `;
}

function renderSpotlight(spotlight, compact = false) {
  if (!spotlight) return "";
  const answerItems = (spotlight.answerItems || []).slice(0, compact ? 4 : 8);
  return `
    <section class="spotlight-card ${compact ? "compact" : ""}">
      <div class="spotlight-kicker">${icon("ticket")}抽籤結果</div>
      <div class="spotlight-name">${escapeHtml(spotlight.participantName)}</div>
      <p>${escapeHtml(spotlight.answerText)}</p>
      ${
        answerItems.length > 1
          ? `<div class="spotlight-tags">${answerItems
              .map((item) => `<span>${escapeHtml(item)}</span>`)
              .join("")}</div>`
          : ""
      }
    </section>
  `;
}

function renderDanmaku(messages = [], compact = false) {
  if (!messages.length) return `<div class="empty-results">${icon("message", 30)}<p>想法會在觀眾送出後即時飄過</p></div>`;
  const colors = ["#159e97", "#2d8bd7", "#f5a524", "#ff6f61", "#3d4758", "#7c6ee6"];
  const visibleMessages = messages.slice(-(compact ? 14 : 36));
  const laneCount = compact ? 5 : 9;
  return `
    <div class="danmaku-stage ${compact ? "compact" : ""}" aria-live="polite">
      ${visibleMessages
        .map((message, index) => {
          const lane = index % laneCount;
          const laneTop = laneCount === 1 ? 0 : Math.round((lane / (laneCount - 1)) * 78);
          const duration = compact ? 10 + (index % 4) * 1.2 : 15 + (index % 6) * 1.4;
          const delay = -1 * (index % laneCount) * (compact ? 0.9 : 1.15);
          return `
            <span class="danmaku-item" style="--lane-top:${laneTop}%;--duration:${duration}s;--delay:${delay}s;--text-color:${colors[index % colors.length]}">
              ${escapeHtml(message.text)}
            </span>
          `;
        })
        .join("")}
    </div>
  `;
}

async function handleClick(event) {
  primeAudio();
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const snapshot = state.snapshot;
  const selectedActivity = getSelectedActivity();

  if (action === "create-room") {
    const response = await request("host:create-room");
    if (response.snapshot?.pin) window.localStorage.setItem("interaction-live-pin", response.snapshot.pin);
  }
  if (!snapshot) return;

  if (action === "copy-link") {
    await navigator.clipboard.writeText(button.dataset.value);
    state.error = "加入連結已複製。";
    render();
    setTimeout(() => {
      state.error = "";
      render();
    }, 1200);
  } else if (action === "go-waiting") {
    await request("host:go-waiting", { pin: snapshot.pin });
  } else if (action === "reset-room") {
    await request("host:reset-room", { pin: snapshot.pin });
  } else if (action === "close-room") {
    await request("host:close-room", { pin: snapshot.pin });
    window.localStorage.removeItem("interaction-live-pin");
  } else if (action === "select-activity") {
    state.selectedActivityId = button.dataset.id;
    render();
  } else if (action === "set-mode") {
    await request("host:update-activity", {
      pin: snapshot.pin,
      activityId: selectedActivity.id,
      patch: { mode: button.dataset.mode }
    });
  } else if (action === "add-option") {
    const options = selectedActivity.options || [];
    if (options.length < 5) {
      await request("host:update-activity", {
        pin: snapshot.pin,
        activityId: selectedActivity.id,
        patch: {
          options: [
            ...options,
            {
              id: `opt-${Date.now()}`,
              text: `選項 ${options.length + 1}`,
              color: ["#159e97", "#2d8bd7", "#f5a524", "#ff6f61", "#7c6ee6"][options.length % 5]
            }
          ]
        }
      });
    }
  } else if (action === "remove-option") {
    await request("host:update-activity", {
      pin: snapshot.pin,
      activityId: selectedActivity.id,
      patch: { options: selectedActivity.options.filter((option) => option.id !== button.dataset.id) }
    });
  } else if (action === "publish-activity") {
    await request("host:publish-activity", { pin: snapshot.pin, activityId: button.dataset.id });
  } else if (action === "draw-participant") {
    await request("host:draw-participant", { pin: snapshot.pin, activityId: button.dataset.id });
  } else if (action === "clear-draw") {
    await request("host:clear-draw", { pin: snapshot.pin });
  } else if (action === "summarize-wordcloud") {
    state.summarizingActivityId = button.dataset.id;
    render();
    await request("host:summarize-wordcloud", { pin: snapshot.pin, activityId: button.dataset.id });
    state.summarizingActivityId = "";
    render();
  } else if (action === "toggle-results") {
    await request("host:toggle-results", { pin: snapshot.pin, activityId: button.dataset.id });
  } else if (action === "clear-responses") {
    await request("host:clear-responses", { pin: snapshot.pin, activityId: button.dataset.id });
  } else if (action === "select-answer") {
    selectAudienceAnswer(button.dataset.id);
  } else if (action === "submit-choice") {
    await submitAudienceChoice();
  }
}

async function handleSubmit(event) {
  primeAudio();
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  const formData = new FormData(form);

  if (form.dataset.form === "join-participant") {
    const pin = String(formData.get("pin") || "").toUpperCase();
    const name = String(formData.get("name") || "").trim();
    if (!name) {
      state.error = "請輸入姓名後再加入。";
      render();
      return;
    }
    const response = await request("participant:join", { pin, name });
    if (response.ok) state.joined = true;
    render();
  }

  if (form.dataset.form === "join-screen") {
    const pin = String(formData.get("pin") || "").toUpperCase();
    await request("screen:join", { pin });
  }

  if (form.dataset.form === "submit-word") {
    const snapshot = state.snapshot;
    const activeActivity = getActiveActivity(snapshot);
    const text = String(formData.get("word") || "").trim();
    const response = await request("participant:submit-word", {
      pin: snapshot.pin,
      activityId: activeActivity.id,
      text
    });
    if (response.ok) {
      state.lastSentWord = response.text;
      queueOrPlayWordChime("participant");
      setTimeout(() => {
        state.lastSentWord = "";
        render();
      }, 1400);
    }
  }

  if (form.dataset.form === "submit-danmaku") {
    const snapshot = state.snapshot;
    const activeActivity = getActiveActivity(snapshot);
    const text = String(formData.get("danmaku") || "").trim();
    const response = await request("participant:submit-danmaku", {
      pin: snapshot.pin,
      activityId: activeActivity.id,
      text
    });
    if (response.ok) {
      state.lastSentDanmaku = response.text;
      queueOrPlayWordChime("participant");
      setTimeout(() => {
        state.lastSentDanmaku = "";
        render();
      }, 1400);
    }
  }
}

async function handleChange(event) {
  const target = event.target.closest("[data-change]");
  if (!target || !state.snapshot) return;
  const activity = getSelectedActivity();
  if (!activity) return;

  if (target.dataset.change === "activity-title") {
    await request("host:update-activity", {
      pin: state.snapshot.pin,
      activityId: activity.id,
      patch: { title: target.value }
    });
  }

  if (target.dataset.change === "option-text" || target.dataset.change === "option-color") {
    const options = activity.options.map((option) =>
      option.id === target.dataset.id
        ? {
            ...option,
            [target.dataset.change === "option-text" ? "text" : "color"]: target.value
          }
        : option
    );
    await request("host:update-activity", {
      pin: state.snapshot.pin,
      activityId: activity.id,
      patch: { options }
    });
  }
}

function handleInput(event) {
  if (event.target.name === "word") {
    const remaining = event.target.closest("form")?.querySelector("[data-remaining]");
    if (remaining) remaining.textContent = `${15 - event.target.value.length} 字可用`;
  }
  if (event.target.name === "danmaku") {
    const remaining = event.target.closest("form")?.querySelector("[data-remaining]");
    if (remaining) remaining.textContent = `${40 - event.target.value.length} 字可用`;
  }
  if (event.target.name === "pin") {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  }
}

function selectAudienceAnswer(optionId) {
  const snapshot = state.snapshot;
  const activity = getActiveActivity(snapshot);
  const key = `${activity.id}:${activity.responseVersion}`;
  if (state.answers[key]?.answered) return;
  const selected = state.selectedAnswers[key] || [];
  if (activity.mode === "single") state.selectedAnswers[key] = [optionId];
  else {
    state.selectedAnswers[key] = selected.includes(optionId)
      ? selected.filter((id) => id !== optionId)
      : [...selected, optionId];
  }
  render();
}

async function submitAudienceChoice() {
  const snapshot = state.snapshot;
  const activity = getActiveActivity(snapshot);
  const key = `${activity.id}:${activity.responseVersion}`;
  const selected = state.selectedAnswers[key] || [];
  const response = await request("participant:answer-choice", {
    pin: snapshot.pin,
    activityId: activity.id,
    optionIds: selected
  });
  if (response.ok) state.answers[key] = { answered: true, selected: response.selected };
  render();
}

function ensureSelectedActivity() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const exists = snapshot.activities.some((activity) => activity.id === state.selectedActivityId);
  if (!exists) state.selectedActivityId = snapshot.currentActivityId || snapshot.activities[0]?.id || "";
}

function getSelectedActivity() {
  return state.snapshot?.activities.find((activity) => activity.id === state.selectedActivityId) || null;
}

function getActiveActivity(snapshot) {
  if (!snapshot) return null;
  return snapshot.activities.find((activity) => activity.id === snapshot.currentActivityId) || null;
}

function getRoute() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "join") return { view: "participant", pin: parts[1] || "" };
  if (parts[0] === "screen") return { view: "screen", pin: parts[1] || "" };
  return { view: "presenter", pin: "" };
}

function joinUrl(pin) {
  return `${window.location.origin}/join/${pin}`;
}

function screenUrl(pin) {
  return `${window.location.origin}/screen/${pin}`;
}

function renderQrImages() {
  document.querySelectorAll("[data-qr]").forEach((image) => {
    image.src = `/qr.svg?data=${encodeURIComponent(image.dataset.qr)}`;
  });
}

function qrImg(value, size, alt, className) {
  return `<img class="${attr(className)}" data-qr="${attr(value)}" data-qr-size="${size}" alt="${attr(alt)}" />`;
}

function buildPieGradient(options, total) {
  if (!total) return "";
  let start = 0;
  const stops = options
    .filter((option) => option.count > 0)
    .map((option) => {
      const share = (option.count / total) * 360;
      const end = start + share;
      const segment = `${option.color} ${start}deg ${end}deg`;
      start = end;
      return segment;
    });
  return `conic-gradient(${stops.join(", ")})`;
}

function percent(value, total) {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

function messageLine() {
  return state.error ? `<span class="error-line">${escapeHtml(state.error)}</span>` : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function attr(value) {
  return escapeHtml(value);
}

function icon(name, size = 18) {
  const common = `class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    sparkles: '<path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7Z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z"/><path d="M5 13l.7 1.8L7.5 15.5l-1.8.7L5 18l-.7-1.8-1.8-.7 1.8-.7Z"/>',
    ticket: '<path d="M3 9a3 3 0 1 0 0 6v3h18v-3a3 3 0 1 0 0-6V6H3Z"/><path d="M9 6v12"/>',
    message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/>',
    cloud: '<path d="M17.5 19H7a5 5 0 1 1 1.1-9.88A7 7 0 0 1 21 12.5 4.5 4.5 0 0 1 17.5 19Z"/>',
    bar: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/>',
    x: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    radio: '<path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M10.6 13.4a2 2 0 0 1 0-2.8M13 12h7"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    "eye-off": '<path d="m2 2 20 20"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 10 8 10 8a14.2 14.2 0 0 1-3.2 4.6"/><path d="M6.5 6.5C3.6 8.4 2 12 2 12s3 8 10 8a10.5 10.5 0 0 0 4.1-.8"/>'
  };
  return `<svg ${common}>${paths[name] || ""}</svg>`;
}
