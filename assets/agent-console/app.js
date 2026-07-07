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
  filter: "all",
  lastServerEventId: "",
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
  if (!markEventSeen(event)) return;
  rememberServerEvent(event);
  applyRealtimeStatus(event);
  if (event.type === "message.assistant.delta") {
    mergeAssistantDelta(event);
  } else {
    state.pendingAssistant = null;
    state.events.push(normalizeEvent(event));
  }

  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  renderEvents();
}

function mergeSnapshotEvents(events) {
  if (!Array.isArray(events) || !events.length) return;

  let changed = false;
  events.forEach((item) => {
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
    state.pendingAssistant = null;
    state.events.push(normalizeEvent(event));
    changed = true;
  });

  if (!changed) return;
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  renderEvents();
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

function mergeAssistantDelta(event) {
  const last = state.events[state.events.length - 1];
  const nextText = event.text || "";
  if (last && (last.type === "message.assistant.delta" || last.type === "message.assistant.final")) {
    last.type = "message.assistant.delta";
    last.text = `${last.text || ""}${nextText}`;
    last.timestamp = event.timestamp;
    last.payload = { ...last.payload, ...event.payload };
    state.pendingAssistant = last;
    return;
  }

  const merged = { ...event, text: nextText };
  state.events.push(merged);
  state.pendingAssistant = merged;
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
  if (filter === "message") return event.type.startsWith("message.");
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
  if (isCard) return renderLarkCard(event, text);
  if (role === "system") {
    return `<div class="system-text">${renderMarkdown(text)}</div>`;
  }
  return `<div class="markdown-body">${renderMarkdown(text)}</div>`;
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
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
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

  lines.forEach((line) => {
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
      return;
    }

    if (fence) {
      flushInlineBlocks();
      code = { lang: fence[1] || "", lines: [] };
      return;
    }

    if (!line.trim()) {
      flushInlineBlocks();
      return;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushInlineBlocks();
      const level = heading[1].length + 2;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      return;
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
      return;
    }

    flushQuote();
    flushList();
    paragraph.push(line);
  });

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

  const text = els.messageInput.value.trim();
  if (!text) return;

  els.sendButton.disabled = true;

  try {
    await requestJson("/api/message", {
      method: "POST",
      body: JSON.stringify({
        text,
        skill: shouldAttachSelectedSkill(text) ? state.selectedSkill?.name : undefined,
        source: "web",
      }),
    });
    els.messageInput.value = "";
    resizeMessageInput();
    updateCommandHint();
    await loadState().catch(() => null);
  } catch (error) {
    appendLocalEvent("system.notice", `发送失败：${error.message}`, "error");
  } finally {
    els.sendButton.disabled = false;
    els.messageInput.focus();
  }
}

function shouldAttachSelectedSkill(text) {
  return Boolean(state.selectedSkill?.name && !text.startsWith("/"));
}

function selectSkill(skillName) {
  state.selectedSkill = state.skills.find((item) => item.name === skillName) || { name: skillName };
  els.selectedSkillLabel.innerHTML = `已选择 <strong>${escapeHtml(state.selectedSkill.name)}</strong>`;
  els.clearSkillButton.disabled = false;
  renderSkills();
  els.messageInput.focus();
}

function clearSelectedSkill() {
  state.selectedSkill = null;
  els.selectedSkillLabel.textContent = "未选择 skill";
  els.clearSkillButton.disabled = true;
  renderSkills();
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
