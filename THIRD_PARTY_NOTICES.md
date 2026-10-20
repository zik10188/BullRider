# Third-Party Notices

BullRider is licensed under the [MIT](LICENSE) license. It reuses the third-party software listed below. Each project remains under its own license; nothing in this file changes those terms, and copyright notices are preserved as required.

## Runtime dependencies (npm)

| Package | Purpose | License | Source |
| --- | --- | --- | --- |
| [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis) | Plugin kernel (Context/Fiber/Service/Events) | MIT | [cordiverse/cordis](https://github.com/cordiverse/cordis) |
| [`@deepseek-ai/cordis-plugin-logger-console`](https://www.npmjs.com/package/@deepseek-ai/cordis-plugin-logger-console) | Console logger plugin | MIT | [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |

The complete dependency closure (including dev dependencies) is recorded in [`pnpm-lock.yaml`](pnpm-lock.yaml) and can be inspected with `pnpm licenses list`.

## Architecture and implementation references

- [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — MIT licensed. This project's "everything is a plugin" architecture and the capability-seam design patterns (market-data, signal, etc.) are inspired by and partially adapted from its implementation ideas.
- [Cordis](https://github.com/cordiverse/cordis) — MIT licensed, the plugin framework itself.

> The above projects retain their respective copyrights; they are credited here to fulfill the notice-preservation obligation of the MIT license.
