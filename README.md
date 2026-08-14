# 三国杀 · 联机版

朋友之间玩的三国杀。网页版，点链接就能进，5–8 人身份局，标准包 25 将 + 军争牌堆。

## 跑起来

```bash
pnpm install
pnpm --filter @sgs/web build      # 前端产物由 Worker 托管
pnpm --filter @sgs/server dev     # http://localhost:8787
```

## 部署到 Cloudflare（0 元）

```bash
pnpm exec wrangler login          # 一次性，浏览器授权
pnpm deploy                       # 构建前端 + 部署 Worker
```

## 架构

```
packages/engine/   纯 TS 规则引擎，零依赖，可脱离 Cloudflare 单测
  ├─ game.ts       结算栈 / 时机总线 / 事件溯源的 ask 机制
  ├─ options.ts    合法动作枚举（前端不做任何规则推导）
  ├─ view.ts       按玩家视角裁剪状态（防作弊边界）
  ├─ cards/        军争牌堆 157 张
  ├─ skills/       标准包 40 个技能
  └─ modes/        身份局
apps/server/       Cloudflare Worker + Durable Object（一房间一 DO）
apps/web/          React + Vite 牌桌
```

### 为什么用事件溯源

一局游戏 = `随机种子 + 玩家决策日志`。Durable Object 会休眠，async 调用栈保不住，
所以不存游戏状态，只存决策日志 —— 醒来时重放（几百个决策，毫秒级）就回到断点。

顺带白拿三件事：断线重连、观战回放，以及**任何 bug 都能用 `seed + 决策日志` 精确复现**。

## 验收

```bash
pnpm --filter @sgs/engine test    # 42 项
pnpm soak 500 8                   # 无头随机对局压测
```

压测崩溃时会直接打印失败局的 seed 和完整决策日志。
