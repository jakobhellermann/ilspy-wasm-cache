import { type Decompiler, MissingAssembliesError } from "./index.ts";
import type { AssemblyFile, AssemblySet, DecompiledType, Status } from "./protocol.ts";

export interface SessionState {
  /** Key of the set types are read from: the one passed to `use`, else the newest added set's. */
  key: string | null;
  /** The added set with that key, if it was ever added in this origin. */
  set: AssemblySet | null;
  /** Whether the assemblies of `key` are loaded in this page, i.e. uncached types can be decompiled. */
  loaded: boolean;
  /** The last added set when it is not the one `use` asked for. */
  mismatch: AssemblySet | null;
  status: Status;
  /** Types requested while neither cached nor decompilable; `type` resolves them after adding `key`'s set. */
  waiting: string[];
}

export interface SessionOptions {
  /** Read types from this set (the SHA-256 of its main assembly) instead of the newest added one. */
  key?: string;
}

export interface Session {
  readonly state: SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  /** Reads types from the set with `key`, or the newest added one for null; rejects pending `type` calls. */
  use(key: string | null): Promise<void>;
  /** Adds dropped assemblies; waiting types are decompiled against them if they are `key`'s set. */
  add(files: Iterable<File | AssemblyFile>, main?: string): Promise<AssemblySet>;
  /** Resolves once the type is cached or decompiled, waiting for an `add` if needed. */
  type(name: string): Promise<DecompiledType>;
}

interface Waiter {
  resolve(t: DecompiledType): void;
  reject(e: unknown): void;
}

export function createSession(decompiler: Decompiler, options: SessionOptions = {}): Session {
  let state: SessionState = {
    key: null,
    set: null,
    loaded: false,
    mismatch: null,
    status: { phase: "idle" },
    waiting: [],
  };
  const listeners = new Set<(s: SessionState) => void>();
  const waiters = new Map<string, Waiter[]>();
  let wanted = options.key ?? null;
  let loadedKey: string | null = null;
  let ready = select();

  decompiler.onStatus((status) => update({ status }));

  function update(patch: Partial<SessionState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  }

  async function select(): Promise<void> {
    const sets = await decompiler.sets();
    const set = wanted ? (sets.find((s) => s.key === wanted) ?? null) : (sets[0] ?? null);
    const key = wanted ?? set?.key ?? null;
    update({ key, set, loaded: key !== null && key === loadedKey });
  }

  function wait(name: string): Promise<DecompiledType> {
    return new Promise((resolve, reject) => {
      waiters.set(name, [...(waiters.get(name) ?? []), { resolve, reject }]);
      update({ waiting: [...waiters.keys()] });
    });
  }

  function drain(): [string, Waiter[]][] {
    const drained = [...waiters];
    waiters.clear();
    update({ waiting: [] });
    return drained;
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
    async use(key) {
      if (key === wanted) return ready;
      wanted = key;
      const error = new Error(`set changed to ${key ?? "the newest"}`);
      for (const [, ws] of drain()) ws.forEach((w) => w.reject(error));
      update({ mismatch: null });
      return (ready = select());
    },
    async add(files, main) {
      await ready;
      const set = await decompiler.add(files, main);
      loadedKey = set.key;
      if (wanted && set.key !== wanted) {
        update({ mismatch: set, loaded: false });
        return set;
      }
      update({ key: set.key, set, loaded: true, mismatch: null });
      for (const [name, ws] of drain()) {
        decompiler.request(set.key, name).then(
          (t) => ws.forEach((w) => w.resolve(t)),
          (e) => ws.forEach((w) => w.reject(e)),
        );
      }
      return set;
    },
    async type(name) {
      await ready;
      const { key } = state;
      if (!key) return wait(name);
      try {
        return await decompiler.request(key, name);
      } catch (e) {
        if (!(e instanceof MissingAssembliesError)) throw e;
        // the key changed or its set was added while the request was in flight
        if (state.key !== key || state.loaded) return this.type(name);
        return wait(name);
      }
    },
  };
}
