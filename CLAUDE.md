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
    skills/               75 个技能（武将 61 + 装备 14）
      util.ts             跨势力共用的小工具（拼点）
    generals.ts           39 将数值表（与 noname 官方数据核对过）
                          标准 25 + 风包 6 + 火包 8；DEFAULT_PACKS 是启用哪些包的唯一出处
    modes/identity.ts     身份局：分身份、选将、死亡奖惩、胜负判定
    modes/duel.ts         1v1 单挑：各带 3 将、阵亡换将、三将尽出即负
    ai/simple.ts          机器人（启发式，只读公开信息）
    cards/desc.ts         牌的效果说明与身份目标（面向玩家的文案）
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

1. `generals.ts` 加一条（**id 必须和 noname 的立绘文件名一字不差**，所以风火两包沿用了
   noname 的 `re_` / `old_` / `sp_` 前缀 —— 那是它区分同名武将不同版本的方式，
   比如 `sp_zhugeliang`（卧龙）和标准包的 `zhugeliang` 是两个武将）
2. `skills/<势力>.ts` 加技能实现
3. `tools/art/fetch-art.mjs` 的清单里加上 id，重跑脚本拿立绘
4. `tools/audio/fetch-voice.mjs` 的 `SKILL_VOICE_MAP` 加技能 id，重跑脚本拿台词

