import fs from "fs/promises";
import path from "path";

/** Clean adapter-managed subdirectories in the output dir before each build. */
export async function prepareOutputDir(
  projectRoot: string,
  outputDir: string
): Promise<void> {
  const outputPath = path.join(projectRoot, outputDir);

  const pathsToClean = [
    path.join(outputPath, "assets"),
    path.join(outputPath, "cloud-functions", "ssr-node"),
  ];

  for (const p of pathsToClean) {
    await fs.rm(p, { recursive: true, force: true });
  }

  await fs.mkdir(outputPath, { recursive: true });
}
