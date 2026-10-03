// Stands in for `gh api graphql` in ghClient tests. FAKE_GH_MODE picks the reply;
// FAKE_GH_ARGS_FILE receives the argument array as JSON.
import process from "node:process";
import { setTimeout } from "node:timers";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_GH_ARGS_FILE)
  writeFileSync(process.env.FAKE_GH_ARGS_FILE, JSON.stringify(args));

const numbers = [];
for (let i = 0; i < args.length; i++)
  if (args[i] === "-F") numbers.push(Number(args[i + 1].split("=")[1]));

const pr = (n, extra = {}) => ({
  number: n,
  title: `PR ${n}`,
  state: "OPEN",
  isDraft: false,
  body: "body",
  url: `https://github.com/o/r/pull/${n}`,
  ...extra,
});
const repository = Object.fromEntries(numbers.map((n, i) => [`p${i}`, pr(n)]));
const print = (obj) => process.stdout.write(JSON.stringify(obj));

switch (process.env.FAKE_GH_MODE ?? "ok") {
  case "ok":
    print({ data: { repository } });
    break;
  case "partial-exit1":
    repository.p1 = null;
    print({
      data: { repository },
      errors: [
        { type: "NOT_FOUND", path: ["repository", "p1"], message: "gone" },
      ],
    });
    process.exitCode = 1;
    break;
  case "null-repo":
    print({
      data: { repository: null },
      errors: [{ type: "NOT_FOUND", path: ["repository"] }],
    });
    process.exitCode = 1;
    break;
  case "malformed":
    process.stdout.write("not json");
    break;
  case "no-data":
    print({ errors: [{ message: "Bad credentials" }] });
    process.exitCode = 1;
    break;
  case "hang":
    if (process.env.FAKE_GH_PID_FILE)
      writeFileSync(process.env.FAKE_GH_PID_FILE, String(process.pid));
    setTimeout(() => {}, 60_000);
    break;
  case "big-body":
    repository.p0 = pr(numbers[0], { body: "é".repeat(40_000) });
    print({ data: { repository } });
    break;
}
