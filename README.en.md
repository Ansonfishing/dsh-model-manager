# dsh-model-manager

**Languages: [English](README.en.md) | [中文](README.md)**

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

In your DSH web profile directory (the directory with the profile's `package.json`, default `~/.dsh/profiles/web`):

```bash
cd ~/.dsh/profiles/web
pnpm add github:Ansonfishing/dsh-model-manager
```

Then make sure `dsh.profile.bundles` in `package.json` includes `"dsh-model-manager"`, and restart `dsh`. A "Model Manager" tab then appears in the conversation view.

### Local development

Clone this repo and use a `link:` dependency in your profile:

```bash
cd ~/.dsh/profiles/web
pnpm add link:../path/to/dsh-model-manager
```

Client-only changes need a browser refresh; Node-side changes (`index.js` / `lib/*.js`) need a `dsh` restart.

## Local GPU table (optional)

The repo ships **no** hardcoded GPU mappings. If you want card names and memory capacity shown in the panel, create:

```
~/.dsh/model-manager/builtin-gpus.local.json
```

Example:

```json
{
  "0": { "name": "RTX 4090", "memGb": 24 },
  "1": { "name": "RTX 6000 Ada", "memGb": 48 }
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
