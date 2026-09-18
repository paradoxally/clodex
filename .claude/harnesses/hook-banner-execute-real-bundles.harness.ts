// PATCH 11 + PATCH 12 verification harness — clodex
//
// Claim under test: the two hook-banner sites bind to the RIGHT function on a real
// Claude Code build, and the code they emit RUNS.
//
// WHY THIS EXISTS: `scripts/probe-patch-sites.mjs` proves an anchor matched once,
// and nothing more. A regex that binds a lookalike still emits valid JavaScript and
// still reports OK. Both sites here rewrite functions that are (a) unnamed in the
// source clodex matches against, so the anchor carries the body rather than a name,
// and (b) memoised by their caller, so a plausible-looking gate that never
// re-renders would pass every string assertion. This harness executes them.
//
// HOW TO RUN: vitest does not collect this folder, so copy it in first.
//   node scripts/extract-cc-bundles.mjs            # → $REVIEW_BUNDLE_DIR
//   cp .claude/harnesses/hook-banner-execute-real-bundles.harness.ts tests/tmp-harness.test.ts
//   REVIEW_BUNDLE_DIR=<that dir> pnpm vitest run tests/tmp-harness.test.ts
// It reads every *.js in REVIEW_BUNDLE_DIR, or one file from HOOK_BANNER_BUNDLE.
//
// WHAT IT DOES NOT PROVE: that Claude Code draws the banner at all (that needs a
// live pty capture), and that an old binary keeps working. It also does not prove
// the THRESHOLD is right — only that the gate reads the clock and fails open.
//
// VERIFIED 2026-09-18 against Claude Code 2.1.273 on darwin-arm64, linux-arm64 and
// win32-arm64: all 13 sites apply on each, and both rewritten functions execute and
// return the expected banner in each of the three states.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkPatchSites } from '../scripts/probe-patch-sites.mjs';

const dir = process.env.REVIEW_BUNDLE_DIR ?? '/tmp/cc-bundles';
const BUNDLE_FILE = process.env.HOOK_BANNER_BUNDLE ?? '';
const BUILDS: Array<[string, string]> = BUNDLE_FILE
  ? [[process.env.HOOK_BANNER_LABEL ?? 'single', BUNDLE_FILE]]
  : readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .map(f => [f.replace(/\.js$/, ''), join(dir, f)]);

describe('the emitted code RUNS on every platform build', () => {
  it.each(BUILDS)('%s', (label, path) => {
    const source = readFileSync(path as string, 'utf8');
    const patched = checkPatchSites(source).patchedSource!;

    // PATCH 11: from its marker to the end of that one function. The function is
    // found by BALANCING its own braces rather than by taking a line — the joined
    // bundle puts many functions on one line, so a line slice picks up whatever
    // else shares it, including `import` statements from a neighbouring module.
    const m = patched.indexOf('/*ccpatch:hook-banner*/');
    const trackStart = m + '/*ccpatch:hook-banner*/'.length;
    const open = patched.indexOf('{', patched.indexOf(')', trackStart));
    let depth = 0;
    let trackEnd = open;
    for (let i = open; i < patched.length; i += 1) {
      if (patched[i] === '{') depth += 1;
      else if (patched[i] === '}') { depth -= 1; if (depth === 0) { trackEnd = i + 1; break; } }
    }
    const trackDecl = patched.slice(trackStart, trackEnd);
    const trackName = /function\s+([\w$]+)\s*\(/.exec(trackDecl)![1];
    // The store factory the tracker calls keeps ITS minified name per build, so it
    // is read off the emitted text rather than assumed. A wrong name here is a
    // ReferenceError, not a silent pass — which is the point.
    const storeName = /let _ccHookBannerTimer,[\w$]+=([\w$]+)\(\)/.exec(trackDecl)![1];

    let state: Array<Record<string, unknown>> = [];
    const timers: number[] = [];
    const buildTrack = new Function(storeName, 'setTimeout', 'clearTimeout',
      `${trackDecl}; return ${trackName};`) as (
        s: () => unknown,
        t: (c: () => void, ms: number) => number,
        c: (id: number) => void,
      ) => (o: { hookEvent: string; hooks: unknown[] }) => { settle: (h: unknown) => void; [Symbol.dispose]: () => void };
    const track = buildTrack(
      () => ({
        getSnapshot: () => state,
        setState: (n: unknown) => {
          state = (typeof n === 'function' ? (n as (p: unknown[]) => unknown[])(state) : n) as Array<Record<string, unknown>>;
        },
      }),
      (_cb, ms) => { timers.push(ms); return timers.length; },
      () => {},
    );
    track({ hookEvent: 'PreToolUse', hooks: [{ command: 'x' }] });
    expect(typeof state[0]!.startedAt, `${label}: startedAt is stamped`).toBe('number');
    expect(timers, `${label}: one tick at the threshold`).toEqual([500]);

    // PATCH 12: from its function head to the same line's end.
    const gm = patched.indexOf('/*ccpatch:hook-banner-gate*/');
    const gmStart = patched.indexOf('function', gm - 400);
    const gOpen = patched.indexOf('{', gmStart);
    let gDepth = 0;
    let gEnd = gOpen;
    for (let i = gOpen; i < patched.length; i += 1) {
      if (patched[i] === '{') gDepth += 1;
      else if (patched[i] === '}') { gDepth -= 1; if (gDepth === 0) { gEnd = i + 1; break; } }
    }
    const suffixDecl = patched.slice(gmStart, gEnd).replace('/*ccpatch:hook-banner-gate*/', '');
    const suffixName = /function\s+([\w$]+)\s*\(/.exec(suffixDecl)![1];
    const body = suffixDecl.slice(suffixDecl.indexOf('{') + 1, suffixDecl.lastIndexOf('}'));
    // The plural helper's minified name differs per build, so it is read off the
    // body rather than assumed to be `H`.
    const pluralName = /:(\w+)\((\w+),"\)?hook/.exec(body)?.[1]
      ?? /Se\?"hook":([\w$]+)\(/.exec(body)![1];
    const buildSuffix = new Function(pluralName, `return function(h){${body}};`) as (
      H: (n: number, s: string) => string,
    ) => (h: unknown[]) => string | null;
    const render = buildSuffix((n, s) => (n === 1 ? s : s + 's'));
    void suffixName;
    const rec = (ago: number | undefined) => [{
      agentId: undefined, hooks: [{ command: 'x' }], settled: new Set(),
      hookEvent: 'PreToolUse', ...(ago === undefined ? {} : { startedAt: Date.now() - ago }),
    }];
    expect(render(rec(50)), `${label}: hidden while young`).toBeNull();
    expect(render(rec(5000)), `${label}: shown once old`).toBe('running PreToolUse hook');
    expect(render(rec(undefined)), `${label}: fails open`).toBe('running PreToolUse hook');
    console.log(label, 'tracker + gate execute OK');
  });
});
