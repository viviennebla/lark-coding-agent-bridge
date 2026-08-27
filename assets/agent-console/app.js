const DEFAULT_API_BASE =
  window.location.protocol === "http:" || window.location.protocol === "https:"
    ? window.location.origin
    : "http://127.0.0.1:1313";
const MAX_EVENTS = 240;
const COMPOSER_MIN_HEIGHT = 44;
const COMPOSER_MAX_HEIGHT = 156;
const PRIORITY_SKILLS = [
  "orchestrator-agent",
  "coding-agent",
  "investigator-agent",
  "review-agent",
  "fixit",
  "plan",
  "explain",
  "whatsnext",
  "computer-use",
  "control-chrome",
  "control-in-app-browser",
];

const els = {
  apiBaseInput: document.querySelector("#apiBaseInput"),
  clearSkillButton: document.querySelector("#clearSkillButton"),
  commandHint: document.querySelector("#commandHint"),
  connectButton: document.querySelector("#connectButton"),
  connectionStatus: document.querySelector("#connectionStatus"),
  eventStream: document.querySelector("#eventStream"),
  filterButtons: Array.from(document.querySelectorAll("[data-filter]")),
  form: document.querySelector("#messageForm"),
  lastEventLabel: document.querySelector("#lastEventLabel"),
  messageInput: document.querySelector("#messageInput"),
  profileLabel: document.querySelector("#profileLabel"),
  quickActions: document.querySelector(".quick-actions"),
  refreshButton: document.querySelector("#refreshButton"),
  reloadSkillsButton: document.querySelector("#reloadSkillsButton"),
  selectedSkillLabel: document.querySelector("#selectedSkillLabel"),
  sendButton: document.querySelector("#sendButton"),
  settingsSummary: document.querySelector("#settingsSummary"),
  skillCount: document.querySelector("#skillCount"),
  skillList: document.querySelector("#skillList"),
  skillSearch: document.querySelector("#skillSearch"),
  taskStatus: document.querySelector("#taskStatus"),
  threadId: document.querySelector("#threadId"),
  workspaceLabel: document.querySelector("#workspaceLabel"),
};

const commandCatalog = [
  { name: "/interrupt", detail: "打断当前运行，语义和 CLI 输入打断命令一致" },
  { name: "/status", detail: "查看当前 session 状态" },
  { name: "/continue", detail: "基于当前 thread 继续发送" },
  { name: "/skills", detail: "查看 skill 摘要或搜索结果" },
  { name: "/skills doc", detail: "按关键词搜索 skills" },
  { name: "/help", detail: "查看可用命令" },
];

const state = {
  apiBase: initialApiBase(),
  eventSource: null,
  events: [],
  filter: "message",
  lastServerEventId: "",
  localMessageSeq: 0,
  pendingAssistant: null,
  seenEventKeys: new Set(),
  selectedSkill: null,
  skillRequestSeq: 0,
  skills: [],
  token: "",
};

function initialApiBase() {
  const saved = localStorage.getItem("agentConsole.apiBase");
  if (!saved || saved === "http://127.0.0.1:1313" || saved === "http://localhost:1313") {
    return DEFAULT_API_BASE;
  }
  return saved;
}

function normalizeBaseUrl(value) {
  return (value || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
}

function apiUrl(path, query) {
  const url = new URL(path, normalizeBaseUrl(state.apiBase));
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
  }
  return url.toString();
}

function setConnectionStatus(text, tone = "neutral") {
  els.connectionStatus.textContent = text;
  els.connectionStatus.dataset.tone = tone;
}

