// src/patch-transforms.ts — clodex patch transforms, applied in-process.
//
// Ported from the relay-ai scripts/patch-custom-models wrapper, originally run
// as a tweakcc `adhoc-patch --script` inside tweakcc's sandbox (with the Claude
// Code source as global `js`). Now a pure function: patcher.ts reads every
// JavaScript module out of the binary, calls `applyClodexPatches`, and publishes
// the result itself (`bun-bundle.ts`); tweakcc's `writeContent` is used only to
// resize the binary's Bun section. The patch sites and
// their regex/replacement logic are unchanged — they are hard-won; do not
// "improve" them.
//
// Inspired by https://github.com/East-rayyy/claude-alias-patch (MIT); this is a
// from-scratch reimplementation with a different patch mechanism and an added
// per-model context window patch.
//
// The ALIAS is the model's identity inside the binary: for any entry that
// defines one, the alias (not the canonical `clodex:<provider>:<model>` id) is
// what lands in the Agent-tool enum, the known-alias validator, the /model
// picker, and the context-window table — so `model: sol` in agent/skill
// frontmatter validates. Entries with no alias fall back to their canonical id
// as the identity (they still join the enum, validator, and context table, but
// skip the resolver and /model picker patches).

import { isReservedModelAlias } from './model-aliases.js';
import {
  CHILD_NETWORK_ENV_VARS,
  NETWORK_ENV_CONTRACT_VAR,
} from './network-env.js';

/**
 * Version of the transform set below — NOT of the patch-state manifest, whose
 * shape is unrelated. It is folded into `computePatchConfigHash`, so bumping it
 * is what makes an existing install read as `stale-config` and repatch.
 *
 * IMPORTANT: bump this whenever the transform set changes materially — adding or
 * removing a PATCH site, or changing a site's regex, replacement, or ordering —
 * and whenever a binary an older clodex produced has to be replaced rather than
 * left alone. Without a bump, users whose favorites are unchanged keep the OLD
 * patch forever and never receive the new transforms, silently.
 * `tests/patcher.test.ts` pins a hash of the transform inputs to force that
 * decision to be made rather than forgotten.
 *
 * 10 — the transforms are unchanged, but the way the patched bundle is written
 * back into the binary is not: clodex 2.8.1 and earlier let tweakcc rebuild the
 * Bun blob, dropping structures Bun 1.4.1 needs and leaving a patched module's
 * stale bytecode in place. Any binary written by that mechanism has to be
 * replaced rather than read as current.
 *
 * Note what the bump does NOT do: it cannot rescue an install whose patched binary
 * no longer STARTS, because `clodex patch` resolves the version by executing the
 * binary and then fails at `version-unknown` long before the staleness check.
 * Those users need `clodex patch --restore`, which reads the version from the
 * manifest instead, and then a fresh `clodex patch`. Measured, that is the two
 * arm64 Linux builds of 2.1.246, the only ones any leg here executes; macOS
 * refused rather than publishing, so it left nothing broken, and what a
 * 2.8.1-patched Windows binary does is not measured. The bump is for every install
 * that still starts: a patch written the old way carries stale bytecode beside
 * patched source, and on 2.1.246 that stale bytecode runs.
 *
 * 11 — two sites stopped recognising Claude Code 2.1.257, each on all eight
 * published builds. PATCH 7's anchor hardcoded the context-window resolver's
 * parameter NAMES, and 2.1.257 minified the same function as `(e,n)` instead of
 * `(e,t)`. PATCH 10 required the child-env builder to spell every one of five
 * scrubbed environment variable names, and 2.1.257 replaced a run of per-name
 * reads with a set-membership test that spells `CLAUDE_BG_PTY_AUTH` nowhere.
 * An install patched by an older clodex is not wrong, but it was produced by a
 * transform set whose anchors are narrower, so it re-reads as stale rather than
 * current.
 *
 * 12 — PATCH 10 stopped recognising Claude Code 2.1.260 on all eight published
 * builds. Its head anchor spelled the remote-mode check as a call wrapping a
 * `process.env` read, `<fn>(process.env.CLAUDE_CODE_REMOTE)?`; 2.1.260 reads the
 * flag off the typed env accessor and compares it directly
 * (`i=a.CLAUDE_CODE_REMOTE===!0`), so neither the call nor the `process.env.`
 * prefix survives. The head now also accepts `getAgentProxyEnv` — the agent-proxy
 * env the builder folds into the child's environment — and tolerates that name
 * being destructured. The old ternary is kept as the alternative, because the
 * 2.1.238 builder reaches the same env through a helper and spells the name
 * nowhere.
 *
 * Unlike 10 and 11, this bump rescues nobody by itself: on all 19 measured
 * pre-2.1.260 bundles the version-12 output is byte-identical to version 11's, so
 * the repatch it forces reproduces the same bytes; and an install already on
 * 2.1.260 was never patched at all (`applyClodexPatches` throws before anything is
 * written) and re-reads as stale from the version comparison regardless. It is
 * bumped because the rule above says a changed anchor is bumped — an install
 * patched by an older clodex is not wrong, but it was produced by a transform set
 * whose anchors are narrower, so it re-reads as stale rather than current.
 *
 * 13 — PATCH 5 titles each injected /model picker row with the model's own name
 * (`GPT-5.6 Luna`) instead of the title-cased alias (`Luna`), and its description
 * becomes `<provider> · /model <alias>`. No anchor changed and `value` is still
 * the alias. Every existing config hash changes regardless, because `name` and
 * `provider` joined it; the bump follows the rule that a changed replacement
 * bumps.
 *
 * 14 — PATCH 11 and PATCH 12 are new sites, and they are what stops the spinner
 * line flashing `running PreToolUse hook` for a hook that finished in 20 ms. Two
 * sites rather than one because the fix needs both ends of one data path: the
 * batch record gains a start time, and the renderer refuses to draw the banner
 * before that start time is old enough. Neither is configurable, so unlike every
 * other site these run for every install — which is also why the bump matters
 * here more than usual: without it, a user whose favorites never change keeps a
 * binary that still flashes, forever.
 */
export const PATCH_TRANSFORMS_VERSION = 14;

/**
 * How long a hook must have been running before its banner is drawn on the
 * spinner line.
 *
 * Measured on 2026-09-18 with a real Claude Code 2.1.273 under clodex, spinner
 * line sampled every 1.5 ms through a pty: the real Orca hook config produced 16
 * banner appearances at ~32 ms each, a `sleep 0.02` hook 18 at ~57 ms, and a hook
 * backgrounded with `( sleep 1.2 ) &` 12 at ~35 ms. So the flash is not the hook's
 * duration — it is one render frame per hook, whatever the hook does.
 *
 * 500 ms is 9-15x the longest flash measured. It is emitted as a literal into BOTH
 * sites from this one constant, so the writer and the reader cannot disagree about
 * it. It lives here, not in a module of its own, because the source-digest guard
 * in `tests/patcher.test.ts` hashes this file (and `network-env.ts`) and a
 * constant placed anywhere else would be emitted into the bundle unseen.
 *
 * The slow end was confirmed the same way, against a `sleep 1.5` PreToolUse hook:
 * the patched binary shows the banner where the unpatched one does, so the delay
 * does not cost a reader the signal that something is running. Note what that run
 * actually showed — three appearances of 645, 269 and 57 ms against the unpatched
 * build's two of 590 ms — because a spinner repaints the whole line, so a visible
 * run is sampled shorter than the hook that caused it. The point is that it still
 * appears; a hook's real length is not recoverable from this measurement.
 */
export const HOOK_BANNER_DELAY_MS = 500;

export interface PatchScriptModelEntry {
  alias?: string;
  context?: number;
  /** Full human label, model and provider, e.g. `GPT-5.6 Sol (OpenAI (ChatGPT))`. */
  display?: string;
  /** The model's own name, e.g. `GPT-5.6 Sol` — the /model picker row title. */
  name?: string;
  /** The provider's display name, e.g. `OpenAI (ChatGPT)`. */
  provider?: string;
  /** Provider reasoning levels projected onto Claude Code's native effort ladder. */
  effort?: PatchScriptEffort;
}

export interface PatchScriptEffort {
  levels: string[];
  defaultLevel: string;
}

/** Real model id (e.g. `clodex:openai-oauth:gpt-5.6-sol`) → alias/context. */
export type PatchScriptModelConfig = Record<string, PatchScriptModelEntry>;

