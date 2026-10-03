import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionPrLink } from "../../ipcTypes";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";

// A search:changed event invalidates every loaded id and refetches the last
// requested window; old links stay on screen until the new reply lands.
export function useSessionPrs(
  bridge: CsmBridge | undefined = currentBridge(),
): {
  prs: ReadonlyMap<string, SessionPrLink[]>;
  requestPrs: (ids: readonly string[]) => void;
} {
  const [prs, setPrs] = useState<Map<string, SessionPrLink[]>>(new Map());
  const known = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const epoch = useRef(0);
  const lastIds = useRef<readonly string[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const requestPrs = useCallback(
    (ids: readonly string[]) => {
      const search = bridge?.search;
      if (!search) return;
      lastIds.current = ids;
      const seen = known.current;
      const flight = inFlight.current;
      const ep = epoch.current;
      const need = ids.filter((id) => !seen.has(id) && !flight.has(id));
      if (need.length === 0) return;
      need.forEach((id) => flight.add(id));
      void search
        .prsFor([...need])
        .then((res) => {
          need.forEach((id) => flight.delete(id));
          if (!mounted.current || ep !== epoch.current) return;
          need.forEach((id) => seen.add(id));
          setPrs((prev) => {
            const next = new Map(prev);
            for (const id of need)
              next.set(id, Object.hasOwn(res, id) ? res[id] : []);
            return next;
          });
        })
        .catch(() => {
          need.forEach((id) => flight.delete(id));
        });
    },
    [bridge],
  );

  useEffect(() => {
    const search = bridge?.search;
    if (!search) return;
    return search.onChanged(() => {
      epoch.current++;
      known.current = new Set();
      inFlight.current = new Set();
      requestPrs(lastIds.current);
    });
  }, [bridge, requestPrs]);

  return { prs, requestPrs };
}