async function requestJson(path, options = {}) {
  const { authHeader = true, headers: optionHeaders = {}, ...fetchOptions } = options;
  const headers = { ...optionHeaders };
  if (fetchOptions.body && !headers["content-type"]) headers["content-type"] = "application/json";
  if (state.token && authHeader) headers["x-agent-console-token"] = state.token;

  const response = await fetch(apiUrl(path), {
    headers,
    ...fetchOptions,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function loadState() {
  try {
    const data = await requestJson("/api/state");
    state.token = data?.api?.token || state.token;
    renderState(data || {});
    mergeSnapshotEvents(data?.events);
    setConnectionStatus("已连接", "ok");
    return data;
  } catch (error) {
    setConnectionStatus("连接失败", "bad");
    appendLocalEvent("system.notice", `状态拉取失败：${error.message}`, "error");
    throw error;
  }
}

async function loadSkills() {
  const query = els.skillSearch.value.trim();
  const requestSeq = ++state.skillRequestSeq;
  try {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (state.token) params.set("token", state.token);
    const data = await requestJson(`/api/skills${params.size ? `?${params.toString()}` : ""}`, { authHeader: false });
    if (query !== els.skillSearch.value.trim()) return;
    if (requestSeq !== state.skillRequestSeq) return;
    state.skills = normalizeSkills(data);
    renderSkills();
  } catch (error) {
    if (query !== els.skillSearch.value.trim()) return;
    if (requestSeq !== state.skillRequestSeq) return;
    appendLocalEvent("system.notice", `Skill 拉取失败：${error.message}`, "error");
    state.skills = [];
    renderSkills();
  }
}

function normalizeSkills(data) {
  const raw = Array.isArray(data) ? data : data?.skills || data?.items || data?.data || [];
  return raw.map((item, index) => {
    if (typeof item === "string") {
      return { id: item, name: item, source: "unknown", description: "" };
    }

    const name = item.name || item.id || item.key || item.skill || `skill-${index + 1}`;
    return {
      ...item,
      id: item.id || name,
      name,
      source: item.source || item.origin || item.provider || "unknown",
      description: item.description || item.summary || item.detail || "",
    };
  });
}

function renderState(data) {
  const session = data.session || data.currentSession || {};
  const task = data.task || data.currentTask || data.current || {};
  const settings = data.settings || data.config || data.bridge || {};

  const taskStatus = task.status || data.status || session.status || "idle";
  setTaskStatus(taskStatus);
  els.threadId.textContent = session.threadId || task.threadId || data.threadId || "-";
  els.profileLabel.textContent =
    settings.profile || settings.bridgeProfile || data.profile || data.bridgeProfile || "-";
  els.workspaceLabel.textContent =
    data.workspace || settings.workspace || session.workspace || "Workspace unknown";

  const summary = [
    ["API", state.apiBase],
    ["Workspace", data.workspace || settings.workspace || "-"],
    ["Bridge profile", settings.profile || settings.bridgeProfile || data.profile || "-"],
    ["Codex", settings.codexBinary || settings.codexPath || "-"],
    ["lark-cli", settings.larkCliBinary || settings.larkCliPath || "-"],
    ["通知目标", settings.notificationChat || settings.chatId || data.chatId || "-"],
    ["最近任务", task.prompt || task.taskId || data.lastTask || "-"],
  ];

  els.settingsSummary.innerHTML = summary
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd title="${escapeAttr(String(value))}">${escapeHtml(String(value))}</dd>`)
    .join("");
}

function renderSkills() {
  const query = els.skillSearch.value.trim();
  const total = state.skills.length;
  const sortedSkills = sortedSkillList(state.skills);
  els.skillCount.textContent = query ? `${total} results` : `${total} loaded`;

  if (!total) {
    els.skillList.innerHTML = `<div class="empty-state">暂无 skill 数据</div>`;
    return;
  }

  els.skillList.innerHTML = sortedSkills
    .map((skill) => {
      const active = state.selectedSkill?.name === skill.name;
      return `
        <button class="skill-card${active ? " active" : ""}" type="button" data-skill="${escapeAttr(skill.name)}">
          <span class="skill-name">${escapeHtml(skill.name)}</span>
          <span class="skill-source">${escapeHtml(skill.source)}</span>
          ${skill.description ? `<span class="skill-description">${escapeHtml(skill.description)}</span>` : ""}
        </button>
      `;
    })
    .join("");
}

function sortedSkillList(skills) {
  return skills
    .map((skill, index) => ({ skill, index, priority: skillPriority(skill) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => item.skill);
}

function skillPriority(skill) {
  const name = String(skill.name || "").toLowerCase();
  const source = String(skill.source || "").toLowerCase();
  const exactIndex = PRIORITY_SKILLS.findIndex((item) => item === name);
  if (exactIndex >= 0) return exactIndex;
  const partialIndex = PRIORITY_SKILLS.findIndex((item) => name.includes(item));
  if (partialIndex >= 0) return partialIndex + 20;
  if (source.includes("user") || source.includes("custom")) return 50;
  if (source.includes("codex")) return 70;
  return 90;
}

function connectEvents() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const eventQuery = {};
  if (state.token) eventQuery.token = state.token;
  if (state.lastServerEventId) eventQuery.after = state.lastServerEventId;
  const source = new EventSource(apiUrl("/api/events", eventQuery));
  state.eventSource = source;
  setConnectionStatus("已连接", "ok");

  source.onopen = () => setConnectionStatus("已连接", "ok");
  source.onerror = () => setConnectionStatus("事件断开", "warn");

  [
    "message.user",
    "message.assistant.delta",
    "message.assistant.final",
    "task.started",
    "task.status",
    "task.usage",
    "task.completed",
    "task.failed",
    "task.interrupted",
    "tool.started",
    "tool.output",
    "tool.completed",
    "tool.failed",
    "skill.selected",
    "artifact.created",
    "notification.requested",
    "notification.sent",
    "notification.failed",
    "permission.required",
    "auth.required",
    "confirmation.required",
    "system.notice",
  ].forEach((type) => {
    source.addEventListener(type, (event) => appendEvent({ ...parseEventData(event.data), type }));
  });

  source.onmessage = (event) => appendEvent(parseEventData(event.data));
}

function parseEventData(value) {
  try {
    const parsed = JSON.parse(value);
    return {
      id: parsed.id,
      type: parsed.type || parsed.event || "message",
      text: parsed.text || parsed.message || parsed.content || parsed.delta || parsed.summary || "",
      timestamp: parsed.timestamp || parsed.time || parsed.createdAt || new Date().toISOString(),
      runId: parsed.runId,
      scope: parsed.scope,
      payload: parsed,
    };
  } catch {
    return {
      type: "message",
      text: value,
      timestamp: new Date().toISOString(),
      payload: { raw: value },
    };
  }
}

function appendLocalEvent(type, text, tone = "info") {
  appendEvent({
    type,
    text,
    timestamp: new Date().toISOString(),
    payload: { tone },
  });
}

function appendEvent(event) {
  applyMirrorNotification(event);
  removeOptimisticUserEcho(event);
  if (!markEventSeen(event)) return;
  rememberServerEvent(event);
  applyRealtimeStatus(event);
  ingestConsoleEvent(event);

  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  renderEvents();
}

function mergeSnapshotEvents(events) {
  if (!Array.isArray(events) || !events.length) return;

  let changed = false;
  [...events].sort(compareSnapshotEvents).forEach((item) => {
    const event = {
      id: item.id,
      type: item.type || item.event || "message",
      text: item.text || item.message || item.content || item.delta || item.summary || "",
      timestamp: item.timestamp || item.time || item.createdAt || new Date().toISOString(),
      runId: item.runId,
      scope: item.scope,
      payload: item,
    };

    if (!markEventSeen(event)) return;
    rememberServerEvent(event);
    applyMirrorNotification(event);
    removeOptimisticUserEcho(event);
    ingestConsoleEvent(event);
    changed = true;
  });

  if (!changed) return;
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  renderEvents();
}

function compareSnapshotEvents(left, right) {
  return (
    eventSortMillis(left) - eventSortMillis(right) ||
    eventSortPosition(left) - eventSortPosition(right) ||
    eventSortTypeRank(left) - eventSortTypeRank(right)
  );
}

function eventSortMillis(event) {
  const value = event?.timestamp || event?.time || event?.createdAt || "";
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function eventSortPosition(event) {
  const value = event?.event?.messagePosition || event?.messagePosition || event?.event?.message_position;
  const position = Number(value);
  return Number.isFinite(position) ? position : Number.MAX_SAFE_INTEGER;
}

function eventSortTypeRank(event) {
  const type = event?.type || event?.event || "";
  if (type === "message.user") return 10;
  if (String(type).startsWith("message.assistant")) return 20;
  if (String(type).startsWith("message.")) return 30;
  if (type === "task.started") return 40;
  if (type === "task.completed" || type === "task.failed" || type === "task.interrupted") return 90;
  return 50;
}

function markEventSeen(event) {
  const key = eventKey(event);
  if (state.seenEventKeys.has(key)) return false;
  state.seenEventKeys.add(key);
  return true;
}

function rememberServerEvent(event) {
  const id = event.id || event.payload?.id;
  if (id) state.lastServerEventId = id;
}

function eventKey(event) {
  if (event.id) return `id:${event.id}`;
  const payloadId = event.payload?.id;
  if (payloadId) return `id:${payloadId}`;
  return [event.timestamp || "", event.type || "", event.text || ""].join("|");
}

function applyRealtimeStatus(event) {
  if (event.type === "task.started") {
    setTaskStatus("running");
    return;
  }

  if (event.type === "task.completed" || event.type === "task.interrupted") {
    setTaskStatus("idle");
    loadState().catch(() => null);
    return;
  }

  if (event.type === "task.failed") {
    setTaskStatus("failed");
    window.setTimeout(() => loadState().catch(() => null), 800);
  }
}

function setTaskStatus(status) {
  els.taskStatus.textContent = status;
  els.taskStatus.dataset.status = status;
}

function normalizeEvent(event) {
  if (event.type === "task.usage") {
    const usage = event.payload?.usage || event.payload || {};
    const total = usage.total_tokens || usage.totalTokens || usage.total || "";
    const input = usage.input_tokens || usage.prompt_tokens || usage.inputTokens || "";
    const output = usage.output_tokens || usage.completion_tokens || usage.outputTokens || "";
    return {
      ...event,
      text: event.text || [`input ${input || "-"}`, `output ${output || "-"}`, total ? `total ${total}` : ""].filter(Boolean).join(" / "),
    };
  }
  return event;
}

function ingestConsoleEvent(event) {
  if (event.type === "notification.sent" || event.type === "notification.failed") {
    applyMirrorNotification(event);
  }
  if (event.type === "message.assistant.delta") {
    mergeAssistantDelta(event);
    return;
  }
  if (event.type === "message.assistant.final") {
    mergeAssistantFinal(event);
    return;
  }

  state.events.push(normalizeEvent(event));
}

function appendOptimisticUserMessage(input) {
  const localId = `local-user-${++state.localMessageSeq}`;
  const event = normalizeEvent({
    id: localId,
    type: "message.user",
    text: input.text,
    timestamp: new Date().toISOString(),
    source: "web",
    payload: {
      id: localId,
      localPending: true,
      mirrorStatus: input.mirrorStatus || "pending",
      skill: input.skill,
    },
  });
  state.seenEventKeys.add(`id:${localId}`);
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  renderEvents();
  return localId;
}

function updateOptimisticUserMessage(localId, patch) {
  const target = state.events.find((event) => event.id === localId);
  if (!target) return;
  target.runId = patch.runId || target.runId;
  target.scope = patch.scope || target.scope;
  target.payload = { ...(target.payload || {}), ...patch };
  renderEvents();
}

function removeOptimisticUserEcho(event) {
  if (event.type !== "message.user" || event.id?.startsWith("local-user-")) return;
  const text = String(event.text || "").trim();
  const index = state.events.findIndex(
    (item) =>
      item.type === "message.user" &&
      (item.payload?.localPending || item.id?.startsWith("local-user-")) &&
      String(item.text || "").trim() === text &&
      (!item.runId || !event.runId || item.runId === event.runId),
  );
  if (index < 0) return;
  state.seenEventKeys.delete(`id:${state.events[index].id}`);
  state.events.splice(index, 1);
}

function applyMirrorNotification(event) {
  const stage = event.payload?.event?.stage || event.event?.stage;
  if (stage !== "user-message") return;
  const status = event.type === "notification.failed" ? "failed" : "sent";
  const mirrorMessageId = event.payload?.event?.mirrorMessageId || event.event?.mirrorMessageId;
  const target = findUserMirrorTarget(event);
  if (!target) return;
  target.payload = {
    ...(target.payload || {}),
    mirrorStatus: status,
    mirrorMessageId: mirrorMessageId || target.payload?.mirrorMessageId,
  };
}

function findUserMirrorTarget(event) {
  if (event.runId) {
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const candidate = state.events[index];
      if (candidate.type === "message.user" && candidate.runId === event.runId) return candidate;
    }
  }
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const candidate = state.events[index];
    if (candidate.type === "message.user" && candidate.payload?.localPending) return candidate;
  }
  return null;
}

function mergeAssistantDelta(event) {
  const entry = findAssistantStreamEntry(event);
  const target = entry?.event;
  const nextText = event.text || "";
  if (target && target.type !== "message.assistant.final") {
    target.type = "message.assistant.delta";
    target.text = `${target.text || ""}${nextText}`;
    target.timestamp = event.timestamp;
    target.payload = { ...target.payload, ...event.payload };
    moveEventToEnd(entry.index);
    state.pendingAssistant = target;
    return;
  }

  const merged = normalizeEvent({ ...event, text: nextText });
  state.events.push(merged);
  state.pendingAssistant = merged;
}

function mergeAssistantFinal(event) {
  const entry = findAssistantStreamEntry(event);
  const target = entry?.event;
  if (target) {
    target.type = "message.assistant.final";
    target.text = event.text || target.text || "";
    target.timestamp = event.timestamp;
    target.payload = { ...target.payload, ...event.payload };
    moveEventToEnd(entry.index);
    state.pendingAssistant = null;
    return;
  }

  state.pendingAssistant = null;
  state.events.push(normalizeEvent(event));
}

function findAssistantStreamEntry(event) {
  if (event.runId) {
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const candidate = state.events[index];
      if (candidate.runId === event.runId && candidate.type?.startsWith("message.assistant")) {
        return { event: candidate, index };
      }
    }
  }

  const last = state.events[state.events.length - 1];
  if (!event.runId && last?.type?.startsWith("message.assistant")) {
    return { event: last, index: state.events.length - 1 };
  }
  return null;
}

function moveEventToEnd(index) {
  if (index < 0 || index === state.events.length - 1) return;
  const [event] = state.events.splice(index, 1);
  state.events.push(event);
}

function renderEvents() {
  const visible = state.events.filter((event) => filterEvent(event, state.filter));

  if (!visible.length) {
    els.eventStream.innerHTML = `<div class="empty-state">事件会显示在这里</div>`;
    els.lastEventLabel.textContent = "等待事件";
    return;
  }

  els.eventStream.innerHTML = visible.map(renderEvent).join("");
  const last = state.events[state.events.length - 1];
  els.lastEventLabel.textContent = `${formatTime(last.timestamp)} · ${eventTitle(last.type)}`;
  els.eventStream.scrollTop = els.eventStream.scrollHeight;
}

function filterEvent(event, filter) {
  if (filter === "all") return true;
  if (filter === "message") return event.type.startsWith("message.") && !isStatusOnlyLarkCardForChat(event);
  if (filter === "work") return event.type.startsWith("task.") || event.type.startsWith("tool.");
  if (filter === "error") return classifyEvent(event.type, event.payload?.tone) === "error";
  return true;
}

function renderEvent(event) {
  const tone = classifyEvent(event.type, event.payload?.tone);
  const role = event.type.startsWith("message.user")
    ? "user"
    : event.type.startsWith("message.assistant")
      ? "assistant"
      : "system";
  const text = event.text || event.payload?.resultSummary || event.payload?.prompt || JSON.stringify(event.payload);
  const isCard = isLarkCardEvent(event, text);

  return `
    <article class="event-item ${role}${isCard ? " card-backed" : ""}" data-tone="${escapeAttr(tone)}">
      <div class="event-meta">
        <span>${escapeHtml(eventTitle(event.type))}</span>
        <time>${escapeHtml(formatTime(event.timestamp))}</time>
      </div>
      <div class="event-body">
        ${renderEventContent(event, text, role, isCard)}
      </div>
    </article>
  `;
}

function renderEventContent(event, text, role, isCard) {
  if (isCard && role === "assistant" && state.filter === "message") {
    return `<div class="markdown-body">${renderMarkdown(cleanLarkCardChatText(text))}</div>`;
  }
  if (isCard) return renderLarkCard(event, text);
  if (role === "system") {
    return `<div class="system-text">${renderMarkdown(text)}</div>`;
  }
  return `<div class="markdown-body">${renderMarkdown(text)}</div>${role === "user" ? renderUserDeliveryStatus(event) : ""}`;
}

function renderUserDeliveryStatus(event) {
  const status = userMirrorStatus(event);
  const localPending = event.payload?.localPending;
  if (!status && !localPending) return "";
  if (status === "failed") {
    const message = event.payload?.error || event.text || "飞书同步失败";
    return `<div class="delivery-status failed" title="${escapeAttr(String(message))}">飞书同步失败</div>`;
  }
  if (status === "sent") {
    return `<div class="delivery-status sent">已同步到飞书</div>`;
  }
  return `<div class="delivery-status pending"><span class="delivery-spinner" aria-hidden="true"></span>同步飞书中</div>`;
}

function userMirrorStatus(event) {
  return event.payload?.mirrorStatus || event.payload?.event?.mirrorStatus || event.event?.mirrorStatus || "";
}

function isLarkCardEvent(event, text) {
  const messageType =
    event.payload?.event?.messageType ||
    event.payload?.messageType ||
    event.payload?.message?.messageType ||
    event.payload?.message?.message_type;
  if (String(messageType || "").toLowerCase() === "interactive") return true;

  const content = String(text || "").trim();
  if (/^<card[\s>]/i.test(content) || /<\/card>$/i.test(content)) return true;
  return /command_\*{0,4}execution|正在调用工具|正在思考|已被中断|终止/.test(content);
}

function renderLarkCard(event, text) {
  const cleaned = stripCardEnvelope(text);
  const messageId = event.payload?.event?.messageId || event.payload?.messageId || "";
  const footer = messageId ? `<div class="card-foot">message ${escapeHtml(shortId(messageId))}</div>` : "";

  return `
    <section class="lark-card-message">
      <div class="card-head">
        <span class="card-label">飞书卡片</span>
        <span>${escapeHtml(cardSummary(cleaned))}</span>
      </div>
      <div class="card-content">${renderCardMarkdown(cleaned)}</div>
      ${footer}
    </section>
  `;
}

function stripCardEnvelope(text) {
  return String(text || "")
    .trim()
    .replace(/^<card[^>]*>/i, "")
    .replace(/<\/card>$/i, "")
    .trim();
}

function isStatusOnlyLarkCardForChat(event) {
  const text = event.text || event.payload?.resultSummary || event.payload?.prompt || "";
  if (!isLarkCardEvent(event, text)) return false;
  return cleanLarkCardChatText(text)
    .replace(/[✅❌⚠️⏹🧠🧰🔎*_`#>\-\s.。…]+/g, "")
    .trim().length === 0;
}

function cleanLarkCardChatText(text) {
  return stripCardEnvelope(text)
    .replace(/\[[^\]]*(?:终止|stop)[^\]]*\]/gi, "")
    .replace(/\bmessage\s+[a-z0-9_.:-]+/gi, "")
    .replace(/>\s*[✅❌⚠️⏹🧠]\s*\*{0,2}command[\s\S]{0,260?}…/gi, "")
    .split(/\r?\n/)
    .filter((line) => !isCardStatusLine(line))
    .join("\n")
    .replace(/(?:正在思考|已被中断|终止|interactive message)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cardSummary(text) {
  const firstUsefulLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^>\s*/, "").replace(/[*_`#]/g, "").trim())
    .find(Boolean);
  if (!firstUsefulLine) return "interactive message";
  return firstUsefulLine.length > 42 ? `${firstUsefulLine.slice(0, 42)}...` : firstUsefulLine;
}

function shortId(value) {
  const text = String(value);
  return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-6)}` : text;
}

function renderCardMarkdown(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const chunks = [];
  let buffered = [];

  const flushBuffer = () => {
    if (!buffered.length) return;
    chunks.push(`<div class="card-markdown">${renderMarkdown(buffered.join("\n"))}</div>`);
    buffered = [];
  };

  lines.forEach((line) => {
    if (isCardStatusLine(line)) {
      flushBuffer();
      chunks.push(`<div class="card-status-line">${renderInlineMarkdown(line.replace(/^>\s*/, "").trim())}</div>`);
      return;
    }
    buffered.push(line);
  });

  flushBuffer();
  return chunks.join("");
}

function isCardStatusLine(line) {
  return /^(>\s*)?[*\s]*(✅|⏹|🧠|🧰|🔎|⚠️)|command_\*{0,4}execution|正在调用工具|正在思考|已被中断|终止/.test(
    line.trim(),
  );
}

function renderMarkdown(value) {
  const lines = normalizeMarkdownSource(value).split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  const flushInlineBlocks = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (code) {
      if (fence) {
        blocks.push(
          `<pre class="code-block"><code${code.lang ? ` data-lang="${escapeAttr(code.lang)}"` : ""}>${escapeHtml(
            code.lines.join("\n"),
          )}</code></pre>`,
        );
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    if (fence) {
      flushInlineBlocks();
      code = { lang: fence[1] || "", lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushInlineBlocks();
      continue;
    }

    const table = readMarkdownTable(lines, index);
    if (table) {
      flushInlineBlocks();
      blocks.push(renderMarkdownTable(table.rows));
      index = table.endIndex;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushInlineBlocks();
      const level = heading[1].length + 2;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const orderedList = Boolean(ordered);
      if (!list || list.ordered !== orderedList) flushList();
      if (!list) list = { ordered: orderedList, items: [] };
      list.items.push((ordered || unordered)[1]);
      continue;
    }

    flushQuote();
    flushList();
    paragraph.push(line);
  }

  if (code) {
    blocks.push(
      `<pre class="code-block"><code${code.lang ? ` data-lang="${escapeAttr(code.lang)}"` : ""}>${escapeHtml(
        code.lines.join("\n"),
      )}</code></pre>`,
    );
  }
  flushInlineBlocks();

  return blocks.join("") || `<p>${escapeHtml(value)}</p>`;
}

function normalizeMarkdownSource(value) {
  const text = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/([^\n`])(```[\w-]+)/g, "$1\n$2")
    .replace(/([^\n`])```(?![\w-])([^\n`])/g, "$1\n```\n$2")
    .replace(/\|(\*\*[^*\n]+\*\*)\|/g, "|\n$1|")
    .replace(/([^\n])(\|[^\n|]*\|[^\n]*\n\|[\s:|-]+\|)/g, "$1\n$2");

  return text.split("\n").flatMap(splitLooseCodeFenceLine).flatMap(splitLooseMarkdownTableLine).join("\n");
}

function splitLooseCodeFenceLine(line) {
  const match = String(line || "").match(/^```([\w-]{1,24})([^\w\s-][^\n]*)$/);
  if (!match) return [line];
  return [`\`\`\`${match[1]}`, match[2]];
}

function splitLooseMarkdownTableLine(line) {
  const parts = [];
  let rest = String(line || "");
  const firstPipe = rest.indexOf("|");

  if (firstPipe > 0 && rest.indexOf("|", firstPipe + 1) > firstPipe) {
    const prefix = rest.slice(0, firstPipe).trimEnd();
    if (prefix) parts.push(prefix);
    rest = rest.slice(firstPipe);
  }

  if (rest.startsWith("|")) {
    const lastPipe = rest.lastIndexOf("|");
    if (lastPipe > 0 && lastPipe < rest.length - 1) {
      const tableRow = rest.slice(0, lastPipe + 1);
      const tail = rest.slice(lastPipe + 1).trimStart();
      parts.push(tableRow);
      if (tail) parts.push(tail);
      return parts;
    }
  }

  parts.push(rest);
  return parts;
}

function readMarkdownTable(lines, startIndex) {
  if (!isMarkdownTableRow(lines[startIndex]) || !isMarkdownTableDivider(lines[startIndex + 1])) return null;

  const rows = [splitMarkdownTableRow(lines[startIndex]), splitMarkdownTableRow(lines[startIndex + 1])];
  let endIndex = startIndex + 1;
  for (let index = startIndex + 2; index < lines.length; index += 1) {
    if (!isMarkdownTableRow(lines[index])) break;
    rows.push(splitMarkdownTableRow(lines[index]));
    endIndex = index;
  }

  return { rows, endIndex };
}

function isMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  return (trimmed.match(/\|/g) || []).length >= 2;
}

function isMarkdownTableDivider(line) {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitMarkdownTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdownTable(rows) {
  const header = rows[0] || [];
  const bodyRows = rows.slice(2);
  const columnCount = Math.max(header.length, ...bodyRows.map((row) => row.length));
  const normalizeRow = (row) =>
    Array.from({ length: columnCount }, (_item, index) => (row[index] === undefined ? "" : row[index]));

  return `
    <div class="markdown-table-wrap">
      <table class="markdown-table">
        <thead>
          <tr>${normalizeRow(header)
            .map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`)
            .join("")}</tr>
        </thead>
        <tbody>
          ${bodyRows
            .map(
              (row) => `
                <tr>${normalizeRow(row)
                  .map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`)
                  .join("")}</tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderInlineMarkdown(value) {
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  let text = String(value || "");
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/gi, (_match, label, url) =>
    stash(`<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`),
  );

  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || "");
}

function eventTitle(type) {
  const titles = {
    "message.user": "你",
    "message.assistant.delta": "Agent",
    "message.assistant.final": "Agent",
    "task.started": "任务开始",
    "task.status": "任务状态",
    "task.usage": "用量",
    "task.completed": "任务完成",
    "task.failed": "任务失败",
    "task.interrupted": "任务已打断",
    "tool.started": "工具开始",
    "tool.output": "工具输出",
    "tool.completed": "工具完成",
    "tool.failed": "工具失败",
    "skill.selected": "Skill",
    "artifact.created": "产物",
    "permission.required": "需要权限",
    "auth.required": "需要授权",
    "confirmation.required": "需要确认",
    "system.notice": "系统",
  };
  return titles[type] || type;
}

function classifyEvent(type, explicitTone) {
  if (explicitTone) return explicitTone;
  if (type.includes("failed") || type.includes("required")) return "error";
  if (type.includes("completed") || type.includes("sent")) return "success";
  if (type.includes("task") || type.includes("tool")) return "work";
  return "info";
}

async function sendMessage(event) {
  event.preventDefault();

  const request = prepareMessageRequest(els.messageInput.value);
  if (!request.text) return;

  els.sendButton.disabled = true;
  els.messageInput.value = "";
  resizeMessageInput();
  updateCommandHint();
  const localId = appendOptimisticUserMessage({
    text: request.displayText,
    skill: request.skill,
    mirrorStatus: request.command ? "" : "pending",
  });

  try {
    const response = await requestJson("/api/message", {
      method: "POST",
      body: JSON.stringify({
        text: request.text,
        skill: request.skill,
        source: "web",
      }),
    });
    updateOptimisticUserMessage(localId, {
      localPending: false,
      runId: response?.runId,
      scope: response?.scope,
      mirrorStatus: response?.mirrorPending ? "pending" : "",
    });
    clearSelectedSkill({ preserveInput: true });
    await loadState().catch(() => null);
  } catch (error) {
    updateOptimisticUserMessage(localId, {
      localPending: false,
      mirrorStatus: "failed",
      error: error.message,
    });
    appendLocalEvent("system.notice", `发送失败：${error.message}`, "error");
  } finally {
    els.sendButton.disabled = false;
    els.messageInput.focus();
  }
}

function prepareMessageRequest(value) {
  const original = String(value || "").trim();
  const skillToken = parseSkillToken(original);
  const selectedSkill = shouldAttachSelectedSkill(original) ? state.selectedSkill?.name : undefined;
  const skill = skillToken?.skill || selectedSkill;
  const text = skillToken ? skillToken.text.trim() : original;
  return {
    command: text.startsWith("/"),
    displayText: skill ? `$${skill} ${text}`.trim() : text,
    skill,
    text,
  };
}

function parseSkillToken(text) {
  const match = String(text || "").trim().match(/^\$([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { skill: match[1], text: match[2] || "" };
}

function shouldAttachSelectedSkill(text) {
  return Boolean(state.selectedSkill?.name && !text.startsWith("/") && !parseSkillToken(text));
}

function selectSkill(skillName) {
  state.selectedSkill = state.skills.find((item) => item.name === skillName) || { name: skillName };
  els.selectedSkillLabel.innerHTML = `已选择 <strong>${escapeHtml(state.selectedSkill.name)}</strong>`;
  els.clearSkillButton.disabled = false;
  insertSkillToken(state.selectedSkill.name);
  renderSkills();
  els.messageInput.focus();
}

function clearSelectedSkill(options = {}) {
  state.selectedSkill = null;
  els.selectedSkillLabel.textContent = "未选择 skill";
  els.clearSkillButton.disabled = true;
  if (!options.preserveInput) {
    els.messageInput.value = removeLeadingSkillToken(els.messageInput.value);
    resizeMessageInput();
    updateCommandHint();
  }
  renderSkills();
}

function insertSkillToken(skillName) {
  const token = `$${skillName}`;
  const text = removeLeadingSkillToken(els.messageInput.value).trimStart();
  els.messageInput.value = `${token}${text ? ` ${text}` : " "}`;
  els.messageInput.selectionStart = els.messageInput.value.length;
  els.messageInput.selectionEnd = els.messageInput.value.length;
  resizeMessageInput();
  updateCommandHint();
}

function removeLeadingSkillToken(value) {
  return String(value || "").replace(/^\s*\$[A-Za-z0-9_.:-]+(?:\s+|$)/, "");
}

function updateCommandHint() {
  const value = els.messageInput.value.trimStart();
  if (!value.startsWith("/")) {
    els.commandHint.hidden = true;
    els.commandHint.innerHTML = "";
    return;
  }

  const query = value.split(/\s+/)[0].toLowerCase();
  const matches = commandCatalog.filter((item) => item.name.toLowerCase().startsWith(query) || query === "/");
  els.commandHint.hidden = false;
  els.commandHint.innerHTML = matches.length
    ? matches
        .map(
          (item) => `
            <button type="button" data-command="${escapeAttr(item.name)}">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.detail)}</span>
            </button>
          `,
        )
        .join("")
    : `<div class="command-empty">未知命令，会按普通消息发送</div>`;
}

function handleMessageInput() {
  resizeMessageInput();
  updateCommandHint();
}

function resizeMessageInput() {
  els.messageInput.style.height = "auto";
  const nextHeight = Math.min(Math.max(els.messageInput.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
  els.messageInput.style.height = `${nextHeight}px`;
  els.messageInput.style.overflowY = els.messageInput.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

function applyCommandTemplate(command) {
  els.messageInput.value = `${command} `;
  els.messageInput.focus();
  els.messageInput.setSelectionRange(els.messageInput.value.length, els.messageInput.value.length);
  handleMessageInput();
}

function setFilter(filter) {
  state.filter = filter;
  els.filterButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  });
  renderEvents();
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

async function reconnect() {
  state.apiBase = normalizeBaseUrl(els.apiBaseInput.value);
  els.apiBaseInput.value = state.apiBase;
  localStorage.setItem("agentConsole.apiBase", state.apiBase);
  state.events = [];
  state.seenEventKeys.clear();
  state.lastServerEventId = "";
  state.pendingAssistant = null;
  renderEvents();
  appendLocalEvent("system.notice", `连接到 ${state.apiBase}`);
  await loadState().catch(() => null);
  connectEvents();
  await loadSkills();
}

function bindEvents() {
  els.form.addEventListener("submit", sendMessage);
  els.connectButton.addEventListener("click", reconnect);
  els.refreshButton.addEventListener("click", () => Promise.allSettled([loadState(), loadSkills()]));
  els.reloadSkillsButton.addEventListener("click", loadSkills);
  els.clearSkillButton.addEventListener("click", clearSelectedSkill);
  els.messageInput.addEventListener("input", handleMessageInput);
  els.skillSearch.addEventListener("input", debounce(loadSkills, 220));

  els.messageInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      els.form.requestSubmit();
    }
  });

  els.skillList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-skill]");
    if (button) selectSkill(button.dataset.skill);
  });

  els.commandHint.addEventListener("click", (event) => {
    const button = event.target.closest("[data-command]");
    if (button) applyCommandTemplate(button.dataset.command);
  });

  els.quickActions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-command]");
    if (button) applyCommandTemplate(button.dataset.command);
  });

  els.filterButtons.forEach((button) => {
    button.addEventListener("click", () => setFilter(button.dataset.filter));
  });
}

function init() {
  els.apiBaseInput.value = state.apiBase;
  bindEvents();
  resizeMessageInput();
  renderEvents();
  reconnect();
}

init();
