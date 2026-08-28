# dsh-model-manager

Local inference server management panel — a plugin for DSH (DeepSeek Harness).

![Panel screenshot](screenshots/model-manager-panel.png)

## Features

- **Service registry** — register local inference servers (port, framework, model, GPU) with health checks and one-click stop.
- **Parameter profiles** — named parameter versions per model × framework × GPU for llama.cpp / SGLang / vLLM, rendered in each framework's official parameter order with recommended-value comparison and diff highlighting.
- **GPU detection** — auto-enumerates GPUs via `libcuda` (python3 ctypes), falling back to `nvidia-smi`; card index = the `CUDA_VISIBLE_DEVICES` value (CUDA device order).
- **VRAM validation** — estimates KV memory from `-c` / `-np` when saving a profile and warns when the target card cannot hold it.
- **One-click benchmark** — sends a fixed prompt (non-streaming, 256 tokens) to a running server and records tok/s.
- **Safety rails** — never uses `pkill`; port 11437 (DSH's own inference port) requires double confirmation before stopping.

## Install

```bash
# Install into a DSH web profile
pnpm add dsh-model-manager
# or link locally for development
dsh web --patch ./cordis.patch.yml --port 3090
```

After install, a "Model Manager" tab appears in the conversation view (order 41).

## Local GPU table (optional)

The repo ships **no** hardcoded GPU mappings. If you want card names and memory capacity shown in the panel, create:

```
~/.dsh/model-manager/builtin-gpus.local.json
```

Example:

```json
{
  "0": { "name": "4090", "memGb": 48 },
  "1": { "name": "PRO 6000", "memGb": 96 }
}
```

Without this file the panel falls back to "GPU 0 / GPU 1" and VRAM validation is skipped.

## Development

```bash
npm test                        # node --test test/*.test.mjs
node build/build-client.cjs     # rebuild lib/client.js from mockup-v3.html
```

See `test/harness/index.html` for a standalone browser render harness (mock data only).

## License

[MIT](LICENSE) © Ansonfishing
