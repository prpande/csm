import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewSessionModal } from "../../src/renderer/components/NewSessionModal";
import type { CsmBridge } from "../../src/renderer/types/csm";
import type {
  NewSessionResult,
  PickFolderResult,
  ReopenResult,
} from "../../src/ipcTypes";

// NewSessionModal (#165) is the structured launcher: dir + Browse, permission
// dropdown with inline bypass warning, free-form args, an Open-terminal-here
// escape hatch, and a focus trap. All validation is main-side; the modal only
// surfaces the discriminated result. An explicit fake bridge is injected so no
// window.csm / preload is needed. Plain matchers so it passes locally too.

function fakeBridge(over: Partial<CsmBridge> = {}): CsmBridge {
  return {
    isDesktop: true,
    platform: "win32",
    openExternal: vi.fn(async () => true),
    listSessions: vi.fn(() => vi.fn()),
    reopenSession: vi.fn(async () => ({ ok: true }) as ReopenResult),
    getClaudePath: vi.fn(async () => "claude"),
    getTempRoots: vi.fn(async () => []),
    setClaudePath: vi.fn(async () => {}),
    getFacts: vi.fn(async () => ({})),
    newSession: vi.fn(async () => ({ ok: true }) as NewSessionResult),
    pickFolder: vi.fn(
      async () => ({ canceled: false, path: "C:\\picked" }) as PickFolderResult,
    ),
    openTerminalHere: vi.fn(async () => ({ ok: true }) as ReopenResult),
    ...over,
  };
}

function renderModal(
  props: Partial<Parameters<typeof NewSessionModal>[0]> = {},
) {
  const onClose = vi.fn();
  const onLaunched = vi.fn();
  const bridge = props.bridge ?? fakeBridge();
  render(
    <NewSessionModal
      initialDir={props.initialDir ?? "C:\\work\\proj"}
      onClose={onClose}
      onLaunched={onLaunched}
      bridge={bridge}
    />,
  );
  return { onClose, onLaunched, bridge };
}

const dirInput = () => screen.getByLabelText("Directory") as HTMLInputElement;
const argsInput = () =>
  screen.getByLabelText(/additional cli arguments/i) as HTMLInputElement;
const modeSelect = () =>
  screen.getByLabelText("Permission mode") as HTMLSelectElement;
const launchBtn = () =>
  screen.getByTestId("new-session-launch") as HTMLButtonElement;

describe("NewSessionModal (#165)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefills the directory and defaults the permission mode", () => {
    renderModal({ initialDir: "D:\\src\\csm" });
    expect(dirInput().value).toBe("D:\\src\\csm");
    expect(modeSelect().value).toBe("default");
    // Every CLI mode is offered.
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });

  it("launches with the trimmed dir, chosen mode, and raw args", async () => {
    const { bridge, onClose, onLaunched } = renderModal({
      initialDir: "  C:\\work\\proj  ",
    });
    fireEvent.change(modeSelect(), { target: { value: "plan" } });
    fireEvent.change(argsInput(), { target: { value: "--model opus" } });
    fireEvent.click(launchBtn());
    await waitFor(() => expect(bridge.newSession).toHaveBeenCalled());
    expect(bridge.newSession).toHaveBeenCalledWith({
      cwd: "C:\\work\\proj",
      mode: "plan",
      rawArgs: "--model opus",
    });
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the INVALID_ARGS detail inline and stays open", async () => {
    const bridge = fakeBridge({
      newSession: vi.fn(async (): Promise<NewSessionResult> => ({
        ok: false,
        code: "INVALID_ARGS",
        detail: "argument contains a cmd.exe metacharacter: a&b",
      })),
    });
    const { onClose, onLaunched } = renderModal({ bridge });
    fireEvent.change(argsInput(), { target: { value: "a&b" } });
    fireEvent.click(launchBtn());
    const err = await screen.findByTestId("new-session-error");
    expect(err.textContent).toContain("a&b");
    expect(onClose).not.toHaveBeenCalled();
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("renders the error as text, never as HTML", async () => {
    const bridge = fakeBridge({
      newSession: vi.fn(async (): Promise<NewSessionResult> => ({
        ok: false,
        code: "INVALID_ARGS",
        detail: "<img src=x onerror=alert(1)>",
      })),
    });
    renderModal({ bridge });
    fireEvent.click(launchBtn());
    const err = await screen.findByTestId("new-session-error");
    expect(err.querySelector("img")).toBeNull();
    expect(err.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("warns inline when bypassPermissions is selected", () => {
    renderModal();
    expect(screen.queryByText(/auto-approves every tool call/i)).toBeNull();
    fireEvent.change(modeSelect(), {
      target: { value: "bypassPermissions" },
    });
    expect(screen.getByText(/auto-approves every tool call/i)).toBeTruthy();
  });

  it("Browse fills the directory from the native picker", async () => {
    const { bridge } = renderModal({ initialDir: "" });
    fireEvent.click(screen.getByTestId("new-session-browse"));
    await waitFor(() => expect(dirInput().value).toBe("C:\\picked"));
    expect(bridge.pickFolder).toHaveBeenCalled();
  });

  it("a canceled Browse leaves the directory unchanged", async () => {
    const bridge = fakeBridge({
      pickFolder: vi.fn(async (): Promise<PickFolderResult> => ({
        canceled: true,
      })),
    });
    renderModal({ initialDir: "D:\\keep", bridge });
    fireEvent.click(screen.getByTestId("new-session-browse"));
    await waitFor(() => expect(bridge.pickFolder).toHaveBeenCalled());
    expect(dirInput().value).toBe("D:\\keep");
  });

  it("Open terminal here launches the escape hatch and closes", async () => {
    const { bridge, onClose, onLaunched } = renderModal({
      initialDir: "C:\\dir",
    });
    fireEvent.click(screen.getByTestId("new-session-terminal"));
    await waitFor(() =>
      expect(bridge.openTerminalHere).toHaveBeenCalledWith("C:\\dir"),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onLaunched).toHaveBeenCalled();
  });

  it("disables launch and terminal when the directory is empty", () => {
    renderModal({ initialDir: "" });
    expect(launchBtn().disabled).toBe(true);
    expect(
      (screen.getByTestId("new-session-terminal") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(dirInput(), { target: { value: "C:\\x" } });
    expect(launchBtn().disabled).toBe(false);
  });

  it("Escape cancels", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("a backdrop click cancels, an inner click does not", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("new-session-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });

  it("traps Tab inside the dialog and cycles with wraparound", () => {
    renderModal();
    const focusables = Array.from(
      screen
        .getByRole("dialog")
        .querySelectorAll<HTMLElement>(
          "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
        ),
    );
    // Focus the last control, Tab forward → wraps to the first.
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);
    // Shift+Tab from the first → wraps to the last.
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Tab",
      shiftKey: true,
    });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  it("does not launch twice on a rapid double activation", async () => {
    let resolve!: (r: NewSessionResult) => void;
    const gated = new Promise<NewSessionResult>((r) => (resolve = r));
    const bridge = fakeBridge({ newSession: vi.fn(() => gated) });
    renderModal({ bridge });
    fireEvent.click(launchBtn());
    fireEvent.click(launchBtn());
    expect(bridge.newSession).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await waitFor(() => expect(bridge.newSession).toHaveBeenCalledTimes(1));
  });
});
