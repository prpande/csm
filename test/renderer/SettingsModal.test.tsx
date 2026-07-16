import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SettingsModal } from "../../src/renderer/components/SettingsModal";
import type { CsmBridge } from "../../src/renderer/types/csm";

function makeBridge(overrides: Partial<CsmBridge> = {}): CsmBridge {
  return {
    ...window.csm!,
    getClaudePath: vi.fn(async () => "claude"),
    setClaudePath: vi.fn(async () => {}),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderModal(
  bridge: CsmBridge,
  onClose = vi.fn(),
  onSaved = vi.fn(),
) {
  await act(async () => {
    render(
      <SettingsModal onClose={onClose} onSaved={onSaved} bridge={bridge} />,
    );
  });
  return { onClose, onSaved };
}

const getInput = () =>
  screen.getByLabelText("Claude executable path") as HTMLInputElement;
const getForm = () => getInput().closest("form")!;
const getSave = () => screen.getByTestId("settings-save") as HTMLButtonElement;

test("renders an accessible dialog with a labelled path input", async () => {
  await renderModal(makeBridge());
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeTruthy();
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  expect(getInput()).toBeTruthy();
});

test("prefills the input from getClaudePath and focuses it once loaded", async () => {
  const bridge = makeBridge({
    getClaudePath: vi.fn(async () => "D:\\tools\\claude.exe"),
  });
  await renderModal(bridge);
  expect(getInput().value).toBe("D:\\tools\\claude.exe");
  expect(getInput().disabled).toBe(false);
  expect(document.activeElement).toBe(getInput());
});

test("save persists the trimmed value, then calls onSaved and onClose", async () => {
  const bridge = makeBridge();
  const { onClose, onSaved } = await renderModal(bridge);
  fireEvent.change(getInput(), {
    target: { value: "  /usr/local/bin/claude  " },
  });
  await act(async () => {
    fireEvent.click(getSave());
  });
  expect(bridge.setClaudePath).toHaveBeenCalledTimes(1);
  expect(bridge.setClaudePath).toHaveBeenCalledWith("/usr/local/bin/claude");
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("whitespace-only input saves as the empty string (store restores default)", async () => {
  const bridge = makeBridge();
  await renderModal(bridge);
  fireEvent.change(getInput(), { target: { value: "   " } });
  await act(async () => {
    fireEvent.click(getSave());
  });
  expect(bridge.setClaudePath).toHaveBeenCalledWith("");
});

test("submitting the form (Enter in the input) saves like the Save button", async () => {
  const bridge = makeBridge();
  const { onClose, onSaved } = await renderModal(bridge);
  fireEvent.change(getInput(), { target: { value: "claude-custom" } });
  await act(async () => {
    fireEvent.submit(getForm());
  });
  expect(bridge.setClaudePath).toHaveBeenCalledWith("claude-custom");
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("cancel closes without persisting", async () => {
  const bridge = makeBridge();
  const { onClose, onSaved } = await renderModal(bridge);
  fireEvent.click(screen.getByTestId("settings-cancel"));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(bridge.setClaudePath).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

test("Escape and backdrop click close without saving; inside clicks don't close", async () => {
  const bridge = makeBridge();
  const { onClose } = await renderModal(bridge);
  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("settings-backdrop"));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(bridge.setClaudePath).not.toHaveBeenCalled();
});

test("a failed save keeps the modal open and announces a fixed error", async () => {
  const bridge = makeBridge({
    setClaudePath: vi.fn(async () => {
      throw new Error("EACCES: /home/someone/secret");
    }),
  });
  const { onClose, onSaved } = await renderModal(bridge);
  await act(async () => {
    fireEvent.click(getSave());
  });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Couldn't save settings");
  expect(alert.textContent).not.toContain("EACCES");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("while a save is pending, Save is disabled and dismissal is inert", async () => {
  const save = deferred<void>();
  const bridge = makeBridge({ setClaudePath: vi.fn(() => save.promise) });
  const { onClose, onSaved } = await renderModal(bridge);
  fireEvent.click(getSave());
  expect(getSave().disabled).toBe(true);
  fireEvent.click(screen.getByTestId("settings-cancel"));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByTestId("settings-backdrop"));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => {
    save.resolve();
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a failed prefill falls back to the default, stays usable, and shows a notice", async () => {
  const bridge = makeBridge({
    getClaudePath: vi.fn(async () => {
      throw new Error("ipc transport gone");
    }),
  });
  await renderModal(bridge);
  expect(getInput().value).toBe("claude");
  expect(getInput().disabled).toBe(false);
  expect(document.activeElement).toBe(getInput());
  expect(screen.getByText(/couldn't load the current setting/i)).toBeTruthy();
});

test("submitting while the prefill is still pending is a no-op", async () => {
  const load = deferred<string>();
  const bridge = makeBridge({ getClaudePath: vi.fn(() => load.promise) });
  await renderModal(bridge);
  expect(getSave().disabled).toBe(true);
  fireEvent.submit(getForm());
  expect(bridge.setClaudePath).not.toHaveBeenCalled();
  await act(async () => {
    load.resolve("claude");
  });
});

test("without a bridge, the modal fails soft: default value, notice, Save disabled", async () => {
  // Passing bridge={undefined} would just trigger the default parameter, so
  // remove the global stub to exercise the genuine no-preload path.
  delete (window as { csm?: unknown }).csm;
  await act(async () => {
    render(<SettingsModal onClose={vi.fn()} onSaved={vi.fn()} />);
  });
  expect(getInput().value).toBe("claude");
  expect(screen.getByText(/couldn't load the current setting/i)).toBeTruthy();
  expect(getSave().disabled).toBe(true);
});

test("double submission before the first save settles persists exactly once", async () => {
  const save = deferred<void>();
  const bridge = makeBridge({ setClaudePath: vi.fn(() => save.promise) });
  await renderModal(bridge);
  fireEvent.submit(getForm());
  fireEvent.submit(getForm());
  expect(bridge.setClaudePath).toHaveBeenCalledTimes(1);
  await act(async () => {
    save.resolve();
  });
});
