import fs from "fs/promises";
import path from "path";
import { getAllEntries } from "@universal-deploy/store";
import type { EntryMeta } from "@universal-deploy/store";
import { convertRoutesToOutputRoutes, isCatchAllRoute } from "../route/regex.js";
import type { RouteInfo, OutputRoute } from "../route/regex.js";

export interface OutputConfig {
  version: 3;
  routes: OutputRoute[];
}

/** Convert store entries to RouteInfo (deduped). */
function entriesToRouteInfos(entries: readonly EntryMeta[]): RouteInfo[] {
  const seen = new Set<string>();
  const result: RouteInfo[] = [];

  for (const entry of entries) {
    const routes = Array.isArray(entry.route) ? entry.route : [entry.route];
    for (const r of routes) {
      if (seen.has(r)) continue;
      seen.add(r);
      result.push({ path: r, isStatic: false, srcRoute: r });
    }
  }

  return result;
}

/** Generate Build Output API v3 config.json from registered store entries. */
export async function generateEdgeOneConfigJson(
  projectRoot: string,
  outputDir: string,
  log: (msg: string) => void = () => {}
): Promise<void> {
  const entries = getAllEntries();
  const routeInfos = entriesToRouteInfos(entries);
  const outputRoutes = convertRoutesToOutputRoutes(routeInfos);

  const routes: OutputRoute[] = [
    { handle: "filesystem" },
    ...outputRoutes,
  ];

  // Only append a catch-all fallback if no registered route already covers it.
  const hasCatchAll = routeInfos.some((r) => isCatchAllRoute(r.path));
  if (!hasCatchAll) {
    routes.push({ src: "/.*" });
  }

  const config: OutputConfig = { version: 3, routes };

  const configDir = path.join(projectRoot, outputDir, "cloud-functions", "ssr-node");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify(config, null, 2)
  );

  log(
    `config.json generated with ${routeInfos.length} route(s) from ${entries.length} registered entry(s)`
  );
}
