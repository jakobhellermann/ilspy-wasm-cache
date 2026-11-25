import assert from "node:assert/strict";
import { test } from "node:test";
import { type Decompiler, MissingAssembliesError } from "../src/index.ts";
import type { AssemblySet, DecompiledType } from "../src/protocol.ts";
import { createSession } from "../src/session.ts";

/** In-memory decompiler: `add` loads a set named by its first file, `request` answers only for the loaded set. */
function fakeDecompiler(known: AssemblySet[] = []) {
  const sets = [...known];
  let loaded: string | null = null;
  const decompiler: Decompiler = {
    async add(files) {
      const [first] = [...files];
      const set: AssemblySet = {
        key: first.name,
        main: first.name,
        used: [],
        addedAt: sets.length,
      };
      sets.unshift(set);
      loaded = set.key;
      return set;
    },
    sets: async () => sets,
    get: async () => undefined,
    async request(key, type) {
      if (key !== loaded) throw new MissingAssembliesError(key);
      return { type: `${key}/${type}` } as DecompiledType;
    },
    onStatus: () => () => {},
    terminate() {},
  };
  return decompiler;
}

const file = (name: string) => ({ name, bytes: new ArrayBuffer(0) });
const settled = () => new Promise((r) => setTimeout(r, 0));

test("without a key, types come from the newest added set", async () => {
  const session = createSession(fakeDecompiler());
  const pending = session.type("Hero");
  await settled();
  assert.deepEqual(session.state.waiting, ["Hero"]);
  await session.add([file("ss")]);
  assert.equal((await pending).type, "ss/Hero");
  assert.equal(session.state.key, "ss");
});

test("with a key, another set is a mismatch and does not resolve waiting types", async () => {
  const session = createSession(fakeDecompiler(), { key: "hk" });
  let resolved: DecompiledType | null = null;
  const pending = session.type("Hero").then((t) => (resolved = t));
  await settled();
  await session.add([file("ss")]);
  await settled();
  assert.equal(resolved, null);
  assert.equal(session.state.mismatch?.key, "ss");
  assert.deepEqual(session.state.waiting, ["Hero"]);
  await session.add([file("hk")]);
  await pending;
  assert.equal(resolved!.type, "hk/Hero");
  assert.equal(session.state.mismatch, null);
});

test("use rejects types waiting for the previous key and switches the set", async () => {
  const session = createSession(fakeDecompiler([{ key: "ss", main: "ss", used: [], addedAt: 0 }]), {
    key: "hk",
  });
  const pending = session.type("Hero");
  await settled();
  await session.use("ss");
  await assert.rejects(pending, /set changed/);
  assert.equal(session.state.key, "ss");
  assert.equal(session.state.set?.key, "ss");
  assert.equal(session.state.loaded, false);
});
