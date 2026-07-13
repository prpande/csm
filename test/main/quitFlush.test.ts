import { test, expect, vi } from "vitest";
import { createBeforeQuitHandler } from "../../src/quitFlush";

// A tiny deferred so the test can observe the "quit waits for flush" ordering.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("clean index: handler does nothing, quit proceeds normally", () => {
  const flush = vi.fn(async () => {});
  const quit = vi.fn();
  const preventDefault = vi.fn();
  const handler = createBeforeQuitHandler({
    isDirty: () => false,
    flush,
    quit,
  });
  handler({ preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});

test("dirty index: prevents quit, flushes, then re-quits after flush resolves", async () => {
  const d = deferred();
  const flush = vi.fn(() => d.promise);
  const quit = vi.fn();
  const preventDefault = vi.fn();
  const handler = createBeforeQuitHandler({ isDirty: () => true, flush, quit });

  handler({ preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(quit).not.toHaveBeenCalled(); // quit is held until flush resolves

  d.resolve();
  await d.promise;
  await Promise.resolve(); // let the .finally microtask run
  expect(quit).toHaveBeenCalledTimes(1);
});

test("re-quits even if flush rejects, with no unhandled rejection", async () => {
  // A failing index write at quit must still quit AND must not surface as an
  // unhandled promise rejection in the main process (the flush rejection is
  // swallowed before quit).
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const flush = vi.fn(async () => {
      throw new Error("EPERM");
    });
    const quit = vi.fn();
    const handler = createBeforeQuitHandler({
      isDirty: () => true,
      flush,
      quit,
    });
    handler({ preventDefault: () => {} });
    await Promise.resolve();
    await Promise.resolve();
    // Give any stray rejection a macrotask to be reported.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(quit).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("idempotent: a second before-quit (the re-quit) does not prevent again", async () => {
  const flush = vi.fn(async () => {});
  const quit = vi.fn();
  const preventDefault = vi.fn();
  const handler = createBeforeQuitHandler({ isDirty: () => true, flush, quit });

  handler({ preventDefault }); // first pass: prevents + flushes
  await Promise.resolve();
  await Promise.resolve();
  // The re-quit fires before-quit a second time; isDirty is still true in this
  // fake, but the `quitting` guard must let it through without preventing.
  handler({ preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(1); // not called on the 2nd pass
});
