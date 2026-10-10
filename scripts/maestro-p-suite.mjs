#!/usr/bin/env node
// Black-box regression battery for maestro-p, run against a REAL binary and a
// REAL claude account.
//
// maestro-p drives Claude Code's interactive TUI so a caller gets `claude -p`
// semantics on plan quota. Its unit tests (src/__tests__/maestro-p) run against
// fixtures and a mocked PTY; this suite runs the binary end to end and checks
// that it behaves like `claude -p` would: envelopes, exit codes, timeouts,
// slash commands, trust dialogs, odd input, concurrency, and process cleanup.
// Ported from the Pedsidian agent's maestro_p_suite.py.
//
// Every case runs a real turn, so the suite spends a little plan quota on the
// account it runs as.
//
// Usage:
//   node scripts/maestro-p-suite.mjs                      # installed maestro-p
//   node scripts/maestro-p-suite.mjs --local              # build this checkout, run it
//   node scripts/maestro-p-suite.mjs --only T01,T09 --config-dir ~/.claude-smash
//   node scripts/maestro-p-suite.mjs --cli /Applications/Maestro.app/Contents/Resources/maestro-cli.js --cli-agent <id>
//
// Test folders are created under --root, which must be inside a folder claude
// already trusts on that account: claude inherits trust from a parent folder,
// and an untrusted folder parks the TUI on its "trust this folder?" dialog.
// T16/T17 test that dialog on purpose, in an untrusted temp folder.
//
// T23 runs plain `claude -p` (no maestro-p) on the plan login. It is the
// tripwire for Anthropic making `--bare` the default for `-p`: bare mode never
// reads the plan login, so on that release every agent on the `claude -p`
// token source with no API key starts failing to authenticate.
//
// Exit: 0 all pass, 2 only known-issue failures, 1 any unexpected failure.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same flags Maestro passes when it spawns a TUI-mode Claude agent.
const BASE = [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
];

// Case id -> upstream issue it currently fails on (RunMaestro/Maestro). A case
// listed here that passes is reported, so the entry can be removed.
const KNOWN = {};

// The documented exit codes (src/main/cue/cue-db.ts keeps the same list).
const EXIT = {
	ok: 0,
	tuiExited: 1,
	limit: 2,
	timeout: 3,
	readyTimeout: 4,
	firstByteTimeout: 5,
	promptTruncated: 6,
	workspaceUntrusted: 7,
	apiError: 8,
};

const HOSTILE =
	'line one\nquotes " \' ` and $HOME and \\n literal\n' +
	'emoji 🐎🔥 and ünïcödé\n/slash-at-line-start';
const TABBED = 'col_a\tcol_b\tcol_c';
// What claude's paste path turns a tab into; maestro-p types it the same way.
const TAB_SPACES = '    ';

// ── args ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const opts = {
		bin: null,
		local: false,
		configDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
		model: 'sonnet',
		only: null,
		json: false,
		keep: false,
		root: path.join(repoRoot, '.maestro', 'scratch', 'maestro-p-suite'),
		claudeBin: null,
		cli: null,
		cliAgent: null,
		jobs: 4,
	};
	const value = (i) => {
		if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
		return argv[i + 1];
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--bin') opts.bin = expandHome(value(i++));
		else if (a === '--local') opts.local = true;
		else if (a === '--config-dir') opts.configDir = expandHome(value(i++));
		else if (a === '--model') opts.model = value(i++);
		else if (a === '--only')
			opts.only = new Set(
				value(i++)
					.split(',')
					.map((s) => s.trim().toUpperCase())
			);
		else if (a === '--json') opts.json = true;
		else if (a === '--keep') opts.keep = true;
		else if (a === '--root') opts.root = path.resolve(expandHome(value(i++)));
		else if (a === '--claude-bin') opts.claudeBin = expandHome(value(i++));
		else if (a === '--cli') opts.cli = expandHome(value(i++));
		else if (a === '--cli-agent') opts.cliAgent = value(i++);
		else if (a === '--jobs') opts.jobs = Math.max(1, Number(value(i++)) || 1);
		else if (a === '-h' || a === '--help') {
			process.stdout.write(
				fs
					.readFileSync(fileURLToPath(import.meta.url), 'utf8')
					.split('\n')
					.slice(1, 27)
					.map((l) => l.replace(/^\/\/ ?/, ''))
					.join('\n') + '\n'
			);
			process.exit(0);
		} else fail(`unknown option ${a}`);
	}
	return opts;
}

