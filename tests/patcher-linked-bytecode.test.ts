// `clodex patch` on a blob whose cached bytecode is one linked payload (Claude Code 2.1.310).
//
// tests/bun-bundle-linked-bytecode.test.ts pins `prepareRepackInput` itself; this pins that
// `applyPatch` calls it, and before tweakcc's repack. Without that call the sizing no longer
// refuses the overlapping ranges, so tweakcc is left to copy one ~100 MB range per module.

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBunModuleTable, tweakccRecognizesModuleName } from '../src/bun-module-table.js';
import { applyPatch } from '../src/patcher.js';
import {
  buildFakeNativeClaude,
  MACHO_MAGIC,
  parseBunBlob,
  rebuildFakeNativeClaude,
} from './bun-blob-fixture.js';
import { CLAUDE_FIXTURE } from './fixtures/claude-bundle.js';

const tweakccMocks = vi.hoisted(() => ({
  tryDetectInstallation: vi.fn(),
  readContent: vi.fn(),
  writeContent: vi.fn(),
}));

vi.mock('tweakcc', () => tweakccMocks);
// The patcher signs a Mach-O candidate after repacking it; nothing here may shell out for real.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

/**
 * Bun's `HAS_LINKED_BYTECODE_PAYLOAD`, spelled as a literal rather than read from
 * `BUN_BLOB_FLAGS`, so a wrong value there cannot build a fixture that agrees with it.
 */
const LINKED_BYTECODE_PAYLOAD = 1 << 13;

describe('applyPatch on a linked bytecode payload', () => {
  it('hands tweakcc a candidate with no bytecode ranges, then publishes them all back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-linked-payload-'));
    const binaryPath = join(dir, 'claude');
    const tweakccHome = join(dir, 'tweakcc-home');
    const previousAppHome = process.env.CLODEX_HOME;
    const previousTweakccHome = process.env.TWEAKCC_CONFIG_DIR;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const pristine = Buffer.concat([MACHO_MAGIC, buildFakeNativeClaude('test-version', [
      { name: '/$bunfs/root/cli', contents: CLAUDE_FIXTURE, bytecode: 'compiled:cli' },
      { name: '/$bunfs/root/chunk-a.js', contents: 'export const a=1;', bytecode: 'compiled:a' },
    ], { flags: LINKED_BYTECODE_PAYLOAD, linkedBytecode: true })]);
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.mocked(execFileSync).mockReset()
        .mockImplementation((() => '') as unknown as typeof execFileSync);
      mkdirSync(tweakccHome, { recursive: true });
      writeFileSync(binaryPath, pristine, { mode: 0o755 });
      process.env.CLODEX_HOME = dir;
      process.env.TWEAKCC_CONFIG_DIR = tweakccHome;
      const before = readBunModuleTable(binaryPath)!;
      expect(before.bytecode.every(range => range.length > 0)).toBe(true);

      tweakccMocks.tryDetectInstallation.mockReset().mockImplementation(
        async ({ path }: { path: string }) => ({ path, version: 'test-version', kind: 'native' }),
      );
      tweakccMocks.readContent.mockReset();
      const handedToTweakcc: { offset: number; length: number }[][] = [];
      // tweakcc's repack: rebuild the blob from every module's ranges, each copied separately.
      tweakccMocks.writeContent.mockReset().mockImplementation(
        async ({ path }: { path: string }, content: string) => {
          handedToTweakcc.push(readBunModuleTable(path)!.bytecode);
          const parsed = parseBunBlob(readFileSync(path));
          writeFileSync(path, Buffer.concat([MACHO_MAGIC, rebuildFakeNativeClaude(
            readFileSync(path),
            'test-version',
            (index, previous) => (tweakccRecognizesModuleName(parsed.names[index]!) ? content : previous),
          )]), { mode: 0o755 });
        },
      );

      const outcome = await applyPatch(binaryPath, 'test-version', {
        config: { 'clodex:test:extended': { alias: 'extended' } },
        unknownWindows: [],
      }, 'desired-config-hash', { trace: false, manifest: null });

      expect(outcome.ok, outcome.message).toBe(true);
      expect(handedToTweakcc).toHaveLength(1);
      expect(handedToTweakcc[0]!.every(range => range.offset === 0 && range.length === 0)).toBe(true);
      // The published binary is the pristine blob again: the module the patch did not touch keeps
      // its entry in the shared payload, exactly where it was.
      const after = readBunModuleTable(binaryPath)!;
      expect(after.bytecode[1]).toEqual(before.bytecode[1]);
      expect(after.flags).toBe(LINKED_BYTECODE_PAYLOAD);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (previousAppHome === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = previousAppHome;
      if (previousTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
      else process.env.TWEAKCC_CONFIG_DIR = previousTweakccHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
