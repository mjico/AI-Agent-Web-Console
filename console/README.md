# WebAI 控制台 · 多项目

控制台一次只代理一个本机 agent（端口 `3000`）。**Agent 项目**下拉框会重启 `agent-sdk serve`，并带上对应的 `--dir` 与 `--state-root`。

## 用 agent 启动

`D:\AI_Proj\webAI\bin` 已放在用户 PATH 最前面。在任意目录执行：

```text
agent
agent --continue
```

包装命令会先确认 http://127.0.0.1:3080/ 在运行。当前目录如果有 `bot/agent.ts`，网页会登记并切到这个项目。然后参数原样交给 Cursor 自带的 `agent.cmd`。新开的终端才能看到更新后的 PATH。

也可以双击 `D:\AI_Proj\webAI\start-console.cmd`，只开网页、不启动 CLI。

## 登记新项目

编辑 `console/projects.json`，在 `projects` 里追加一项：

```json
{
  "id": "my-agent",
  "name": "我的 Agent",
  "projectDir": "D:\\AI_Proj\\my-agent",
  "stateRoot": "D:\\AI_Proj\\my-agent\\.agent-state"
}
```

- `id`：小写字母开头，仅 `a-z0-9_-`。
- `projectDir`：已 `agent-sdk init` 的目录（需有 `bot/agent.ts`）。
- `stateRoot`：可省略，默认为 `projectDir/.agent-state`。
- 同一 `projectDir` 可配多个 `stateRoot`，用于隔离不同历史。

也可用 API 登记（控制台未开时先手写 JSON）：

```http
POST http://127.0.0.1:3080/api/projects
Content-Type: application/json

{ "id": "demo", "name": "Demo", "projectDir": "D:\\path\\to\\agent" }
```

切换项目：`POST /api/project/switch`，body `{"id":"my-agent"}`。

每个项目的 serve 日志：`console/serve-<id>.log`。
