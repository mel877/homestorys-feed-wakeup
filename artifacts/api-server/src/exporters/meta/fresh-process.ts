/**
 * Runs the heavy Meta export outside the long-lived API process.
 *
 * Google and Meta exports can both retain large V8 heaps. Starting Meta in a
 * clean child process prevents a completed Google export from pushing the API
 * process over its memory limit before the Meta language URLs are published.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { logger as rootLogger } from "../../lib/logger";

const logger = rootLogger.child({ module: "meta-fresh-process" });

export interface FreshMetaExportOptions {
  markets?: string[];
  syncRunId?: string;
}

export async function runMetaExportInFreshProcess(
  options: FreshMetaExportOptions = {},
): Promise<void> {
  // The API bundle is flattened into dist/index.mjs, so import.meta.url cannot
  // preserve this source module's directory. The package working directory is
  // stable for all configured API workflows.
  const runCli = async (cliFile: string, extraArgs: string[], message: string): Promise<void> => {
    const cliPath = resolve(process.cwd(), "dist/cli", cliFile);
    const args = ["--max-old-space-size=4096", "--enable-source-maps", cliPath, ...extraArgs];
    logger.info({ markets: options.markets ?? "all", syncRunId: options.syncRunId ?? null }, message);

    await new Promise<void>((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, args, {
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", rejectChild);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolveChild();
          return;
        }
        rejectChild(new Error(`Meta export child exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`));
      });
    });
  };

  const sharedArgs = options.syncRunId ? [`--sync-run-id=${options.syncRunId}`] : [];
  const marketArgs = options.markets?.length ? [`--markets=${options.markets.join(",")}`] : [];
  await runCli("sync-meta.mjs", [...marketArgs, ...sharedArgs], "Starting Meta layer export in fresh process");

  // Shared public language feeds are only safe for a full market run. Run each
  // language in its own clean process so the large flat CSV never inherits heap
  // retained by the layer export or the other language.
  if (!options.markets?.length) {
    await runCli("sync-meta-language.mjs", ["--language=fr", ...sharedArgs], "Starting Meta French public feed in fresh process");
    await runCli("sync-meta-language.mjs", ["--language=de", ...sharedArgs], "Starting Meta German public feed in fresh process");
  }
}