const NATIVE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const BASE_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export function projectNativeEffort(
  effort: PatchScriptEffort | undefined,
): PatchScriptEffort | undefined {
  if (!effort || !Array.isArray(effort.levels) || typeof effort.defaultLevel !== 'string') return undefined;
  const declared = new Set(effort.levels);
  const levels = NATIVE_EFFORT_LEVELS.filter(level => declared.has(level));
  if (!BASE_EFFORT_LEVELS.every(level => declared.has(level))) return undefined;
  if (!levels.some(level => level === effort.defaultLevel)) return undefined;
  // The native client defaults custom identities to high; preserve that contract.
  return { levels, defaultLevel: 'high' };
}

/**
 * The `{value,label,description}` literal PATCH 5 injects for one alias. The built-in postcondition
 * proof rebuilds the row through this same function, so the two cannot disagree about its bytes.
 *
 * The literal is pure ASCII: Bun loads Claude Code's modules as Latin-1, so a raw UTF-8 character
 * such as `·` renders as `Â·`. Non-ASCII is written as a `\u` escape instead.
 */
export function modelPickerOption(alias: string, id: string, entry: PatchScriptModelEntry): string {
  const name = entry.name ? String(entry.name) : '';
  const label = name || alias.charAt(0).toUpperCase() + alias.slice(1);
  const description = name
    ? (entry.provider ? String(entry.provider) + ' · ' : '') + '/model ' + alias
    : 'Custom model (' + id + ')';
  const ascii = (value: string) => JSON.stringify(value)
    .replace(/[^\x00-\x7f]/g, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  return '{value:' + ascii(alias) + ',label:' + ascii(label) + ',description:' + ascii(description) + '}';
}

export type PatchSiteStatus = 'OK' | 'SKIP' | 'FAIL';

export interface PatchSiteResult {
  status: PatchSiteStatus;
  name: string;
  extra?: string;
}

export interface ApplyPatchesOutcome {
  /** The patched Claude Code source. */
  content: string;
  /** Per-site outcome, in patch order. */
  results: PatchSiteResult[];
}

/**
 * Thrown when a required patch site fails (or the config is invalid). Carries
 * the per-site results collected up to the failure so `--trace` can report
 * exactly what the sandboxed script used to print.
 */
export class PatchApplyError extends Error {
  readonly results: PatchSiteResult[];
  constructor(message: string, results: PatchSiteResult[]) {
    super(message);
    this.name = 'PatchApplyError';
    this.results = results;
  }
}

/** One report line, same format the tweakcc-sandbox script wrote to stderr. */
export function formatPatchSiteLine(result: PatchSiteResult): string {
  return '  ' + result.status.padEnd(4) + ' ' + result.name + (result.extra ? ' — ' + result.extra : '');
}

/**
 * Apply the clodex patch sites (PATCH 1–10) to the Claude Code source.
 * Pure: source string in → patched string + per-site results out. Throws
 * `PatchApplyError` when the config is invalid or a required site fails —
 * nothing should be written to the binary in that case.
 */
export function applyClodexPatches(source: string, config: PatchScriptModelConfig): ApplyPatchesOutcome {
  let js = source;
  const MODEL_CONFIG = config;

  // ---- derive helpers ------------------------------------------------------
  // alias -> model id (only for entries that define an alias)
  const ALIAS_TO_ID: Record<string, string> = Object.create(null);
  // The name Claude Code knows a model by: its alias when it has one, else its
  // canonical id. This single value is used for the Agent-tool enum, the
  // known-alias validator, the /model picker value, and the context-window table,
  // so the name the binary validates == the name it sends upstream == the name
  // the proxy echoes back == the key its context window is stored under.
  const IDENTITIES: string[] = [];
  // identity -> human label for the Agent tool description
  const DISPLAY_BY_IDENTITY: Record<string, string> = Object.create(null);
  const ENTRY_BY_ALIAS: Record<string, PatchScriptModelEntry> = Object.create(null);
  // lowercased alias AND id -> context-window tokens (only for models that set it)
  const CONTEXT_BY_KEY: Record<string, number> = Object.create(null);
  // lowercased alias AND id for every configured model. Capability verdicts
  // must distinguish configured-false from an unknown identity that may use
  // the native fallback.
  const CONFIGURED_CAPABILITY_KEYS = new Set<string>();
  // lowercased alias AND id -> effort metadata for Claude Code's capability gates.
  const EFFORT_BY_KEY = Object.create(null) as Record<
    string,
    PatchScriptModelEntry['effort']
  >;

  const report: PatchSiteResult[] = [];
  const fail = (message: string): never => {
    throw new PatchApplyError(message, report);
  };
  const capabilityKeys = (value: string): string[] => {
    const normalized = value.trim().toLowerCase();
    const bare = normalized.replace(/\[1m\]$/i, '');
    return [...new Set([bare, `${bare}[1m]`])];
  };
  const registerCapabilityKeys = (value: string): void => {
    for (const key of capabilityKeys(value)) {
      CONFIGURED_CAPABILITY_KEYS.add(key);
    }
  };

  for (const [id, value] of Object.entries(MODEL_CONFIG)) {
    const spec: PatchScriptModelEntry = value && typeof value === 'object' ? value : { alias: value as unknown as string };
    if (spec.alias !== undefined) {
      const rawAlias = String(spec.alias).trim();
      const a = rawAlias.toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]*(\[1m\])?$/.test(a)) {
        fail('clodex patch: alias "' + spec.alias + '" is not a safe lowercase alias');
      }
      if (isReservedModelAlias(a)) {
        fail('clodex patch: reserved alias "' + a + '" cannot be reassigned');
      }
      ALIAS_TO_ID[a] = String(id);
      ENTRY_BY_ALIAS[a] = spec;
      IDENTITIES.push(a);
      if (spec.display) DISPLAY_BY_IDENTITY[a] = String(spec.display);
    } else {
      IDENTITIES.push(String(id));
      if (spec.display) DISPLAY_BY_IDENTITY[String(id)] = String(spec.display);
    }
    if (spec.alias !== undefined) {
      registerCapabilityKeys(String(spec.alias));
    }
    registerCapabilityKeys(String(id));

    if (spec.context !== undefined) {
      const n = Number(spec.context);
      if (!Number.isInteger(n) || n <= 0) {
        fail('clodex patch: context for "' + id + '" must be a positive integer, got ' + spec.context);
      }
      // A [1m] suffix hard-codes 1M upstream (and sends the context-1m beta header
      // + raises the media cap). An explicit context on a [1m] model would win via
      // PATCH 7 while those side effects silently stayed on — so reject it.
      if (/\[1m\]/i.test(String(spec.alias ?? '')) || /\[1m\]/i.test(id)) {
        fail(
          'clodex patch: "' + id + '" sets context but keeps the [1m] suffix — drop the suffix from both the id and the alias'
        );
      }
      if (spec.alias !== undefined) CONTEXT_BY_KEY[String(spec.alias).trim().toLowerCase()] = n;
      CONTEXT_BY_KEY[String(id).trim().toLowerCase()] = n;
    }

    if (spec.effort) {
      const effort = projectNativeEffort(spec.effort);
      if (!effort) {
        fail(
          `clodex patch: effort for "${id}" must include low, medium, and high with a native default`,
        );
      }
      if (spec.alias !== undefined) {
        for (const key of capabilityKeys(String(spec.alias))) {
          EFFORT_BY_KEY[key] = effort;
        }
      }
      for (const key of capabilityKeys(String(id))) {
        EFFORT_BY_KEY[key] = effort;
      }
    }
  }
  const ALIASES = Object.keys(ALIAS_TO_ID);
  const MODELS = Object.keys(MODEL_CONFIG);
  if (MODELS.length === 0) fail('clodex patch: MODEL_CONFIG is empty');

  const reEsc = (s: string) => s.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const q = (s: string) => JSON.stringify(s); // safe JS string literal

  // ---- reporting -----------------------------------------------------------
  function log(status: PatchSiteStatus, name: string, extra?: string) {
    report.push(extra === undefined ? { status, name } : { status, name, extra });
  }

  /**
   * Apply exactly one regex replacement.
   *  - marker: if present in js, treat as already-patched -> SKIP.
   *  - expects exactly one match; 0 -> FAIL, >1 -> FAIL (ambiguous).
   *  - fn(match, ...groups) returns the replacement text.
   *  - required: on FAIL, throw (aborts the whole patch).
   */
  function applyOnce(
    name: string,
    regex: RegExp,
    fn: (match: string, ...groups: string[]) => string,
    { marker, required, noopIsSkip }: { marker?: string; required?: boolean; noopIsSkip?: boolean } = {},
  ): void {
    if (marker && js.includes(marker)) { log('SKIP', name, 'already patched'); return; }
    const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const matches = js.match(g);
    const count = matches ? matches.length : 0;
    if (count === 0) {
      log('FAIL', name, 'anchor not found');
      if (required) fail('clodex patch: required patch failed: ' + name);
      return;
    }
    if (count > 1) {
      log('FAIL', name, 'anchor matched ' + count + ' times (expected 1)');
      if (required) fail('clodex patch: ambiguous anchor: ' + name);
      return;
    }
    const before = js;
    js = js.replace(regex, fn as (substring: string, ...args: unknown[]) => string);
    if (js === before) {
      // For array-extend / append patches, "no change" means the aliases are
      // already present (anchor matched, but fn had nothing new to add) -> SKIP.
      if (noopIsSkip) { log('SKIP', name, 'already patched'); return; }
      log('FAIL', name, 'replacement made no change');
      if (required) fail(name);
      return;
    }
    log('OK', name);
  }

  /** Insert missing identities just before the closing bracket of a JS array literal string. */
  function extendAliasArray(arrLiteral: string): string {
    const toAdd = IDENTITIES.filter((a) => !new RegExp('"' + reEsc(a) + '"').test(arrLiteral));
    if (toAdd.length === 0) return arrLiteral; // idempotent
    return arrLiteral.replace(/\]\s*$/, ',' + toAdd.map(q).join(',') + ']');
  }

  // ---------------------------------------------------------------------------
  // PATCH 1 — Agent/subagent tool 'model' zod enum.
  // Anchor: the aliases array ["sonnet",...,"fable"] wrapped in an enum
  // constructor and immediately followed by .optional().describe(. Builds
  // through 2.1.223 spell the constructor `.enum(`; 2.1.224+ minifies it to a
  // bare helper call on the model property (`model:xr([...])`), so both are
  // accepted. We append our identities (alias when defined, else the canonical
  // id) inside the enum so the tool accepts them — this is the same enum
  // subagent/skill 'model:' frontmatter is validated against, which is why
  // the short alias has to be the value that lands here.
  // (This same .describe( is patched by PATCH 4 below.)
  // ---------------------------------------------------------------------------
  applyOnce(
    'PATCH 1: Agent tool model enum',
    /((?:\.enum|model:[A-Za-z_$][\w$]*)\()(\["sonnet","opus","haiku"(?:,"[^"]+")*\])\)(\.optional\(\)\.describe\()/,
    (_m, open, arr, tail) => open! + extendAliasArray(arr!) + ')' + tail!,
    { required: true, noopIsSkip: true }
  );

  // ---------------------------------------------------------------------------
  // PATCH 3 — known-alias validator list (drives "is this a known alias?").
  // Anchor: the master list literal, matched loosely as
  // ["sonnet","opus","haiku","fable", ...anything... ,"opusplan"] so it
  // tolerates new built-ins being added in the middle. Appending our identities
  // makes them recognized as first-class aliases everywhere the gate runs.
  // ---------------------------------------------------------------------------
  applyOnce(
    'PATCH 3: known-alias validator list',
    /\["sonnet","opus","haiku","fable"(?:,"[^"]+")*,"opusplan"(?:,"[^"]+")*\]/,
    (m) => extendAliasArray(m),
    { required: true, noopIsSkip: true }
  );

  // ---------------------------------------------------------------------------
  // PATCH 6 — alias resolver switch (IDENTITY mapping).
  // Anchor: case"best":{ ... } (the case"best":{ is unique). We inject
  // case"<alias>":return"<alias>"; right after it (before the switch's
  // default:return null).
  //
  // The mapping is deliberately an identity, NOT alias -> canonical id: the alias
  // IS the model's identity everywhere else in the patched binary (enum,
  // validator, picker, context table), and the MITM proxy resolves short alias
  // names as request model ids and echoes request bodies unrewritten. Resolving
  // to the canonical id here would make Claude Code send one name and look its
  // context window up under another — the exact mismatch that stopped auto-compact
  // from firing and killed agents with "Prompt is too long". The case still has to
  // EXIST (rather than be skipped) so the resolver returns the name instead of
  // falling through to default:return null.
  // Only aliases not already present are inserted, so a rerun (or a config
  // edit) tops up cleanly rather than duplicating cases.
  // ---------------------------------------------------------------------------
  {
    const missing = ALIASES.filter((a) => !new RegExp('case' + reEsc(q(a)) + ':return').test(js));
    const cases = missing.map((a) => 'case' + q(a) + ':return ' + q(a) + ';').join('');
    if (ALIASES.length === 0) {
      log('SKIP', 'PATCH 6: alias resolver switch', 'no aliases configured');
    } else {
      applyOnce(
        'PATCH 6: alias resolver switch',
        /(case"best":\{[^{}]*\})/,
        (m) => m + cases,
        { required: true, noopIsSkip: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 5 — interactive /model picker.
  // The picker is assembled through a single choke-point function; we insert,
  // right after its loop, a snippet that appends our custom
  // {value,label,description} entries — with a runtime .some() dedupe guard so
  // it is safe even if the function runs over the same array twice. Only
  // aliases not already injected are added, so reruns top up cleanly.
  //
  // Anchor: the choke-point's own code — its `"opus"`/`"sonnet"` selection, which
  // is what makes it the MODEL picker and not merely a loop that appends things,
  // followed by the loop and the per-item appender. Every minified identifier is
  // wildcarded and repeats are tied together with back-references rather than
  // spelled out. Claude Code 2.1.238 shipped per-platform builds whose minifier
  // handed this function different names — `(e,t,r){let n=...}` on five of the
  // eight published builds, but `(e,t,n){let r=...}` on linux-arm64,
  // linux-arm64-musl and win32-arm64 — so an anchor naming `r` literally stopped
  // matching on the other three, and their users silently lost every custom
  // picker entry.
  // Keep BOTH halves. The back-references alone only make the identifiers
  // internally consistent; they do not say the function is the picker, and a
  // review demonstrated that a same-shaped neighbour could then be patched
  // instead if the real site ever drifted out of the match. The model-name
  // comparison is the discriminator; the wildcards are what survive a rename.
  // The tolerated run between the comparison and the pair is bounded to
  // `[^;{}]` so it cannot reach out of the statement it starts in.
  // The appender's FIRST argument is captured and the append snippet is bound to
  // that name, so we push into the very array the built-in options were just
  // appended to, under whatever name this build gave it, instead of into a
  // variable we assumed was called `e`.
  // The anchor deliberately stops before the function's `return`: the snippet is
  // spliced in between, so consuming the tail would make a re-run of the patch
  // report a missing anchor instead of the SKIP that keeps re-patching clean.
  //
  // The selection is ALSO counted across the whole bundle, and that check is not
  // redundant. "The anchor matched once" only means one candidate survived, not
  // that it was the right one: a review built a second builder with its own
  // opus/sonnet selection and moved the real picker out of the match by turning
  // `for(` into `for (` — one space — and PATCH 5 reported OK while injecting
  // into the impostor, where no user would ever see the entries. The anchor
  // BEGINS with the selection, so at most one site in the bundle can match it,
  // and that composition becomes a refusal.
  // State the guarantee precisely, because it rests on an assumption nothing
  // here tests: the counted site is the picker only while the picker keeps
  // spelling its selection THIS way. Respelt upstream to the equivalent
  // `(x==="sonnet"||x==="opus")` with something else adopting this spelling, the
  // survivor would be the wrong function again. No published bundle contains a
  // second selection in any spelling, and that needs two coordinated upstream
  // changes rather than one, so it is calibrated as unreachable rather than
  // defended against — adding more discriminators is what broke this patch on
  // three platforms in the first place. If only the spelling drifts, the count
  // goes to ZERO and PATCH 5 fails loudly (it is `required:false`, so the rest
  // of the patch still applies) and the release canary reports it on all eight
  // platforms. Failing loud is the direction to bias toward here.
  // ---------------------------------------------------------------------------
  {
    const missing = ALIASES.filter((a) => !new RegExp('value:' + reEsc(q(a))).test(js));
    const entries = missing
      .map((a) => modelPickerOption(a, ALIAS_TO_ID[a]!, ENTRY_BY_ALIAS[a]!))
      .join(',');
    /** The append snippet, bound to whatever this build named the options array. */
    const injectInto = (options: string) =>
      missing.length
        ? '[' + entries + '].forEach(function(_o){if(!' + options + '.some(function(_i){return _i.value===_o.value}))' + options + '.push(_o)});'
        : '';
    const pickerSite = 'PATCH 5: model picker options';
    // MUST stay a prefix of the anchor below — that is what makes the count mean
    // "the anchor can only match the picker". A harness asserts the relationship
    // and, on every real bundle, that the anchor binds at this very offset.
    const modelSelections = [...js.matchAll(/\(([\w$]+)==="opus"\|\|\1==="sonnet"\)/g)];
    if (ALIASES.length === 0) {
      log('SKIP', pickerSite, 'no aliases configured');
    } else if (modelSelections.length !== 1) {
      log('FAIL', pickerSite, 'model selection appears ' + modelSelections.length + ' times (expected 1)');
    } else {
      applyOnce(
        pickerSite,
        /\(([\w$]+)==="opus"\|\|\1==="sonnet"\)[^;{}]*\?\[\1,([\w$]+)\]:\[\2\];for\(let ([\w$]+) of [\w$]+\)[\w$]+\(([\w$]+),\3,[\w$]+\);/,
        (m, _selected, _requested, _item, options) => m + injectInto(options!),
        { required: false, noopIsSkip: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 4 — Agent tool 'model' parameter description text.
  // Append the available model names (with their real labels) before the closing
  // backtick so the model knows which extra names it may request and what they
  // actually are. Best-effort (cosmetic). The text is spliced into a backtick
  // template literal, so backticks and interpolation openers are stripped.
  //
  // The anchor ends at the template's own closing backtick and says nothing about
  // what follows it. Through 2.1.241 the call closed immediately (`` `) ``);
  // 2.1.242 started appending a conditional sentence to the same string
  // (`` `+(fn()?"...":"") ``), and an anchor that insisted on the `)` read that as
  // "not found" and silently dropped every custom model from the description the
  // Agent tool shows.
  //
  // The wildcard skips backslash pairs rather than stopping at the first backtick
  // BYTE, so it ends at the template's real close even if the description ever
  // contains an escaped backtick. A plain `[^`]*?` would stop mid-escape there and
  // splice the addition after the backslash, turning the once-escaped backtick into
  // a live terminator — a syntax error in a module Bun loads at startup. No shipped
  // release has one (checked on 2.1.208-2.1.232 and all eight 2.1.243 builds), and
  // this keeps that corner fail-closed instead of fail-open. Constraining what
  // FOLLOWS the template is what drifted in 2.1.242; this constrains nothing.
  // ---------------------------------------------------------------------------
  {
    const safe = (s: string) => String(s).replace(/`/g, "'").replace(/\$\{/g, '(');
    const listing = IDENTITIES.map(function (i) {
      const d = DISPLAY_BY_IDENTITY[i];
      return d ? safe(i) + ' = ' + safe(d) : safe(i);
    }).join('; ');
    applyOnce(
      'PATCH 4: Agent tool model description',
      /(describe\(`Optional model override for this agent(?:[^`\\]|\\.)*?)(`)/,
      (_m, body, close) =>
        body!.includes('Additional custom models')
          ? body! + close!
          : body! + ' Additional custom models: ' + listing + '.' + close!,
      { required: false, noopIsSkip: true }
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 7 — per-model context window.
  //
  // Claude Code funnels EVERY context-window consumer (autocompact threshold,
  // /context, the countdown, statusline, cost/usage records, subagent budgets)
  // through one resolver function. We inject a baked table lookup at the TOP of
  // that resolver, so it wins over the 200k clamp and the global
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS env override. Lookup is on the raw,
  // lowercased model string — alias and id are both in the table, so it hits
  // pre- or post-alias-resolution.
  //
  // Anchor: the resolver's exact body shape. EVERY identifier is wildcarded,
  // including the two PARAMETER names — the minifier renames those per build
  // too. Claude Code 2.1.252 spelled the resolver `(e,t)` and 2.1.257 spelled
  // the same function `(e,n)`, which is exactly how a hardcoded `(e,t)` came to
  // fail on all eight published builds at once. What still pins the site is the
  // shape, not the spelling: two parameters, both threaded unchanged into the
  // two calls, around a 3-statement body. That matches once per bundle.
  //
  // The injected lookup reads the model string out of the FIRST parameter, so
  // the snippet has to be built around whatever this build named it.
  // ---------------------------------------------------------------------------
  if (Object.keys(CONTEXT_BY_KEY).length) {
    const MARKER = '/*ccpatch:ctx*/';
    const snippetFor = (modelParam: string) =>
      MARKER + 'var _ccw=(' + JSON.stringify(CONTEXT_BY_KEY) + ')[String(' + modelParam + '||"").trim().toLowerCase()];if(_ccw!==void 0)return _ccw;';

    if (js.includes(MARKER)) {
      // Re-patching an already-patched binary: refresh the baked table in place
      // so a MODEL_CONFIG edit takes effect without a restore first. The name in
      // the snippet already there is the one this binary's resolver declares —
      // reusing it is what keeps a refresh from rewriting `n` back to `e` and
      // leaving a lookup on an identifier that is not in scope.
      applyOnce(
        'PATCH 7: per-model context window (refresh)',
        /\/\*ccpatch:ctx\*\/var _ccw=\(\{[^{}]*\}\)\[String\(([\w$]+)\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_ccw!==void 0\)return _ccw;/,
        (_m, modelParam) => snippetFor(modelParam!),
        { required: true, noopIsSkip: true }
      );
    } else {
      applyOnce(
        'PATCH 7: per-model context window',
        /(function [\w$]+\(([\w$]+),([\w$]+)\)\{)(let [\w$]+=[\w$]+\(\);if\([\w$]+!==void 0\)return [\w$]+;if\([\w$]+\(\2,\3\)\)return [\w$]+;return [\w$]+\(\2,\3\)\})/,
        (_m, head, modelParam, _windowParam, body) => head! + snippetFor(modelParam!) + body!,
        { required: true }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 8 — per-model effort capability gates.
  //
  // Claude Code checks three separate resolvers before it exposes effort at all,
  // includes xhigh/max in the picker, and emits effort.level in status hooks.
  // Inject model-specific lookups after the native denylist, but before the
  // built-in metadata and provider-fallback checks.
  // ---------------------------------------------------------------------------
  function patchEffortCapability(
    capability: 'effort' | 'xhigh_effort' | 'max_effort',
    marker: string,
    name: string,
    anchor: RegExp,
  ): void {
    const verdicts = Object.fromEntries(
      [...CONFIGURED_CAPABILITY_KEYS].map(key => {
        const effort = EFFORT_BY_KEY[key];
        return [
          key,
          effort !== undefined && (
            capability === 'effort'
            || effort.levels.includes(capability === 'xhigh_effort' ? 'xhigh' : 'max')
          ),
        ];
      }),
    );
    const hasMarker = js.includes(marker);
    if (Object.keys(verdicts).length === 0 && !hasMarker) return;

    const snippet = (arg: string) =>
      marker
      + 'var _ccv=Object.assign(Object.create(null),' + JSON.stringify(verdicts)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_ccv!==void 0)return _ccv;';

    if (hasMarker) {
      const markerPattern = reEsc(marker);
      applyOnce(
        name + ' (refresh)',
        new RegExp(
          markerPattern
          + 'var _ccv=Object\\.assign\\(Object\\.create\\(null\\),\\{[^{}]*\\}\\)'
          + '\\[String\\(([\\w$]+)\\|\\|""\\)\\.trim\\(\\)\\.toLowerCase\\(\\)\\];'
          + 'if\\(_ccv!==void 0\\)return _ccv;',
        ),
        (_m, arg) => snippet(arg!),
        { required: false, noopIsSkip: true },
      );
      return;
    }

    applyOnce(
      name,
      anchor,
      (_m, head, arg, body) => head! + snippet(arg!) + body!,
      { required: false },
    );
  }

  patchEffortCapability(
    'effort',
    '/*ccpatch:effort*/',
    'PATCH 8a: effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"effort"\);)/,
  );
  patchEffortCapability(
    'xhigh_effort',
    '/*ccpatch:xhigh-effort*/',
    'PATCH 8b: xhigh effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"xhigh_effort"\);)/,
  );
  patchEffortCapability(
    'max_effort',
    '/*ccpatch:max-effort*/',
    'PATCH 8c: max effort capability',
    /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"max_effort"\);)/,
  );

  // ---------------------------------------------------------------------------
  // PATCH 9 — per-model default effort.
  // ---------------------------------------------------------------------------
  const DEFAULT_EFFORT_MARKER = '/*ccpatch:default-effort*/';
  const defaults = Object.fromEntries(
    Object.entries(EFFORT_BY_KEY).map(([key, effort]) => [key, effort!.defaultLevel]),
  );
  if (Object.keys(defaults).length || js.includes(DEFAULT_EFFORT_MARKER)) {
    const snippet = (arg: string) =>
      DEFAULT_EFFORT_MARKER
      + 'var _cce=Object.assign(Object.create(null),' + JSON.stringify(defaults)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_cce!==void 0)return _cce;';

    if (js.includes(DEFAULT_EFFORT_MARKER)) {
      applyOnce(
        'PATCH 9: default effort (refresh)',
        /\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\(([\w$]+)\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_cce!==void 0\)return _cce;/,
        (_m, arg) => snippet(arg!),
        { required: false, noopIsSkip: true },
      );
    } else {
      applyOnce(
        'PATCH 9: default effort',
        /(function [\w$]+\(([\w$]+)\)\{)(return [\w$]+\([\w$]+\(\2\)\)\?\.default_effort\?\?"high"\})/,
        (_m, head, arg, body) => head! + snippet(arg!) + body!,
        { required: false },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 11 — hook batch start time, and the tick that reveals the banner.
  //
  // Claude Code draws `running PreToolUse hook` as the spinner's suffix. The
  // suffix comes from one function (PATCH 12 below), fed by this one: a tracker
  // that publishes a record per hook batch, `{hookEvent,hooks,settled,agentId}`.
  // There is no time in that record and nowhere else on the path — the per-hook
  // `Date.now()` reads all live in the executor and are consumed only to stamp
  // `durationMs` on an ALREADY-FINISHED hook. So the start time has to be added
  // here, at the only writer.
  //
  // The timer is here for the same reason, and it is the whole reason this is two
  // sites rather than one. PATCH 12's gate reads the clock, and the renderer
  // memoises its selector on `(snapshot, selectorFn)`:
  //   `if(e.last!==null&&e.last.snapshot===n&&e.last.select===s)return e.last.selected`
  // so once the banner has been drawn, or declined, it is not recomputed until
  // the snapshot OBJECT changes. A clock read alone would freeze: a hook that
  // blocks for a minute would never start showing. Passing a fresh selector each
  // render is the other way to force recomputation and it is the wrong one — it
  // makes `getSnapshot` non-idempotent, which is the documented footgun for the
  // hook this wrapper is built on. So the recomputation is delivered the way the
  // renderer already expects it: one `setState` at the threshold, with a new
  // array, changing the snapshot identity exactly once per batch. The cost is one
  // wakeup per hook, not a frame loop.
  //
  // `startedAt` needs no care in `settle`: that branch does `{...<entry>,...}`,
  // so the field survives a settle untouched. It does need `clearTimeout` on the
  // `[Symbol.dispose]` arm, or a batch that finishes early leaves a timer holding
  // a store reference until it fires.
  //
  // Identity is carried two ways, because neither is enough alone. The anchor
  // itself is the whole factory, so it can only match a function of that exact
  // shape; and the record literal inside it is counted across the whole bundle
  // first, because "matched once" says one candidate survived, not that it was
  // the right one. The record's own identity is that `hookEvent`, `hooks` and
  // `agentId` all read names the parameter DESTRUCTURED — a bare object literal
  // cannot satisfy that.
  // ---------------------------------------------------------------------------
  {
    const patchName = 'PATCH 11: hook banner start time';
    const marker = '/*ccpatch:hook-banner*/';
    const delay = String(HOOK_BANNER_DELAY_MS);
    // Named capture groups, and a source joined from fragments rather than one
    // literal — both unusual for this file and both for the same reason. This
    // anchor spells seven identifiers more than once each and the replacement
    // REORDERS them, which is what numbered back-references cannot survive: a
    // mis-numbered one still compiles, matches nothing, and reports as "anchor
    // not found" — the error that otherwise means Claude Code moved the site. A
    // numeric escape is a second trap in the same place, because `'\6'` in a
    // plain string is an octal escape, not a back-reference to group six.
    const anchor = new RegExp([
      '(?<head>function [\\w$]+\\(\\{hookEvent:(?<event>[\\w$]+),hooks:(?<hooks>[\\w$]+),agentId:(?<agent>[\\w$]+)\\}\\)\\{let )',
      '(?<decl>(?<store>[\\w$]+)=(?<factory>[\\w$]+)\\(\\),(?<entry>[\\w$]+)=\\{hookEvent:\\k<event>,hooks:\\k<hooks>,settled:new Set,agentId:\\k<agent>\\};)',
      '(?<publish>return \\k<store>\\.setState\\(\\((?<prev>[\\w$]+)\\)=>\\[\\.\\.\\.\\k<prev>,\\k<entry>\\]\\),)',
      '(?<settle>\\{settle:\\((?<settled>[\\w$]+)\\)=>\\k<store>\\.setState\\(\\((?<mutate>[\\w$]+)\\)=>\\{let (?<at>[\\w$]+)=\\k<mutate>\\.indexOf\\(\\k<entry>\\);)',
      '(?<guard>if\\(\\k<at>===-1\\|\\|\\k<entry>\\.settled\\.has\\(\\k<settled>\\)\\)return \\k<mutate>;)',
      '(?<mark>return \\k<entry>=\\{\\.\\.\\.\\k<entry>,settled:new Set\\(\\k<entry>\\.settled\\)\\.add\\(\\k<settled>\\)\\},\\k<mutate>\\.toSpliced\\(\\k<at>,1,\\k<entry>\\)\\}\\),)',
      '(?<disposeHead>\\[Symbol\\.dispose\\]:\\(\\)=>\\k<store>\\.setState\\(\\((?<cleanup>[\\w$]+)\\)=>\\{)',
      '(?<disposeDrop>let (?<drop>[\\w$]+)=\\k<cleanup>\\.indexOf\\(\\k<entry>\\);)',
      '(?<disposeRest>return \\k<drop>===-1\\?\\k<cleanup>:\\k<cleanup>\\.toSpliced\\(\\k<drop>,1\\)\\}\\)\\})',
      '(?<close>\\})',
    ].join(''));
    // Counted against the ORIGINAL source, like PATCH 10: PATCH 4 and PATCH 5
    // splice user-supplied text into `js` before this runs, and a model
    // configured with a name shaped like this literal must not be able to
    // manufacture a second one.
    //
    // `startedAt` is optional BECAUSE this counter also runs on a re-run, where
    // `source` already carries the patch this very site wrote. Requiring the
    // unpatched spelling made a second `clodex patch` refuse the binary the first
    // one had just produced.
    const recordLiterals = source.match(
      /hookEvent:[\w$]+,hooks:[\w$]+,settled:new Set,agentId:[\w$]+(?:,startedAt:Date\.now\(\))?\};/g,
    ) ?? [];
    if (recordLiterals.length !== 1) {
      log('FAIL', patchName, 'hook batch record appears ' + recordLiterals.length + ' times (expected 1)');
      fail('clodex patch: required patch failed: ' + patchName);
    }
    applyOnce(
      patchName,
      anchor,
      (_match, ...rest) => {
        const g = rest[rest.length - 1] as unknown as Record<string, string>;
        // A fresh array on the tick: the renderer memoises on the snapshot's
        // IDENTITY, so mutating it in place would not recompute the suffix.
        return marker + g.head
          // `startedAt` is spliced into the record rather than added after it, so
          // `settle`'s `{...<entry>,...}` spread carries it for free.
          + '_ccHookBannerTimer,' + g.store + '=' + g.factory + '(),'
          + g.entry + '={hookEvent:' + g.event + ',hooks:' + g.hooks + ',settled:new Set,agentId:'
          + g.agent + ',startedAt:Date.now()};'
          + g.publish
          + '_ccHookBannerTimer=setTimeout(()=>' + g.store + '.setState(' + g.prev
          + '=>' + g.prev + '.slice()),' + delay + '),'
          + g.settle + g.guard + g.mark
          + g.disposeHead
          + 'clearTimeout(_ccHookBannerTimer);' + g.disposeDrop
          + g.disposeRest + g.close;
      },
      { marker, required: true },
    );
  }

  // ---------------------------------------------------------------------------
  // PATCH 12 — hide the hook banner until the batch is old enough.
  //
  // This is the gate PATCH 11's start time exists for. The function renders the
  // spinner suffix, and its return value is what the reader sees flash.
  //
  // The comparison fails OPEN on purpose: a record with no `startedAt` gives
  // `NaN`, `NaN < n` is false, and the banner draws exactly as it does on an
  // unpatched binary. That is what makes PATCH 11 safe to lose — a build whose
  // tracker anchor drifted still shows a banner, it just shows it always. The
  // alternative, treating a missing start time as "young", would silently drop
  // the banner for every hook the moment the two sites fell out of step.
  //
  // A hook carrying `statusMessage` is exempt from the delay. That field is the
  // one piece of this text a user deliberately chose, and suppressing their own
  // label for half a second to hide a generic string they never asked for is the
  // wrong trade.
  //
  // Deliberately NOT the elapsed duration in the text. The function has a free
  // slot for it — `Se` is bound to `""` and never reassigned, so `${Se}` is
  // always empty — but a value that changes on every render is exactly what
  // makes a snapshot function unstable, and the spinner already carries a turn
  // timer two characters to the right. Adding it is a separate change with its
  // own reason.
  //
  // Anchor runs from the function head through the null-guard, and stops there:
  // the guard is the ONLY thing inserted against, and the loops after it are
  // what identify the function, so consuming them keeps the anchor specific
  // without making the replacement depend on their spelling. `Fjt` is reused as
  // a name in two unrelated scopes in 2.1.273, so the name alone identifies
  // nothing — the body is the discriminator. Measured: 78 bytes, unique.
  // ---------------------------------------------------------------------------
  {
    const patchName = 'PATCH 12: hook banner delay';
    const marker = '/*ccpatch:hook-banner-gate*/';
    const delay = String(HOOK_BANNER_DELAY_MS);
    if (js.includes(marker)) {
      log('SKIP', patchName, 'already patched');
    } else {
      // Counted against the ORIGINAL source, for the reason PATCH 10 states: by the
      // time this runs, PATCH 4 and PATCH 5 have spliced USER-SUPPLIED model labels
      // into `js`, and a label shaped like this anchor would make the count read 2
      // and refuse the whole patch — with nothing wrong in Claude Code to find.
      // `source` cannot carry that text.
      //
      // What this does NOT close: `applyOnce` still matches against `js`, so a label
      // crafted as this minified function would make it ambiguous and abort the
      // patch. That is the same boundary PATCH 10 has, it fails in the loud
      // direction, and reaching it means pasting Claude Code's own minified source
      // into a model label — so it is left as-is rather than buying a lookahead that
      // would make the anchor depend on the statement BELOW it.
      const anchors = source.match(
        /function (?:[\w$]+)\((?<arg>[\w$]+)\)\{let (?<entry>[\w$]+)=\k<arg>\.findLast\(\((?<item>[\w$]+)\)=>\k<item>\.agentId===void 0\);if\(!\k<entry>\)return null;/g,
      ) ?? [];
      if (anchors.length !== 1) {
        log('FAIL', patchName, 'hook banner builder appears ' + anchors.length + ' times (expected 1)');
        fail('clodex patch: required patch failed: ' + patchName);
      }
    }
    if (!js.includes(marker)) {
      applyOnce(
        patchName,
        /(?<head>function [\w$]+\((?<arg>[\w$]+)\)\{let (?<entry>[\w$]+)=\k<arg>\.findLast\(\((?<item>[\w$]+)\)=>\k<item>\.agentId===void 0\);if\(!\k<entry>\)return null;)/,
        (_match, ...rest) => {
          const g = rest[rest.length - 1] as unknown as Record<string, unknown>;
          const entry = g.entry as string;
          // The gate must not shadow the hook's OWN spinner text. `statusMessage` is
          // a documented hook field, and it is the one thing on this path a user
          // deliberately chose to see, so it is exempt: a hook carrying one shows
          // immediately, exactly as it does unpatched.
          //
          // Asked as "does any hook in this batch carry one" rather than repeating
          // the branch below, which looks for the first UNSETTLED hook's
          // `statusMessage`. The two agree in every ordinary case and differ only
          // for a batch where a settled hook has a label and an unsettled one does
          // not — where this errs toward SHOWING the banner, the harmless
          // direction. Duplicating the branch's own expression here would put a
          // second copy of it in the bundle for upstream to reshape independently.
          return g.head! as string + marker + 'if(Date.now()-' + entry
            + '.startedAt<' + delay + '&&!' + entry
            + '.hooks.some(function(_h){return _h.statusMessage}))return null;';
        },
        { marker, required: true },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH 10 — child command network environment.
  //
  // The wrapper routes the parent client through a local bridge and records the
  // external and injected values. In the shared child-environment builder,
  // revert a key only while its live value still equals the Clodex injection.
  // Settings-level overrides therefore remain authoritative, and the builder's
  // existing filtering continues against the resulting copy.
  //
  // Both ends of the anchor are described by what the builder MEANS, because both
  // ends have drifted with upstream refactors:
  //
  //   * head — Claude Code 2.1.228 hoisted the settings-colour env into its own
  //     declarator, and 2.1.239 rewrote the whole opening `let` again: the agent
  //     proxy env moved behind `sUn.of(lr().host)` and the settings-colour env
  //     became a DESTRUCTURING declarator (`{settingsColorEnv:n}=e`). Spelling
  //     the declarators out, or forbidding braces in the run between them, read
  //     both of those as "anchor not found" — and because PATCH 10 is required,
  //     `clodex patch` then refused to patch the release at all, on every
  //     platform. So the head run is "anything up to the pinned name, containing
  //     no `;`": `[^;{}]` characters or a single balanced `{...}` group, and then
  //     optionally a single UNCLOSED `{…` so the pin may sit inside a
  //     destructuring pattern. The opening `let` may itself be `let{` or `let[` —
  //     a minifier drops the space when the first declarator is a pattern of
  //     either kind, and each measured DARWIN 2.1.260 bundle already carries 4784
  //     `let{` and 2246 `let[` occurrences, opening 84 and 17 zero-arg functions
  //     respectively (the Linux and Windows builds are within a few dozen of
  //     that). None of that lets
  //     the run leave the function: consuming the enclosing function's closing `}`
  //     would need an unmatched CLOSING brace, which the run never admits — that
  //     part is unconditional. Staying inside the opening `let` STATEMENT rests on
  //     excluding `;`, which is a property of minified output, not of JavaScript:
  //     a review reached a second statement across a newline through automatic
  //     semicolon insertion. No measured bundle relies on ASI here, and the
  //     function-level containment above holds either way.
  //     Both tolerances are there because upstream has made this exact move once
  //     already — 2.1.239 turned the settings-colour env, the SIBLING property on
  //     the same registry entry, into a destructuring declarator. Neither shape
  //     occurs in the 27 measured bundles; both were constructed against a real
  //     2.1.260 bundle, both refuse without the tolerances, and adding them
  //     changes nothing measurable on those 27.
  //
  //     What the run ends AT has drifted too, and for the same reason: a value
  //     the builder happens to COMPUTE is only as durable as the expression that
  //     computes it. Through 2.1.259 the only thing it could end at was the
  //     remote-mode ternary `<fn>(process.env.CLAUDE_CODE_REMOTE)?`; 2.1.260 reads
  //     that flag off the typed env accessor and compares it inline
  //     (`i=a.CLAUDE_CODE_REMOTE===!0`), keeping neither the call nor the
  //     `process.env.` prefix, and PATCH 10 refused all eight builds. So the run
  //     now ends at EITHER that ternary or `getAgentProxyEnv` — the agent-proxy
  //     env this builder folds into the child's environment, and the thing PATCH 10
  //     exists to correct rather than a flag check that can be rewritten again.
  //     `getAgentProxyEnv` is a cross-module property and export name — a class
  //     field assigned from outside the class (directly on the registry entry from
  //     2.1.246 on, through a setter method in 2.1.238) and re-exported under its
  //     own name — and it survived unminified, spelled identically,
  //     in all 27 bundles measured below. That is an observation, not a guarantee:
  //     nothing stops a future build renaming it, and — the likelier move — nothing
  //     stops the builder reaching it through a helper instead of spelling it, which
  //     is exactly what the 2.1.238 builder does (see below). A name is only as
  //     durable as the builder INLINING it.
  //
  //     The ternary is kept as the second alternative for that reason. The name
  //     `getAgentProxyEnv` is NOT new — it occurs 6 times in the real 2.1.238
  //     bundle, including its own `__export` map entry — but that builder reaches
  //     the agent-proxy env through a plain call, `function JP(){let e=NDt(),…`,
  //     where `NDt` is `return <mod>.getAgentProxyEnv?.()??{}`, so the name appears
  //     nowhere in the builder itself. Every measured builder from 2.1.246 on
  //     spells it inline. Dropping the ternary would therefore have refused
  //     2.1.238 — measured on its darwin-arm64 build, the only one on disk — and
  //     presumably everything older, which is not measured at all.
  //
  //     The pair produced no extra candidates in the corpus. Over 27 real bundles
  //     (2.1.238, 2.1.246, 2.1.252, 2.1.257, 2.1.259 and all eight 2.1.260 builds)
  //     the head matches EXACTLY ONCE per bundle, as does the whole anchor; and on
  //     the 19 that predate 2.1.260 the WHOLE ANCHOR's matched span — not the head
  //     prefix, which now ends earlier — is byte-identical to what version 11
  //     matched, and so is the whole `applyClodexPatches` output. Relaxing instead
  //     to a bare `CLAUDE_CODE_REMOTE` was measured and is the worse trade: four
  //     head candidates on 2.1.238, five on each 2.1.246 build and six from 2.1.252
  //     on, leaving identity to rest entirely on the passthrough count below.
  //
  //   * tail — through 2.1.238 the builder ended by scrubbing GitHub Actions
  //     inputs (``delete p[`INPUT_${f}`]``); 2.1.239 dropped that entirely. The
  //     tail is now tied to the merged copy by BACK-REFERENCE: the same variable
  //     the builder declares for `{...process.env,...}` is the one it returns at
  //     the end. That survives a RENAME of the merged copy in a way a named
  //     statement does not — but it is not refactor-proof, and it does NOT prove
  //     we stopped at the function's own closing brace. It can stop short at a
  //     nested `return <copy>}`, and if the builder's own final return is ever
  //     minified to the comma form it runs long into a neighbour. The brace walk
  //     below is what rules out both.
  //
  // Identity is carried by the passthrough early-out — `)return process.env;let
  // <copy>={` — which reads as nothing but the shared child-env builder ("nothing
  // to change, so hand the parent's own env straight through, otherwise start a
  // copy"). It is counted across the WHOLE bundle before the anchor runs, so a
  // second candidate fails loud instead of being silently preferred. It occurs
  // exactly once — over 29 real bundles (2.1.208 through every 2.1.239 build),
  // and again over the 27 re-measured for 2.1.260, where it sits inside the
  // builder and exactly one head candidate precedes it. Those two facts together
  // are what pin the head to the real builder.
  //
  // The nested-function and brace-balance checks below are the last line: they
  // reject a match that ends at a nested `return <copy>}` (which would truncate
  // the function) or that swallowed a neighbour. The literal checks are split by
  // what they are FOR — two the rewrite structurally depends on, and a quorum
  // over names Claude Code happens to scrub, which churn. See below.
  // ---------------------------------------------------------------------------
  {
    const patchName = 'PATCH 10: child network environment';
    const marker = '/*ccpatch:child-network-env*/';
    const contractVar = q(NETWORK_ENV_CONTRACT_VAR);
    const networkVars = JSON.stringify(CHILD_NETWORK_ENV_VARS);
    // What the REWRITE depends on: `{...process.env` is the merged copy every
    // `process.env` read is redirected away from. Nothing else is: the builder's
    // remote-mode check used to read `process.env.CLAUDE_CODE_REMOTE` and so was
    // rewritten with everything else, but 2.1.260 reads that flag off the typed
    // env accessor instead and the rewrite no longer touches it. That is a change
    // in nothing that matters here — `CLAUDE_CODE_REMOTE` is not one of the
    // network variables clodex reverts, so which object it is read from cannot
    // change what the child sees.
    const requiredBodyLiterals = ['{...process.env'];
    // A smell test, NOT the identity proof. Identity is the whole-bundle count of
    // the passthrough early-out below, the name the head pins on, and the brace
    // walk proving the match spans exactly the function it started in.
    // Measured on all 27 real bundles above: with these names ignored entirely,
    // the full anchor still has exactly ONE candidate in each. They never choose among candidates,
    // so all they can do is reject one already identified.
    //
    // Which is what makes an aggressive threshold the wrong trade. These are names
    // Claude Code happens to scrub out of a child's environment, each only as
    // durable as the line that spells it: 2.1.252 wrote
    // `process.env.CLAUDE_BG_PTY_AUTH!==void 0` inline, and 2.1.257 replaced that
    // whole run of per-name reads with a set-membership test and stopped spelling
    // the name anywhere. Requiring EVERY name turned that refactor — which changed
    // nothing about what clodex rewrites — into `clodex patch` refusing 2.1.257 on
    // all eight published builds at once, and the same move on any other group
    // would do it again. Nor is a higher floor worth much: two of the five are the
    // OTEL pair, so "at least two" can be satisfied from a single category and
    // buys little over one.
    //
    // So the floor is ONE. It still refuses a body that spells none of them —
    // which is the only case where these names say something the anchor does not.
    // 2.1.252 spells five and 2.1.257 spells four. Note what the floor does NOT
    // buy: one refactor can still take it to zero, because "extract the remaining
    // literals into a shared table" is a single ordinary move and is exactly what
    // 2.1.257 already did to one of the five. The floor is cheap insurance
    // against a body that spells none of these names, not a durable identity signal.
    //
    // These are matched as SUBSTRINGS of the body. A builder that scrubs the same
    // names through a table declared elsewhere spells none of them here and is
    // refused; that is the conservative direction, and the message below says
    // "spells" rather than "scrubs" so the next reader is not sent looking for
    // deletion logic that is not there.
    const scrubbedEnvNames = [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SUBSCRIPTION_TYPE',
      'CLAUDE_BG_PTY_AUTH',
      '"OTEL_"',
      'CLAUDE_CODE_OTEL_DIAG_STDERR',
    ];
    const MIN_SCRUBBED_ENV_NAMES = 1;
    /**
     * Index of the `}` closing the block opened at `open`, or -1 if the scan runs
     * off the end. Braces inside strings, template literals and comments do not
     * count — a plain `{`/`}` tally does, and a single `"}"` in a string is enough
     * to make it agree with a match that stopped in the middle of the function.
     *
     * A `/` is read as division, never as the start of a regex literal, because
     * telling those apart needs the grammar. That is a real limit, not a safe
     * approximation: a review built a builder ending
     * `…if(x){var re=/}/;return <copy>}…;return <copy>}` where the unbalanced `}`
     * inside the regex literal moved this walk's zero-crossing onto the NESTED
     * return, so a truncated match agreed with it and PATCH 10 reported OK with
     * a live `process.env` read stranded past the rewritten span. A later review
     * built a worse one: a decoy carrying `/[{]/` and an ARROW-function builder
     * carrying `/[}]/`, where the two phantom braces cancel, `bound` lands on 0,
     * the nested-`function` guard never fires because the builder is an arrow, and
     * the emitted builder READS `_clodexChildEnv` without declaring it — every
     * child command would throw. It reproduces identically on the pre-2.1.260
     * anchor, so it is a property of this walk, not of any one head.
     *
     * It is left as-is deliberately, but NOT for the reason once written here.
     * "A regex literal no minifier emits" is measurably false: `2.1.260`'s
     * darwin-arm64 bundle alone holds 90 regex literals with unbalanced unescaped
     * braces (`/[)`}]/`, `/[*?[{]/`, …), and walking every zero-arg function with
     * this routine disagrees with a real parser 3-4 times per bundle, in all 27
     * (counting the named `function X(){` bodies this anchor can open, which is
     * the population that matters — not arrows, methods or anonymous functions).
     * (Escaped `\{`/`\}` are harmless — the `\\` branch skips them.)
     *
     * What actually makes it unreachable is narrower and stronger: a mis-tallied
     * function only matters if it can REACH the passthrough, and in all 27 bundles
     * the builder is immediately preceded by `}function `, which the body run
     * refuses to cross — a 0-byte window. None of the disagreeing functions is in
     * front of the builder in any measured bundle. Closing the limit properly
     * means parsing JavaScript; until the window stops being 0, every wrong bind
     * reachable from a shape a real build emits still fails LOUD.
     */
    const blockEndIndex = (text: string, open: number): number => {
      // Each entry is a brace depth; a new entry is pushed on entering `${`.
      const depths: number[] = [0];
      const templates: boolean[] = [false];
      for (let i = open; i < text.length; i++) {
        const ch = text[i];
        const inTemplate = templates[templates.length - 1]!;
        if (inTemplate) {
          if (ch === '\\') { i++; continue; }
          if (ch === '`') { templates.pop(); depths.pop(); continue; }
          if (ch === '$' && text[i + 1] === '{') { templates.push(false); depths.push(0); i++; }
          continue;
        }
        if (ch === '\\') { i++; continue; }
        if (ch === '"' || ch === "'") {
          const quote = ch;
          for (i++; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === quote) break;
          }
          continue;
        }
        if (ch === '`') { templates.push(true); depths.push(0); continue; }
        if (ch === '/' && text[i + 1] === '/') {
          while (i < text.length && text[i] !== '\n') i++;
          continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
          i = text.indexOf('*/', i + 2);
          if (i < 0) return -1;
          i++;
          continue;
        }
        if (ch === '{') { depths[depths.length - 1]!++; continue; }
        if (ch === '}') {
          if (depths[depths.length - 1] === 0 && templates.length > 1) {
            // Closes a `${…}` and hands control back to the template literal.
            templates.pop();
            depths.pop();
            continue;
          }
          depths[depths.length - 1]!--;
          if (depths.length === 1 && depths[0] === 0) return i;
        }
      }
      return -1;
    };
    // Count against the ORIGINAL source, not the partly-patched `js`: PATCH 4 and
    // PATCH 5 splice user-supplied model display text into the bundle, so counting
    // afterwards lets a model label that happens to contain this signal refuse a
    // patch that would otherwise succeed.
    //
    // Patching an already-patched bundle rewrites `return process.env` to
    // `return _clodexChildEnv`, so the count is only meaningful pre-patch —
    // applyOnce reports SKIP for that case and must still be allowed to.
    const passthroughSites = source.includes(marker)
      ? 1
      : (source.match(/\)return process\.env;let [\w$]+=\{/g) ?? []).length;
    if (passthroughSites !== 1) {
      log('FAIL', patchName, 'child env passthrough appears ' + passthroughSites + ' times (expected 1)');
      fail('clodex patch: required patch failed: ' + patchName);
    }
    applyOnce(
      patchName,
      /(function [\w$]+\(\)\{)(let[ {[](?:[^;{}]|\{[^;{}]*\})*?(?:\{[^;{}]*)?(?:getAgentProxyEnv|[\w$]+\(process\.env\.CLAUDE_CODE_REMOTE\)\?)(?:(?!\}\s*function )[\s\S])*?\)return process\.env;let ([\w$]+)=\{(?:(?!\}\s*function )[\s\S])*?return \3)(\})/,
      (match, head, body, _copyVar, tail) => {
        // The tail is found lazily, so it can stop in the wrong place in EITHER
        // direction, and both are silent without this check:
        //   * short — a nested `return <copy>}` ends the match inside the
        //     function, so only part of it is rewritten and live `process.env`
        //     reads survive;
        //   * long — if the builder's own final `return <copy>}` is ever
        //     minified to the comma form `return f(),<copy>}` (400+ of those
        //     already exist elsewhere in 2.1.239), the tail runs past the true
        //     end into a neighbour and rewrites ITS `process.env` to a name
        //     that is out of scope there, which throws at runtime. The
        //     `}<space>function` guard does not stop this: a neighbour written
        //     `};var x=()=>{` never matches it.
        // Walking the real block from the function's own `{` rules out both:
        // the anchor's end must BE the function's end.
        const at = js.indexOf(match);
        const closingBrace = at < 0 ? -1 : blockEndIndex(js, at + head!.length - 1);
        // Distinct from "ended in the wrong place": -1 means the walk ran off the
        // end of the source without ever closing the block. Folding it into the
        // arithmetic below reports it as a bundle-sized negative distance, which
        // names nothing.
        const braceScanFailed = at < 0 || closingBrace < 0;
        const bound = braceScanFailed ? 0 : closingBrace - at - (match.length - 1);
        // Name the check that rejected it. "target validation failed" alone sends
        // the next person triaging a canary failure off to extract a 32 MB bundle
        // by hand to learn which of four unrelated conditions was the one.
        const missingLiteral = requiredBodyLiterals.find(literal => !body!.includes(literal));
        const scrubbedSeen = scrubbedEnvNames.filter(name => body!.includes(name));
        const why = missingLiteral !== undefined
          ? 'body does not contain ' + missingLiteral
          : scrubbedSeen.length < MIN_SCRUBBED_ENV_NAMES
            ? 'body spells only ' + scrubbedSeen.length + ' of the '
              + scrubbedEnvNames.length + ' known child-env names (expected at least '
              + MIN_SCRUBBED_ENV_NAMES + ')'
            : /\bfunction\s*[\w$]*\(/.test(body!)
              ? 'body declares a nested function'
              : braceScanFailed
                ? "the brace walk never reached the function's closing brace"
                : bound !== 0
                  // Say which way it went. `bound` is the function's closing brace minus the
                  // match's last character, so a positive value means the match stopped SHORT
                  // (a nested `return <copy>}` ended it early, leaving live `process.env` reads
                  // unrewritten) and a negative one means it RAN PAST the function into a
                  // neighbour. Those are different bugs; a signed number in front of the word
                  // "from" reads as neither.
                  ? 'match ends ' + Math.abs(bound) + ' characters '
                    + (bound > 0 ? 'before' : 'after')
                    + ' the end of the function it started in'
                  : undefined;
        if (why !== undefined) {
          log('FAIL', patchName, 'target validation failed: ' + why);
          fail('clodex patch: child network environment target validation failed: ' + why);
        }
        const restoredBody = body!.replace(/process\.env/g, '_clodexChildEnv');
        const restore = marker
          + 'let _clodexChildEnv=process.env,_clodexNetworkRaw=_clodexChildEnv[' + contractVar + '];'
          + 'if(_clodexNetworkRaw!==void 0){_clodexChildEnv={..._clodexChildEnv};'
          + 'delete _clodexChildEnv[' + contractVar + '];try{'
          + 'let _clodexNetwork=JSON.parse(_clodexNetworkRaw);'
          + 'if(_clodexNetwork&&typeof _clodexNetwork==="object"&&!Array.isArray(_clodexNetwork)'
          + '&&_clodexNetwork.version===1&&_clodexNetwork.original'
          + '&&typeof _clodexNetwork.original==="object"&&!Array.isArray(_clodexNetwork.original)'
          + '&&_clodexNetwork.injected&&typeof _clodexNetwork.injected==="object"'
          + '&&!Array.isArray(_clodexNetwork.injected)'
          + '&&Object.keys(_clodexNetwork.original).every(_clodexKey=>'
          + networkVars + '.includes(_clodexKey)'
          + '&&(typeof _clodexNetwork.original[_clodexKey]==="string"'
          + '||_clodexNetwork.original[_clodexKey]===null)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.injected,_clodexKey))'
          + '&&Object.keys(_clodexNetwork.injected).every(_clodexKey=>'
          + networkVars + '.includes(_clodexKey)'
          + '&&(typeof _clodexNetwork.injected[_clodexKey]==="string"'
          + '||_clodexNetwork.injected[_clodexKey]===null)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.original,_clodexKey)))'
          + 'for(let _clodexKey of ' + networkVars + '){'
          + 'if(Object.prototype.hasOwnProperty.call(_clodexNetwork.original,_clodexKey)'
          + '&&Object.prototype.hasOwnProperty.call(_clodexNetwork.injected,_clodexKey)){'
          + 'let _clodexOriginal=_clodexNetwork.original[_clodexKey],'
          + '_clodexInjected=_clodexNetwork.injected[_clodexKey],'
          + '_clodexCurrent=_clodexChildEnv[_clodexKey]===void 0?null:_clodexChildEnv[_clodexKey];'
          + 'if((typeof _clodexOriginal==="string"||_clodexOriginal===null)'
          + '&&(typeof _clodexInjected==="string"||_clodexInjected===null)'
          + '&&_clodexCurrent===_clodexInjected){if(_clodexOriginal===null)'
          + 'delete _clodexChildEnv[_clodexKey];else '
          + '_clodexChildEnv[_clodexKey]=_clodexOriginal}}}}catch(_clodexError){}}';
        return head! + restore + restoredBody + tail!;
      },
      { marker, required: true },
    );
  }

  return { content: js, results: report };
}
