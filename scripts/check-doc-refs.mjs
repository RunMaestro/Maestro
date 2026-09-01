#!/usr/bin/env node
/**
 * check-doc-refs.mjs - compare the agent briefing docs against the repo they
 * describe, and fail when a doc sends an agent somewhere that does not exist.
 *
 * The CLAUDE*.md set and docs/agent-guides/ are the first thing every coding
 * agent reads, and CLAUDE.md's "commonly-reimplemented functions" list is
 * literally a table of import paths. A moved file silently turns those into
 * instructions to import from nowhere. Nothing in the build notices, because
 * a code review looks at the diff rather than at the docs the diff
 * invalidated.
 *
 * Three checks, all mechanical, no model in the loop:
 *
 *   PATH    every `src/` / `docs/` / `scripts/` reference resolves. Hard.
 *   SYMBOL  (--names) a `foo()` named beside a live path exists SOMEWHERE
 *           under src/. A name found nowhere was renamed or deleted.
 *   MOVED   (--soft) the name exists, but not in the file the line names.
 *           Heuristic, and noisier: verify by hand.
 *
 * PATH is the only bucket fit to gate a merge. The other two run under the
 * weekly Cue sweep as advisory findings, because a prose sentence that names
 * a function is easy to write in a way SYMBOL misreads, and a gate that
 * blocks merges on a heuristic gets switched off within a month.
 *
 * Deliberately forgiving in four places, because a false positive is worse
 * than a miss here: an author who has to fight the checker stops trusting it.
 *   - Fenced code blocks are skipped. They hold shell transcripts and
 *     illustrative snippets, whose paths are examples rather than claims.
 *   - Extension-less refs resolve like an import would (foo -> foo.ts,
 *     foo/index.tsx), since docs cite modules by module name.
 *   - `file.ts:symbolName` and `file.md:412` citations drop the suffix.
 *   - A bare `Name.md` only counts when it came from a link or a [[wiki
 *     link]], and it resolves next to the citing doc before the repo root.
 *     A bare .md inside a code span is usually a prompt id, not a path.
 *
 * Escape hatch, for a path that is SUPPOSED to be dead - a template
 * placeholder, or prose describing code that was deliberately removed:
 *   <!-- doc-refs-ignore -->        exempts this line and the next NON-BLANK
 *                                  one, so it can sit above the paragraph it
 *                                  is exempting with a blank line between
 *   <!-- doc-refs-ignore:start -->  ... <!-- doc-refs-ignore:end -->
 * The region form exists for tables. A comment inside a table row renders as
 * a stray cell, and a comment on the row above exempts that row's refs too,
 * so a retirement table has no way to spell the single-line form.
 *
 * Usage: node scripts/check-doc-refs.mjs [options]
 *   --names             also run the SYMBOL check
 *   --soft              also run the MOVED check (implies --names)
 *   --allow-ref <ref>   a path present in this git ref (e.g. origin/rc) is
 *                       reported separately and does not fail. `main` and
 *                       `rc` are permanently divergent and main never
 *                       receives rc merges, so a briefing file on main
 *                       legitimately describes rc-only subsystems.
 *   --repo <path>       scan a tree other than this script's own repo
 *   --json              machine-readable output
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? null : argv[i + 1];
};

const asJson = flag('--json');
const withSoft = flag('--soft');
const withNames = withSoft || flag('--names');
const allowRef = value('--allow-ref');
const ROOT = resolve(value('--repo') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

/** Docs whose paths are promises to an agent, so a dead one is a real bug. */
const DOC_SOURCES = [
	{ dir: '.', match: /^CLAUDE.*\.md$/ },
	{ dir: 'docs/agent-guides', match: /\.md$/ },
	{ dir: '.', match: /^(AGENT_SUPPORT|ARCHITECTURE|CONTRIBUTING)\.md$/ },
];

/**
 * A reference only counts as a claim about this tree if it starts with one of
 * these. `.maestro/` and `assets/` are deliberately absent: both name folders
 * inside a USER's project (Cue output, playbook attachments, the PWA bundle),
 * so they can never exist in this repo and flagging them is pure noise.
 */
const TRACKED_PREFIXES = ['src/', 'scripts/', 'docs/', 'e2e/', 'packages/', '.github/'];

/** How an import would resolve a reference written without its extension. */
const IMPLIED_SUFFIXES = [
	'',
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.md',
	'/index.ts',
	'/index.tsx',
	'/index.js',
];

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE_MARKER = '<!-- doc-refs-ignore -->';
const IGNORE_START = '<!-- doc-refs-ignore:start -->';
const IGNORE_END = '<!-- doc-refs-ignore:end -->';

function listDocs() {
	const seen = new Set();
	for (const { dir, match } of DOC_SOURCES) {
		const abs = join(ROOT, dir);
		if (!existsSync(abs)) continue;
		for (const name of readdirSync(abs)) {
			if (match.test(name)) seen.add(dir === '.' ? name : `${dir}/${name}`);
		}
	}
	return [...seen].sort();
}

