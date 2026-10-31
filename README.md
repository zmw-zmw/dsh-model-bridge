# dsh-model-bridge

把 **DeepSeek Harness (dsh)** 的模型和 agent 能力暴露成一个 **MCP server**，让任何说 MCP 的
agent（ZCode、Claude Code、Cursor、Cline……）都能调用 dsh 的模型，并委派任务给 dsh agent 协作。

dsh 自带 MCP **client**（去调别人的 server），但一直没有反向的出口；本插件补上这一环：

```
外部 agent (MCP client) ──MCP──► dsh-model-bridge（dsh 插件）─进程内─► dsh 运行时
                                                     ctx.llm / ctx.agents.create
```

## 暴露的 MCP 工具

| 工具 | 说明 |
|---|---|
| `dsh_model_list` | 列出 harness 里所有 provider 及其模型（官方 DeepSeek、workbuddy-ai 接入的模型等），agent 用它发现可用的 (provider, model) 组合 |
| `dsh_chat` | 直接调 dsh 的模型；支持 `session_id` 多轮、`role` 预设（reviewer / architect / brainstormer）、自定义 system prompt |
| `dsh_agent_run` | 把一个任务委派给全新的一次性 dsh agent（可用 dsh 工具集，默认只读），跑完返回最终答案 |
| `dsh_session_list` / `dsh_session_close` | 管理桥接会话 |

## 安装（dsh 侧）

```bash
# 从本地目录装进 web profile（发布后可换 npm 包名或 github:...）
dsh plugin --profile web add /path/to/dsh-model-bridge
```

然后在你的 `cordis.patch.yml`（用户层 patch）里挂载：

```yaml
- insert:
  - id: model-bridge
    name: dsh-model-bridge
    config:
      port: 3091
      # authToken: 留空，用环境变量 DSH_BRIDGE_TOKEN 提供
      defaultModel: deepseek-flash
```

启动 harness 后插件即在 `http://127.0.0.1:3091/mcp` 提供 MCP Streamable HTTP 服务：

```bash
dsh web --no-open
# 日志会出现：dsh-model-bridge: MCP endpoint on http://127.0.0.1:3091/mcp
```

## 接入（agent 侧）

**ZCode / Claude Code（Streamable HTTP）**——MCP 配置里加：

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:3091/mcp",
      "headers": { "Authorization": "Bearer <DSH_BRIDGE_TOKEN>" }
    }
  }
}
```

**只支持 stdio 的 host**——用自带的 stdio 代理（读取 `DSH_BRIDGE_URL` / `DSH_BRIDGE_TOKEN`）：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "npx",
      "args": ["-y", "dsh-model-bridge-mcp"],
      "env": { "DSH_BRIDGE_URL": "http://127.0.0.1:3091/mcp", "DSH_BRIDGE_TOKEN": "..." }
    }
  }
}
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址；保持回环除非你清楚风险 |
| `port` | `3091` | MCP HTTP 端口 |
| `httpPath` | `/mcp` | MCP 端点路径 |
| `authToken` | `""` | Bearer token；空=不鉴权（仅限本机）。建议用环境变量 `DSH_BRIDGE_TOKEN`（优先级更高） |
| `defaultProvider` | 首个已注册 provider | 模型路由 |
| `defaultModel` | `deepseek-chat` | 默认模型 id |
| `agentAllowTools` | `[]` | 非空则委派 agent 只见这些工具（allow 优先） |
| `agentDenyTools` | `bash, bash_persistent, pwsh, pwsh_persistent, str_replace_editor, write` | 委派 agent 的工具黑名单 |
| `agentTimeoutMs` | `600000` | 单次 `dsh_agent_run` 预算 |
| `stateDir` | `~/.dsh-model-bridge` | 多轮会话历史落盘目录 |

## 安全设计

- 默认只绑回环地址；设了 token 则常量时间比较校验。
- 委派的 agent 默认**只读**（bash/写工具被拒），需在配置中显式放开。
- stdio 子进程不继承任何 dsh 凭证；token 只在客户端侧 env 中。

## 开发与测试

```bash
npm install
npm run build          # tsc -> lib/
node test/protocol-test.mjs   # 8 个 MCP 协议用例（stub harness，零模型调用）
node test/stdio-test.mjs      # stdio 代理端到端
```

测试全部基于 stub harness，不消耗任何模型额度。真实 harness 的联调：
启动 `dsh web --no-open` 后用任意 MCP client 连 `http://127.0.0.1:3091/mcp` 执行 tools/list 即可。