function expandHome(p) {
	return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function fail(msg) {
	process.stderr.write(`maestro-p-suite: ${msg}\n`);
	process.exit(1);
}

// ── the binary under test ────────────────────────────────────────────────

// [command, ...prefixArgs] for the maestro-p under test.
function resolveCommand(opts) {
	if (opts.local) {
		execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-maestro-p.mjs')], {
			stdio: 'ignore',
		});
		// node-pty in this checkout is built for Electron's ABI, so run the
		// bundle the way the packaged app does: Electron in Node mode.
		const electron = createRequire(import.meta.url)('electron');
		return {
			argv: [electron, path.join(repoRoot, 'dist', 'cli', 'maestro-p.js')],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		};
	}
	const bin =
		opts.bin || which('maestro-p') || path.join(os.homedir(), '.local', 'bin', 'maestro-p');
	try {
		fs.accessSync(bin, fs.constants.X_OK);
	} catch {
		fail(`maestro-p not found at ${bin} (pass --bin or --local)`);
	}
	return { argv: [bin], env: {} };
}

function which(name) {
	const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.trim() : null;
}

// ── trust preflight ──────────────────────────────────────────────────────

// claude records folder trust in the account's .claude.json and inherits it
// from any parent folder. Returns true/false, or null when it cannot tell.
function isTrusted(configDir, dir) {
	const candidates = [path.join(configDir, '.claude.json')];
	if (path.resolve(configDir) === path.join(os.homedir(), '.claude')) {
		candidates.unshift(path.join(os.homedir(), '.claude.json'));
	}
	for (const file of candidates) {
		let projects;
		try {
			projects = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
		} catch {
			continue;
		}
		if (!projects || typeof projects !== 'object') continue;
		for (let d = path.resolve(dir); ; d = path.dirname(d)) {
			if (projects[d]?.hasTrustDialogAccepted === true) return true;
			if (path.dirname(d) === d) break;
		}
		return false;
	}
	return null;
}

// ── suite plumbing ───────────────────────────────────────────────────────

class Suite {
	constructor(opts, cmd) {
		this.opts = opts;
		this.cmd = cmd;
		this.env = { ...process.env, ...cmd.env, CLAUDE_CONFIG_DIR: opts.configDir };
		if (opts.claudeBin) this.env.MAESTRO_CLAUDE_BIN = opts.claudeBin;
		this.model = ['--model', opts.model];
		this.dirs = [];
		this.verdicts = [];
		this.logDir = path.join(
			opts.root,
			'logs',
			new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
		);
	}

