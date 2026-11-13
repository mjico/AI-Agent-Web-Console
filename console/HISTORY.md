# WebAI 开发历史

## 2026-11-13

- 修复页面脚本多出一个 `}` 导致整页 JS 不执行，左侧会话列表和历史空白。
- 会话忙时继续发送会进入队列，不再把「正在处理」画成失败；远端仍忙时也会排队，空闲后自动发出。
- 对话区顶部固定当前问题；记录里保留用户气泡并用青色区分。
- 每轮展示顺序改为：问题 → 工具步骤 → 结论；结束后显示「本轮已结束」。
- 支持终止当前轮（Esc / 终止按钮）、输入历史上下键、CLI 选择题面板。

## 2026-11-12

- 控制台从 Agent SDK 代理改为本机 Cursor CLI 共用会话：网页消息走 `stream-json`，终端进度读 agent-transcripts。
- 支持多会话并行；同一会话同时只处理一条网页消息。
- `agent --continue` 按目录附着：本地记录 → 控制台会话 → 有 transcript 的 Cursor 会话。
- 历史只加载最近几轮，降低大 transcript 卡顿；流式增量合并，避免一字一气泡。
- 监控时间线：步骤耗时、可视化改动、类型过滤（修改 / 命令 / 读取等）。
- 发送快捷键 Alt+S，按钮上显示提示。
- 增加 Linux 支持：`bin/agent`、`bin/ensure-console.sh`、`start-console.sh`；Windows 路径保持不变。
- 忽略运行态文件：`cli-sessions.json`、`last-by-cwd.json`、`bin/last-launch.txt`。

## 更早

- 初版控制台发布到 GitHub：`mjico/AI-Agent-Web-Console`。
- 早期曾通过 Agent SDK `serve` 与多项目下拉切换；现已改为直接对接 Cursor CLI。
