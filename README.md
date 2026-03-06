# @edgeone/vite

Vite plugin adapter for deploying SSR applications to [EdgeOne Pages](https://edgeone.ai/products/pages). Supports **Vite SSR**, **TanStack Start**, and **Vike** out of the box.

## Installation

```bash
npm install @edgeone/vite
```

**Peer dependency:** Vite 7 or 8.

## Usage

### TanStack Start

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin";
import { edgeoneAdapter } from "@edgeone/vite";

export default defineConfig({
  plugins: [tanstackStart(), edgeoneAdapter()],
});
```

### Vike

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vike from "vike/plugin";
import { edgeoneVikeAdapter } from "@edgeone/vite";

export default defineConfig({
  plugins: [vike(), edgeoneVikeAdapter()],
});
```

### Standard Vite SSR

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { edgeoneAdapter } from "@edgeone/vite";

export default defineConfig({
  build: { ssr: "src/entry-server.ts" },
  plugins: [edgeoneAdapter()],
});
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `outputDir` | `string` | `".edgeone"` | Output directory for deployment artifacts |
| `verbose` | `boolean` | `false` | Enable verbose logging during build |

## How It Works

After the SSR build completes, the adapter:

1. Copies the SSR build output into `<outputDir>/cloud-functions/ssr-node/`
2. Generates a bridge entry (`handler.js`) that converts Node.js `IncomingMessage` to Web `Request`, compatible with EdgeOne Pages bootstrap
3. Copies static assets into `<outputDir>/assets/`
4. Generates `config.json` with route definitions for EdgeOne Pages

## Build Output

```
.edgeone/
├── assets/              # Static client assets
├── cloud-functions/
│   └── ssr-node/
│       ├── handler.js   # Bridge entry (adapter-generated)
│       ├── _handler.js  # Catch-all handler (Vite build output)
│       ├── server.js    # Framework SSR entry
│       └── assets/      # Server-side chunks
└── config.json          # EdgeOne Pages route config
```

## Examples

- [`examples/tanstack-demo`](./examples/tanstack-demo) — TanStack Start
- [`examples/vike-starter`](./examples/vike-starter) — Vike

## License

MIT
