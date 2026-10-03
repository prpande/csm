import { test, expect, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { PrPopover } from "../../src/renderer/components/PrPopover";
import type { SessionPrLink } from "../../src/ipcTypes";

const pr = (over: Partial<SessionPrLink> = {}): SessionPrLink => ({
  repo: "o/r",
  number: 12,
  url: "https://github.com/o/r/pull/12",
  title: "Fix the parser",
  state: "OPEN",
  isDraft: false,
  createdHere: true,
  firstSeen: 1,
  lastSeen: 2,
  ...over,
});

const links = [
  pr({ number: 5, createdHere: false, state: "MERGED", lastSeen: 1 }),
  pr(),
  pr({ number: 7, createdHere: false, title: null, state: null }),
];

const anchors: HTMLElement[] = [];
const makeAnchor = () => {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  anchors.push(anchor);
  return anchor;
};

afterEach(() => {
  vi.restoreAllMocks();
  anchors.splice(0).forEach((a) => a.remove());
});

const itemsOf = () => within(screen.getByRole("dialog")).getAllByRole("button");

const setup = (over: Partial<Parameters<typeof PrPopover>[0]> = {}) => {
  const anchor = makeAnchor();
  const onOpenPr = vi.fn();
  const onClose = vi.fn();
  render(
    <PrPopover
      anchor={anchor}
      sessionTitle="Refactor the parser"
      links={links}
      onOpenPr={onOpenPr}
      onClose={onClose}
      {...over}
    />,
  );
  return { anchor, onOpenPr, onClose };
};

test("renders in document.body as a labelled dialog, primary first", () => {
  const { anchor } = setup();
  const dialog = screen.getByRole("dialog", {
    name: "Pull requests for Refactor the parser",
  });
  expect(dialog.parentElement).toBe(document.body);
  expect(anchor.contains(dialog)).toBe(false);
  const items = within(dialog).getAllByRole("button");
  expect(items.map((b) => b.textContent)).toEqual([
    expect.stringContaining("#12"),
    expect.stringContaining("#7"),
    expect.stringContaining("#5"),
  ]);
  expect(dialog.textContent).toContain("3 pull requests");
  expect(dialog.textContent).toContain("Enter opens · Esc closes");
  expect(items[0].textContent).toContain("opened here");
  expect(items[1].textContent).toContain("Title unavailable");
});

test("the primary item takes focus on open", () => {
  setup();
  const items = itemsOf();
  expect(document.activeElement).toBe(items[0]);
});

test("a title is never parsed as markup", () => {
  setup({
    links: [pr({ title: "<img src=x onerror=alert(1)>" }), pr({ number: 3 })],
  });
  expect(document.querySelector("img")).toBeNull();
});

test("Enter and click open the PR and keep the popover open", () => {
  const { onOpenPr, onClose } = setup();
  const items = itemsOf();
  fireEvent.keyDown(items[0], { key: "Enter" });
  expect(onOpenPr).toHaveBeenLastCalledWith(links[1]);
  fireEvent.click(items[2]);
  expect(onOpenPr).toHaveBeenLastCalledWith(links[0]);
  expect(onOpenPr).toHaveBeenCalledTimes(2);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("Up, Down, Home and End move focus and clamp at the ends", () => {
  setup();
  const dialog = screen.getByRole("dialog");
  const items = itemsOf();
  fireEvent.keyDown(items[0], { key: "ArrowUp" });
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(items[2]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[2]);
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(items[0]);
  expect(dialog.isConnected).toBe(true);
});

test("Tab stays inside the popover", () => {
  setup();
  const items = itemsOf();
  act(() => items[2].focus());
  const ev = fireEvent.keyDown(items[2], { key: "Tab" });
  expect(ev).toBe(false);
  expect(document.activeElement).toBe(items[0]);
  const back = fireEvent.keyDown(items[0], { key: "Tab", shiftKey: true });
  expect(back).toBe(false);
  expect(document.activeElement).toBe(items[2]);
});

test("Escape asks to close as a keyboard close", () => {
  const { onClose } = setup();
  fireEvent.keyDown(itemsOf()[0], { key: "Escape" });
  expect(onClose).toHaveBeenCalledWith({ keyboard: true });
});

test("keys do not bubble out of the popover", () => {
  const outer = vi.fn();
  const anchor = makeAnchor();
  render(
    <div onKeyDown={outer}>
      <PrPopover
        anchor={anchor}
        sessionTitle="t"
        links={links}
        onOpenPr={vi.fn()}
        onClose={vi.fn()}
      />
    </div>,
  );
  fireEvent.keyDown(itemsOf()[0], { key: "Enter" });
  expect(outer).not.toHaveBeenCalled();
});

test("an outside pointerdown closes it; inside and on the anchor do not", () => {
  const { anchor, onClose } = setup();
  fireEvent.pointerDown(itemsOf()[0]);
  fireEvent.pointerDown(anchor);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(onClose).toHaveBeenCalledWith({ keyboard: false });
});

test("a popover that does not fit below flips above the anchor", () => {
  const anchor = makeAnchor();
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const r =
        this === anchor
          ? {
              top: 250,
              bottom: 274,
              left: 600,
              right: 700,
              width: 100,
              height: 24,
            }
          : {
              top: 0,
              bottom: 200,
              left: 0,
              right: 368,
              width: 368,
              height: 200,
            };
      return { ...r, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    },
  );
  render(
    <PrPopover
      anchor={anchor}
      sessionTitle="t"
      links={links}
      onOpenPr={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.getAttribute("data-placement")).toBe("above");
  expect(dialog.style.position).toBe("fixed");
  expect(parseFloat(dialog.style.top)).toBeLessThan(250);
  expect(parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(0);
});

test("a popover that fits opens below the anchor", () => {
  const anchor = makeAnchor();
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const r =
        this === anchor
          ? {
              top: 100,
              bottom: 124,
              left: 600,
              right: 700,
              width: 100,
              height: 24,
            }
          : {
              top: 0,
              bottom: 200,
              left: 0,
              right: 368,
              width: 368,
              height: 200,
            };
      return { ...r, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    },
  );
  render(
    <PrPopover
      anchor={anchor}
      sessionTitle="t"
      links={links}
      onOpenPr={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.getAttribute("data-placement")).toBe("below");
  expect(parseFloat(dialog.style.top)).toBeGreaterThan(124);
});

test("when the links shrink the focus stays on a valid item and nothing throws", () => {
  const anchor = makeAnchor();
  const props = {
    anchor,
    sessionTitle: "t",
    onOpenPr: vi.fn(),
    onClose: vi.fn(),
  };
  const { rerender } = render(<PrPopover {...props} links={links} />);
  fireEvent.keyDown(itemsOf()[0], { key: "End" });
  rerender(<PrPopover {...props} links={[pr(), pr({ number: 7 })]} />);
  const items = itemsOf();
  expect(items.length).toBe(2);
  expect(document.activeElement).toBe(items[1]);
});
