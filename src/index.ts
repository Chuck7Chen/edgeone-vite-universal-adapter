import path from "path";
import fs from "fs/promises";
import type { Plugin, ResolvedConfig } from "vite";
import { catchAllEntry } from "@universal-deploy/store";
import { catchAll, resolver, compat } from "@universal-deploy/store/vite";
import { createVikeHandlerPlugin } from "./vike-handler.js";
import { prepareOutputDir } from "./platform/output.js";
import { copyStaticAssets } from "./platform/static-assets.js";
import { generateEdgeOneConfigJson } from "./platform/config-json.js";

export interface EdgeOneAdapterOptions {
  /** @default ".edgeone" */
  outputDir?: string;
  /** @default false */
  verbose?: boolean;
}

function createLogger(verbose: boolean) {
  return {
    log: (msg: string) => console.log(`[EdgeOne] ${msg}`),
    verbose: (msg: string) => {
      if (verbose) console.log(`[EdgeOne] ${msg}`);
    },
    warn: (msg: string) => console.warn(`[EdgeOne] ⚠  ${msg}`),
  };
}

/**
 * Force all npm dependencies to be bundled into the SSR output.
 * EdgeOne Pages runs as edge functions without node_modules,
 * so every dependency must be inlined into the build artifacts.
 */
function createBundleDepsPlugin(): Plugin {
  return {
    name: "edgeone:bundle-deps",
    apply: "build",
    enforce: "pre",

    configEnvironment(name, env) {
      if (env.consumer !== "server") return;

      return {
        resolve: {
          // Bundle all npm packages into the SSR output instead of leaving
          // them as external imports (Vite's default SSR behaviour).
          noExternal: true,
        },
      };
    },
  };
}

/** Append `virtual:ud:catch-all` as an additional SSR build entry (preserving framework entries). */
function createApplyCatchAllPlugin(): Plugin {
  return {
    name: "edgeone:apply-catch-all",
    apply: "build",
    enforce: "post",

    configEnvironment: {
      order: "post",
      handler(name, env) {
        if (env.consumer !== "server" || name !== "ssr") return;

        // Vite 7+ uses Rolldown; Vite 6 uses Rollup.
        // `this` may be undefined in Vite 6, guard with optional chaining.
        const hasRolldown =
          // @ts-expect-error rolldownVersion exists only on Vite 7+
          typeof this?.meta?.rolldownVersion === "string";
        const optionName = hasRolldown ? "rolldownOptions" : "rollupOptions";

        const existingInput =
          (env.build as Record<string, any>)?.[optionName]?.input;
        const mergedInput = mergeInput(existingInput, catchAllEntry);

        return {
          build: {
            [optionName]: {
              input: mergedInput,
              output: { entryFileNames: "[name].js" },
            },
          },
        };
      },
    },
  };
}

/**
 * Merge a new `handler` entry into the existing Rollup/Rolldown input config,
 * preserving original entry names (e.g. "server.ts" → key "server").
 */
function mergeInput(
  existing: string | string[] | Record<string, string> | undefined,
  handlerEntry: string,
): Record<string, string> {
  if (!existing) {
    return { handler: handlerEntry };
  }
  if (typeof existing === "string") {
    // "server.ts" → { server: "server.ts", handler: ... }
    const key = path.basename(existing, path.extname(existing));
    return { [key]: existing, handler: handlerEntry };
  }
  if (Array.isArray(existing)) {
    const obj: Record<string, string> = {};
    for (const entry of existing) {
      const key = path.basename(entry, path.extname(entry));
      obj[key] = entry;
    }
    obj.handler = handlerEntry;
    return obj;
  }
  return { ...existing, handler: handlerEntry };
}

/**
 * Post-build plugin: copy handler.js and static assets into .edgeone/,
 * then generate config.json.
 */
