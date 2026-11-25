# ilspy-wasm-cache

```ts
import { collectFiles, createDecompiler, createSession, MissingAssembliesError, symbolOf } from "ilspy-wasm-cache";

// URL where the app serves the package's dist/assets/
function createDecompiler(assets: string | URL): Decompiler;

function createSession(decompiler: Decompiler): Session;

// .dll files, recursing into dropped directories; call synchronously in the drop handler
function collectFiles(source: DataTransfer | FileList | Iterable<File>): Promise<File[]>;

interface Session {
  readonly state: SessionState;
  // calls the listener immediately
  subscribe(listener: (state: SessionState) => void): () => void;
  // adds the assemblies and decompiles the waiting types against them
  add(files: Iterable<File | AssemblyFile>, main?: string): Promise<AssemblySet>;
  // cached or decompiled; waits for the next add if neither is possible
  type(name: string): Promise<DecompiledType>;
}

interface SessionState {
  set: AssemblySet | null; // newest set
  loaded: boolean; // assemblies of set are loaded in this page
  status: Status;
  waiting: string[]; // types waiting for an add
}

interface Decompiler {
  // non-.dll files are ignored; the bytes are not persisted
  add(files: Iterable<File | AssemblyFile>, main?: string /* "Assembly-CSharp.dll" */): Promise<AssemblySet>;
  // newest first
  sets(): Promise<AssemblySet[]>;
  // cache only, does not start the runtime
  get(key: string, type: string): Promise<DecompiledType | undefined>;
  // cache or decompile; concurrent requests for one type share a decompilation
  // throws MissingAssembliesError if uncached and the set's assemblies are not loaded
  request(key: string, type: string): Promise<DecompiledType>;
  onStatus(listener: (status: Status) => void): () => void;
  terminate(): void;
}

interface AssemblyFile {
  name: string;
  bytes: ArrayBuffer;
}

interface AssemblySet {
  key: string; // SHA-256 of the main assembly
  main: string;
  used: string[]; // assemblies the main assembly's type system resolved
  addedAt: number;
}

interface DecompiledType {
  type: string;
  source: string;
  members: Member[];
  tokens: number[]; // [gap, length, kind, symbol] quadruples, gap = characters since the previous token's end, kind indexes TOKEN_KINDS, symbol = id or 0
  symbols: number[]; // id n is [symbolTypes index, metadata token] at [2n - 2, 2n - 1]
  symbolTypes: string[]; // reflection names of declaring types
}

// an entity by declaring type and metadata token, equal across decompiled types
interface Symbol {
  type: string;
  token: number;
}

// null for id 0
function symbolOf(t: DecompiledType, id: number): Symbol | null;

const TOKEN_KINDS = ["keyword", "type", "method", "member", "string", "number", "comment"] as const;
type TokenKind = (typeof TOKEN_KINDS)[number];

interface Member {
  name: string;
  line: number; // 1-based line of the member's name in source
  symbol: number; // id or 0
}

type Status =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "loading"; main: string }
  | { phase: "decompiling"; type: string; pending: number };
```

Cache: IndexedDB `ilspy-wasm-cache`, per origin, keyed by assembly hash, decompiler version and type name.