	mkdir(name, { trusted = true } = {}) {
		const parent = trusted ? this.opts.root : os.tmpdir();
		fs.mkdirSync(parent, { recursive: true });
		// realpath: macOS's $TMPDIR is a /var -> /private/var symlink, and
		// claude keys its project folder on the resolved path.
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, `mp-${name}-`)));
		this.dirs.push(dir);
		return dir;
	}

	/**
	 * One maestro-p run. Resolves with the parsed envelope rows and the result
	 * row; never rejects.
	 */
	run(name, { prompt, extra = [], stdin, cwd, timeoutMs = 330_000, model = true, env } = {}) {
		cwd = cwd || this.mkdir(name);
		const args = [...this.cmd.argv.slice(1), ...BASE, ...(model ? this.model : []), ...extra];
		if (prompt !== undefined) args.push('--', prompt);
		const t0 = Date.now();
		return new Promise((resolve) => {
			const child = spawn(this.cmd.argv[0], args, {
				cwd,
				env: { ...this.env, ...env },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			child.stdout.on('data', (d) => (stdout += d));
			child.stderr.on('data', (d) => (stderr += d));
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, timeoutMs);
			child.stdin.on('error', () => {});
			child.stdin.end(stdin ?? '');
			child.on('close', (code) => {
				clearTimeout(timer);
				const rows = [];
				for (const line of stdout.split('\n')) {
					try {
						rows.push(JSON.parse(line));
					} catch {
						// stream-json is one object per line; skip anything else
					}
				}
				const res = [...rows].reverse().find((r) => r?.type === 'result') || {};
				resolve({
					name,
					rc: timedOut ? null : code,
					secs: Math.round((Date.now() - t0) / 100) / 10,
					rows,
					res,
					text: res.result || '',
					sid: res.session_id || null,
					error: res.error ?? null,
					stdout,
					stderr: timedOut ? `${stderr}\nharness timeout` : stderr,
					cwd,
				});
			});
		});
	}

	/** First user message as claude recorded it in the session transcript. */
	transcriptUserText(r) {
		if (!r.sid) return '';
		const projects = path.join(this.opts.configDir, 'projects');
		let dirs = [];
		try {
			dirs = fs.readdirSync(projects);
		} catch {
			return '';
		}
		for (const d of dirs) {
			const file = path.join(projects, d, `${r.sid}.jsonl`);
			if (!fs.existsSync(file)) continue;
			for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
				let row;
				try {
					row = JSON.parse(line);
				} catch {
					continue;
				}
				if (row?.type !== 'user' || row.isMeta) continue;
				let c = row.message?.content;
				if (Array.isArray(c)) c = c.map((x) => x?.text || '').join('');
				if (typeof c === 'string') return c;
			}
		}
		return '';
	}

	verdict(id, title, ok, why, runs = []) {
		const v = { case: id, title, ok: Boolean(ok), why, known: KNOWN[id] ?? null };
		const first = runs.find(Boolean);
		if (first) {
			v.rc = first.rc;
			v.secs = first.secs;
		}
		// A failure keeps its raw output: the test folders are deleted on exit,
		// and a flake under load is undiagnosable without the result row.
		if (!ok) {
			for (const r of runs.filter(Boolean)) {
				v.why += ` | ${r.name} rc=${r.rc} error=${JSON.stringify(r.error)}`;
				fs.mkdirSync(this.logDir, { recursive: true });
				fs.writeFileSync(path.join(this.logDir, `${r.name}.stdout`), r.stdout);
				fs.writeFileSync(path.join(this.logDir, `${r.name}.stderr`), r.stderr);
				v.log = this.logDir;
			}
		}
		this.verdicts.push(v);
	}

	cleanup() {
		for (const d of this.dirs) {
			fs.rmSync(d, { recursive: true, force: true });
			// Same slug claude uses for its project folder (see cwdSlug in
			// src/maestro-p/session-watcher.ts).
			const slug = d.replace(/[/\\]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
			fs.rmSync(path.join(this.opts.configDir, 'projects', slug), {
				recursive: true,
				force: true,
			});
		}
		try {
			fs.rmdirSync(this.opts.root);
		} catch {
			// still holds logs from a failing run, or other files
		}
	}
}

function toolsSeen(r) {
	const uses = [];
	const results = [];
	for (const row of r.rows) {
		for (const c of row?.message?.content || []) {
			if (c?.type === 'tool_use') uses.push(c.name);
			if (c?.type === 'tool_result') results.push(JSON.stringify(c.content));
		}
	}
	return { uses, results };
}

const clip = (s, n = 40) => JSON.stringify(String(s ?? '').slice(0, n));

