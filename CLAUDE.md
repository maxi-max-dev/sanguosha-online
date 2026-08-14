# 给接手的 AI / 开发者

这是一个自用的联机三国杀。先读完这一页再动代码 —— 有一条架构约束一旦破坏，
表面上一切正常，但断线重连和房间恢复会静默出错，很难查。

---

## 一句话架构

**一局游戏 = 随机种子 + 玩家决策日志。游戏状态从不存储，永远是重放出来的。**

原因：后端跑在 Cloudflare Durable Object 上，DO 会休眠（这是免费额度内运行的前提），
休眠时内存里的 `Game` 对象连同它的 async 调用栈一起消失。三国杀的结算天然是深度嵌套的
（杀 → 闪 → 技能 → 判定 → 再触发；锦囊 → 无懈 → 无懈 → …），改写成可序列化的显式状态机
会失控。所以我们不保存状态，只保存决策日志，醒来时重放（一局几百个决策，毫秒级）。

副产品：断线重连、观战回放、以及**任何 bug 都能用 `seed + 决策日志` 精确复现**。

### 🔴 唯一的硬约束

> **引擎里不允许出现决策日志之外的随机性或副作用。**

具体地说，在 `packages/engine/` 里：

- 所有随机**必须**走 `this.rng`（`Rng` 类，mulberry32）。**禁止 `Math.random()`**。
- 所有玩家输入**必须**走 `this.ask()`。禁止任何其他等待外部输入的方式。
- 禁止读取 `Date.now()` 之类的环境状态来影响规则判断（日志里的 `at` 字段仅供展示）。

破坏这条的后果不是立刻报错，而是重放出来的牌局和原来不一样 —— 玩家会看到手牌
莫名其妙变了。`test/core.test.ts` 里有专门测这个的用例，改引擎后务必跑。

---

## 目录

```
packages/engine/          纯 TS 规则引擎，零运行时依赖，可脱离 Cloudflare 单测
  src/
    rng.ts                确定性随机（唯一的随机源）
    types.ts              领域模型。所有类型必须可 JSON 序列化
    protocol.ts           AskRequest / Decision —— 引擎与玩家的交互契约
    defs.ts               CardDef / SkillDef / GeneralDef —— 内容的实现接口
    game.ts               ★ 核心：ask 双模式、时机总线、结算栈、伤害/濒死/判定
    options.ts            合法动作枚举（服务端算好下发，客户端零规则推导）
    view.ts               ★ 按玩家视角裁剪状态 —— 防作弊边界
    deck.ts               牌堆构建（157 张）
    cards/                军争牌堆实现
    skills/               标准包 40 个技能 + 装备技能
    generals.ts           25 将数值表（与 noname 官方数据核对过）
    modes/identity.ts     身份局：分身份、选将、死亡奖惩、胜负判定
    registry.ts           把上面这些拼成引擎需要的 Registry
    wire.ts               客户端 ↔ 服务端报文类型（web 和 server 共用）
    tools/soak.ts         ★ 无头随机对局压测（验收主力工具）
apps/server/              Cloudflare Worker + Durable Object
  src/index.ts            路由：发房间码、把 WebSocket 转给对应 DO
  src/room.ts             ★ RoomDO：一房间一实例，决策日志落 SQLite
apps/web/                 React + Vite 牌桌
  src/store.ts            zustand + WebSocket
  src/components/Table.tsx  牌桌 UI
  src/styles/tokens.css   设计令牌（换皮肤只改这里）
tools/art/fetch-art.mjs   美术抓取脚本
```

`★` 标记的是改动前最好先读懂的文件。

---

## 三条设计原则

**1. 规则只有一份实现，在服务端。**
客户端**不做任何规则推导**。哪张牌能点、能点谁、要选几张，全部由 `options.ts`
算好，随 `AskRequest` 下发。好处是客户端改不了规则（防作弊），以及规则不会前后端漂移。
加新牌新技能时，如果发现"前端也得判断一下"，那是设计错了 —— 应该让服务端多下发一个字段。

**2. 玩家只能看到他该看到的。**
服务端**永远只发 `buildView()` 的输出**，绝不广播 `GameState`。别人的手牌只给 id
不给牌面（`cards` 字典里没有该条目）。id 与牌面的映射每局随种子重新随机
（见 `game.ts` 的 `initState`），所以知道 id 也推不出牌 —— 这一步不能删。

**3. 牌的移动只走 `moveCards()`。**
它是 `state.locations` 的唯一写入口，也是"失去牌/获得牌"类技能（枭姬、连营、奸雄）
的触发点。绕过它直接改 `player.hand` 会让位置表和实际区域不一致，相关技能静默漏触发。
`test/core.test.ts` 的「牌的守恒」用例专门查这个。

---

## 怎么加内容

### 加一张牌

在 `src/cards/` 对应文件里加一个 `CardDef`，然后在 `deck.ts` 里给它花色点数。
接口看 `defs.ts`，照着 `cards/basic.ts` 里的【杀】写最直观。

### 加一个武将

1. `generals.ts` 加一条（id 用拼音，要和立绘文件名一致）
2. `skills/<势力>.ts` 加技能实现
3. `tools/art/fetch-art.mjs` 的清单里加上 id，重跑脚本拿立绘

技能有四种能力，按需组合（见 `defs.ts` 的 `SkillDef`）：

| 能力 | 用途 | 例子 |
|---|---|---|
| `triggers` | 在某个时机做点什么 | 奸雄（受伤后拿牌） |
| `active` | 出牌阶段的主动技按钮 | 制衡、苦肉 |
| `convert` | 把某类牌当另一张牌用 | 武圣、龙胆 |
| `mods` | 持续改变规则计算 | 马术（距离-1）、咆哮（杀无限） |

