import { type Decompiler, MissingAssembliesError } from "./index.ts";
import type { AssemblyFile, AssemblySet, DecompiledType, Status } from "./protocol.ts";

export interface SessionState {
  /** The newest added set; its cached types are readable without its assemblies. */
  set: AssemblySet | null;
  /** Whether the assemblies of `set` are loaded in this page, i.e. uncached types can be decompiled. */
  loaded: boolean;
  status: Status;
  /** Types requested while neither cached nor decompilable; `type` resolves them after the next `add`. */
  waiting: string[];
}

export interface Session {
  readonly state: SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  /** Adds dropped assemblies and decompiles the waiting types against them. */
  add(files: Iterable<File | AssemblyFile>, main?: string): Promise<AssemblySet>;
  /** Resolves once the type is cached or decompiled, waiting for an `add` if needed. */
  type(name: string): Promise<DecompiledType>;
}

interface Waiter {
  resolve(t: DecompiledType): void;
  reject(e: unknown): void;
}

export function createSession(decompiler: Decompiler): Session {
  let state: SessionState = { set: null, loaded: false, status: { phase: "idle" }, waiting: [] };
  const listeners = new Set<(s: SessionState) => void>();
  const waiters = new Map<string, Waiter[]>();
  const ready = decompiler.sets().then(([newest]) => update({ set: newest ?? null }));

  decompiler.onStatus((status) => update({ status }));

  function update(patch: Partial<SessionState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  }

  function wait(name: string): Promise<DecompiledType> {
    return new Promise((resolve, reject) => {
      waiters.set(name, [...(waiters.get(name) ?? []), { resolve, reject }]);
      update({ waiting: [...waiters.keys()] });
    });
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async add(files, main) {
      await ready;
      const set = await decompiler.add(files, main);
      const resumed = [...waiters];
      waiters.clear();
      update({ set, loaded: true, waiting: [] });
      for (const [name, ws] of resumed) {
        decompiler.request(set.key, name).then(
          (t) => ws.forEach((w) => w.resolve(t)),
          (e) => ws.forEach((w) => w.reject(e)),
        );
      }
      return set;
    },
    async type(name) {
      await ready;
      const { set } = state;
      if (!set) return wait(name);
      try {
        return await decompiler.request(set.key, name);
      } catch (e) {
        if (!(e instanceof MissingAssembliesError)) throw e;
        // an add finished while the request was in flight
        if (state.set?.key !== set.key) return this.type(name);
        return wait(name);
      }
    },
  };
}