/** Run thunks with at most `limit` in flight. */
async function pool(thunks, limit) {
	const out = new Array(thunks.length);
	let next = 0;
	const worker = async () => {
		while (next < thunks.length) {
			const i = next++;
			out[i] = await thunks[i]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
	return out;
}

function pgrep(args) {
	const r = spawnSync('pgrep', args, { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
}

// ── cases ────────────────────────────────────────────────────────────────

/** Independent single-turn cases, run in parallel. */
async function parallelCases(s, want) {
	const jobs = {
		T01: { prompt: 'Reply with exactly this token and nothing else: PONG-7731' },
		T02: {
			prompt: 'Use the Bash tool to run: echo tuitest-$((6*7))  Then reply with only its output.',
		},
		T04: {
			prompt: `Repeat the text between <x> and </x> verbatim inside a fenced code block, nothing else.\n<x>${HOSTILE}</x>`,
		},
		T05: {
			prompt: '/clear is not a command here. Reply with exactly: SLASH-OK',
			extra: ['--max-wait', '60'],
		},
		T06: {
			prompt:
				'filler '.repeat(5000) + '\nThe secret word is ZEBRA-9. Reply with the secret word only.',
		},
		T07: { stdin: 'Reply with exactly: STDIN-OK', extra: ['-p'] },
		T08: {
			prompt: 'Use the Bash tool to run: sleep 45 && echo done. Then reply done.',
			extra: ['--max-wait', '15'],
		},
		T09: {
			prompt: 'hi',
			extra: ['--model', 'no-such-model-xyz', '--max-wait', '60'],
			model: false,
		},
		T10: {
			extra: ['--input-format', 'stream-json'],
			stdin:
				JSON.stringify({
					type: 'user',
					message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: SJ-OK' }] },
				}) + '\n',
		},
		T15: { prompt: `Reply OK. ${TABBED}` },
		T16: { prompt: 'Reply with exactly: TRUST-OK', extra: ['--max-wait', '60'], untrusted: true },
		T17: {
			prompt: 'Reply with exactly: TRUST-OPTIN-OK',
			extra: ['--max-wait', '60'],
			untrusted: true,
			env: { MAESTRO_P_ACCEPT_WORKSPACE_TRUST: '1' },
		},
		T19: { prompt: 'Reply with exactly: READY-OK', extra: ['--ready-timeout', '1'] },
		T21: { prompt: 'Reply with exactly: PROMPT-FLAG-OK', viaPromptFlag: true },
	};
	// T03, T14 and T18 resume T01's session.
	const needT01 = ['T03', 'T14', 'T18'].some(want);
	const ids = Object.keys(jobs).filter((k) => want(k) || (k === 'T01' && needT01));
	const results = await pool(
		ids.map((id) => () => {
			const { untrusted, viaPromptFlag, ...kw } = jobs[id];
			if (untrusted) kw.cwd = s.mkdir(id, { trusted: false });
			if (viaPromptFlag) {
				kw.extra = ['--prompt', kw.prompt];
				delete kw.prompt;
			}
			return s.run(id, kw);
		}),
		s.opts.jobs
	);
	return Object.fromEntries(ids.map((id, i) => [id, results[i]]));
}

function judge(s, R, want) {
	if (R.T01 && want('T01')) {
		const r = R.T01;
		const types = r.rows.map((x) => x?.type);
		const init = r.rows.find((x) => x?.type === 'system');
		const missing = ['subtype', 'is_error', 'duration_ms', 'result', 'session_id', 'usage'].filter(
			(k) => !(k in r.res)
		);
		const ok =
			r.rc === EXIT.ok &&
			types[0] === 'system' &&
			init?.subtype === 'init' &&
			types.at(-1) === 'result' &&
			r.res.is_error === false &&
			r.res.subtype === 'success' &&
			missing.length === 0 &&
			r.sid &&
			init?.session_id === r.sid &&
			r.text.includes('PONG-7731');
		s.verdict(
			'T01',
			'basic run, envelope shape matches claude -p',
			ok,
			`types=${[...new Set(types)].sort()} missing=${missing} text=${clip(r.text)}`,
			[r]
		);
	}
	if (R.T02) {
		const r = R.T02;
		const { uses, results } = toolsSeen(r);
		s.verdict(
			'T02',
			'tool_use / tool_result envelopes',
			uses.includes('Bash') &&
				results.some((x) => x.includes('tuitest-42')) &&
				r.text.includes('tuitest-42'),
			`tools=${uses} text=${clip(r.text)}`,
			[r]
		);
	}
	if (R.T04) {
		const r = R.T04;
		s.verdict(
			'T04',
			'newlines, quotes, $VARS, emoji, unicode survive typing',
			r.text.includes(HOSTILE),
			`text=${clip(r.text, 120)}`,
			[r]
		);
	}
	if (R.T05) {
		const r = R.T05;
		s.verdict(
			'T05',
			'leading-slash prompt completes (no hang)',
			r.rc === EXIT.ok && r.error !== 'timeout',
			`error=${r.error} text=${clip(r.text)}`,
			[r]
		);
	}
	if (R.T06) {
		const r = R.T06;
		s.verdict(
			'T06',
			'35KB prompt delivered intact',
			r.text.includes('ZEBRA-9'),
			`text=${clip(r.text)}`,
			[r]
		);
	}
	if (R.T07) {
		const r = R.T07;
		s.verdict(
			'T07',
			'prompt via stdin',
			r.rc === EXIT.ok && r.text.includes('STDIN-OK'),
			`text=${clip(r.text)}`,
			[r]
		);
	}
	if (R.T08) {
		const r = R.T08;
		s.verdict(
			'T08',
			'--max-wait 15 aborts a 45s turn with exit 3',
			r.rc === EXIT.timeout && r.error === 'timeout' && r.secs < 40,
			`error=${r.error}`,
			[r]
		);
	}
	if (R.T09) {
		const r = R.T09;
		s.verdict(
			'T09',
			"bad model fails fast (<30s) with exit 8 and claude's message",
			r.rc === EXIT.apiError &&
				r.secs < 30 &&
				r.res.is_error === true &&
				/model/i.test(r.error || ''),
			`error=${clip(r.error, 80)}`,
			[r]
		);
	}
	if (R.T10) {
		const r = R.T10;
		s.verdict(
			'T10',
			'--input-format stream-json',
			r.rc === EXIT.ok && r.text.includes('SJ-OK'),
			`text=${clip(r.text)}`,
			[r]
		);
	}
	if (R.T15) {
		// claude's TUI cannot hold a literal tab, so maestro-p types each one as
		// four spaces and says so on stderr (#1755).
		const r = R.T15;
		const got = s.transcriptUserText(r);
		const expected = TABBED.replaceAll('\t', TAB_SPACES);
		s.verdict(
			'T15',
			'tabs arrive as 4 spaces, with a stderr warning',
			r.rc === EXIT.ok &&
				got.includes(expected) &&
				!got.includes('\t') &&
				/tab characters/.test(r.stderr),
			`recorded=${clip(got.slice(-40))} warned=${/tab characters/.test(r.stderr)}`,
			[r]
		);
	}
	if (R.T16) {
		// $TMPDIR is never trusted, and claude's dialog defaults to "No, exit"
		// there. Without the opt-in maestro-p must name that, quickly (#1756).
		const r = R.T16;
		const named =
			r.rc === EXIT.workspaceUntrusted && r.error === 'workspace_untrusted' && r.secs < 45;
		s.verdict(
			'T16',
			'untrusted cwd without opt-in: exit 7 workspace_untrusted',
			(r.rc === EXIT.ok && r.text.includes('TRUST-OK')) || named,
			`error=${r.error} secs=${r.secs}`,
			[r]
		);
	}
	if (R.T17) {
		const r = R.T17;
		s.verdict(
			'T17',
			'untrusted cwd with MAESTRO_P_ACCEPT_WORKSPACE_TRUST=1 runs',
			r.rc === EXIT.ok && r.text.includes('TRUST-OPTIN-OK'),
			`error=${r.error} text=${clip(r.text)}`,
			[r]
		);
	}
	if (R.T19) {
		// A ceiling below a cold boot must fail as ready_timeout with the
		// screen on stderr, never hang or report a generic exit (#1765).
		const r = R.T19;
		const timedOut =
			r.rc === EXIT.readyTimeout && r.error === 'ready_timeout' && /screen|tail/i.test(r.stderr);
		s.verdict(
			'T19',
			'--ready-timeout 1: ready_timeout (exit 4) with a screen dump, or a pass',
			timedOut || (r.rc === EXIT.ok && r.text.includes('READY-OK')),
			`error=${r.error} secs=${r.secs} stderr=${clip(r.stderr.trim().split('\n')[0], 80)}`,
			[r]
		);
	}
	if (R.T21) {
		const r = R.T21;
		s.verdict(
			'T21',
			'prompt via --prompt flag',
			r.rc === EXIT.ok && r.text.includes('PROMPT-FLAG-OK'),
			`text=${clip(r.text)}`,
			[r]
		);
	}
}

/** Cases that resume a session, share a folder, or watch processes. */
async function serialCases(s, R, want) {
	const base = R.T01;
	const needsBase = (id, title) => {
		if (base?.sid) return true;
		s.verdict(id, title, false, 'skipped: T01 produced no session id');
		return false;
	};

	if (want('T03') && needsBase('T03', '--resume keeps context and session id')) {
		const r = await s.run('T03', {
			prompt: 'What exact token did I ask you to reply with earlier? Reply with the token only.',
			extra: ['--resume', base.sid],
			cwd: base.cwd,
		});
		s.verdict(
			'T03',
			'--resume keeps context and session id',
			r.text.includes('PONG-7731') && r.sid === base.sid,
			`same_sid=${r.sid === base.sid} text=${clip(r.text)}`,
			[r]
		);
	}

	if (want('T11')) {
		const shared = s.mkdir('T11');
		const cr = await Promise.all(
			[1, 2, 3].map((i) =>
				s.run(`T11.${i}`, { prompt: `Reply with exactly: CONC-${i}-${i * 111}`, cwd: shared })
			)
		);
		const sids = new Set(cr.map((c) => c.sid));
		const ok =
			cr.every((c, i) => c.text.includes(`CONC-${i + 1}-${(i + 1) * 111}`)) && sids.size === 3;
		s.verdict(
			'T11',
			'3 concurrent runs in one cwd, no cross-wiring',
			ok,
			`texts=${JSON.stringify(cr.map((c) => c.text.slice(0, 12)))} distinct_sids=${sids.size}`,
			cr
		);
	}

	if (want('T12')) await caseT12(s);

	if (want('T13')) {
		const st = spawnSync(s.cmd.argv[0], [...s.cmd.argv.slice(1), '--status'], {
			env: s.env,
			encoding: 'utf8',
			timeout: 60_000,
		});
		let obj = null;
		try {
			obj = JSON.parse(st.stdout.trim().split('\n').at(-1));
		} catch {
			// reported below
		}
		s.verdict(
			'T13',
			'--status returns a parsed usage object',
			st.status === 0 && obj && typeof obj === 'object',
			`rc=${st.status} keys=${obj ? Object.keys(obj).sort().slice(0, 6) : null}`
		);
	}

	if (want('T14') && needsBase('T14', '/compact on a resumed session completes')) {
		const r = await s.run('T14', {
			prompt: '/compact',
			extra: ['--resume', base.sid, '--max-wait', '120'],
			cwd: base.cwd,
		});
		s.verdict(
			'T14',
			'/compact on a resumed session completes',
			r.rc === EXIT.ok && r.error !== 'timeout' && r.res.is_error === false,
			`error=${r.error} secs=${r.secs} text=${clip(r.text)}`,
			[r]
		);
	}

	if (want('T18') && needsBase('T18', '/clear on a resumed session completes')) {
		// /clear is a local command: no end_turn row, only its output row (#1754).
		const r = await s.run('T18', {
			prompt: '/clear',
			extra: ['--resume', base.sid, '--max-wait', '60'],
			cwd: base.cwd,
		});
		s.verdict(
			'T18',
			'/clear on a resumed session completes',
			r.rc === EXIT.ok && r.error !== 'timeout' && r.secs < 45,
			`error=${r.error} secs=${r.secs} rotated_sid=${r.sid !== base.sid}`,
			[r]
		);
	}

	if (want('T20')) {
		const cwd = s.mkdir('T20');
		const first = await s.run('T20.1', {
			prompt: 'Remember the word OTTER-55. Reply with only: NOTED',
			cwd,
		});
		const r = await s.run('T20.2', {
			prompt: 'What word did I ask you to remember? Reply with the word only.',
			extra: ['--continue'],
			cwd,
		});
		s.verdict(
			'T20',
			'--continue picks up the latest session in the folder',
			first.rc === EXIT.ok && r.rc === EXIT.ok && r.text.includes('OTTER-55'),
			`same_sid=${r.sid === first.sid} text=${clip(r.text)}`,
			[first, r]
		);
	}

	if (want('T22')) await caseT22(s);
	if (want('T23')) await caseT23(s);
}

/** SIGTERM mid-turn must take claude and the tool it is running down too. */
async function caseT12(s) {
	const title = 'SIGTERM mid-turn reaps claude and tool children';
	if (process.platform === 'win32') {
		s.verdict('T12', title, true, 'skipped on Windows (no process groups)');
		return;
	}
	const marker = 'sleep 97';
	const cwd = s.mkdir('T12');
	const child = spawn(
		s.cmd.argv[0],
		[
			...s.cmd.argv.slice(1),
			...BASE,
			...s.model,
			'--',
			`Use the Bash tool to run: ${marker}. Then reply done.`,
		],
		{ cwd, env: s.env, stdio: 'ignore', detached: true }
	);
	let exitCode = null;
	const exited = new Promise((resolve) =>
		child.on('exit', (code, signal) => {
			exitCode = code ?? signal;
			resolve(true);
		})
	);
	// Kill only once the tool is really running, or the case proves nothing.
	let started = false;
	for (let i = 0; i < 60 && exitCode === null; i++) {
		if (pgrep(['-fx', marker]).length) {
			started = true;
			break;
		}
		await sleep(1000);
	}
	child.kill('SIGTERM');
	const didExit = await Promise.race([exited, sleep(20_000).then(() => false)]);
	await sleep(3000);
	const kids = pgrep(['-g', String(child.pid)]);
	const orphans = pgrep(['-fx', marker]);
	for (const pid of [...kids, ...orphans]) {
		try {
			process.kill(Number(pid), 'SIGKILL');
		} catch {
			// already gone
		}
	}
	s.verdict(
		'T12',
		title,
		started && didExit && kids.length === 0 && orphans.length === 0,
		`tool_started=${started} exited=${didExit} rc=${exitCode} survivors=${[...kids, ...orphans]}`
	);
}

/**
 * #1770: `maestro-cli send` to a maestro-p agent, with the CLI under a plain
 * system `node`. Needs a packaged app's maestro-cli.js and an agent in TUI
 * token mode, so it only runs when both are given.
 */
async function caseT22(s) {
	const title = 'maestro-cli send under system node reaches a maestro-p agent';
	if (!s.opts.cli || !s.opts.cliAgent) {
		s.verdict('T22', title, true, 'skipped: pass --cli <maestro-cli.js> and --cli-agent <id>');
		return;
	}
	const t0 = Date.now();
	const r = spawnSync(
		'node',
		// `send` always prints JSON; a crash shows up as `outcome: "crashed"`.
		[s.opts.cli, 'send', s.opts.cliAgent, 'Reply with exactly: CLI-SEND-OK'],
		{ env: s.env, encoding: 'utf8', timeout: 330_000 }
	);
	let obj = null;
	try {
		obj = JSON.parse(r.stdout);
	} catch {
		// reported below
	}
	const text = JSON.stringify(obj ?? r.stdout);
	s.verdict(
		'T22',
		title,
		r.status === 0 && text.includes('CLI-SEND-OK') && !/node-pty|posix_spawn/.test(text + r.stderr),
		`rc=${r.status} secs=${Math.round((Date.now() - t0) / 1000)} out=${clip(text, 120)}`
	);
}

/**
 * Plain `claude -p` on the plan login, with every credential that would
 * outrank it removed. Passing proves `-p` still reads the plan login
 * (`apiKeySource: none`) and runs against the plan's own windows (the
 * `rate_limit_event` row). Anthropic has said `--bare` will become the default
 * for `-p`; on that release this case fails, and so does every Maestro agent
 * on the `claude -p` token source that has no API key set.
 */
async function caseT23(s) {
	const title = 'claude -p still runs on the plan login (no --bare default yet)';
	const claudeBin = s.opts.claudeBin || process.env.MAESTRO_CLAUDE_BIN || which('claude');
	if (!claudeBin) {
		s.verdict('T23', title, false, 'claude not found on PATH (pass --claude-bin)');
		return;
	}
	const env = { ...s.env };
	for (const key of [
		'ANTHROPIC_API_KEY',
		'ANTHROPIC_AUTH_TOKEN',
		'ANTHROPIC_BASE_URL',
		'CLAUDE_CODE_USE_BEDROCK',
		'CLAUDE_CODE_USE_VERTEX',
		'CLAUDE_CODE_USE_FOUNDRY',
		'CLAUDE_CODE_SIMPLE',
	]) {
		delete env[key];
	}
	const t0 = Date.now();
	const r = spawnSync(
		claudeBin,
		[
			'-p',
			'--verbose',
			'--output-format',
			'stream-json',
			'--model',
			s.opts.model,
			'Reply with exactly: PLAN-P-OK',
		],
		{ cwd: s.mkdir('T23'), env, input: '', encoding: 'utf8', timeout: 180_000 }
	);
	const rows = [];
	for (const line of (r.stdout || '').split('\n')) {
		try {
			rows.push(JSON.parse(line));
		} catch {
			// one object per line; skip anything else
		}
	}
	const init = rows.find((x) => x?.type === 'system' && x.subtype === 'init');
	const limit = rows.find((x) => x?.type === 'rate_limit_event')?.rate_limit_info;
	const res = [...rows].reverse().find((x) => x?.type === 'result') || {};
	const windows = limit?.unifiedWindows
		? Object.entries(limit.unifiedWindows)
				.map(([name, w]) => `${name}=${Math.round((w?.utilization ?? 0) * 100)}%`)
				.join(',')
		: 'none';
	const ok =
		r.status === 0 &&
		init?.apiKeySource === 'none' &&
		res.is_error === false &&
		String(res.result || '').includes('PLAN-P-OK');
	s.verdict(
		'T23',
		title,
		ok,
		`apiKeySource=${init?.apiKeySource ?? 'missing'} plan_windows=${windows} ` +
			`secs=${Math.round((Date.now() - t0) / 1000)} result=${clip(res.result ?? res.error)}` +
			(ok
				? ''
				: ' | if this reads "Failed to authenticate", --bare is now the -p default: ' +
					'plan-only agents on the claude -p token source need the TUI Wrapper or an API key')
	);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const cmd = resolveCommand(opts);
	const want = opts.only ? (c) => opts.only.has(c) : () => true;

	const trusted = isTrusted(opts.configDir, opts.root);
	if (trusted === false) {
		fail(
			`${opts.root} is not inside a folder claude trusts for ${opts.configDir}. ` +
				'Open claude once in it (or a parent) and accept the trust prompt, or pass --root.'
		);
	}

	const s = new Suite(opts, cmd);
	const t0 = Date.now();
	try {
		const R = await parallelCases(s, want);
		judge(s, R, want);
		await serialCases(s, R, want);
	} finally {
		if (!opts.keep) s.cleanup();
	}

	const v = s.verdicts.sort((a, b) => a.case.localeCompare(b.case, 'en', { numeric: true }));
	const unexpected = v.filter((x) => !x.ok && !x.known);
	const known = v.filter((x) => !x.ok && x.known);
	const fixed = v.filter((x) => x.ok && x.known);
	const wall = Math.round((Date.now() - t0) / 1000);
	if (opts.json) {
		process.stdout.write(JSON.stringify({ verdicts: v, wallSecs: wall }, null, 2) + '\n');
	} else {
		if (trusted === null)
			process.stdout.write(`note: could not read trust state for ${opts.root}\n`);
		for (const x of v) {
			const tag = x.ok ? 'PASS' : x.known ? 'KNOWN' : 'FAIL';
			const ref = x.known ? ` #${x.known}` : '';
			const secs = x.secs !== undefined ? ` ${x.secs}s` : '';
			process.stdout.write(
				`${tag.padEnd(5)} ${x.case}${ref.padEnd(7)} ${x.title}${secs} :: ${x.why}\n`
			);
		}
		process.stdout.write(
			`\n${v.filter((x) => x.ok).length}/${v.length} pass, ${known.length} known-issue, ` +
				`${unexpected.length} unexpected, ${wall}s wall\n`
		);
		if (v.some((x) => x.log)) process.stdout.write(`raw output of failing runs: ${s.logDir}\n`);
		for (const x of fixed) {
			process.stdout.write(
				`NOTE  ${x.case} now passes: upstream #${x.known} may be fixed, update KNOWN.\n`
			);
		}
	}
	return unexpected.length ? 1 : known.length ? 2 : 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(`maestro-p-suite: ${err?.stack || err}\n`);
		process.exit(1);
	}
);
