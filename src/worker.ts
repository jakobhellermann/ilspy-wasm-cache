import type {
  AssemblyFile,
  AssemblySet,
  DecompiledType,
  FromWorker,
  Request,
  Status,
  ToWorker,
} from "./protocol.ts";

declare const DECOMPILER_VERSION: string;

/** Bumped when the shape of cached types changes. */
const CACHE_FORMAT = 4;
declare const self: DedicatedWorkerGlobalScope;

interface Exports {
  AddAssembly(name: string, bytes: Uint8Array): void;
  Clear(): void;
  Load(main: string): Promise<string>;
  DecompileType(fullName: string): Promise<string>;
}

class MissingAssemblies extends Error {}

const db = openDb();
let runtime: Promise<Exports> | null = null;
let loadedKey: string | null = null;
let pending = 0;
let queue: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<DecompiledType>>();

self.onmessage = async ({ data }: MessageEvent<ToWorker>) => {
  const { id, ...request } = data;
  try {
    post({ id, ok: true, value: await handle(request) });
  } catch (e) {
    post({
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      missingAssemblies: e instanceof MissingAssemblies || undefined,
    });
  }
};

function post(msg: FromWorker) {
  self.postMessage(msg);
}

function status(s: Status) {
  post({ status: s });
}

async function handle(r: Request): Promise<unknown> {
  switch (r.op) {
    case "add":
      return add(r.files, r.main);
    case "sets":
      return all<AssemblySet>("sets");
    case "get":
      return get<DecompiledType>("types", typeId(r.key, r.type));
    case "request":
      return request(r.key, r.type);
  }
}

async function add(files: AssemblyFile[], main: string): Promise<AssemblySet> {
  const mainFile = files.find((f) => f.name === main);
  if (!mainFile) throw new Error(`${main} is not among the ${files.length} dropped files`);
  const key = hex(await crypto.subtle.digest("SHA-256", mainFile.bytes));
  const exports = await start();
  status({ phase: "loading", main });
  loadedKey = null;
  exports.Clear();
  for (const f of files) exports.AddAssembly(f.name, new Uint8Array(f.bytes));
  const used: string[] = JSON.parse(await exports.Load(main));
  loadedKey = key;
  const set: AssemblySet = { key, main, used, addedAt: Date.now() };
  await put("sets", set);
  status({ phase: "idle" });
  return set;
}

async function request(key: string, type: string): Promise<DecompiledType> {
  const id = typeId(key, type);
  const cached = await get<DecompiledType>("types", id);
  if (cached) return cached;
  let job = inflight.get(id);
  if (!job) {
    pending++;
    job = enqueue(() => decompile(key, type)).finally(() => {
      pending--;
      inflight.delete(id);
      if (!pending) status({ phase: "idle" });
    });
    inflight.set(id, job);
  }
  return job;
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

async function decompile(key: string, type: string): Promise<DecompiledType> {
  if (loadedKey !== key) throw new MissingAssemblies(`assemblies for ${key} are not loaded`);
  status({ phase: "decompiling", type, pending });
  // yield so queued messages (cache reads) are answered before the long synchronous call
  await new Promise((r) => setTimeout(r));
  const { source, members, tokens, symbols, symbolTypes } = JSON.parse(
    await (await start()).DecompileType(type),
  );
  const result: DecompiledType = { type, source, members, tokens, symbols, symbolTypes };
  await put("types", { id: typeId(key, type), ...result });
  return result;
}

function start(): Promise<Exports> {
  return (runtime ??= (async () => {
    status({ phase: "starting" });
    const { dotnet } = await import(
      /* @vite-ignore */ new URL("./_framework/dotnet.js", import.meta.url).href
    );
    const { getAssemblyExports, getConfig } = await dotnet.create();
    return (await getAssemblyExports(getConfig().mainAssemblyName)).Decompiler as Exports;
  })());
}

const typeId = (key: string, type: string) =>
  `${key}:${DECOMPILER_VERSION}:${CACHE_FORMAT}:${type}`;

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ilspy-wasm-cache", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("sets", { keyPath: "key" });
      req.result.createObjectStore("types", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const s = (await db).transaction(store, mode).objectStore(store);
  return new Promise((resolve, reject) => {
    const req = op(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const get = <T>(store: string, id: string) =>
  tx<T | undefined>(store, "readonly", (s) => s.get(id));
const all = <T>(store: string) => tx<T[]>(store, "readonly", (s) => s.getAll());
const put = (store: string, value: object) => tx(store, "readwrite", (s) => s.put(value));
