# WebAI 控制台

网页和本机 Cursor CLI 共用一条会话。工作目录就是启动包装命令时的当前目录，不需要 `bot/agent.ts`。

Windows 和 Linux 的包装命令不同。Windows 仍使用 `agent`，只监听本机，打开网页不需要密码。Linux 使用 `cursor-web`，避免和 Cursor 自带的 `agent` 冲突；服务监听所有网卡，第一次打开网页要设置密码。

## Windows

`D:\AI_Proj\webAI\bin` 放在用户 PATH 最前面。在任意目录执行：

```text
agent
agent --continue
```

包装命令 `bin\agent.cmd` 会先确认 http://127.0.0.1:3080/ 在运行。新开会话时先 `agent create-chat`；`--continue` 或已有 `--resume` 则沿用原来的 chat id。然后打开：

```text
http://127.0.0.1:3080/?chat=<id>
```

终端里启动的是 Cursor 自带的 `agent.cmd --resume <id> --force --trust`。网页发来的消息写入同一条会话。同一条会话同时只处理一条网页消息。处理中继续发送会进入队列，当前这轮结束后按顺序执行。处理中可以按「终止」或 Esc 停掉当前这一轮。

再开一个终端执行 `agent` 会新建另一条会话，并再打开一个页面。两个页面可以同时对话。左侧列表能切到已经附着过的会话。同一个目录里的 `agent --continue` 会回到这个目录上一次启动的那条会话；如果本地还没记过，会按该目录在 Cursor 里最近的会话附着。找不到可继续的会话时，网页不会附着，终端仍按 CLI 自己的 `--continue` 启动。

也可以双击 `D:\AI_Proj\webAI\start-console.cmd`，只开网页、不启动 CLI。Windows 上的网页只监听 `127.0.0.1:3080`，不启用密码。

## Linux

Linux 不使用 `bin/agent`。包装命令是 `bin/cursor-web`，它调用本机的 `~/.local/bin/agent`（也可用环境变量 `CURSOR_AGENT_BIN` 指定），不会替换 Cursor 自带的 `agent`。

```bash
chmod +x bin/cursor-web bin/ensure-console.sh start-console.sh
ln -sfn "$(pwd)/bin/cursor-web" "$HOME/.local/bin/cursor-web"
```

`$HOME/.local/bin` 需要在 `PATH` 里。脚本会沿着符号链接找到仓库里的 `ensure-console.sh`。然后在工作目录执行：

```bash
cursor-web
cursor-web --continue
```

行为与 Windows 的 `agent` / `agent --continue` 相同：确认网页服务、创建或继续会话、再启动 Cursor CLI 的 `agent --resume <id> --force --trust`。终端会打印：

```text
http://127.0.0.1:3080/?chat=<id>
```

Linux 上的服务监听 `0.0.0.0:3080`，同一页面也可以用这台机器的局域网地址打开，例如 `http://192.168.0.33:3080/`。第一次打开时在页面上设置密码（至少 4 位）；如果是在终端前台第一次启动，会先在终端里要求设置。之后每次打开浏览器都要输入这个密码。密码以哈希写在 `console/auth.json`，权限 `600`，不提交到仓库。本机 `cursor-web` 附着会话仍走 `127.0.0.1`，不经过网页登录。

只开网页、不启动 CLI：

```bash
./start-console.sh
```

Node 先用 `WEB_AI_NODE`，再看 `.tools/node-home.txt` 里的 `bin/node`，最后用 `PATH` 里的 `node`。

本机附着过的会话记在 `console/cli-sessions.json`，不提交到仓库。

开发过程见 [HISTORY.md](./HISTORY.md)。
