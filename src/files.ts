/**
 * The `.dll` files of a drop or a file input, including those inside dropped directories.
 * For a `DataTransfer`, call this synchronously in the `drop` handler: its items are only readable during the event.
 */
export function collectFiles(source: DataTransfer | FileList | Iterable<File>): Promise<File[]> {
  if (typeof DataTransfer !== "undefined" && source instanceof DataTransfer) {
    const entries = [...source.items].map((i) => i.webkitGetAsEntry()).filter((e) => e !== null);
    return Promise.all(entries.map(filesOf)).then((f) => f.flat().filter(isDll));
  }
  return Promise.resolve([...(source as Iterable<File>)].filter(isDll));
}

const isDll = (f: File) => f.name.toLowerCase().endsWith(".dll");

async function filesOf(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return [await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // Chromium returns at most 100 entries per call; an empty batch means done
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(filesOf))).flat();
}
