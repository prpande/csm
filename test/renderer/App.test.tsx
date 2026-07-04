import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../../src/renderer/App";

// App is now just the folder-browser shell (behavior is covered in
// FolderBrowser.test.tsx). This is a thin smoke test that the root renders.
// The setup.ts fake bridge's listSessions never emits, so App sits in its
// initial scanning state. Plain assertions (no jest-dom) so it passes locally.
describe("App", () => {
  it("renders the folder-browser shell", () => {
    render(<App />);
    expect(screen.getByText(/claude session manager/i)).toBeTruthy();
    expect(screen.getByText(/loading older sessions/i)).toBeTruthy();
  });
});
