import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "console", "public");
const projectsPath = path.join(root, "console", "projects.json");
const journalPath = path.join(root, "interactions", "console.jsonl");
const agentPort = 3000;
const uiPort = 3080;
const nodeHome = fs.readFileSync(path.join(root, ".tools", "node-home.txt"), "utf8").trim();
const nodeBin = path.join(nodeHome, "node.exe");

const PARAM_NAMES = {
  reasoning_effort: "推理强度",
  effort: "推理强度",
  reasoning: "推理强度",
  fast: "快速模式",
  context: "上下文长度",
  thinking: "思考",
  optimize_for: "优化目标",
};
const VARIANT_NAMES = {
  Default: "默认",
  default: "默认",
  Balanced: "平衡",
  Fast: "更快",
  Quality: "更稳",
};
const MODEL_HINTS = {
  "composer-2.5": "Composer 2.5（日常推荐）",
  "gpt-5.6-sol-high": "GPT 5.6 · 深度推理",
  "gpt-5.6-sol-xhigh": "GPT 5.6 · 更深推理",
  "gpt-5.6-luna-high": "GPT 5.6 Luna",
};
const VALUE_NAMES = {
  true: "开",
  false: "关",
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  intelligence: "智能优先",
  balanced: "平衡",
  cost: "成本优先",
};

let child = null;
let restarting = false;
let catalogCache = null;
let catalogAt = 0;
/** @type {{ id: string, name: string, projectDir: string, stateRoot: string }} */
let activeProject = null;

function isProjectId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function normalizeDir(input, base) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("路径不能为空。");
  }
  const resolved = path.resolve(base, input.trim());
  if (!fs.existsSync(resolved)) throw new Error(`路径不存在：${resolved}`);
  return resolved;
}

function resolveAgentCli(projectDir) {
  const local = path.join(projectDir, "node_modules", "@grok", "agent-sdk", "dist", "bin", "agent-serve.js");
  if (fs.existsSync(local)) return local;
  const shared = path.join(root, "node_modules", "@grok", "agent-sdk", "dist", "bin", "agent-serve.js");
  if (fs.existsSync(shared)) return shared;
  throw new Error("找不到 agent-sdk，请在项目目录执行 npm install。");
}

function assertAgentProject(projectDir) {
  const hasBot = fs.existsSync(path.join(projectDir, "bot", "agent.ts"));
  const hasPkg = fs.existsSync(path.join(projectDir, "package.json"));
  if (!hasBot && !hasPkg) {
    throw new Error(`不是 agent 项目（缺少 bot/agent.ts）：${projectDir}`);
  }
}

