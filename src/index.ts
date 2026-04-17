import path from "path";
import fs from "fs/promises";
import type { Plugin, ResolvedConfig } from "vite";
import { catchAllEntry, addEntry } from "@universal-deploy/store";
import { catchAll, resolver, compat } from "@universal-deploy/store/vite";
import { prepareOutputDir } from "./platform/output.js";
import { copyStaticAssets } from "./platform/static-assets.js";
import { generateEdgeOneConfigJson } from "./platform/config-json.js";

export interface EdgeOneAdapterOptions {
  /** @default ".edgeone" */
  outputDir?: string;
  /** @default false */
  verbose?: boolean;
  /**
   * SSR entry file path for traditional Vite SSR projects.
   *
   * When set, the adapter automatically handles the two-step build:
   * 1. Client build runs normally (produces index.html + JS + CSS)
   * 2. SSR build is triggered automatically after client build completes
   *
   * The entry file must default-export a `{ fetch(request: Request): Response }` object.
   *
   * Not needed for frameworks that use the Vite Environment API
   * (Vike, TanStack Start) — they manage SSR entries internally.
   *
   * @example
   * edgeoneAdapter({ ssrEntry: "src/entry-server.jsx" })
   */
  ssrEntry?: string;
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
function createBundleDepsPlugin(ssrEntry?: string): Plugin {
  return {
    name: "edgeone:bundle-deps",
    apply: "build",
    enforce: "pre",

    // Environment API path (Vike, TanStack Start, etc.)
    configEnvironment(name, env) {
      if (env.consumer !== "server") return;

      return {
        resolve: {
          noExternal: true,
        },
      };
    },

    // Traditional build.ssr path (CLI --ssr or ssrEntry triggered rebuild)
    config(config) {
      if (!config.build?.ssr && !ssrEntry) return;
      // Only apply when actually in SSR build (not client build with ssrEntry pending)
      if (!config.build?.ssr) return;

      return {
        ssr: {
          noExternal: true,
        },
      };
    },
  };
}

/** Append `virtual:ud:catch-all` as an additional SSR build entry (preserving framework entries). */
function createApplyCatchAllPlugin(ssrEntry?: string): Plugin {
  return {
    name: "edgeone:apply-catch-all",
    apply: "build",
    enforce: "post",

    // Environment API path (Vike, TanStack Start, etc.)
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

        const existingInput = (env.build as Record<string, any>)?.[optionName]
          ?.input;
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

    // Traditional build.ssr path (CLI --ssr or ssrEntry triggered rebuild)
    config(config) {
      const ssr = config.build?.ssr;
      if (!ssr) return;

      const entry = typeof ssr === "string" ? ssr : ssrEntry;
      const rollupInput = config.build?.rollupOptions?.input;

      // compat() only works with Environment API; for traditional build.ssr
      // we must manually register the SSR entry in the UD store.
      if (entry) {
        addEntry({ id: entry, route: "/**" });
      }

      const mergedInput = mergeInput(
        rollupInput ?? entry,
        catchAllEntry
      );

      return {
        build: {
          ssr: true,
          rollupOptions: {
            input: mergedInput,
            output: { entryFileNames: "[name].js" },
          },
        },
      };
    },
  };
}

/**
 * When `ssrEntry` is set, automatically trigger an SSR build after the
 * client build completes. This lets users run a single `vite build` instead
 * of manually scripting two separate build steps.
 */
function createSsrEntryPlugin(options: EdgeOneAdapterOptions): Plugin {
  const { ssrEntry, outputDir = ".edgeone", verbose = false } = options;
  const log = createLogger(verbose);

  let projectRoot = "";
  let resolvedConfig: ResolvedConfig;

  return {
    name: "edgeone:ssr-entry",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      projectRoot = config.root;
      resolvedConfig = config;
    },

    async closeBundle() {
      // Only trigger on client build (build.ssr is falsy)
      if (resolvedConfig.build.ssr) return;
      if (!ssrEntry) return;

      log.log(`ssrEntry detected — running SSR build for ${ssrEntry}...`);

      // Dynamically import Vite's build function to run a second build
      const { build } = await import("vite");

      const ssrOutDir = path.join(projectRoot, "dist", "server");

      // Register the SSR entry in the UD store before the SSR build
      addEntry({ id: ssrEntry, route: "/**" });

      const mergedInput = mergeInput(ssrEntry, catchAllEntry);

      await build({
        root: projectRoot,
        // Inherit user's config file, but we override SSR-specific settings
        configFile: resolvedConfig.configFile || undefined,
        build: {
          ssr: true,
          outDir: ssrOutDir,
          rollupOptions: {
            input: mergedInput,
            output: { entryFileNames: "[name].js" },
          },
        },
        ssr: {
          noExternal: true,
        },
        // Prevent recursive ssrEntry triggering
        plugins: [],
      });

      log.log("SSR build complete.");

      // Now produce EdgeOne deployment artifacts
      log.log("Generating EdgeOne deployment artifacts...");

      await prepareOutputDir(projectRoot, outputDir);

      // Copy SSR output
      const handlerSrc = path.join(ssrOutDir, "handler.js");
      try {
        await fs.access(handlerSrc);
      } catch {
        log.warn(`handler.js not found at ${handlerSrc}`);
        return;
      }

      const destDir = path.join(
        projectRoot,
        outputDir,
        "cloud-functions",
        "ssr-node"
      );
      await fs.mkdir(destDir, { recursive: true });
      await copyDirRecursive(ssrOutDir, destDir);

      // Bridge entry
      const destHandler = path.join(destDir, "handler.js");
      const destInternal = path.join(destDir, "_handler.js");
      await fs.rename(destHandler, destInternal);
      await fs.writeFile(destHandler, BRIDGE_ENTRY_CODE, "utf-8");

      // Copy static assets from the client build
      await copyStaticAssets(projectRoot, resolvedConfig, outputDir, log.log);

      // Generate config.json
      await generateEdgeOneConfigJson(projectRoot, outputDir, log.log);

      log.log(`Deployment artifacts written to ${outputDir}/`);
    },
  };
}

