import { FolderBrowser } from "./components/FolderBrowser";

// Root renderer component: the folder-browser shell (title bar + sidebar tree +
// folder-view pane) over the #64 data layer. The bridge is read inside
// useSessionScan; a plain browser without the preload fails soft to an empty
// tree with an error notice.
export function App() {
  return <FolderBrowser />;
}