function createOutputPlugin(options: EdgeOneAdapterOptions): Plugin {
  const outputDir = options.outputDir ?? ".edgeone";
  const log = createLogger(options.verbose ?? false);

  let projectRoot = "";
  let resolvedConfig: ResolvedConfig;
  let hasProcessed = false;

  return {
    name: "edgeone:output",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      projectRoot = config.root;
      resolvedConfig = config;
    },

    async closeBundle() {
      // Only run once, after the SSR build finishes
      const isSsrBuild =
        resolvedConfig.build.ssr !== false &&
        resolvedConfig.build.ssr !== undefined;

      if (!isSsrBuild || hasProcessed) return;
      hasProcessed = true;

      log.log("Build complete — generating EdgeOne deployment artifacts...");

      try {
        await prepareOutputDir(projectRoot, outputDir);
        log.verbose(`Output directory prepared: ${outputDir}/`);

        await copySsrOutput(projectRoot, resolvedConfig, outputDir, log.verbose);
        await copyStaticAssets(projectRoot, resolvedConfig, outputDir, log.log);
        await generateEdgeOneConfigJson(projectRoot, outputDir, log.log);

        log.log(`Deployment artifacts written to ${outputDir}/`);
      } catch (err) {
        log.warn(
          `Failed to generate EdgeOne artifacts: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    },
  };
}

/** Copy the entire SSR build output into .edgeone/cloud-functions/ssr-node/. */
async function copySsrOutput(
  projectRoot: string,
  viteConfig: ResolvedConfig,
  outputDir: string,
  verbose: (msg: string) => void
): Promise<void> {
  const ssrOutDir = path.isAbsolute(viteConfig.build.outDir)
    ? viteConfig.build.outDir
    : path.join(projectRoot, viteConfig.build.outDir);

  const handlerSrc = path.join(ssrOutDir, "handler.js");
  try {
    await fs.access(handlerSrc);
  } catch {
    verbose(`handler.js not found at ${handlerSrc}, skipping SSR output copy`);
    return;
  }

  const destDir = path.join(projectRoot, outputDir, "cloud-functions", "ssr-node");
  await fs.mkdir(destDir, { recursive: true });
  await copyDirRecursive(ssrOutDir, destDir);

  // Rename the Vite-produced handler.js → _handler.js, then generate a bridge
  // entry as handler.js that adapts the { fetch(Request) } interface to the
  // (IncomingMessage, context) => Response function expected by EdgeOne Pages bootstrap.
  const destHandler = path.join(destDir, "handler.js");
  const destInternal = path.join(destDir, "_handler.js");
  await fs.rename(destHandler, destInternal);
  await fs.writeFile(destHandler, BRIDGE_ENTRY_CODE, "utf-8");

  verbose(`SSR output copied → ${outputDir}/cloud-functions/ssr-node/`);
}

/**
 * Bridge entry that adapts the universal-deploy catch-all handler
 * ({ default: { fetch(Request): Response } }) into the
 * (IncomingMessage, context) => Response function signature
 * expected by EdgeOne Pages bootstrap's createFrameworkServer().
 */
const BRIDGE_ENTRY_CODE = `\
import catchAll from "./_handler.js";

const handler = catchAll.default || catchAll;

export default async function edgeoneHandler(req, context) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["eo-pages-host"] || req.headers.host || "localhost";
  const url = protocol + "://" + host + req.url;

  const method = req.method || "GET";
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val != null) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  let body = undefined;
  if (hasBody) {
    body = new ReadableStream({
      start(controller) {
        req.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
        req.on("end", () => controller.close());
        req.on("error", (e) => controller.error(e));
      },
    });
  }

  const request = new Request(url, { method, headers, body, duplex: hasBody ? "half" : undefined });

  if (typeof handler.fetch === "function") {
    return handler.fetch(request);
  }
  if (typeof handler === "function") {
    return handler(request);
  }
  throw new Error("handler must export { fetch(Request) } or be a function");
};
`;

/** Recursively copy all files from src directory to dest directory. */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * EdgeOne adapter for Vite SSR / TanStack Start projects.
 *
 * @example
 * // TanStack Start
 * export default defineConfig({ plugins: [tanstackStart(), edgeoneAdapter()] });
 *
 * @example
 * // Standard Vite SSR
 * export default defineConfig({
 *   build: { ssr: "src/entry-server.ts" },
 *   plugins: [edgeoneAdapter()],
 * });
 */
export function edgeoneAdapter(options: EdgeOneAdapterOptions = {}): Plugin[] {
  return [
    createBundleDepsPlugin(),
    compat(),
    catchAll(),
    resolver(),
    createApplyCatchAllPlugin(),
    createOutputPlugin(options),
  ];
}

/**
 * EdgeOne adapter for Vike projects.
 * Wraps `vike/server`'s `renderPage()` into a `{ fetch }` handler,
 * then delegates to `edgeoneAdapter()`.
 *
 * @example
 * export default defineConfig({ plugins: [vike(), edgeoneVikeAdapter()] });
 */
export function edgeoneVikeAdapter(options: EdgeOneAdapterOptions = {}): Plugin[] {
  return [
    createVikeHandlerPlugin(),
    ...edgeoneAdapter(options),
  ];
}

export type { RouteInfo, OutputRoute } from "./route/regex.js";
export { routeToRegex, convertRoutesToOutputRoutes } from "./route/regex.js";
