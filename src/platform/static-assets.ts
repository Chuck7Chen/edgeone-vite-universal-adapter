import fs from "fs/promises";
import path from "path";
import type { ResolvedConfig } from "vite";

/** Resolve the client build output directory (SSR: sibling "client" dir; SPA: outDir itself). */
function resolveClientDir(
  projectRoot: string,
  viteConfig: ResolvedConfig
): string {
  const outDir = path.isAbsolute(viteConfig.build.outDir)
    ? viteConfig.build.outDir
    : path.join(projectRoot, viteConfig.build.outDir);

  const isSSR =
    viteConfig.build.ssr !== false && viteConfig.build.ssr !== undefined;

  if (isSSR) {
    return path.join(path.dirname(outDir), "client");
  }

  return outDir;
}

/** Copy client-side static assets to .edgeone/assets/. */
export async function copyStaticAssets(
  projectRoot: string,
  viteConfig: ResolvedConfig,
  outputDir: string,
  log: (msg: string) => void = () => {}
): Promise<void> {
  const targetPath = path.join(projectRoot, outputDir, "assets");

  const primaryCandidate = resolveClientDir(projectRoot, viteConfig);

  const candidates: string[] = [
    primaryCandidate,
    path.join(projectRoot, "dist", "client"),
    path.join(projectRoot, "dist"),
    path.join(projectRoot, "build", "client"),
    path.join(projectRoot, "build"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      await fs.cp(candidate, targetPath, { recursive: true });
      log(`Static assets copied from ${path.relative(projectRoot, candidate)} → ${outputDir}/assets`);
      return;
    } catch {
      // try next candidate
    }
  }

  log(`Warning: no client build directory found; .edgeone/assets will be empty`);
  await fs.mkdir(targetPath, { recursive: true });
}