function readProjectsFile() {
  if (!fs.existsSync(projectsPath)) {
    const initial = {
      activeId: "webai",
      projects: [
        {
          id: "webai",
          name: "WebAI",
          projectDir: root,
          stateRoot: path.join(root, ".agent-state"),
        },
      ],
    };
    fs.writeFileSync(projectsPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    return initial;
  }
  return JSON.parse(fs.readFileSync(projectsPath, "utf8"));
}

function writeProjectsFile(data) {
  fs.writeFileSync(projectsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeProject(entry) {
  if (!entry || !isProjectId(entry.id)) throw new Error("项目 id 无效（小写字母开头，仅字母数字 _ -）。");
  if (typeof entry.name !== "string" || !entry.name.trim()) throw new Error("项目名称无效。");
  const projectDir = normalizeDir(entry.projectDir, root);
  assertAgentProject(projectDir);
  const stateRoot = entry.stateRoot
    ? path.resolve(projectDir, entry.stateRoot)
    : path.join(projectDir, ".agent-state");
  fs.mkdirSync(stateRoot, { recursive: true });
  return { id: entry.id, name: entry.name.trim(), projectDir, stateRoot };
}

function loadRegistry() {
  const data = readProjectsFile();
  const projects = (data.projects ?? []).map((item) => normalizeProject(item));
  if (projects.length === 0) throw new Error("projects.json 里没有登记任何 agent 项目。");
  const ids = new Set();
  for (const project of projects) {
    if (ids.has(project.id)) throw new Error(`重复的项目 id：${project.id}`);
    ids.add(project.id);
  }
  let activeId = data.activeId;
  if (!projects.some((item) => item.id === activeId)) activeId = projects[0].id;
  const active = projects.find((item) => item.id === activeId) ?? projects[0];
  activeProject = active;
  if (data.activeId !== active.id || (data.projects ?? []).length !== projects.length) {
    writeProjectsFile({
      activeId: active.id,
      projects: projects.map((item) => ({
        id: item.id,
        name: item.name,
        projectDir: item.projectDir,
        stateRoot: item.stateRoot,
      })),
    });
  }
  return { activeId: active.id, projects };
}

function projectLogPath(projectId) {
  return path.join(root, "console", `serve-${projectId}.log`);
}

function label(map, value, fallback) {
  return map[value] ?? fallback ?? value;
}

function isSafeToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(raw);
}

async function fetchCatalog() {
  if (catalogCache && Date.now() - catalogAt < 5 * 60 * 1000) return catalogCache;
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error("缺少 CURSOR_API_KEY，无法读取模型列表。");
  const response = await fetch("https://api.cursor.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`模型列表请求失败（${response.status}）。`);
  const json = await response.json();
  catalogCache = (json.items ?? []).map((item) => ({
    id: item.id,
    displayName: MODEL_HINTS[item.id] || item.displayName || item.id,
    caution: String(item.id).startsWith("grok")
      ? "团队管理员当前拦截了 Grok。选它之后，对话可能再次失败。"
      : null,
    parameters: (item.parameters ?? []).map((param) => ({
      id: param.id,
      displayName: label(PARAM_NAMES, param.id, param.displayName || param.id),
      values: (param.values ?? []).map((entry) => ({
        value: entry.value,
        displayName: label(VALUE_NAMES, entry.value, entry.displayName || entry.value),
      })),
    })),
    variants: (item.variants ?? []).map((variant) => ({
      displayName: label(VARIANT_NAMES, variant.displayName, variant.displayName || "预设"),
      isDefault: variant.isDefault === true,
      params: variant.params ?? [],
    })),
  }));
  catalogAt = Date.now();
  return catalogCache;
}

function renderAgent(selection) {
  const params = selection.params ?? [];
  const model =
    params.length === 0
      ? JSON.stringify(selection.id)
      : `{
    id: ${JSON.stringify(selection.id)},
    params: [
${params.map((param) => `      { id: ${JSON.stringify(param.id)}, value: ${JSON.stringify(param.value)} },`).join("\n")}
    ],
  }`;
  return `import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  model: ${model},
});
`;
}

async function validateSelection(selection) {
  if (!selection || !isSafeToken(selection.id)) {
    throw new Error("模型 id 无效。");
  }
  const models = await fetchCatalog();
  const model = models.find((item) => item.id === selection.id);
  if (!model) throw new Error("这个模型不在当前账号的列表里。");
  const params = Array.isArray(selection.params) ? selection.params : [];
  const seen = new Set();
  for (const param of params) {
    if (!isSafeToken(param?.id) || !isSafeToken(param?.value)) {
      throw new Error("参数格式无效。");
    }
    const spec = model.parameters.find((item) => item.id === param.id);
    if (!spec || seen.has(param.id)) throw new Error(`参数 ${param.id} 不能用于这个模型。`);
    if (!spec.values.some((entry) => entry.value === param.value)) {
      throw new Error(`参数 ${param.id} 的取值无效。`);
    }
    seen.add(param.id);
  }
  return { id: selection.id, params };
}

function killPid(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
}

function listeningPid(port) {
  return new Promise((resolve) => {
    const command = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`;
    const probe = spawn("powershell", ["-NoProfile", "-Command", command], { windowsHide: true });
    let out = "";
    probe.stdout.on("data", (chunk) => {
      out += chunk;
    });
    probe.on("exit", () => {
      const pid = Number(out.trim());
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
    probe.on("error", () => resolve(null));
  });
}

async function stopServe() {
  if (child && !child.killed) {
    await killPid(child.pid);
    child = null;
  }
  const pid = await listeningPid(agentPort);
  if (pid) await killPid(pid);
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (!(await listeningPid(agentPort))) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("旧的 agent 服务没有退出。");
}

function startServe() {
  if (!activeProject) throw new Error("没有选中的 agent 项目。");
  const cli = resolveAgentCli(activeProject.projectDir);
  const logPath = projectLogPath(activeProject.id);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: "a" });
  log.write(
    `\n[${new Date().toISOString()}] start project=${activeProject.id} dir=${activeProject.projectDir} state=${activeProject.stateRoot}\n`,
  );
  child = spawn(
    nodeBin,
    [
      cli,
      "serve",
      "--dir",
      activeProject.projectDir,
      "--mode",
      "single",
      "--dev",
      "--port",
      String(agentPort),
      "--state-root",
      activeProject.stateRoot,
    ],
    { cwd: activeProject.projectDir, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", () => {
    child = null;
  });
}

async function waitForInfo() {
  const started = Date.now();
  let lastError = "服务没有响应。";
  while (Date.now() - started < 60000) {
    try {
      const response = await fetch(`http://127.0.0.1:${agentPort}/v1/info`);
      if (response.ok) return await response.json();
      lastError = `服务返回 ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(lastError);
}

async function applyModel(selection) {
  if (restarting) throw new Error("正在切换模型，请稍候。");
  restarting = true;
  try {
    const clean = await validateSelection(selection);
    const agentFile = path.join(activeProject.projectDir, "bot", "agent.ts");
    if (!fs.existsSync(agentFile)) {
      throw new Error("当前项目没有 bot/agent.ts，无法在这里改模型。");
    }
    fs.writeFileSync(agentFile, renderAgent(clean), "utf8");
    await stopServe();
    startServe();
    const info = await waitForInfo();
    return { ok: true, model: info.model, requested: clean, project: activeProject.id };
  } finally {
    restarting = false;
  }
}

async function switchProject(projectId) {
  if (restarting) throw new Error("正在切换项目，请稍候。");
  const data = readProjectsFile();
  const raw = (data.projects ?? []).find((item) => item.id === projectId);
  if (!raw) throw new Error("没有这个项目。");
  const next = normalizeProject(raw);
  if (activeProject?.id === next.id) {
    return { ok: true, project: next, switched: false };
  }
  restarting = true;
  try {
    await stopServe();
    activeProject = next;
    writeProjectsFile({
      activeId: next.id,
      projects: (data.projects ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        projectDir: item.projectDir,
        stateRoot: item.stateRoot,
      })),
    });
    startServe();
    const info = await waitForInfo();
    return {
      ok: true,
      switched: true,
      project: { ...next },
      name: info.name,
      model: info.model,
    };
  } finally {
    restarting = false;
  }
}

function registerProject(entry) {
  const data = readProjectsFile();
  const projects = data.projects ?? [];
  if (projects.some((item) => item.id === entry.id)) {
    throw new Error("这个 id 已经存在。");
  }
  const normalized = normalizeProject(entry);
  projects.push({
    id: normalized.id,
    name: normalized.name,
    projectDir: normalized.projectDir,
    stateRoot: normalized.stateRoot,
  });
  writeProjectsFile({ activeId: data.activeId ?? activeProject?.id ?? normalized.id, projects });
  return normalized;
}

function proxy(req, res) {
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: agentPort,
      path: req.url,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, 503, {
      ok: false,
      message: restarting ? "正在切换项目或模型，请稍候。" : "Agent 服务未就绪。",
    });
  });
  req.pipe(upstream);
}

function appendJournal(entry) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
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
    if (req.method === "GET" && url.pathname === "/api/projects") {
      const data = readProjectsFile();
      const projects = (data.projects ?? []).map((item) => {
        try {
          return normalizeProject(item);
        } catch {
          return { id: item.id, name: item.name, projectDir: item.projectDir, stateRoot: item.stateRoot, invalid: true };
        }
      });
      sendJson(res, 200, { activeId: activeProject?.id ?? data.activeId, projects });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/projects") {
      const body = await readBody(req);
      const created = registerProject(body);
      appendJournal({ kind: "project-register", projectId: created.id, name: created.name });
      sendJson(res, 200, { ok: true, project: created });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/project/switch") {
      const body = await readBody(req);
      const result = await switchProject(body.id);
      appendJournal({ kind: "project-switch", projectId: result.project.id, name: result.project.name });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      if (restarting) {
        sendJson(res, 503, { ok: false, restarting: true, project: activeProject });
        return;
      }
      try {
        const info = await fetch(`http://127.0.0.1:${agentPort}/v1/info`).then((response) => response.json());
        sendJson(res, 200, {
          ok: true,
          restarting: false,
          model: info.model,
          name: info.name,
          skills: info.skills ?? [],
          project: activeProject,
        });
      } catch {
        sendJson(res, 503, { ok: false, restarting: false, project: activeProject });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      sendJson(res, 200, { models: await fetchCatalog() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/model") {
      const body = await readBody(req);
      sendJson(res, 200, await applyModel(body));
      appendJournal({
        kind: "model",
        projectId: activeProject?.id ?? null,
        model: body.id,
        params: body.params ?? [],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/journal") {
      const body = await readBody(req);
      if (typeof body.role === "string" && typeof body.text === "string") {
        appendJournal({
          kind: "chat",
          projectId: activeProject?.id ?? null,
          role: body.role,
          text: body.text,
          sessionId: body.sessionId ?? null,
        });
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/v1/")) {
      proxy(req, res);
      return;
    }
    sendJson(res, 404, { ok: false, message: "没有这个页面。" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) sendJson(res, 400, { ok: false, message });
  }
});

server.listen(uiPort, "127.0.0.1", async () => {
  try {
    loadRegistry();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`WebAI console  http://127.0.0.1:${uiPort}/\n`);
  process.stdout.write(`agent project  ${activeProject.name} (${activeProject.id})\n`);
  process.stdout.write(`state-root    ${activeProject.stateRoot}\n`);
  if (await listeningPid(agentPort)) {
    process.stderr.write(
      `端口 ${agentPort} 已被占用；若历史不对，请在控制台切换项目以重启 agent。\n`,
    );
    return;
  }
  startServe();
  try {
    await waitForInfo();
    process.stdout.write(`agent ready  http://127.0.0.1:${agentPort}/\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
});
