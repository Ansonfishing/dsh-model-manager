# dsh-model-manager

**语言 / Language: [中文](README.md) | [English](README.en.md)**

本地 LLM 推理服务的「总控台」——DSH(DeepSeek Harness)插件。

![面板截图](screenshots/model-manager-panel.png)

## 为什么

本地同时跑几个推理服务(llama.cpp / SGLang / vLLM)时,参数散落在终端历史和笔记本里:这个模型该配哪套 `-c` / `-np`?显存到底够不够?哪个框架在这张卡上能起?

装好本插件,这些答案都在一个面板里:

- 之前:翻终端历史、手动算 KV、等 OOM 才知道配置超了;
- 之后:服务注册表一眼看清谁在哪张卡上跑,参数 Profile 保存前就校验显存,一键测速对比 tok/s。

## 快速开始

**前提**:DSH(带 web)+ pnpm;GPU 检测需要 python3(缺失时自动回退 `nvidia-smi`)。

```bash
cd ~/.dsh/profiles/web                      # 你的 DSH web profile 目录
pnpm add github:Ansonfishing/dsh-model-manager
```

然后在 `package.json` 的 `dsh.profile.bundles` 数组里加上 `"dsh-model-manager"`,重启 `dsh`。会话视图出现「模型管理」tab,就好了。

## 功能

- **服务注册表**——登记本地推理服务(端口、框架、模型、GPU),健康检查实时显示,一键停止。
- **参数 Profile**——每个「模型 × 框架 × GPU」组合的命名参数版本(llama.cpp / SGLang / vLLM),按框架官方参数顺序渲染,推荐值对照 + 差异高亮。
- **GPU 检测**——自动枚举显卡(`libcuda` 主源,`nvidia-smi` 回退);卡编号 = `CUDA_VISIBLE_DEVICES` 值。
- **显存校验**——保存 Profile 时按 `-c` / `-np` 估算 KV 占用,超出目标卡容量立刻 warning。
- **一键测速**——对已运行服务发固定 prompt(非流式 256 token),记录 tok/s。
- **安全红线**——绝不 `pkill`;11437(DSH 自身推理端口)停止前需二次确认。

## 不用装 DSH,先看看面板?

clone 本仓库,浏览器直接打开 `test/harness/index.html`——零依赖渲染 harness,用 mock 数据渲染完整面板,`?chrome=0` 隐藏 harness 顶栏。

## 本地 GPU 表(可选)

仓库不内置任何显卡映射。想让面板显示卡名和显存容量,创建 `~/.dsh/model-manager/builtin-gpus.local.json`:

```json
{
  "0": { "name": "RTX 4090", "memGb": 24 },
  "1": { "name": "RTX 6000 Ada", "memGb": 48 }
}
```

没有这个文件时面板回退为 "GPU 0 / GPU 1",显存校验自动跳过。

## 开发

```bash
npm test                          # node --test test/*.test.mjs
node build/build-client.cjs       # 从 mockup-v3.html 重新构建 lib/client.js
```

本地开发:clone 后在 profile 里用 `pnpm add link:../path/to/dsh-model-manager`。客户端改动浏览器 F5 即可;Node 侧(`index.js` / `lib/*.js`)改动需重启 `dsh`。

## 架构简述

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `index.js` | 注册 13 个工具 + 16 个同源路由 |
| 生命周期 | `lib/lifecycle.js` | 注册表 CRUD、健康探测、托管启动/停止 |
| 安全 | `lib/safety.js` | 停止策略(fuser/kill)、保护端口 |
| 校验 | `lib/validate.js` | launchCommand 解析 + 规则引擎 |
| GPU | `lib/gpu.js` | 检测 + 本地 GPU 表加载 |
| 适配 | `lib/adapters/*.js` | llama / sglang / vllm 命令拼装 |
| 客户端 | `lib/client.js` | React 单文件组件(由 mockup 构建) |

## 许可证

[MIT](LICENSE) © Ansonfishing
