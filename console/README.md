# WebAI 控制台

网页和本机 Cursor CLI 共用一条会话。工作目录就是启动 `agent` 时的当前目录，不需要 `bot/agent.ts`。

## 用 agent 启动

`D:\AI_Proj\webAI\bin` 放在用户 PATH 最前面。在任意目录执行：

```text
agent
agent --continue
```

包装命令会先确认 http://127.0.0.1:3080/ 在运行。新开会话时先 `agent create-chat`；`--continue` 或已有 `--resume` 则沿用原来的 chat id。然后打开：

```text
http://127.0.0.1:3080/?chat=<id>
```

终端里启动的是 Cursor 自带的 `agent.cmd --resume <id> --force --trust`。网页发来的消息写入同一条会话。同一条会话同时只处理一条网页消息。处理中继续发送会进入队列，当前这轮结束后按顺序执行。处理中可以按「终止」或 Esc 停掉当前这一轮。

再开一个终端执行 `agent` 会新建另一条会话，并再打开一个页面。两个页面可以同时对话。左侧列表能切到已经附着过的会话。同一个目录里的 `agent --continue` 会回到这个目录上一次启动的那条会话；如果本地还没记过，会按该目录在 Cursor 里最近的会话附着。找不到可继续的会话时，网页不会附着，终端仍按 CLI 自己的 `--continue` 启动。

也可以双击 `D:\AI_Proj\webAI\start-console.cmd`，只开网页、不启动 CLI。

## Linux

Windows 的 `agent.cmd` 不会走这条路径。在 Linux 上把 `bin` 放进 `PATH`，并给脚本执行权限：

```bash
chmod +x bin/agent bin/ensure-console.sh start-console.sh
export PATH="/path/to/webAI/bin:$PATH"
```

然后同样执行 `agent` 或 `agent --continue`。包装脚本调用本机的 `~/.local/bin/agent`（也可用环境变量 `CURSOR_AGENT_BIN` 指定）。只开网页时：

```bash
./start-console.sh
```

Node 先用 `WEB_AI_NODE`，再看 `.tools/node-home.txt` 里的 `bin/node`，最后用 `PATH` 里的 `node`。网页仍是 http://127.0.0.1:3080/ 。从别的机器访问时请自行做隧道或反向代理。

本机附着过的会话记在 `console/cli-sessions.json`，不提交到仓库。

开发过程见 [HISTORY.md](./HISTORY.md)。
