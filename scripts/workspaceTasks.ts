import { rmSync, readFileSync } from "@toonflow/file";
import { Glob } from "bun";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";

type pluginKind = "tools" | "nodes" | "ext" | "teams";

interface taskTarget {
  name: string;
  dir: string;
  script: "build" | "typecheck";
}

const defaultConcurrency = Math.max(2, Math.min(cpus().length, 6));
const pluginPatterns: Record<pluginKind, string> = {
  tools: "packages/tools/*/package.json",
  nodes: "packages/nodes/*/package.json",
  ext: "packages/ext/*/package.json",
  teams: "packages/teams/*/package.json",
};

function scanTargets(patterns: string[], script: "build" | "typecheck"): taskTarget[] {
  const targets: taskTarget[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    for (const filePath of new Glob(pattern).scanSync(".")) {
      const dir = resolve(filePath, "..");
      if (seen.has(dir)) continue;
      seen.add(dir);

      const pkg = JSON.parse(readFileSync(filePath, "utf8")) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      if (!pkg.scripts?.[script]) continue;
      targets.push({ name: pkg.name || dirname(filePath), dir, script });
    }
  }

  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

async function runTarget(target: taskTarget, env: Record<string, string | undefined>) {
  const startedAt = performance.now();
  const proc = Bun.spawn(["bun", "run", target.script], {
    cwd: target.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    target,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function runPool(targets: taskTarget[], env: Record<string, string | undefined>, concurrency = defaultConcurrency) {
  const startedAt = performance.now();
  let nextIndex = 0;
  const failures: Awaited<ReturnType<typeof runTarget>>[] = [];

  async function worker() {
    while (nextIndex < targets.length) {
      const current = targets[nextIndex++];
      if (!current) break;

      const result = await runTarget(current, env);
      const seconds = (result.durationMs / 1000).toFixed(2);
      if (result.exitCode === 0) {
        console.log(`[ok] ${result.target.name} (${seconds}s)`);
      } else {
        console.error(`[fail] ${result.target.name} (${seconds}s, code=${result.exitCode})`);
        failures.push(result);
      }
    }
  }

  const workerCount = Math.min(concurrency, targets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const totalSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
  console.log(`完成 ${targets.length} 项任务（并发 ${workerCount}），总耗时 ${totalSeconds}s`);

  if (failures.length > 0) {
    for (const item of failures) {
      console.error(`\n--- ${item.target.name} (${item.target.dir}) ---`);
      if (item.stdout) console.error(item.stdout);
      if (item.stderr) console.error(item.stderr);
    }
    process.exit(1);
  }
}

async function main() {
  const [, , command, targetArg, ...flags] = process.argv;

  if (command === "typecheck") {
    const targets = scanTargets(
      [
        "apps/*/package.json",
        "packages/*/package.json",
        "packages/nodes/*/package.json",
        "packages/tools/*/package.json",
        "packages/ext/*/package.json",
        "packages/teams/*/package.json",
      ],
      "typecheck",
    );
    await runPool(targets, process.env);
    return;
  }

  if (command === "build") {
    const isDev = flags.includes("--dev");
    const env = { ...process.env, NODE_ENV: isDev ? "dev" : "production" };

    if (targetArg === "plugins") {
      const targets = scanTargets([pluginPatterns.tools, pluginPatterns.nodes, pluginPatterns.ext], "build");
      await runPool(targets, env);
      return;
    }

    if (targetArg === "tools" || targetArg === "nodes" || targetArg === "ext" || targetArg === "teams") {
      if (!isDev && targetArg !== "teams") {
        rmSync(resolve("build", targetArg), { recursive: true, force: true });
      }
      const targets = scanTargets([pluginPatterns[targetArg]], "build");
      await runPool(targets, env);
      return;
    }
  }

  console.error("用法: bun scripts/workspaceTasks.ts <typecheck | build <tools|nodes|ext|teams|plugins> [--dev]>");
  process.exit(1);
}

await main();
