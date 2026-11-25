import type {
  AssemblyFile,
  AssemblySet,
  DecompiledType,
  FromWorker,
  Request,
  Status,
} from "./protocol.ts";

export type {
  AssemblyFile,
  AssemblySet,
  DecompiledType,
  Member,
  Status,
  Symbol,
  TokenKind,
} from "./protocol.ts";
export { symbolOf, TOKEN_KINDS } from "./protocol.ts";

/** Thrown by `request` when the type is not cached and the assemblies of its set are not loaded. */
export class MissingAssembliesError extends Error {}

export interface Decompiler {
  /** Loads dropped files in place of the previous ones (non-`.dll`s are ignored) and returns their set; the bytes are not persisted. */
  add(files: Iterable<File | AssemblyFile>, main?: string): Promise<AssemblySet>;
  /** Assembly sets added so far in this origin, newest first. */
  sets(): Promise<AssemblySet[]>;
  /** Cached type, without starting the runtime. */
  get(key: string, type: string): Promise<DecompiledType | undefined>;
  /** Cached type, or decompiles it; concurrent requests for the same type share one decompilation. */
  request(key: string, type: string): Promise<DecompiledType>;
  onStatus(listener: (status: Status) => void): () => void;
  terminate(): void;
}

/** `assets` is the URL of the package's `dist/assets/` directory as served by the app. */
export function createDecompiler(assets: string | URL): Decompiler {
  const worker = new Worker(new URL("worker.js", assets), { type: "module" });
  const calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const listeners = new Set<(s: Status) => void>();
  let nextId = 0;

  worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
    if ("status" in data) {
      for (const l of listeners) l(data.status);
      return;
    }
    const call = calls.get(data.id)!;
    calls.delete(data.id);
    if (data.ok) call.resolve(data.value);
    else
      call.reject(
        data.missingAssemblies ? new MissingAssembliesError(data.error) : new Error(data.error),
      );
  };

  // a worker that fails to load or throws outside a call would otherwise leave its callers pending
  worker.onerror = (e) => {
    const error = new Error(`decompiler worker failed: ${e.message || "could not load worker.js"}`);
    for (const call of calls.values()) call.reject(error);
    calls.clear();
  };

  function call<T>(request: Request, transfer: Transferable[] = []): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, ...request }, transfer);
    });
  }

  return {
    async add(files, main = "Assembly-CSharp.dll") {
      const read = await Promise.all(
        [...files]
          .filter((f) => f.name.toLowerCase().endsWith(".dll"))
          .map(async (f) => ({
            name: f.name,
            bytes: f instanceof File ? await f.arrayBuffer() : f.bytes,
          })),
      );
      return call<AssemblySet>(
        { op: "add", files: read, main },
        read.map((f) => f.bytes),
      );
    },
    async sets() {
      return (await call<AssemblySet[]>({ op: "sets" })).sort((a, b) => b.addedAt - a.addedAt);
    },
    get: (key, type) => call({ op: "get", key, type }),
    request: (key, type) => call({ op: "request", key, type }),
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    terminate: () => worker.terminate(),
  };
}

export { collectFiles } from "./files.ts";
export { segmentLines, type Segment } from "./segments.ts";
export { createSession, type Session, type SessionOptions, type SessionState } from "./session.ts";