`mods` 的每个钩子都需要引擎里有对应的**消费点**才生效。加新 mod 时记得
在 `game.ts` 里加聚合方法（照着 `shaLimit()` / `shanNeeded()` 写），
否则它就是死代码 —— 这个坑我们踩过。

### 时机不够用怎么办

`types.ts` 的 `Timing` 是全部可挂载的钩子。加新时机必须**同时**在 `game.ts` 里
补上对应的 `trigger()` 调用点，否则技能永远不会被触发。

---

## 验收

```bash
pnpm install
pnpm --filter @sgs/engine test        # 42 项单测
pnpm soak 500 8                       # 500 局 8 人无头随机对局
```

`soak` 是主力工具：用随机决策把规则空间反复跑穿。**崩溃时它会打印出那一局的
`seed` 和完整决策日志** —— 拿这两样构造一个 `GameRecord` 就能精确重现现场，
不需要"我也遇到过但复现不了"。

改完引擎至少跑 `pnpm soak 500 5` 和 `pnpm soak 500 8`，零崩溃才算过。

---

## 跑起来 / 部署

```bash
pnpm install
pnpm --filter @sgs/web build          # 前端产物由 Worker 托管
pnpm --filter @sgs/server dev         # http://localhost:8787
```

```bash
pnpm cf:login                         # 一次性，浏览器授权 Cloudflare
pnpm cf:deploy
```

> **脚本名必须带 `cf:` 前缀。** `login` / `whoami` / `deploy` 都是 pnpm 的内置命令，
> 优先级高于 package.json 脚本，会被静默劫持（`pnpm login` 会去登录 npmjs.org，
> `pnpm deploy` 跑的是 pnpm 自己的包部署）。这个坑我们踩过两次。

Cloudflare 免费版**只支持 SQLite 后端的 Durable Object**，所以 `wrangler.jsonc` 里
必须是 `new_sqlite_classes`，不能改成 `new_classes`。

---

## 美术

立绘和卡面来自开源项目 [noname](https://github.com/libccy/noname)（GPL-3.0），
**图片著作权归原权利人**，这是私人自用项目，不发行不商用。

图片**不进 git**（`.gitignore` 排除了 `apps/web/public/art/`）。首次 clone 后跑：

```bash
node tools/art/fetch-art.mjs
```

脚本幂等，会浅克隆 noname 到 `tools/.cache/` 只取需要的文件。

代码不依赖任何具体图源 —— 所有查找走 `apps/web/src/art-manifest.json`。
要整套换图（比如为了能公开分发），只改这个 json 的路径即可，组件侧不用动。
缺图时前端自动降级成纯排版卡面，不会开天窗。

已知缺 `huosha` / `leisha` 两张：原作里火杀雷杀本就没独立卡面，前端回落到
【杀】的图加火/雷角标（见 `apps/web/src/art.ts`）。

---

## 已知偏差与待办

**刻意的规则偏差**（原作者拍板，可改回）：

- **集智、连营、枭姬、闭月**官方是可选技（「你**可以**摸一张牌」），这里做成了锁定技
  自动生效。理由：拒绝发动永远没好处，而每次触发都弹确认框是自制三国杀最大的体验杀手
  （枭姬一局能弹十几次）。要改回严格规则，各加一行 `tags: []` 即可。
- **克己**整个技能设成锁定技。这个**不建议改**：它内部有个"本回合是否打出过杀"的
  记账钩子，如果记账走确认框，理性玩家会永远拒绝确认来逃避记账 —— 那是漏洞不是选择。

**已知不足**：

- 牌堆 157 张，官方军争篇是 160–161，差在火杀/雷杀的花色分配版本差异。
- 【铁索连环】的"重铸"没做（代码里标了 TODO）。
- 机器人是 `src/ai/simple.ts` 的启发式 AI，不是搜索/学习型的。它有两条自我约束：
  **只读公开信息**（自己手牌 + 所有人体力/装备/手牌数 + 明置身份 + 战报日志），
  **不做规则判断**（能出什么牌全读引擎给的 `options`，所以不可能违规）。
  当前平衡：5 人局主公方 50% / 反贼 42% / 内奸 7%；8 人局反贼 66%（偏反贼，还能调）。
  用 `pnpm soak 500 8 ai` 看机器人对局的胜负分布。
  **掉线托管不走 AI**，仍用 `submitAuto()` 的安全默认值 —— 替别人乱出牌比什么都不做更糟。
  改 AI 时注意：**绝不能用 `g.rng`**，必须传独立随机流，否则重放会静默错位（原因见文件头注释）。
- 只有身份局。1v1、国战等要加新的 `Game` 子类 —— 引擎核心与模式无关，
  模式层只管开局布置、死亡奖惩、胜负判定，照着 `modes/identity.ts` 写。
- 前端没有出牌动画（只有卡牌进出场的淡入），战报是纯文字。

---

## 调试一局出问题的牌

服务端把决策日志存在 DO 的 SQLite 里（`decisions` 表）。拿到 `seed` 和日志后：

```ts
const g = new IdentityGame({ seed, setup, decisions }, registry);
g.optionProvider = optionProvider;
void g.runGame();
await g.waitIdle();
// 此时 g.state 就是出问题那一刻的精确状态
```

日志和请求对不上时引擎会抛 `ReplayDesyncError` 而不是将错就错 —— 看到这个错
说明有地方破坏了上面那条硬约束。
