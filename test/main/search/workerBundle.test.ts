// @vitest-environment node
import { expect, test } from "vitest";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { workerBuildOptions } from "../../../scripts/build-worker.mjs";
import type {
  HostToWorker,
  WorkerInit,
  WorkerToHost,
} from "../../../src/search/protocol";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";

test("the worker bundle requires only Node built-ins", async () => {
  const result = await build({ ...workerBuildOptions(repoRoot), write: false });
  const out = (result.outputFiles ?? []).find((f) => f.path.endsWith(".js"));
  expect(out).toBeDefined();
  const required = [
    ...out!.text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
  expect(required.filter((m) => !isBuiltin(m))).toEqual([]);
  expect(required).toEqual(
    expect.arrayContaining(["node:sqlite", "node:worker_threads"]),
  );
});

test("the built worker opens the store, ingests and answers prsFor", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "csm-worker-"));
  try {
    const out = join(tmp, "searchWorker.js");
    await build({
      ...workerBuildOptions(repoRoot),
      outfile: out,
      sourcemap: false,
    });
    const root = join(tmp, "projects");
    mkdirSync(join(root, "p"), { recursive: true });
    writeFileSync(
      join(root, "p", `${SID}.jsonl`),
      `${JSON.stringify({
        type: "pr-link",
        sessionId: SID,
        prNumber: 3,
        prRepository: "o/r",
        prUrl: "https://github.com/o/r/pull/3",
        timestamp: "2026-10-01T10:00:00.000Z",
      })}\n`,
    );
    const init: WorkerInit = {
      dbDir: tmp,
      projectsRoot: root,
      platform: process.platform,
      ghPath: null,
    };
    const worker = new Worker(out, { workerData: init });
    const messages: WorkerToHost[] = [];
    worker.on("message", (m: WorkerToHost) => messages.push(m));
    const next = (type: WorkerToHost["type"]) =>
      new Promise<WorkerToHost>((resolve, reject) => {
        const seen = messages.find((m) => m.type === type);
        if (seen) return resolve(seen);
        const onMsg = (m: WorkerToHost) => {
          if (m.type !== type) return;
          worker.off("message", onMsg);
          resolve(m);
        };
        worker.on("message", onMsg);
        worker.once("error", reject);
      });

    expect(await next("ready")).toEqual({
      type: "ready",
      ftsOk: true,
      recovered: false,
    });
    await next("changed");
    worker.postMessage({
      type: "prsFor",
      id: 1,
      sids: [SID],
    } satisfies HostToWorker);
    expect(await next("result")).toMatchObject({
      id: 1,
      ok: true,
      value: { [SID]: [{ repo: "o/r", number: 3, title: null }] },
    });
    worker.postMessage({ type: "shutdown" } satisfies HostToWorker);
    await next("shutdownAck");
    await worker.terminate();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);