> ⚠️ **技能 id 打错字不会报错。** 引擎查技能表全是 `?.`，查不到就静默忽略 ——
> 武将会带着一个永远不发动的技能上场，压测也不会红。加完武将跑一次这个对账：
> 遍历 `GENERALS` 里每个 `skills[]`，确认在 `ALL_SKILLS` 里都查得到。

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
pnpm test                             # 87 项单测 + 10 项 DO 端到端
pnpm soak 500 8                       # 500 局 8 人身份局
pnpm --filter @sgs/engine soak 500 2 random duel   # 500 局单挑
```

> **看压测输出的第一行，不要只看最后那个 ✅。** 这里挂过一个假绿灯：`pnpm ... soak 500 5`
> 会把 `"500 5"` 当**一个**参数传进来，于是 `Number("500 5")` = `NaN`、循环一局都不跑，
> 却照样打印「✅ 无崩溃」。入口现在按空白拆一次参数，并且跑不满局数直接 exit 1，
> 但**「跑了 500/500 局」那行数字才是证据**。

`soak` 是主力工具：用随机决策把规则空间反复跑穿。**崩溃时它会打印出那一局的
`seed` 和完整决策日志** —— 拿这两样构造一个 `GameRecord` 就能精确重现现场，
不需要"我也遇到过但复现不了"。

改完引擎至少跑 `pnpm soak 500 5`、`pnpm soak 500 8` 和单挑那条，零崩溃才算过。

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

- 牌堆 157 张。**早期我在文档里写过"官方是 160–161，差 4 张"，那个数字没有出处，
  是凭记忆写的，已删除**——挂着一个没根据的数字会让人去修一个可能不存在的问题。
  实际核对（对 noname 的 `card/standard.js`，标准包 108 张 32 种）：基本牌每一项
  都与官方军争一致（杀类合计 44、闪 24、桃 12、酒 5），唯一差别是火杀/雷杀的内部
  分配（我们 5/9，常见版本 6/8），合计相同。锦囊和装备的构成也与军争篇吻合。
  **结论：没有已知偏差。** 若日后拿到权威军争牌表再逐张比对。
- 机器人是 `src/ai/simple.ts` 的启发式 AI，不是搜索/学习型的。它有两条自我约束：
  **只读公开信息**（自己手牌 + 所有人体力/装备/手牌数 + 明置身份 + 战报日志），
  **不做规则判断**（能出什么牌全读引擎给的 `options`，所以不可能违规）。
  当前平衡（39 将池 + 无懈修好之后重测）：8 人 主公方37/反贼61/内奸2。
  历史数字（25 将池、无懈还是死牌时）：5 人 52/41/7，6 人 38/58/4，8 人 45/52/3 ——
  **不要拿新旧数字直接对比**，中间换了两个变量。
  用 `pnpm soak 500 8 ai` 看机器人对局的胜负分布。
  **掉线托管不走 AI**，仍用 `submitAuto()` 的安全默认值 —— 替别人乱出牌比什么都不做更糟。
  改 AI 时注意：**绝不能用 `g.rng`**，必须传独立随机流，否则重放会静默错位（原因见文件头注释）。
- 已有身份局和 1v1 单挑。再加新模式（国战等）写新的 `Game` 子类即可 —— 引擎核心
  与模式无关。`modes/duel.ts` 是个好样板：它靠覆写 `die()` 实现"阵亡换将"，
  **`game.ts` 一行没改**，所以身份局完全不受影响。
- 前端已有：出牌飞行动画、伤害/回血飘字、音效、开局引导、牌的效果说明、
  聊天 / 快捷语 / 表情、武将技能台词（59 个技能有台词，马术和奇才是纯 mod 技能，
  官方本来就没有发动时刻，不是抓取失败）。

**修过的坑：【无懈可击】曾经一张都打不出来。** `game.ts` 用 `need: 'wuxie'` 发询问，
而牌名是 `'wuxiekeji'`，`options.ts` 的 `respond()` 拿 `card.name !== need` 筛手牌 ——
永远筛不出东西、`opts` 恒为空、询问从来没发出去过。牌堆里 7 张无懈全程是死牌，
连带 `ai/simple.ts` 里那段「忠臣该不该替主公挡锦囊」也是死代码。
**它能活这么久，是因为压测发现不了它**：随机代理只从引擎给的 `options` 里挑，
引擎不给它就永远不选，「没人能挡」和「没人想挡」在统计上长得一模一样。
教训是 `RespondAsk.need` 必须写牌名全称，以及**「某个入口从来没被走到过」这类缺陷
需要专门的断言去钉**（见 `test/wuxie.test.ts`）。

**风包 / 火包已知偏差**（都是引擎缺能力，不是实现偷懒，要补得动 `game.ts`）：

- **周泰、于吉没做**。不屈要求「武将牌上的牌」这个区域，而 `types.ts` 的 `Zone`
  是封闭联合类型；蛊惑要求一整套「扣置声明 + 依次质疑 + 展示验真」子系统。
- **小乔的红颜、张角的黄天没做**。红颜要求全局把黑桃视为红桃，但引擎有 16 处
  直接读 `card.suit`、没有集中访问器（noname 是靠 `get.suit(card, player)` 这一个
  读取点 + `mod.suit` 实现的）；黄天是「别人在自己回合发动」，而 `options.ts` 的
  active 枚举只看 `p.skills`，没有「全局技能」概念。
- **天义缺一项**：赢了之后「使用【杀】可额外指定一个目标」没做 —— `ModSpec` 没有
  额外目标钩子，目标数由 `CardDef` 写死后经 `options.ts` 直接下发。
  另外「无距离限制」是用 `distanceFrom` 压距离等效实现的（`ignoreDistance` 对【杀】
  是死代码，只有【顺手牵羊】消费它），副作用是那一回合顺手牵羊也不受距离限制。
- **雷击接不住八卦阵**。`game.ts` 的 `askForCard` 里，`beforeAskForCard` 类技能
  （八卦阵、护驾）直接写 `ev.use` 后提前 return，不经过 `onRespond`，所以「视为
  打出了一张【闪】」对雷击是隐形的。官方八卦阵+雷击是成立的连招。
- **血裔不上战报**。`handLimit()` 不像 `shaLimit()`/`shanNeeded()` 那样调 `noteSkill()`，
  袁绍手牌上限被抬高时战报一个字都没有，玩家只会觉得「弃牌阶段怎么没让我弃」。

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
