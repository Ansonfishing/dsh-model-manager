# 贡献指南

感谢关注！欢迎 PR。

## PR 要求

- **测试必须全绿**：`npm test`（node --test，零依赖）。
- **小步 PR**：一个 PR 只解决一件事，附简要说明动机。
- **不提交个人路径与配置**：本机约定（显卡映射、模型路径、个人笔记）一律不入库；个人配置放在 `~/.dsh/model-manager/` 下。
- **不提交真实环境信息**：路径、API key、token、私有模型名、个人文档引用一律脱敏。
- **commit 规范**：`type(scope): 简述`，type ∈ feat / fix / docs / test / chore。
- 改 UI 请同步重建 `lib/client.js`（`node build/build-client.cjs`），两者必须一致。

## 本地开发

```bash
npm test                     # 全部单测
node build/build-client.cjs  # mockup → lib/client.js
dsh web --patch ./cordis.patch.yml --port 3090   # 开发预览
```

## 许可证

MIT（见 [LICENSE](LICENSE)）。