## 兼容性

针对 dsh `0.2.1-rc.5`（developer preview，peerDependencies 已锁定）。dsh 上游 breaking
change 最可能影响 `ctx.llm` / `ctx.agents` 调用面；逻辑集中在 `src/bridge.ts`，升级时只需对齐该文件。

## 更新日志

### 0.1.1

- 🔴 修正 cordis 注入声明：`inject` 从 `[]` 改为 `["llm", "agents"]` —— 此前 apply 后访问
  `ctx.llm` / `ctx.agents` 抛 `cannot get property "llm" without inject`，所有工具返回
  `BRIDGE_ERROR`（服务名来自官方包：dsh-agent 的 AgentRegistry 构造 `super(ctx, "agents")`）。
- 未登录的 provider（如 `deepseek-official`）返回零产出流时，现在显式抛 `EMPTY_STREAM`
  错误并提示在 dsh 界面登录，而不是静默返回空文本。
- 兼容性实测：DSH `0.2.1-rc.5`（desktop profile）+ workbuddy-ai 全模型路由可用。

### 0.1.0

首个可用版本。

## 多 agent 协作（0.2.0）

核心原语：**后台作业 + 并发池**。调用方 agent（ZCode / Claude Code）是编排者，
bridge 只负责并发上限与作业状态。

| 工具 | 说明 |
|---|---|
| `dsh_agent_start` | 后台委派：立刻返回 `jobId`，agent 在后台跑（最多 `agentMaxConcurrent` 个同时，多余排队） |
| `dsh_agent_status` | 查单个作业：`queued → running → done / error / cancelled`，done 时带最终答案 |
| `dsh_agent_list` | 列出全部作业（新→旧），label 为任务前缀 |
| `dsh_agent_cancel` | 取消排队/运行中的作业（运行中的会收到 abort 信号） |

典型编排（以扇出评审为例）：

```text
1. dsh_agent_start ×3（三个不同视角的 review 任务，同一仓库不同侧重）
2. 期间用 dsh_agent_list 看进度
3. 全部 done 后逐个 dsh_agent_status 收割结果，由编排者汇总
```

配置新增：

| 键 | 默认 | 说明 |
|---|---|---|
| `agentMaxConcurrent` | `3` | 同时最多几个一次性 agent 在跑 |
| `jobTtlMs` | `3600000` | 已完成作业的保留时长（过后自动清理） |

## 更新日志

### 0.2.0

- **多 agent 协作**：新增 `dsh_agent_start` / `dsh_agent_status` / `dsh_agent_list` /
  `dsh_agent_cancel` 后台作业工具与并发池（`agentMaxConcurrent`，默认 3；
  超出的任务 FIFO 排队）。阻塞式 `dsh_agent_run` 保留，适合快任务。
- 新增 `src/jobs.ts` 通用作业管理器（并发信号量 / 状态机 / TTL 清理 / 可注入时钟）。
- 测试：`test/jobs-test.mjs`（JobManager 语义 5 项 + MCP 端到端 4 项，含真实并发分布断言），
  原协议/stdio 测试同步更新到 9 工具。

### 0.1.1

- 🔴 修正 cordis 注入声明：`inject` 从 `[]` 改为 `["llm", "agents"]` —— 此前 apply 后访问
  `ctx.llm` / `ctx.agents` 抛 `cannot get property "llm" without inject`，所有工具返回
  `BRIDGE_ERROR`（服务名来自官方包：dsh-agent 的 AgentRegistry 构造 `super(ctx, "agents")`）。
- 未登录的 provider（如 `deepseek-official`）返回零产出流时，现在显式抛 `EMPTY_STREAM`
  错误并提示在 dsh 界面登录，而不是静默返回空文本。
- 兼容性实测：DSH `0.2.1-rc.5`（desktop profile）+ workbuddy-ai 全模型路由可用。

### 0.1.0

首个可用版本。
