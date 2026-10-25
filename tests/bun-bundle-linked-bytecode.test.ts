// Patching a blob whose cached bytecode is one linked payload (Bun's `HAS_LINKED_BYTECODE_PAYLOAD`,
// first shipped in Claude Code 2.1.310).
//
// Every module's `bytecode` range runs from its own entry to the END of one shared payload, so the
// ranges overlap by design. tweakcc's repack copies each range separately: on the real build that
// is ~230 GB, and the sizing mirror refused all eight platforms with "overlapping payload ranges".

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBundleWritePlan,
  PLACEHOLDER_SLACK_BYTES,
  planBundleWrite,
  prepareRepackInput,
  readClaudeBundle,
} from '../src/bun-bundle.js';
import {
  readBunJavaScriptModules,
  readBunModuleTable,
  tweakccRecognizesModuleName,
} from '../src/bun-module-table.js';
import {
  buildFakeNativeClaude,
  parseBunBlob,
  rebuildFakeNativeClaude,
  type BunBlobOptions,
  type BunModuleFixture,
} from './bun-blob-fixture.js';

/**
 * Bun's `HAS_LINKED_BYTECODE_PAYLOAD`, spelled as a literal rather than read from
 * `BUN_BLOB_FLAGS`, so a wrong value there cannot build a fixture that agrees with it.
 */
const LINKED_BYTECODE_PAYLOAD = 1 << 13;

/** An asset between JavaScript modules, so table positions and bundle positions differ. */
const MODULES: BunModuleFixture[] = [
  { name: '/$bunfs/root/chunk-a.js', contents: 'export const a=1;' },
  { name: '/$bunfs/root/mermaid.min.js', loader: 5, contents: 'export const a=99;' },
  { name: '/$bunfs/root/claude', contents: 'import{a}from"./chunk-a.js";a;' },
  { name: '/$bunfs/root/chunk-b.js', contents: 'export const b=2;' },
];
const WRITABLE_ID = 2;
const ENTRY_ID = 3;

/**
 * Each entry is large enough that the overlapping ranges, summed, outrun the placeholder's slack —
 * the shape of the real failure, where the sum is ~1,300x the blob.
 */
const entry = (name: string) => `compiled:${name}:`.padEnd(30 * 1024, '#');

function withBinary(
  modules: BunModuleFixture[],
  options: BunBlobOptions,
  run: (path: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'clodex-bun-linked-'));
  try {
    const path = join(dir, 'claude');
    const binary = buildFakeNativeClaude('2.1.310', modules, { entryPointId: ENTRY_ID, ...options });
    writeFileSync(path, binary);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Stand in for tweakcc's `writeContent`: rebuild the blob from every module's ranges, copying each
 * one separately — overlapping or not — exactly as tweakcc's repack does.
 */
function fakeWriteContent(path: string, content: string): void {
  const parsed = parseBunBlob(readFileSync(path));
  writeFileSync(path, rebuildFakeNativeClaude(
    readFileSync(path),
    '2.1.310',
    (index, previous) => (tweakccRecognizesModuleName(parsed.names[index]!) ? content : previous),
  ));
}

describe('a linked bytecode payload', () => {
  it('patches a blob whose bytecode ranges all run to the end of one shared payload', () => {
    const flags = LINKED_BYTECODE_PAYLOAD;
    const linked = MODULES.map(module => ({ ...module, bytecode: entry(module.name) }));
    withBinary(linked, { flags, linkedBytecode: true }, path => {
      const before = readBunModuleTable(path)!;
      const payloadStart = before.bytecode[0]!.offset;
      const payloadEnd = payloadStart + before.bytecode[0]!.length;
      expect(before.bytecode.every(range => range.offset + range.length === payloadEnd)).toBe(true);
      const pristine = readFileSync(path);

      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      expect(plan.clearsBytecodeBeforeRepack).toBe(true);
      prepareRepackInput(path, plan);
      // What tweakcc is handed carries no bytecode range to copy.
      expect(readBunModuleTable(path)!.bytecode.every(range => range.length === 0)).toBe(true);
      fakeWriteContent(path, plan.content);
      // The placeholder was sized for the repack of the cleared table — exactly.
      expect(readBunModuleTable(path)!.byteCount).toBe(plan.data.length + PLACEHOLDER_SLACK_BYTES);

      applyBundleWritePlan(path, plan);
      const after = readBunModuleTable(path)!;
      // Every module it did not patch keeps its entry in the shared payload; the patched one has
      // none, so Bun compiles its new source.
      expect(after.bytecode).toEqual(before.bytecode.map((range, index) =>
        (index === 0 ? { offset: 0, length: 0 } : range)));
      // And the payload's bytes are still where those entries point.
      expect(readFileSync(path).subarray(after.blobAt + payloadStart, after.blobAt + payloadEnd))
        .toEqual(pristine.subarray(before.blobAt + payloadStart, before.blobAt + payloadEnd));
      expect(after.flags).toBe(flags);
      expect(readBunJavaScriptModules(path)![0]!.source).toBe('export const a=111;');
    });
  });

  it('hands tweakcc an untouched candidate when no linked payload is announced', () => {
    // Every release before 2.1.310 must repack byte for byte as it did before.
    const withBytecode = MODULES.map(module => ({ ...module, bytecode: `compiled:${module.name}` }));
    withBinary(withBytecode, {}, path => {
      const bundle = readClaudeBundle(path)!;
      const patched = bundle.modules.map(module => module.source);
      patched[0] = 'export const a=111;';
      const plan = planBundleWrite(path, bundle, patched, WRITABLE_ID);
      const pristine = readFileSync(path);
      expect(plan.clearsBytecodeBeforeRepack).toBe(false);
      prepareRepackInput(path, plan);
      expect(readFileSync(path).equals(pristine)).toBe(true);
    });
  });

  it('refuses to clear a candidate that no longer holds the blob it was planned around', () => {
    const flags = LINKED_BYTECODE_PAYLOAD;
    const linked = MODULES.map(module => ({ ...module, bytecode: entry(module.name) }));
    const options = { entryPointId: ENTRY_ID, flags, linkedBytecode: true };
    const replacements = {
      // The same module table at a different file offset: a longer version line shifts the blob.
      moved: buildFakeNativeClaude('2.1.3100', linked, options),
      // A different module table at the same offset.
      renamed: buildFakeNativeClaude('2.1.310', linked.map((module, index) =>
        (index === 3 ? { ...module, name: '/$bunfs/root/chunk-z.js' } : module)), options),
    };
    for (const [label, replacement] of Object.entries(replacements)) {
      withBinary(linked, { flags, linkedBytecode: true }, path => {
        const bundle = readClaudeBundle(path)!;
        const unchanged = bundle.modules.map(module => module.source);
        const plan = planBundleWrite(path, bundle, unchanged, WRITABLE_ID);
        writeFileSync(path, replacement);
        expect(() => prepareRepackInput(path, plan), label).toThrow(/no longer holds the Bun blob/);
        expect(readFileSync(path).equals(replacement), label).toBe(true);
      });
    }
  });
});
