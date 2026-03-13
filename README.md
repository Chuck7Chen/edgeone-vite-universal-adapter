# @edgeone/vite

Vite plugin adapter for deploying SSR applications to [EdgeOne Pages](https://edgeone.ai/products/pages). Built on [@universal-deploy/store](https://github.com/nicolo-ribaudo/vite-environment-8-universal-deploy), with out-of-the-box support for **Vite SSR**, **TanStack Start**, and **Vike**.

## Installation

> **Note:** This package is currently in beta. Install with the `beta` tag:

```bash
npm install @edgeone/vite@beta
```

**Peer dependency:** Vite 7 or 8.

## Quick Start

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

Vike's `renderPage()` does not conform to the Fetchable convention (`{ fetch(Request): Response }`), so a dedicated adapter is required:

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

> **SSR entry requirement:** The entry file must default-export a `{ fetch(request: Request): Response | Promise<Response> }` interface.

## API

### `edgeoneAdapter(options?)`

General-purpose adapter for frameworks that conform to the Fetchable convention (TanStack Start, standard Vite SSR, etc.).

### `edgeoneVikeAdapter(options?)`

Vike-specific adapter. Internally composes `vikeHandler` + `edgeoneAdapter()`, automatically wrapping `renderPage()` into a `{ fetch }` interface.

### Options

| Option      | Type      | Default      | Description                               |
| ----------- | --------- | ------------ | ----------------------------------------- |
| `outputDir` | `string`  | `".edgeone"` | Output directory for deployment artifacts |
| `verbose`   | `boolean` | `false`      | Enable verbose logging during build       |

## How It Works

The adapter is composed of 6 Vite plugins (the Vike variant adds 1 more):

| Plugin | Source | Purpose |
|--------|--------|---------|
| `edgeone:bundle-deps` | Adapter | Force-bundle all npm deps (EdgeOne has no `node_modules`) |
| `compat` | @universal-deploy/store | Auto-discover SSR entries from `rollupOptions.input` |
| `catchAll` | @universal-deploy/store | Generate a catch-all virtual module aggregating all registered entries |
| `resolver` | @universal-deploy/store | Resolve store virtual module IDs |
| `edgeone:apply-catch-all` | Adapter | Append the catch-all entry to the SSR build input |
| `edgeone:output` | Adapter | Generate EdgeOne deployment artifacts after build |
| `edgeone:vike-handler` | Adapter (Vike only) | Wrap `renderPage()` → `{ fetch }` and register with store |

After the build completes, the `edgeone:output` plugin:

1. Copies SSR build output into `<outputDir>/cloud-functions/ssr-node/`
2. Generates a bridge entry (`handler.js`) that converts Node.js `IncomingMessage` to Web `Request` (compatible with EdgeOne Pages bootstrap)
3. Copies static assets into `<outputDir>/assets/`
4. Generates `config.json` with route definitions from store-registered entries

## Build Output

```
.edgeone/
├── assets/                  # Client-side static assets
└── cloud-functions/
    └── ssr-node/
        ├── handler.js       # Bridge entry (adapter-generated, IncomingMessage → Request)
        ├── _handler.js      # Catch-all handler (Vite build output)
        ├── server.js        # Framework SSR entry
        ├── assets/          # Server-side chunks
        └── config.json      # EdgeOne Pages route config
```

## License

MIT
