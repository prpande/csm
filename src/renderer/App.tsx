import styles from "./App.module.css";

// Sample scaffold component. Reads the platform from the window.csm IPC bridge
// (exposed by the preload in #4) to prove the renderer ↔ main contract is wired;
// falls back to "web" when the bridge is absent (e.g. a plain browser / test).
export function App() {
  const platform = window.csm?.platform ?? "web";

  return (
    <main className={styles.app}>
      <h1>CSM — Claude Session Manager</h1>
      <p>Renderer scaffold ready.</p>
      <p className={styles.meta}>platform: {platform}</p>
    </main>
  );
}
