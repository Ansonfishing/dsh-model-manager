# dsh-model-manager

**语言 / Language: [中文](README.md) | [English](README.en.md)**

本地推理模型管理面板——DSH（DeepSeek Harness）插件。

![面板截图](screenshots/model-manager-panel.png)

## 功能

- **服务注册表**：登记本地推理服务（端口、框架、模型、GPU），支持健康检查与一键停止。
- **参数 Profile**：为每个模型 × 框架 × GPU 组合维护命名参数版本（llama.cpp / SGLang / vLLM），按框架官方参数顺序渲染，支持推荐值对照与差异高亮。
- **GPU 检测**：自动通过 `libcuda`（python3 ctypes）枚举显卡，回退 `nvidia-smi`；卡编号 = `CUDA_VISIBLE_DEVICES` 值（CUDA 设备序）。
- **显存校验**：保存 Profile 时按 `-c / -np` 估算 KV 占用，超出目标卡容量即给出 warning。
- **一键测速**：对已运行服务发送固定 prompt 非流式生成 256 token，记录 tok/s。
- **安全红线**：绝不 `pkill`；11437（DSH 自身推理端口）需二次确认方可停止。

## 安装

在 DSH 的 web profile 目录（profile 的 `package.json` 所在目录，默认 `~/.dsh/profiles/web`）执行：

```bash
cd ~/.dsh/profiles/web
pnpm add github:Ansonfishing/dsh-model-manager
```

然后确认 `package.json` 的 `dsh.profile.bundles` 数组里包含 `"dsh-model-manager"`，重启 `dsh` 即可。安装后在会话视图 tab 列出现「模型管理」tab。

### 本地开发

clone 本仓库后在 profile 里用 link 依赖：

```bash
cd ~/.dsh/profiles/web
pnpm add link:../path/to/dsh-model-manager
```

客户端改动只需浏览器 F5；Node 侧（`index.js` / `lib/*.js`）改动需重启 `dsh`。

## 本地 GPU 表（可选）

仓库默认不内置任何显卡映射。若希望面板显示卡名与显存容量，创建：

```
~/.dsh/model-manager/builtin-gpus.local.json
```

示例：

```json
{
  "0": { "name": "RTX 4090", "memGb": 24 },
  "1": { "name": "RTX 6000 Ada", "memGb": 48 }
}
```

缺失时面板回退为 "GPU 0 / GPU 1"，显存校验自动跳过。

## 开发

```bash
npm test          # node --test test/*.test.mjs
node build/build-client.cjs   # 从 mockup-v3.html 重新构建 lib/client.js
```

构建链说明见 [build/build-client.cjs](build/build-client.cjs) 头部注释。

## 架构简述

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `index.js` | 注册 13 个工具 + 16 个同源路由 |
| 生命周期 | `lib/lifecycle.js` | 注册表 CRUD、健康探测、托管启动/停止 |
| 安全 | `lib/safety.js` | 停止策略（fuser/kill）、保护端口 |
| 校验 | `lib/validate.js` | launchCommand 解析 + 规则引擎 |
| GPU | `lib/gpu.js` | 检测 + 内置表加载 |
| 适配 | `lib/adapters/*.js` | llama / sglang / vllm 命令拼装 |
| 客户端 | `lib/client.js` | React 单文件组件（由 mockup 构建） |

## 许可证

[MIT](LICENSE) © Ansonfishing
