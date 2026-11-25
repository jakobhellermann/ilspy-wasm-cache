# ilspy-wasm-cache

```ts
import { createDecompiler, MissingAssembliesError } from "ilspy-wasm-cache";

// URL where the app serves the package's dist/assets/
function createDecompiler(assets: string | URL): Decompiler;

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
}

interface Member {
  name: string;
  line: number; // 1-based line of the member's name in source
}

type Status =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "loading"; main: string }
  | { phase: "decompiling"; type: string; pending: number };
```

Cache: IndexedDB `ilspy-wasm-cache`, per origin, keyed by assembly hash, decompiler version and type name.