/**
 * Merge a new `handler` entry into the existing Rollup/Rolldown input config,
 * preserving original entry names (e.g. "server.ts" → key "server").
 */
function mergeInput(
  existing: string | string[] | Record<string, string> | undefined,
  handlerEntry: string
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
 *
 * This plugin is SKIPPED when ssrEntry is set — the ssrEntry plugin
 * handles artifact generation after its own SSR build.
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
      // When ssrEntry is used, the ssrEntry plugin handles artifact generation
      if (options.ssrEntry) return;

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

        await copySsrOutput(
          projectRoot,
          resolvedConfig,
          outputDir,
          log.verbose
        );
        await copyStaticAssets(projectRoot, resolvedConfig, outputDir, log.log);
        await generateEdgeOneConfigJson(projectRoot, outputDir, log.log);

        log.log(`Deployment artifacts written to ${outputDir}/`);
      } catch (err) {
        log.warn(
          `Failed to generate EdgeOne artifacts: ${
            err instanceof Error ? err.message : String(err)
          }`
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

  const destDir = path.join(
    projectRoot,
    outputDir,
    "cloud-functions",
    "ssr-node"
  );
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
// Import framework server entry (if present) to ensure production
// context is initialized before handling requests.
await import("./entry.js").catch(() => {});

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
 * EdgeOne adapter for any UD-aware Vite framework.
 *
 * Works with any framework that registers a Fetchable entry in the
 * Universal Deploy store — including TanStack Start, Vike (≥ 0.4.257
 * with `server: true`), and standard Vite SSR.
 *
 * @example
 * // TanStack Start
 * export default defineConfig({ plugins: [tanstackStart(), edgeoneAdapter()] });
 *
 * @example
 * // Vike (requires `server: true` in pages/+config.ts)
 * export default defineConfig({ plugins: [vike(), edgeoneAdapter()] });
 *
 * @example
 * // Standard Vite SSR (single `vite build` — adapter handles client + SSR automatically)
 * export default defineConfig({
 *   plugins: [edgeoneAdapter({ ssrEntry: "src/entry-server.jsx" })],
 * });
 */
export function edgeoneAdapter(options: EdgeOneAdapterOptions = {}): Plugin[] {
  const plugins: Plugin[] = [
    createBundleDepsPlugin(options.ssrEntry),
    compat(),
    catchAll(),
    resolver(),
    createApplyCatchAllPlugin(options.ssrEntry),
    createOutputPlugin(options),
  ];

  // When ssrEntry is set, add the plugin that auto-triggers SSR build
  if (options.ssrEntry) {
    plugins.push(createSsrEntryPlugin(options));
  }

  return plugins;
}

export type { RouteInfo, OutputRoute } from "./route/regex.js";
export { routeToRegex, convertRoutesToOutputRoutes } from "./route/regex.js";

export default edgeoneAdapter;
