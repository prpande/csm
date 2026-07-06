import { useCallback, useRef, useState } from "react";
import type { SessionFacts } from "../../sessionParser";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";

export type FactEntry =
  { status: "loaded"; facts: SessionFacts } | { status: "error" };

// Lazy, windowed fact loader for the enriched row (#115). Rows call requestFacts
// with the visible-window ids; the hook fetches only the uncached, not-in-flight
// ones via csm.getFacts and merges results. A row absent from `facts` is still
// loading. State lives per mounted list — SessionList is keyed by folder path, so
// a folder switch re-mounts and clears the map (no cross-folder growth).
export function useSessionFacts(
  bridge: CsmBridge | undefined = currentBridge(),
): {
  facts: ReadonlyMap<string, FactEntry>;
  requestFacts: (ids: readonly string[]) => void;
} {
  const [facts, setFacts] = useState<Map<string, FactEntry>>(new Map());
  // Refs mirror state for the has-check so requestFacts stays referentially stable
  // (an effect in SessionList calls it — a changing identity would re-fire it).
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const inFlight = useRef<Set<string>>(new Set());

  const requestFacts = useCallback(
    (ids: readonly string[]) => {
      const getFacts = bridge?.getFacts;
      if (!getFacts) return;
      const need = ids.filter(
        (id) => !factsRef.current.has(id) && !inFlight.current.has(id),
      );
      if (need.length === 0) return;
      need.forEach((id) => inFlight.current.add(id));
      void getFacts([...need])
        .then((res) => {
          setFacts((prev) => {
            const next = new Map(prev);
            for (const id of need) {
              const r = res[id];
              next.set(
                id,
                r && !("error" in r)
                  ? { status: "loaded", facts: r }
                  : { status: "error" },
              );
            }
            return next;
          });
          need.forEach((id) => inFlight.current.delete(id)); // outside the updater — updaters must be pure
        })
        .catch(() => {
          need.forEach((id) => inFlight.current.delete(id)); // allow a later retry
        });
    },
    [bridge],
  );

  return { facts, requestFacts };
}
