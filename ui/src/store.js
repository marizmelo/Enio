import { create } from "zustand";

/**
 * Inspector state that more than one component needs.
 *
 * Deliberately narrow. Per-view fetch state -- the sessions list, the graph
 * nodes, their loading and error flags -- stays local to the view that owns it,
 * because nothing else reads it and moving it here would turn a store into a
 * dumping ground.
 *
 * What is here is the state that was actually being threaded: an auth failure
 * can happen inside any request in any view, but only the shell can render the
 * banner for it. That was an onAuthError callback passed into every view and
 * then into every useCallback dependency array underneath them.
 */
export const useInspector = create((set) => ({
  tab: "runs",
  setTab: (tab) => set({ tab }),

  /**
   * A 401 from anywhere. Views call report(err) with whatever they caught and
   * the filtering happens here rather than at each call site -- there were
   * five copies of `if (err && err.status === 401)` before, and a sixth would
   * have been easy to forget.
   */
  authError: null,
  reportError: (err) => {
    if (err && err.status === 401) set({ authError: err });
  },
  clearAuthError: () => set({ authError: null }),
}));
