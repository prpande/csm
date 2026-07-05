import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";

// Flag the desktop shell so the title-bar drag region and window controls
// activate (styles key off [data-shell="desktop"]). Sourced from the preload
// bridge flag the renderer already owns and set here in the renderer entry —
// not the preload, which runs at document-start when document.documentElement
// can still be null. In a plain browser (no preload) the flag is absent, so the
// app keeps the host chrome. Runs before render, so the drag region is live from
// the first paint of the title bar.
if (window.csm?.isDesktop) {
  document.documentElement.dataset.shell = "desktop";
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("CSM renderer: #root element not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
