import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "console", "public");
const statePath = path.join(root, "console", "cli-sessions.json");
const uiPort = 3080;
const chatIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessions = new Map();
const running = new Map();
const transcriptCache = new Map();
const HISTORY_LIMIT = 20;
const MESSAGE_CHARS = 4000;
const STEP_LIMIT = 40;
const RAW_CHARS = 8000;

function homeDir() {
  if (process.platform === "win32") return process.env.USERPROFILE || process.env.HOME || "";
  return process.env.HOME || process.env.USERPROFILE || "";
}

function agentCmd() {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  return path.join(local, "cursor-agent", "agent.cmd");
}

function linuxAgentBin() {
  const candidates = [
    process.env.CURSOR_AGENT_BIN,
    path.join(homeDir(), ".local", "bin", "agent"),
    path.join(homeDir(), ".local", "bin", "cursor-agent"),
    path.join(homeDir(), ".local", "share", "cursor-agent", "agent"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || "agent";
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      activeChatId: data.activeChatId || null,
      chats: Array.isArray(data.chats) ? data.chats : [],
    };
  } catch {
    return { activeChatId: null, chats: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sessionOf(chatId) {
  let session = sessions.get(chatId);
  if (!session) {
    const saved = loadState().chats.find((item) => item.chatId === chatId);
    session = {
      chatId,
      cwd: saved?.cwd || "",
      model: saved?.model || "",
      status: "idle",
      tool: "",
      note: "",
      usage: saved?.usage || emptyUsage(),
      live: [],
      steps: [],
    };
    sessions.set(chatId, session);
  }
  return session;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function rememberChat(chatId, cwd) {
  const session = sessionOf(chatId);
  session.cwd = cwd || session.cwd;
  const state = loadState();
  const now = new Date().toISOString();
  const chats = state.chats.filter((item) => item.chatId !== chatId);
  chats.unshift({
    chatId,
    cwd: session.cwd,
    model: session.model,
    usage: session.usage,
    updatedAt: now,
  });
  saveState({ activeChatId: chatId, chats: chats.slice(0, 40) });
  return session;
}

function findTranscript(chatId) {
  const projects = path.join(homeDir(), ".cursor", "projects");
  if (!fs.existsSync(projects)) return null;
  for (const name of fs.readdirSync(projects)) {
    const file = path.join(projects, name, "agent-transcripts", chatId, `${chatId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function toolScroll(input) {
  const data = input || {};
  const args = data.arguments && typeof data.arguments === "object" ? data.arguments : {};
  const parts = [
    data.description,
    args.description,
    data.command,
    args.command,
    data.prompt || data.task,
    args.prompt || args.task,
    data.path || data.file_path || data.target_directory,
    args.path || args.file_path,
  ].filter((item) => typeof item === "string" && item.trim());
  if (typeof data.old_string === "string" || typeof data.new_string === "string" || typeof data.contents === "string") {
    parts.push(["--- 原来的内容", data.old_string || "", "+++ 写成", data.new_string || data.contents || ""].join("\n"));
  }
  let text = parts.join("\n\n").trim();
  if (text.length > 8000) text = `${text.slice(0, 8000)}\n…（已截断，子代理滚屏会在点开后继续加载）`;
  return text;
}

function promptHead(input) {
  const data = input || {};
  const args = data.arguments && typeof data.arguments === "object" ? data.arguments : {};
  const prompt = data.prompt || data.task || args.prompt || args.task || "";
  return normalizeText(prompt).slice(0, 160);
}

function isSubagentCall(name, input) {
  const data = input || {};
  const args = data.arguments && typeof data.arguments === "object" ? data.arguments : {};
  return /task|subagent|agent/i.test(name) || data.subagent_type || args.subagent_type || data.toolName === "Task" || args.toolName === "Task";
}

function subagentLog(file) {
  const lines = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.role === "user" || row.role === "assistant") {
      const content = row.message?.content;
      const text = visibleText(textFromContent(content), row.role);
      if (text) lines.push(`${row.role === "user" ? "你" : "Cursor"}\n${text}`);
      for (const item of Array.isArray(content) ? content : []) {
        if (!item || (item.type !== "tool_use" && item.type !== "tool_call")) continue;
        const name = item.name || item.toolName || "工具";
        const summary = summarizeTool(name, item.input || item.args || {});
        const body = toolScroll(item.input || item.args || {});
        lines.push([summary.label || name, summary.title || ""].filter(Boolean).join("  ") + (body ? `\n${body}` : ""));
      }
    }
  }
  let text = lines.join("\n\n").trim();
  if (text.length > 180000) text = `${text.slice(0, 180000)}\n…（滚屏已截断）`;
  return text;
}

function findSubagentScroll(chatId, head) {
  const needle = normalizeText(head).slice(0, 160);
  if (needle.length < 24) return "";
  const transcript = findTranscript(chatId);
  if (!transcript) return "";
  const dir = path.join(path.dirname(transcript), "subagents");
  if (!fs.existsSync(dir)) return "";
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    let first = "";
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(12000);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      first = buffer.subarray(0, read).toString("utf8").split(/\n/, 1)[0];
    } finally {
      fs.closeSync(fd);
    }
    let row;
    try {
      row = JSON.parse(first);
    } catch {
      continue;
    }
    const query = normalizeText(visibleText(textFromContent(row.message?.content), "user"));
    if (!query) continue;
    if (query.startsWith(needle) || needle.startsWith(query.slice(0, needle.length))) return subagentLog(file);
  }
  return "";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && (item.type === "text" || item.text))
    .map((item) => item.text || "")
    .join("");
}

function toolsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item && (item.type === "tool_use" || item.type === "tool_call"))
    .map((item) => item.name || item.toolName || "工具");
}

function clip(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…`;
}

function slimInput(input) {
  const copy = { ...(input || {}) };
  if (typeof copy.contents === "string") copy.contents = `（${copy.contents.split("\n").length} 行，正文见下方摘要）`;
  if (typeof copy.new_string === "string") copy.new_string = clip(copy.new_string, 2000);
  if (typeof copy.old_string === "string") copy.old_string = clip(copy.old_string, 1000);
  if (typeof copy.command === "string") copy.command = clip(copy.command, 1500);
  return copy;
}

function summarizeTool(name, input) {
  const data = input || {};
  const file = data.path || data.file_path || data.target_directory || "";
  if (name === "StrReplace" || name === "Write" || name === "Edit" || name === "Delete") {
    const added = String(data.new_string || data.contents || "").split("\n").filter((line) => line.length);
    const removed = String(data.old_string || "").split("\n").filter((line) => line.length);
    const preview = (name === "Delete" ? removed : added).slice(0, 16).map((line) => `${name === "Delete" ? "- " : "+ "}${line}`).join("\n");
    return {
      kind: "edit",
      label: "修改",
      title: file || name,
      stat: name === "Write" ? `写入 ${added.length} 行` : `+${added.length} / -${removed.length}`,
      detail: clip(preview, 1600),
    };
  }
  if (name === "Read") return { kind: "read", label: "读取", title: file || name, stat: "", detail: "" };
  if (name === "Grep" || name === "Glob") {
    return { kind: "search", label: "搜索", title: data.pattern || data.glob_pattern || name, stat: file, detail: "" };
  }
  if (name === "Shell") {
    const command = String(data.command || "");
    return { kind: "shell", label: "命令", title: data.description || command.split("\n")[0].slice(0, 180) || "命令", stat: "", detail: clip(command, 1600) };
  }
  if (isSubagentCall(name, data)) {
    const args = data.arguments && typeof data.arguments === "object" ? data.arguments : data;
    return {
      kind: "subagent",
      label: "子代理",
      title: args.description || data.description || args.subagent_type || data.subagent_type || name,
      stat: args.subagent_type || data.subagent_type || "",
      detail: clip(args.prompt || args.task || data.prompt || data.task || "", 1200),
      promptHead: promptHead(data),
    };
  }
  if (name === "CallDynamicTool" || name === "GetDynamicTools") {
    const title = [data.namespace, data.toolName].filter(Boolean).join(" / ") || name;
    const skill = /skill/i.test(title) || name === "GetDynamicTools";
    return { kind: skill ? "skill" : "call", label: skill ? "技能" : "调用", title, stat: "", detail: clip(JSON.stringify(data.arguments || data, null, 2), 1200) };
  }
  return { kind: "tool", label: name, title: file || name, stat: "", detail: "" };
}

function visibleText(raw, role) {
  const source = String(raw || "");
  const query = source.match(/<user_query>([\s\S]*?)<\/user_query>/);
  let text = query ? query[1] : source.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "");
  text = text.replace(/<\/?user_query>/g, "").trim();
  if (role === "user") {
    text = text.replace(/<([a-zA-Z0-9_:-]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "").trim();
  }
  if (text.length > MESSAGE_CHARS) return `${text.slice(0, MESSAGE_CHARS)}\n…（已截断）`;
  return text;
}

function parseTranscript(chatId) {
  const file = findTranscript(chatId);
  if (!file) return { found: false, messages: [], tools: [], status: "", omitted: 0 };
  const stat = fs.statSync(file);
  const cached = transcriptCache.get(chatId);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const messages = [];
  const tools = [];
  const steps = [];
  const entries = [];
  let status = "";
  let total = 0;
  let turnTools = 0;
  let skippedTools = 0;
  const flushSkipped = () => {
    if (!skippedTools) return;
    entries.push({ type: "note", text: `本轮还有 ${skippedTools} 个步骤没有展开` });
    skippedTools = 0;
  };
  const pushEntry = (entry) => {
    entries.push(entry);
    const userIndexes = [];
    entries.forEach((item, index) => {
      if (item.type === "user") userIndexes.push(index);
    });
    if (userIndexes.length > 4) entries.splice(0, userIndexes[0] + 1);
  };
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.role === "user" || row.role === "assistant") {
      const content = row.message?.content;
      const text = visibleText(textFromContent(content), row.role);
      if (text) {
        total += 1;
        if (row.role === "user") {
          flushSkipped();
          turnTools = 0;
        }
        messages.push({ role: row.role === "user" ? "user" : "assistant", text });
        if (messages.length > HISTORY_LIMIT) messages.shift();
        pushEntry({ type: row.role === "user" ? "user" : "assistant", text });
      }
      for (const item of Array.isArray(content) ? content : []) {
        if (!item || (item.type !== "tool_use" && item.type !== "tool_call")) continue;
        const name = item.name || item.toolName || "工具";
        const toolInput = item.input || item.args || {};
        const summary = summarizeTool(name, toolInput);
        tools.push(name);
        if (tools.length > 8) tools.shift();
        const step = {
          id: `file-${total}-${entries.length}-${name}`,
          type: "tool",
          ...summary,
          name,
          status: "done",
          durationMs: null,
          source: "transcript",
          scroll: toolScroll(toolInput),
          raw: capRaw({ name, input: slimInput(toolInput) }),
        };
        pushStep(steps, step);
        if (turnTools >= 30) skippedTools += 1;
        else {
          turnTools += 1;
          pushEntry(step);
        }
      }
    } else if (row.type === "turn_ended") {
      status = row.status || "";
      pushStep(steps, {
        id: `turn-${total}`,
        kind: "turn",
        name: "回合结束",
        status: row.status === "error" ? "error" : "done",
        durationMs: null,
        source: "transcript",
        raw: capRaw(row),
      });
    }
  }
  flushSkipped();
  const value = { found: true, messages, tools, status, steps, entries, omitted: Math.max(0, total - messages.length) };
  transcriptCache.set(chatId, { mtime: stat.mtimeMs, size: stat.size, value });
  return value;
}

function addUsage(total, usage) {
  if (!usage) return;
  total.inputTokens += Number(usage.inputTokens) || 0;
  total.outputTokens += Number(usage.outputTokens) || 0;
  total.cacheReadTokens += Number(usage.cacheReadTokens) || 0;
  total.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0;
  total.turns += 1;
}

function sameText(leftText, rightText) {
  const left = normalizeText(leftText);
  const right = normalizeText(rightText);
  return Boolean(left) && left === right;
}

function absorbLive(entries, live) {
  let lastMatchedUser = -1;
  for (let index = 0; index < live.length; index += 1) {
    const text = normalizeText(live[index].text);
    if (live[index].role !== "user" || !text) continue;
    if (entries.some((entry) => entry.type === "user" && sameText(entry.text, text))) lastMatchedUser = index;
  }
  for (let index = lastMatchedUser + 1; index < live.length; index += 1) {
    const item = live[index];
    const text = normalizeText(item.text);
    if (!text) continue;
    const type = item.role === "error" ? "error" : item.role;
    if (type === "user") {
      entries.push({ type: "user", text });
      continue;
    }
    const lastUserIndex = entries.findLastIndex((entry) => entry.type === "user");
    const same = entries.findIndex((entry, entryIndex) => (
      entryIndex >= lastUserIndex && entry.type === type && entry.text && sameReply(entry.text, text)
    ));
    if (same >= 0) {
      if (text.length > entries[same].text.length) entries[same].text = text;
      continue;
    }
    entries.push({ type, text });
  }
}

function orderTurnEntries(entries) {
  const result = [];
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    const users = [];
    const work = [];
    const answers = [];
    for (const entry of bucket) {
      if (entry.type === "user") users.push(entry);
      else if (entry.type === "assistant" || entry.type === "error") answers.push(entry);
      else work.push(entry);
    }
    result.push(...users, ...work, ...answers);
    bucket = [];
  };
  for (const entry of entries || []) {
    if (entry.type === "user") flush();
    bucket.push(entry);
  }
  flush();
  return result;
}

function snapshot(chatId) {
  const session = sessionOf(chatId);
  const transcript = parseTranscript(chatId);
  const messages = [];
  const pushMessage = (role, text) => {
    const clean = normalizeText(text);
    if (!role || !clean) return;
    const similar = role === "user" ? sameText : sameReply;
    const related = [];
    messages.forEach((message, index) => {
      if (message.role === role && similar(message.text, clean)) related.push(index);
    });
    if (related.length === 0) {
      messages.push({ role, text: clean });
      return;
    }
    const keep = related[0];
    const longest = related.reduce((best, index) => (messages[index].text.length > messages[best].text.length ? index : best), keep);
    messages[keep].text = clean.length >= messages[longest].text.length ? clean : messages[longest].text;
    for (let i = related.length - 1; i >= 1; i -= 1) messages.splice(related[i], 1);
  };
  for (const message of transcript.messages) pushMessage(message.role, message.text);
  const messageEntries = messages.map((message) => ({ type: message.role, text: message.text }));
  absorbLive(messageEntries, session.live);
  messages.splice(0, messages.length, ...messageEntries
    .filter((entry) => entry.type === "user" || entry.type === "assistant" || entry.type === "error")
    .map((entry) => ({ role: entry.type, text: entry.text })));
  const entries = (transcript.entries || []).map((entry) => ({ ...entry }));
  absorbLive(entries, session.live);
  for (const step of session.steps) {
    if (step.kind === "thinking" || step.kind === "result") continue;
    if (!step.title && !step.label) continue;
    if (session.turnStartedAt && (step.startedAt || 0) < session.turnStartedAt) continue;
    if (entries.some((entry) => entry.id === step.id)) continue;
    entries.push({ ...step, type: "tool" });
  }
  const ordered = orderTurnEntries(entries);
  const busy = running.has(chatId);
  let status = session.status;
  if (status === "idle" && transcript.status === "error") status = "failed";
  if (!busy && ordered.some((entry) => entry.type === "user" || entry.type === "assistant" || entry.type === "tool")) {
    const stopped = Boolean(session.cancelled);
    ordered.push({
      type: "note",
      kind: stopped || status === "failed" ? "turn-fail" : "turn-end",
      text: stopped ? "已终止" : status === "failed" ? "本轮失败" : "本轮已结束",
    });
  }
  let omitted = transcript.omitted || 0;
  if (messages.length > HISTORY_LIMIT) {
    omitted += messages.length - HISTORY_LIMIT;
    messages.splice(0, messages.length - HISTORY_LIMIT);
  }
  const tools = [...transcript.tools];
  if (session.tool && !tools.includes(session.tool)) tools.push(session.tool);
  return {
    chatId,
    cwd: session.cwd,
    model: session.model,
    status,
    tool: session.tool,
    note: transcript.found ? session.note : "终端进度尚未同步",
    usage: session.usage,
    messages,
    entries: ordered,
    omitted,
    tools,
    steps: mergeSteps(
      transcript.steps || [],
      (session.steps || []).filter((step) => !session.turnStartedAt || (step.startedAt || 0) >= session.turnStartedAt),
    ),
    terminalSync: transcript.found ? "ok" : "missing",
    running: busy,
    pendingChoice: session.pendingChoice || null,
  };
}

function questionList(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value.questions || value.Questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions = [];
  for (const question of raw) {
    if (!question || typeof question !== "object") continue;
    const rawOptions = question.options || question.Options || [];
    if (!Array.isArray(rawOptions)) continue;
    const options = [];
    for (const option of rawOptions) {
      if (!option || typeof option !== "object") continue;
      const label = String(option.label || option.Label || "").trim();
      const id = String(option.id || option.Id || label).trim();
      if (!label || !id || id === "__other__") continue;
      options.push({ id, label });
    }
    if (!options.length) continue;
    const prompt = String(question.prompt || question.promptMarkdown || question.Prompt || "").trim();
    if (!prompt) continue;
    questions.push({
      id: String(question.id || question.Id || questions.length + 1),
      prompt,
      allowMultiple: Boolean(question.allowMultiple || question.allow_multiple),
      options,
    });
  }
  if (!questions.length) return null;
  const title = String(value.title || value.Title || "需要你选择").trim() || "需要你选择";
  return { title, questions };
}

function findChoice(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findChoice(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const direct = questionList(value);
  if (direct) return direct;
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findChoice(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function publishChoice(session, event, emit) {
  const choice = findChoice(event);
  if (!choice) return;
  const signature = choice.questions.map((question) => `${question.prompt}\n${question.options.map((option) => option.label).join("|")}`).join("\n");
  if (session.pendingChoice && session.pendingChoice.signature === signature) return;
  session.pendingChoice = { id: signature, signature, ...choice };
  emit({ type: "choice", choice: session.pendingChoice });
}

function cliScript() {
  return path.join(path.dirname(agentCmd()), "cursor-agent.ps1");
}

function cliArgs(chatId, prompt) {
  return [
    "-p",
    "--resume",
    chatId,
    "--force",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    ...(prompt.startsWith("-") ? ["--"] : []),
    prompt,
  ];
}

function runCli(chatId, cwd, prompt) {
  const args = cliArgs(chatId, prompt);
  const options = {
    cwd: cwd || root,
    env: { ...process.env, CURSOR_INVOKED_AS: process.platform === "win32" ? "agent.cmd" : "agent" },
  };
  if (process.platform === "win32") {
    options.windowsHide = true;
    return spawn(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cliScript(), ...args],
      options,
    );
  }
  return spawn(linuxAgentBin(), args, options);
}

function capRaw(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length > RAW_CHARS) return `${text.slice(0, RAW_CHARS)}\n…（已截断）`;
  return text;
}

function pushStep(list, step) {
  list.push(step);
  if (list.length > STEP_LIMIT) list.shift();
}

function mergeSteps(fromFile, live) {
  const merged = [...(fromFile || [])];
  for (const step of live || []) {
    const index = merged.findIndex((item) => item.kind === step.kind && item.name === step.name && item.durationMs == null && step.durationMs != null);
    if (index >= 0) merged.splice(index, 1);
    merged.push(step);
  }
  return merged.slice(-STEP_LIMIT);
}

function liveToolInput(event) {
  const call = event.tool_call || event.toolCall || {};
  const key = Object.keys(call).find((name) => call[name] && typeof call[name] === "object");
  const node = key ? call[key] : {};
  return node.args || node.input || event.input || event.args || {};
}

function toolLabel(event) {
  const direct = event.name || event.tool_name || event.toolName;
  if (direct) return String(direct);
  const call = event.tool_call || event.toolCall;
  if (call && typeof call === "object") {
    const key = Object.keys(call).find((name) => call[name] && typeof call[name] === "object");
    if (key) return key.replace(/ToolCall$/, "");
  }
  return "工具";
}

function normalizeText(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

function sameReply(leftText, rightText) {
  const left = normalizeText(leftText);
  const right = normalizeText(rightText);
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left) || left.endsWith(`\n${right}`) || right.endsWith(`\n${left}`);
}

function appendAssistant(session, piece, fresh) {
  const chunk = String(piece || "");
  if (!chunk.trim()) {
    const last = session.live[session.live.length - 1];
    return last?.role === "assistant" ? last.text : "";
  }
  const last = session.live[session.live.length - 1];
  if (!fresh && last?.role === "assistant") {
    if (chunk.startsWith(last.text)) last.text = chunk;
    else if (!last.text.startsWith(chunk)) last.text += chunk;
    return last.text;
  }
  session.live.push({ role: "assistant", text: chunk.trim() });
  return chunk.trim();
}

function handleStreamLine(session, line, emit) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "system" && event.subtype === "init") {
    session.model = event.model || session.model;
    emit({ type: "model", model: session.model });
    return;
  }
  if (event.type === "thinking") {
    const open = [...session.steps].reverse().find((step) => step.id === "thinking-open");
    if (event.subtype === "completed") {
      if (open) {
        const end = event.timestamp_ms || Date.now();
        open.durationMs = Math.max(0, end - open.startedAt);
        open.status = "done";
        open.id = `thinking-${end}`;
        open.raw = capRaw({ type: "thinking", subtype: "completed", durationMs: open.durationMs });
        emit({ type: "step", step: open });
      }
    } else if (!open) {
      const step = {
        id: "thinking-open",
        kind: "thinking",
        label: "思考",
        name: "思考",
        title: "思考",
        status: "running",
        startedAt: event.timestamp_ms || Date.now(),
        durationMs: null,
        source: "live",
        raw: "",
      };
      pushStep(session.steps, step);
      emit({ type: "step", step });
    }
    emit({ type: "thinking", text: event.text || "" });
    return;
  }
  if (event.type === "interaction_query") {
    if (event.subtype === "request") publishChoice(session, event, emit);
    return;
  }
  if (event.type === "assistant") {
    const piece = textFromContent(event.message?.content) || event.text || "";
    const last = session.live[session.live.length - 1];
    const fresh = session.assistantBreak || last?.role !== "assistant";
    const text = appendAssistant(session, piece, fresh);
    if (text) {
      session.assistantBreak = false;
      emit({ type: "assistant", text, fresh });
    }
    for (const name of toolsFromContent(event.message?.content)) {
      session.tool = name;
      emit({ type: "tool", name });
    }
    return;
  }
  if (event.type === "tool_call" || event.type === "tool_use") {
    if (event.subtype !== "completed") session.assistantBreak = true;
    const name = toolLabel(event);
    const summary = summarizeTool(name, liveToolInput(event));
    const id = String(event.call_id || event.tool_call_id || event.id || name);
    if (event.subtype === "completed") {
      const step = [...session.steps].reverse().find((item) => item.status === "running" && (item.id === id || item.name === name));
      const end = event.timestamp_ms || Date.now();
      if (step) {
        Object.assign(step, summary, { name, type: "tool" });
        step.durationMs = Math.max(0, end - (step.startedAt || end));
        step.status = "done";
        step.scroll = toolScroll(liveToolInput(event));
        step.raw = capRaw({ name, input: slimInput(liveToolInput(event)) });
        emit({ type: "step", step });
      }
      session.tool = "";
    } else {
      const step = {
        id,
        type: "tool",
        ...summary,
        name,
        status: "running",
        startedAt: event.timestamp_ms || Date.now(),
        durationMs: null,
        source: "live",
        scroll: toolScroll(liveToolInput(event)),
        raw: capRaw({ name, input: slimInput(liveToolInput(event)) }),
      };
      pushStep(session.steps, step);
      session.tool = name;
      emit({ type: "step", step });
      publishChoice(session, event, emit);
    }
    emit({ type: "tool", name: session.tool || name, done: event.subtype === "completed" });
    return;
  }
  if (event.type === "result") {
    addUsage(session.usage, event.usage);
    const failed = event.is_error === true || event.subtype === "error";
    session.status = failed ? "failed" : "idle";
    session.tool = "";
    const message = failed ? (typeof event.result === "string" && event.result ? event.result : "这一轮失败") : "";
    if (message) session.live.push({ role: "error", text: message });
    rememberChat(session.chatId, session.cwd);
    const resultStep = {
      id: `result-${Date.now()}`,
      kind: "result",
      label: "本轮",
      title: failed ? "失败" : "结束",
      name: failed ? "本轮失败" : "本轮结束",
      status: failed ? "error" : "done",
      durationMs: Number(event.duration_ms) || null,
      source: "live",
      raw: capRaw({
        subtype: event.subtype,
        duration_ms: event.duration_ms,
        duration_api_ms: event.duration_api_ms,
        is_error: event.is_error,
        usage: event.usage || null,
      }),
    };
    pushStep(session.steps, resultStep);
    emit({ type: "step", step: resultStep });
    emit({ type: "usage", usage: session.usage, turn: event.usage || null });
    emit({ type: "done", ok: !failed, message });
  }
}

function startTurn(chatId, cwd, text, res) {
  const session = sessionOf(chatId);
  session.cwd = cwd || session.cwd;
  session.status = "running";
  session.turnStartedAt = Date.now();
  session.cancelled = false;
  session.assistantBreak = false;
  session.note = "";
  session.pendingChoice = null;
  session.live.push({ role: "user", text });
  rememberChat(chatId, session.cwd);
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  const emit = (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  emit({ type: "status", status: "running" });
  emit({ type: "user", text });
  const child = runCli(chatId, session.cwd, text);
  running.set(chatId, child);
  let buffer = "";
  let finished = false;
  const finish = (ok, message) => {
    if (finished) return;
    finished = true;
    if (running.get(chatId) === child) running.delete(chatId);
    if (session.status === "running") session.status = ok ? "idle" : "failed";
    session.tool = "";
    if (child.cancelled) session.status = "idle";
    if (!ok && message && !child.cancelled) emit({ type: "error", message });
    emit({ type: "status", status: session.status });
    if (child.cancelled) emit({ type: "done", ok: false, cancelled: true, message: "已终止" });
    res.end();
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleStreamLine(session, line, emit);
      nl = buffer.indexOf("\n");
    }
  });
  let errorText = "";
  child.stderr.on("data", (chunk) => {
    errorText += chunk.toString("utf8");
  });
  child.on("exit", (code) => {
    if (child.cancelled) {
      session.status = "idle";
      session.note = "已终止";
      finish(false, "已终止");
      return;
    }
    if (buffer.trim()) handleStreamLine(session, buffer.trim(), emit);
    if (code && session.status !== "failed" && session.status !== "idle") {
      finish(false, errorText.trim() || `CLI 退出码 ${code}`);
      return;
    }
    finish(session.status !== "failed", "");
  });
  child.on("error", (error) => finish(false, error.message));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${uiPort}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(publicDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const state = loadState();
      sendJson(res, 200, {
        activeChatId: state.activeChatId,
        chats: state.chats,
        runningChatIds: [...running.keys()],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/attach") {
      const body = await readBody(req);
      if (!chatIdPattern.test(body.chatId || "") || typeof body.cwd !== "string" || !body.cwd.trim()) {
        sendJson(res, 400, { ok: false, message: "需要 chatId 和 cwd。" });
        return;
      }
      const cwd = path.resolve(body.cwd);
      rememberChat(body.chatId, cwd);
      sendJson(res, 200, { ok: true, chatId: body.chatId, cwd });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const chatId = decodeURIComponent(sessionMatch[1]);
      if (!chatIdPattern.test(chatId)) {
        sendJson(res, 400, { ok: false, message: "chat id 无效。" });
        return;
      }
      sendJson(res, 200, snapshot(chatId));
      return;
    }
    const scrollMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/scroll$/);
    if (req.method === "GET" && scrollMatch) {
      const chatId = decodeURIComponent(scrollMatch[1]);
      const head = url.searchParams.get("head") || "";
      if (!chatIdPattern.test(chatId)) {
        sendJson(res, 400, { ok: false, message: "chat id 无效。" });
        return;
      }
      const text = findSubagentScroll(chatId, head);
      sendJson(res, 200, { ok: true, found: Boolean(text), text });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cancel") {
      const body = await readBody(req);
      if (!chatIdPattern.test(body.chatId || "")) {
        sendJson(res, 400, { ok: false, message: "需要 chatId。" });
        return;
      }
      const child = running.get(body.chatId);
      if (!child) {
        sendJson(res, 200, { ok: true, stopped: false });
        return;
      }
      child.cancelled = true;
      const session = sessionOf(body.chatId);
      session.cancelled = true;
      session.note = "已终止";
      if (process.platform === "win32") {
        spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
      }
      sendJson(res, 200, { ok: true, stopped: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/message") {
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!chatIdPattern.test(body.chatId || "") || !text) {
        sendJson(res, 400, { ok: false, message: "需要 chatId 和 text。" });
        return;
      }
      if (running.has(body.chatId)) {
        sendJson(res, 409, { ok: false, message: "正在处理" });
        return;
      }
      const known = loadState().chats.find((item) => item.chatId === body.chatId);
      const cwd = typeof body.cwd === "string" && body.cwd.trim() ? path.resolve(body.cwd) : known?.cwd || root;
      startTurn(body.chatId, cwd, text, res);
      return;
    }
    sendJson(res, 404, { ok: false, message: "没有这个页面。" });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(uiPort, "127.0.0.1", () => {
  process.stdout.write(`WebAI console  http://127.0.0.1:${uiPort}/\n`);
});
