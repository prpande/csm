// Application-menu policy for the custom frameless shell (#86). The SPA title bar
// is the visible chrome, so the default Electron menu bar is dropped everywhere —
// EXCEPT macOS, where a native menu is what wires the standard text-editing
// accelerators (⌘C/⌘V/⌘X/⌘A/⌘Q) into focused inputs. Nulling the menu on darwin
// would silently break those shortcuts.
//
// Pure: returns a template (or null); the caller feeds it to Menu.buildFromTemplate
// / Menu.setApplicationMenu. `import type` keeps electron out of the runtime graph
// so this is unit-testable under the node test tsconfig without an Electron runtime.
import type { MenuItemConstructorOptions } from "electron";

// null  → caller sets a null application menu (no menu bar at all).
// array → a minimal role-based menu. Roles auto-populate their items and
//         accelerators, so this stays a declarative one-liner per platform.
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] | null {
  if (platform !== "darwin") return null;
  return [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
}
