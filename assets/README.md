# 美术资源说明

## 来源

武将立绘与卡面来自开源项目 [noname（无名杀）](https://github.com/libccy/noname)（GPL-3.0）。
抓取脚本：`tools/art/fetch-art.mjs`，产出到 `apps/web/public/art/`。

**这些图片的著作权归原权利人所有。** 本项目是私人自用的娱乐项目，不发行、不商用。
如果要公开分发这个游戏，需要先把美术整套换掉（见下）。

## 当前产出

| 类别 | 数量 | 路径 |
|---|---|---|
| 武将立绘 | 25（标准包全员） | `apps/web/public/art/character/<id>.webp` |
| 卡面 | 38 | `apps/web/public/art/card/<name>.webp` |

缺 `huosha` / `leisha` 两张 —— 原作里火杀雷杀本就没有独立卡面，
前端回落到【杀】的图并叠一个火/雷角标（见 `apps/web/src/art.ts`）。

图片不进 git（`.gitignore` 里排除了 `apps/web/public/art/`），只有脚本和
`apps/web/src/art-manifest.json` 进版本库。换机器时重跑脚本即可。

## 重新抓取

```bash
node tools/art/fetch-art.mjs
```

脚本是幂等的：已处理过的图会跳过，可以反复跑。首次运行会把 noname 仓库
浅克隆到 `tools/.cache/noname`（只拉需要的文件，不是整包 2342 张）。

## 整套换图

代码不依赖任何具体图源 —— 所有查找都走 `apps/web/src/art-manifest.json`：

```json
{
  "character": { "caocao": "/art/character/caocao.webp", ... },
  "card":      { "sha": "/art/card/sha.webp", ... }
}
```

换一套图只需要两步：

1. 把新图放进 `apps/web/public/art/`（或任何前端能访问的路径）
2. 改 `art-manifest.json` 里的路径

组件侧不用动。武将 id 用的是拼音（`caocao`、`simayi`…），和
`packages/engine/src/generals.ts` 里的 id 一一对应；牌名同理，对应
`packages/engine/src/cards/`。

缺图时前端会自动降级成纯排版卡面（水墨底 + 中央大字牌名），不会开天窗。
