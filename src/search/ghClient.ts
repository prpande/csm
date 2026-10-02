import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { isPrState } from "../ipcTypes";
import { isRecord } from "../typeGuards";
import type { PrDetails } from "./searchDb";

export const GH_TIMEOUT_MS = 20_000;
export const BODY_MAX_BYTES = 65_536;
export const MAX_GH_STDOUT_BYTES = 16 * 1024 * 1024;

const DARWIN_FALLBACKS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
const ALIAS_RE = /^p\d+$/;

export type GhFailure = "ENOENT" | "timeout" | "bad-output";

export type BatchOutcome =
  | { kind: "data"; byNumber: Map<number, PrDetails | null> }
  | { kind: "failed"; reason: GhFailure };

export interface GhRunner {
  ghPath: string | undefined;
  prefixArgs?: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}

export function resolveGhPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (p: string) => boolean,
): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  // shell:false cannot run a .cmd/.bat shim, so only the real executable counts.
  const name = platform === "win32" ? "gh.exe" : "gh";
  for (const entry of (env.PATH ?? env.Path ?? "").split(p.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    // A relative entry resolves against the app's cwd, not an install location.
    if (!dir || !p.isAbsolute(dir)) continue;
    const candidate = p.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  // Apps launched from the Dock or Finder get launchd's minimal PATH.
  return platform === "darwin" ? DARWIN_FALLBACKS.find(isFile) : undefined;
}

export function ghEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ghPath: string,
): NodeJS.ProcessEnv {
  if (platform !== "darwin") return env;
  const dir = path.posix.dirname(ghPath);
  return { ...env, PATH: env.PATH ? `${dir}:${env.PATH}` : dir };
}

function buildQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$n${i}: Int!`).join(
    ", ",
  );
  const fields = Array.from(
    { length: count },
    (_, i) =>
      `p${i}: pullRequest(number: $n${i}) { number title state isDraft body url }`,
  ).join(" ");
  return `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`;
}

export function buildGraphqlArgs(
  repo: string,
  numbers: readonly number[],
): string[] {
  const [owner, name] = repo.split("/");
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${buildQuery(numbers.length)}`,
    // -f keeps owner/name as strings; -F would turn a numeric name into an Int.
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ];
  numbers.forEach((n, i) => args.push("-F", `n${i}=${n}`));
  return args;
}

export function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
}

function toDetails(node: unknown): PrDetails | null {
  if (
    !isRecord(node) ||
    typeof node.title !== "string" ||
    !isPrState(node.state)
  )
    return null;
  return {
    title: node.title,
    state: node.state,
    isDraft: node.isDraft === true,
    body: truncateUtf8(
      typeof node.body === "string" ? node.body : "",
      BODY_MAX_BYTES,
    ),
  };
}

export function parseGraphqlOutput(
  stdout: string,
  numbers: readonly number[],
): BatchOutcome {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { kind: "failed", reason: "bad-output" };
  }
  if (!isRecord(json) || !isRecord(json.data))
    return { kind: "failed", reason: "bad-output" };
  const errored = new Set<string>();
  if (Array.isArray(json.errors))
    for (const e of json.errors)
      if (isRecord(e) && Array.isArray(e.path))
        for (const seg of e.path)
          if (typeof seg === "string" && ALIAS_RE.test(seg)) errored.add(seg);
  const repo = json.data.repository;
  const byNumber = new Map<number, PrDetails | null>();
  numbers.forEach((n, i) => {
    const alias = `p${i}`;
    byNumber.set(
      n,
      errored.has(alias) || !isRecord(repo) ? null : toDetails(repo[alias]),
    );
  });
  return { kind: "data", byNumber };
}

export function runGhBatch(
  runner: GhRunner,
  repo: string,
  numbers: readonly number[],
): Promise<BatchOutcome> {
  const ghPath = runner.ghPath;
  if (!ghPath) return Promise.resolve({ kind: "failed", reason: "ENOENT" });
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let child: ChildProcess;
    try {
      child = spawn(
        ghPath,
        [...(runner.prefixArgs ?? []), ...buildGraphqlArgs(repo, numbers)],
        {
          shell: false,
          env: runner.env,
          // Without this Windows can flash a console window for gh.exe.
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      resolve({ kind: "failed", reason: "bad-output" });
      return;
    }
    const finish = (outcome: BatchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "failed", reason: "timeout" });
    }, runner.timeoutMs ?? GH_TIMEOUT_MS);
    const maxBytes = runner.maxStdoutBytes ?? MAX_GH_STDOUT_BYTES;
    let total = 0;
    child.stdout?.on("data", (c: Buffer) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        child.kill();
        finish({ kind: "failed", reason: "bad-output" });
        return;
      }
      chunks.push(c);
    });
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({
        kind: "failed",
        reason: err.code === "ENOENT" ? "ENOENT" : "bad-output",
      }),
    );
    // Parse whatever arrived regardless of exit code: gh exits 1 on partial data.
    child.on("close", () =>
      finish(
        parseGraphqlOutput(Buffer.concat(chunks).toString("utf8"), numbers),
      ),
    );
  });
}