/** Every path in `allowRef`, or null when the ref is absent or unusable. */
function allowedPaths() {
	if (!allowRef) return null;
	try {
		const out = execFileSync('git', ['ls-tree', '-r', '--name-only', allowRef], {
			cwd: ROOT,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		const set = new Set(out.split('\n').filter(Boolean));
		// A ref that resolved to almost nothing is a shallow clone, not an
		// empty branch. Treating it as authoritative would silently turn the
		// allow-list off and bury every branch-divergence finding in PATH.
		if (set.size > 100) return set;
		console.error(`check-doc-refs: ${allowRef} listed ${set.size} files, ignoring it as shallow.`);
	} catch {
		console.error(`check-doc-refs: could not read ${allowRef}, running without an allow-list.`);
	}
	return null;
}
const ALLOWED = allowedPaths();

/** Lines outside fenced code blocks, 1-indexed. */
function proseLines(text) {
	const out = [];
	let fence = null;
	text.split('\n').forEach((line, i) => {
		const open = line.match(/^\s*(`{3,}|~{3,})/);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
			return;
		}
		if (open) {
			fence = open[1];
			return;
		}
		out.push({ line: i + 1, text: line });
	});
	return out;
}

/** kind 'code' cannot introduce a bare Name.md; 'link' can. */
function candidatesIn(line) {
	const found = [];
	for (const m of line.matchAll(/`([^`\n]+)`/g)) found.push({ raw: m[1], kind: 'code' });
	for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) found.push({ raw: m[1], kind: 'link' });
	for (const m of line.matchAll(/\[\[([^\]|]+)\]\]/g)) found.push({ raw: m[1], kind: 'link' });
	return found;
}

function normalize(raw, kind) {
	let s = raw.trim();
	if (!s || /\s/.test(s)) return null;
	if (/^(https?:|mailto:|#|~|\/|\$)/.test(s)) return null;
	if (/[<>{}$\\]/.test(s)) return null; // <name>.md and ${var} are templates
	s = s.replace(/^\.\//, '');
	s = s.replace(/#.*$/, ''); // anchor
	s = s.replace(/:\d+(-\d+)?$/, ''); // file:line citation
	s = s.replace(/:[A-Za-z_$][\w$]*$/, ''); // file.ts:symbolName citation
	s = s.replace(/[.,;:'"]+$/, '');
	if (!s) return null;
	if (TRACKED_PREFIXES.some((p) => s.startsWith(p))) return s.replace(/\/+$/, '');
	if (kind === 'link' && /^[A-Za-z0-9_.-]+\.md$/.test(s)) return s;
	return null;
}

/** existsSync, but a `*` in any segment means "at least one match". */
function anyMatch(rel) {
	if (!rel.includes('*')) return existsSync(join(ROOT, rel));
	const walk = (base, segments) => {
		if (segments.length === 0) return true;
		const [head, ...rest] = segments;
		if (!head.includes('*')) {
			const next = join(base, head);
			return existsSync(next) && walk(next, rest);
		}
		const re = new RegExp(`^${head.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
		let entries;
		try {
			entries = readdirSync(base);
		} catch {
			return false;
		}
		return entries.some((name) => re.test(name) && walk(join(base, name), rest));
	};
	return walk(ROOT, rel.split('/'));
}

/** The reference as it actually resolves on disk, or null. */
function resolveRef(rel, docDir) {
	const bases = TRACKED_PREFIXES.some((p) => rel.startsWith(p))
		? [rel]
		: [posix.join(docDir, rel), rel];
	for (const base of bases) {
		for (const suffix of IMPLIED_SUFFIXES) {
			if (anyMatch(base + suffix)) return base + suffix;
		}
	}
	return null;
}

/** Does the reference exist on the allow-ref branch instead of this one? */
function onAllowedRef(rel) {
	if (!ALLOWED) return false;
	const bare = rel.replace(/\/+$/, '');
	for (const suffix of IMPLIED_SUFFIXES) {
		if (ALLOWED.has(bare + suffix)) return true;
	}
	for (const f of ALLOWED) {
		if (f.startsWith(`${bare}/`)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Symbol checks. Only built when asked for: walking all of src/ to collect
// identifiers costs seconds, and the CI gate never needs it.
// ---------------------------------------------------------------------------

let SRC_IDS = null;
const fileCache = new Map();

function walkCodeFiles(rel, out, maxDepth = Infinity) {
	let entries;
	try {
		entries = readdirSync(join(ROOT, rel));
	} catch {
		return out;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name.startsWith('.')) continue;
		const child = `${rel}/${name}`;
		const st = statSync(join(ROOT, child));
		if (st.isFile() && CODE_EXT.test(child)) out.push(child);
		else if (st.isDirectory() && maxDepth > 0) walkCodeFiles(child, out, maxDepth - 1);
	}
	return out;
}

function srcIdentifiers() {
	const ids = new Set();
	const files = [...walkCodeFiles('src', []), ...walkCodeFiles('packages', [])];
	for (const file of files) {
		const text = readFileSync(join(ROOT, file), 'utf8');
		for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g)) ids.add(m[0]);
	}
	return ids;
}

function readCached(rel) {
	if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
	return fileCache.get(rel);
}

/** Code reachable from a resolved reference, so a directory ref still works. */
function expand(rel) {
	const abs = join(ROOT, rel);
	if (!existsSync(abs)) return [];
	if (!statSync(abs).isDirectory()) return CODE_EXT.test(rel) ? [rel] : [];
	return walkCodeFiles(rel, [], 1);
}

// ---------------------------------------------------------------------------

const findings = { path: [], symbol: [], moved: [], otherBranch: [] };

for (const doc of listDocs()) {
	const docDir = posix.dirname(doc);
	const lines = proseLines(readFileSync(join(ROOT, doc), 'utf8'));

	const ignored = new Set();
	let inRegion = false;
	let carry = false;
	for (const { line, text } of lines) {
		if (text.includes(IGNORE_START)) inRegion = true;
		if (inRegion) ignored.add(line);
		if (text.includes(IGNORE_END)) inRegion = false;
		if (carry) {
			ignored.add(line);
			if (text.trim()) carry = false;
		}
		if (text.includes(IGNORE_MARKER)) {
			ignored.add(line);
			carry = true;
		}
	}

	const reported = new Set();
	for (const { line, text } of lines) {
		if (ignored.has(line)) continue;

		const live = [];
		for (const { raw, kind } of candidatesIn(text)) {
			const rel = normalize(raw, kind);
			if (!rel) continue;
			const key = `${line}:${rel}`;
			if (reported.has(key)) continue;
			reported.add(key);

			const hit = resolveRef(rel, docDir);
			if (hit) live.push(hit);
			else {
				const bucket = onAllowedRef(rel) ? findings.otherBranch : findings.path;
				bucket.push({ doc, line, ref: rel });
			}
		}

		if (!withNames || live.length === 0) continue;
		const calls = [
			...new Set([...text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]{3,})\(\)`/g)].map((m) => m[1])),
		];
		if (calls.length === 0) continue;
		const named = live.flatMap(expand);
		if (named.length === 0) continue;
		if (!SRC_IDS) SRC_IDS = srcIdentifiers();

		// MOVED only speaks for the "`foo()` in `path.ts`" shape, one name and
		// one file. The briefing files are full of bullets that name half a
		// dozen helpers across several modules, and pairing every name with
		// every path there manufactures a finding for each combination that
		// does not happen to line up - noise that buries the real ones.
		const canPlace = live.length === 1 && calls.length === 1;
		const haystack = canPlace ? named.map(readCached).join('\n') : '';

		for (const sym of calls) {
			if (!SRC_IDS.has(sym)) findings.symbol.push({ doc, line, ref: sym, claimedIn: live });
			else if (canPlace && !new RegExp(`\\b${sym}\\b`).test(haystack)) {
				findings.moved.push({ doc, line, ref: sym, claimedIn: live });
			}
		}
	}
}

const failing =
	findings.path.length +
	(withNames ? findings.symbol.length : 0) +
	(withSoft ? findings.moved.length : 0);

if (asJson) {
	console.log(JSON.stringify({ ...findings, failing }, null, 2));
	process.exit(failing > 0 ? 1 : 0);
}

const section = (title, list, fmt) => {
	if (!list.length) return;
	console.error(`\n## ${title} (${list.length})\n`);
	for (const f of list) console.error(`- ${f.doc}:${f.line} - ${fmt(f)}`);
};

if (failing === 0) {
	const notes = [];
	if (findings.otherBranch.length) notes.push(`${findings.otherBranch.length} on ${allowRef}`);
	if (!withSoft && findings.moved.length) notes.push(`${findings.moved.length} soft`);
	const suffix = notes.length ? ` (${notes.join(', ')} ignored)` : '';
	console.log(
		`check-doc-refs: all path references resolve across ${listDocs().length} docs${suffix}.`
	);
	process.exit(0);
}

section('Dead paths', findings.path, (f) => `\`${f.ref}\` does not exist`);
if (withNames) {
	section(
		'Names that exist nowhere under src/',
		findings.symbol,
		(f) => `\`${f.ref}()\` claimed alongside ${f.claimedIn.join(', ')}`
	);
}
if (withSoft) {
	section(
		'Possibly moved (exists in src/, not in the file named)',
		findings.moved,
		(f) => `\`${f.ref}()\` not found in ${f.claimedIn.join(', ')}`
	);
}
section(`Ignored: on ${allowRef}, not on this branch`, findings.otherBranch, (f) => `\`${f.ref}\``);

console.error(
	`\ncheck-doc-refs: ${failing} finding(s). Repoint them, or add ` +
		`<!-- doc-refs-ignore --> above a deliberate placeholder.`
);
process.exit(1);
