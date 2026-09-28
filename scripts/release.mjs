#!/usr/bin/env node
/**
 * Mechanical steps of a Maestro release, one subcommand per step.
 *
 * The judgment work (release notes, deciding what is rc-only, announcement copy)
 * belongs to the agents in the release group chat. Everything that can be
 * checked by a machine lives here, so an agent makes one call and reads a
 * pass/fail instead of rediscovering the process. The process itself is
 * docs/agent-guides/RELEASE-RUNBOOK.md.
 *
 * Usage:
 *   node scripts/release.mjs preflight --scope main|rc|all [--json]
 *   node scripts/release.mjs kickoff   --scope main|rc|all [--dry-run]
 *                                              [--main-agent <id>] [--rc-agent <id>] [--site-agent <id>]
 *   node scripts/release.mjs draft     --tag <tag> [--show] [--create] [--title <t>] [--notes-file <f>]
 *   node scripts/release.mjs tag       --branch main|rc [--sha <sha>] [--wait-min <n>]
 *   node scripts/release.mjs watch     --tag <tag> [--max-min <n>]
 *   node scripts/release.mjs verify    --tag <tag> [--repair]
 *   node scripts/release.mjs bump      --branch main|rc [--dry-run]
 *
 * Exit codes:
 *   0  done / everything checks out
 *   1  a check failed (the output names it and links the run)
 *   2  misuse or a precondition was not met (nothing was changed)
 *   3  still in progress (checks or builds running); run the same command again
 *
 * Why it is written this way
 * -------------------------
 * - Agent turns end at 30 minutes. Waiting on CI inside a turn is what cut two
 *   agents off mid-release on 2026-09-25, so nothing here waits longer than the
 *   caller asks (`--wait-min`, `--max-min`, default well under the limit), and
 *   "still running" is its own exit code rather than a failure.
 * - Pushing a tag IS publishing: .github/workflows/release.yml builds and
 *   publishes on the tag push. So `tag` refuses unless the curated draft exists
 *   and every check on the commit passed.
 * - Tags and version bumps are pushed with --no-verify. The pre-push hook's only
 *   job for them is the full test suite, which already ran on the commit (tag)
 *   or cannot be affected by a version string (bump); its main-branch guards are
 *   re-checked here instead. CI still runs on the bump commit.
 * - The bump is built with git plumbing (temporary index, commit-tree), so it
 *   never touches a working tree. The shared checkout usually has other agents'
 *   uncommitted work in it and must stay on main.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.MAESTRO_RELEASE_REPO || 'RunMaestro/Maestro';
const DEFAULT_CLI = '/Applications/Maestro.app/Contents/Resources/maestro-cli.js';
const CLI = process.env.MAESTRO_CLI || DEFAULT_CLI;
const RUNBOOK = path.join(ROOT, 'docs', 'agent-guides', 'RELEASE-RUNBOOK.md');
const BAD_CONCLUSIONS = new Set([
	'failure',
	'timed_out',
	'cancelled',
	'action_required',
	'startup_failure',
	'stale',
]);

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

class Exit extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

const fail = (message) => {
	throw new Exit(1, message);
};
const misuse = (message) => {
	throw new Exit(2, message);
};
const pending = (message) => {
	throw new Exit(3, message);
};

function run(cmd, args, { input, env } = {}) {
	try {
		return execFileSync(cmd, args, {
			cwd: ROOT,
			encoding: 'utf-8',
			input,
			env: env ? { ...process.env, ...env } : process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			maxBuffer: 64 * 1024 * 1024,
		}).trim();
	} catch (error) {
		const detail = (error.stderr || error.stdout || error.message || '').toString().trim();
		throw new Error(`${cmd} ${args.join(' ')} failed: ${detail}`);
	}
}

const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);
const ghJson = (...args) => JSON.parse(gh(...args) || 'null');
/** `gh api --paginate --jq '.[]'` style output: one JSON value per line. */
const ghLines = (...args) =>
	gh(...args)
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** YYYY-MM-DD in the conductor's timezone, not UTC. */
const localDate = () => new Date().toLocaleDateString('en-CA');

function parseArgs(argv) {
	const opts = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			opts._.push(arg);
			continue;
		}
		const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) opts[key] = true;
		else {
			opts[key] = next;
			i++;
		}
	}
	return opts;
}

function needBranch(opts) {
	if (opts.branch !== 'main' && opts.branch !== 'rc') misuse('--branch must be main or rc');
	return opts.branch;
}

function needTag(opts) {
	if (typeof opts.tag !== 'string' || !/^v\d+\.\d+\.\d+(-RC)?$/.test(opts.tag)) {
		misuse('--tag must look like v0.17.5 or v0.18.6-RC');
	}
	return opts.tag;
}

function scopeBranches(opts) {
	const scope = opts.scope;
	if (scope === 'all') return ['main', 'rc'];
	if (scope === 'main' || scope === 'rc') return [scope];
	misuse('--scope must be main, rc, or all');
}

const isRcTag = (tag) => /-rc$/i.test(tag);
const versionOf = (tag) => tag.replace(/^v/, '');
const releaseUrl = (tag) => `https://github.com/${REPO}/releases/tag/${tag}`;

// ---------------------------------------------------------------------------
// Git and GitHub facts
// ---------------------------------------------------------------------------

function fetchOrigin() {
	git('fetch', '--quiet', 'origin', 'main', 'rc');
}

function packageVersionAt(ref) {
	return JSON.parse(git('show', `${ref}:package.json`)).version;
}

function remoteTagCommit(tag) {
	const out = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
	if (!out) return null;
	const lines = out.split('\n').map((l) => l.split('\t'));
	const peeled = lines.find(([, ref]) => ref.endsWith('^{}'));
	return (peeled ?? lines[0])[0];
}

function listReleases() {
	return ghLines('api', '--paginate', `repos/${REPO}/releases?per_page=100`, '--jq', '.[]');
}

function releasesForTag(tag, all = listReleases()) {
	const forTag = all.filter((r) => r.tag_name === tag);
	return {
		published: forTag.filter((r) => !r.draft),
		drafts: forTag.filter((r) => r.draft),
	};
}

function previousReleases(channel, count, all = listReleases()) {
	return all
		.filter((r) => !r.draft && (channel === 'rc') === isRcTag(r.tag_name))
		.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
		.slice(0, count);
}

/** Check runs on a commit, latest attempt per check. */
function checkRuns(sha) {
	return ghLines(
		'api',
		'--paginate',
		`repos/${REPO}/commits/${sha}/check-runs?per_page=100&filter=latest`,
		'--jq',
		'.check_runs[] | {name, status, conclusion, url: .html_url}'
	);
}

/**
 * Checks that vouch for a commit. A commit pushed by the docs bot (the
 * release workflow's own docs/releases.md sync) triggers no workflows, so it
 * has no checks of its own; walk back to the nearest ancestor that does, and
 * accept it only if everything since then is docs.
 */
function checksVouchingFor(sha) {
	let candidate = sha;
	for (let depth = 0; depth < 10; depth++) {
		const runs = checkRuns(candidate);
		if (runs.length > 0) {
			if (candidate !== sha) {
				const changed = git('diff', '--name-only', candidate, sha).split('\n').filter(Boolean);
				const nonDocs = changed.filter((f) => !f.startsWith('docs/'));
				if (nonDocs.length > 0) {
					fail(
						`${sha.slice(0, 9)} has no checks, and the nearest checked ancestor ` +
							`${candidate.slice(0, 9)} differs in non-docs files: ${nonDocs.join(', ')}`
					);
				}
			}
			return { commit: candidate, runs };
		}
		candidate = git('rev-parse', `${candidate}^`);
	}
	fail(`No checks found on ${sha.slice(0, 9)} or its last 10 ancestors`);
}

function summarizeChecks(runs) {
	const failed = runs.filter((r) => r.status === 'completed' && BAD_CONCLUSIONS.has(r.conclusion));
	const running = runs.filter((r) => r.status !== 'completed');
	return { failed, running, total: runs.length };
}

/** The 16 files every release carries (4 platforms, plus the 4 updater manifests). */
function expectedAssets(version) {
	return [
		`maestro-${version}-arm64-mac.dmg`,
		`maestro-${version}-arm64-mac.zip`,
		`maestro-${version}-x64-mac.dmg`,
		`maestro-${version}-x64-mac.zip`,
		'latest-mac.yml',
		`Maestro-Setup-${version}-x64.exe`,
		`Maestro-Portable-${version}-x64.exe`,
		'latest.yml',
		`maestro-${version}-x86_64.AppImage`,
		`maestro-${version}-amd64.deb`,
		`maestro-${version}-x86_64.rpm`,
		'latest-linux.yml',
		`maestro-${version}-arm64.AppImage`,
		`maestro-${version}-arm64.deb`,
		`maestro-${version}-aarch64.rpm`,
		'latest-linux-arm64.yml',
	];
}

function releaseRuns(tag) {
	return ghJson(
		'run',
		'list',
		'-R',
		REPO,
		'--workflow',
		'release.yml',
		'-L',
		'30',
		'--json',
		'databaseId,headBranch,status,conclusion,createdAt,url,event'
	)
		.filter((r) => r.headBranch === tag)
		.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function worktreeFor(branch) {
	const blocks = git('worktree', 'list', '--porcelain').split('\n\n');
	for (const block of blocks) {
		const dir = block.match(/^worktree (.+)$/m)?.[1];
		if (block.includes(`\nbranch refs/heads/${branch}`)) return dir;
	}
	return null;
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

function preflightBranch(branch, releases) {
	const ref = `origin/${branch}`;
	const sha = git('rev-parse', ref);
	const version = packageVersionAt(ref);
	const tag = `v${version}`;
	const { published, drafts } = releasesForTag(tag, releases);
	const problems = [];

	if ((branch === 'rc') !== isRcTag(tag)) {
		problems.push(`${branch} carries version ${version}, which is on the wrong channel`);
	}
	const tagCommit = remoteTagCommit(tag);
	if (published.length > 0 || tagCommit) {
		problems.push(`${tag} is already tagged or released; bump ${branch} first`);
	}
	if (drafts.length === 0) problems.push(`no draft release for ${tag}; write the notes first`);
	if (drafts.length > 1) {
		problems.push(
			`${drafts.length} drafts carry ${tag} (ids ${drafts.map((d) => d.id).join(', ')})`
		);
	}

	let checks;
	try {
		const vouch = checksVouchingFor(sha);
		checks = { ...summarizeChecks(vouch.runs), commit: vouch.commit };
		if (checks.failed.length > 0) {
			problems.push(`failing checks: ${checks.failed.map((c) => c.name).join(', ')}`);
		}
	} catch (error) {
		problems.push(error.message);
	}

	let mainMissing;
	if (branch === 'rc') {
		mainMissing = mainCommitsMissingFrom(sha);
		if (mainMissing.length > 0) {
			problems.push(`${mainMissing.length} origin/main commit(s) are not in rc; merge main first`);
		}
	}

	const previous = previousReleases(branch, 2, releases).map((r) => r.tag_name);
	return {
		branch,
		sha,
		version,
		tag,
		draft: drafts[0]
			? {
					id: drafts[0].id,
					name: drafts[0].name,
					url: drafts[0].html_url,
					bodyChars: (drafts[0].body || '').length,
				}
			: null,
		previous,
		checks: checks
			? {
					total: checks.total,
					failed: checks.failed.map((c) => `${c.name} ${c.url}`),
					running: checks.running.map((c) => c.name),
					commit: checks.commit,
				}
			: null,
		mainMissing: mainMissing?.length,
		problems,
	};
}

/** Commits on origin/main that `sha` lacks, ignoring the docs bot's releases.md syncs. */
function mainCommitsMissingFrom(sha) {
	const commits = git('log', '--format=%H', `${sha}..origin/main`).split('\n').filter(Boolean);
	return commits.filter((c) => {
		const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', c).split('\n');
		return files.some((f) => f && f !== 'docs/releases.md');
	});
}

function preflight(opts, { quiet = false } = {}) {
	const branches = scopeBranches(opts);
	fetchOrigin();
	const releases = listReleases();
	const results = branches.map((b) => preflightBranch(b, releases));
	if (opts.json) console.log(JSON.stringify(results, null, 2));
	else if (!quiet) console.log(formatPreflight(results));
	return results;
}

function formatPreflight(results) {
	const lines = [];
	for (const r of results) {
		lines.push(`## ${r.branch}: ${r.tag}  (${r.sha.slice(0, 9)})`);
		lines.push(
			`- Draft: ${r.draft ? `${r.draft.name || '(untitled)'} ${r.draft.url} (${r.draft.bodyChars} chars)` : 'none'}`
		);
		lines.push(`- Previous releases on this channel: ${r.previous.join(', ') || 'none'}`);
		if (r.checks) {
			const state = r.checks.failed.length
				? `${r.checks.failed.length} failing`
				: r.checks.running.length
					? `${r.checks.running.length} still running`
					: `all ${r.checks.total} passed`;
			const on = r.checks.commit === r.sha ? '' : ` (on ancestor ${r.checks.commit.slice(0, 9)})`;
			lines.push(`- Checks: ${state}${on}`);
		}
		if (r.mainMissing !== undefined) lines.push(`- main commits missing from rc: ${r.mainMissing}`);
		lines.push(
			r.problems.length
				? r.problems.map((p) => `- ⚠️ ${p}`).join('\n')
				: '- ✅ Ready to tag once notes are final'
		);
		lines.push('');
	}
	return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// kickoff
// ---------------------------------------------------------------------------

function cli(args) {
	return run(process.execPath, [CLI, ...args]);
}

function resolveAgents(opts, branches) {
	const agents = JSON.parse(cli(['list', 'agents', '--json']));
	const byId = (id) =>
		agents.find((a) => a.id === id || a.id.startsWith(id)) ?? misuse(`No agent ${id}`);
	const one = (label, matches, flag) => {
		if (matches.length === 1) return matches[0];
		misuse(
			`${matches.length === 0 ? 'No' : matches.length} agent(s) match the ${label} role; pass ${flag} <agent-id>`
		);
	};
	const byCwd = (dir) => agents.filter((a) => dir && path.resolve(a.cwd) === path.resolve(dir));
	const roles = {};
	if (branches.includes('main')) {
		roles.main = opts.mainAgent
			? byId(opts.mainAgent)
			: one('main', byCwd(worktreeFor('main')), '--main-agent');
	}
	if (branches.includes('rc')) {
		roles.rc = opts.rcAgent
			? byId(opts.rcAgent)
			: one('rc', byCwd(worktreeFor('rc')), '--rc-agent');
	}
	roles.site = opts.siteAgent
		? byId(opts.siteAgent)
		: one(
				'announcement',
				agents.filter((a) => path.basename(a.cwd) === 'RunMaestro.ai'),
				'--site-agent'
			);

	// Participants join by @mention, so each name must pick out one agent.
	for (const agent of Object.values(roles)) {
		const namesakes = agents.filter((a) => a.name.toLowerCase() === agent.name.toLowerCase());
		if (namesakes.length > 1)
			misuse(`${namesakes.length} agents are named "${agent.name}"; rename one`);
	}
	return roles;
}

function buildBrief(scope, roles, results) {
	const today = localDate();
	const mention = (role) => (roles[role] ? `@${roles[role].name.replace(/\s+/g, '-')}` : null);
	const owners = [
		roles.main &&
			`- ${mention('main')} owns the stable release from \`main\` (worktree ${roles.main.cwd}).`,
		roles.rc &&
			`- ${mention('rc')} owns the release candidate from \`rc\` (worktree ${roles.rc.cwd}).`,
		`- ${mention('site')} owns the announcement: Discord #announcements and the subscriber email.`,
	].filter(Boolean);
	return [
		`# Maestro Release (${scope}), ${today}`,
		'',
		'You are moderating a fully delegated Maestro release. The conductor handed releases to this',
		'group permanently. **There is no human approval gate**: draft, dedup, tag, verify, announce,',
		'and only stop to ask the conductor on a failure you cannot resolve or a decision nobody has',
		'made before.',
		'',
		`**Read the runbook before you route anything; it is the process:** \`${RUNBOOK}\``,
		'',
		'## Who owns what',
		...owners,
		'',
		'## Preflight (read-only snapshot taken at kickoff)',
		'',
		formatPreflight(results),
		'',
		`Re-run it any time with \`node ${path.join(ROOT, 'scripts/release.mjs')} preflight --scope ${scope}\`.`,
		'',
		'Start Phase 1 of the runbook now.',
	].join('\n');
}

function activeReleaseChat() {
	let chats;
	try {
		chats = JSON.parse(cli(['group-chat', 'list', '--json'])).chats ?? [];
	} catch (error) {
		if (/does not support|unknown command|group-chat/i.test(error.message)) return undefined;
		throw error;
	}
	return chats.find((c) => c.topic.startsWith('Maestro Release') && c.isActive) ?? null;
}

async function kickoff(opts) {
	const branches = scopeBranches(opts);
	const results = preflight({ scope: opts.scope }, { quiet: true });
	const roles = resolveAgents(opts, branches);
	const brief = buildBrief(opts.scope, roles, results);
	const name = `Maestro Release ${opts.scope} ${localDate()}`;
	const briefFile = path.join(os.tmpdir(), `maestro-release-${opts.scope}-${Date.now()}.md`);
	const participants = Object.values(roles);
	const startArgs = [
		'group-chat',
		'start',
		name,
		...participants.flatMap((a) => ['-p', a.id]),
		'--moderator',
		opts.moderator || 'claude-code',
		'--message-file',
		briefFile,
		'--json',
	];

	if (opts.dryRun) {
		console.log(brief);
		console.log(
			`\n---\nWould run: maestro-cli ${startArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
		);
		return;
	}

	fs.writeFileSync(briefFile, brief);
	const running = activeReleaseChat();
	if (running) misuse(`A release chat is already running: "${running.topic}" (${running.id})`);
	if (running === undefined) {
		console.log(`This Maestro build cannot start group chats from the CLI yet.`);
		console.log(`Brief written to ${briefFile}.`);
		console.log(
			`Start a group chat by hand (moderator: claude-code) and paste the brief; participants: ${participants
				.map((a) => a.name)
				.join(', ')}.`
		);
		throw new Exit(2, 'group-chat start unavailable in the running app');
	}

	const result = JSON.parse(cli(startArgs));
	if (!result.success) fail(`group-chat start failed: ${result.error}`);
	console.log(
		`Started "${name}" (${result.chatId}) with ${participants.map((a) => a.name).join(', ')}.`
	);
	const blocked = results.filter((r) => r.problems.length);
	if (blocked.length)
		console.log(`Preflight flagged: ${blocked.flatMap((r) => r.problems).join('; ')}`);
}

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

// gh cannot take JSON input through the helpers above without a pipe, so
// requests with a body go through this.
function ghApiWithBody(method, endpoint, body) {
	return JSON.parse(
		run('gh', ['api', '-X', method, endpoint, '--input', '-'], { input: JSON.stringify(body) }) ||
			'null'
	);
}

function draftCommand(opts) {
	const tag = needTag(opts);
	const { published, drafts } = releasesForTag(tag);
	if (drafts.length > 1) {
		misuse(`${drafts.length} drafts carry ${tag}: ids ${drafts.map((d) => d.id).join(', ')}`);
	}

	if (opts.show) {
		const shown = drafts[0] ?? published[0];
		if (!shown) misuse(`No release or draft for ${tag}`);
		console.log(
			[
				`id: ${shown.id}`,
				`state: ${shown.draft ? 'draft' : 'published'}`,
				`name: ${shown.name}`,
				`url: ${shown.html_url}`,
				'',
				shown.body || '',
			].join('\n')
		);
		return;
	}
	if (published.length > 0) {
		misuse(`${tag} is already published; change it with gh release edit ${tag} if it must change`);
	}

	const patch = {};
	if (typeof opts.title === 'string') patch.name = opts.title;
	if (typeof opts.notesFile === 'string') patch.body = fs.readFileSync(opts.notesFile, 'utf-8');

	let target = drafts[0];
	if (!target) {
		if (!opts.create) misuse(`No draft for ${tag}; pass --create to make one`);
		target = ghApiWithBody('POST', `repos/${REPO}/releases`, {
			tag_name: tag,
			target_commitish: isRcTag(tag) ? 'rc' : 'main',
			name: patch.name ?? tag,
			body: patch.body ?? '',
			draft: true,
			prerelease: isRcTag(tag),
		});
		console.log(`Created draft ${target.id} for ${tag}: ${target.html_url}`);
		return;
	}
	if (Object.keys(patch).length === 0)
		misuse('Nothing to change: pass --title and/or --notes-file, or --show');
	target = ghApiWithBody('PATCH', `repos/${REPO}/releases/${target.id}`, patch);
	console.log(`Updated draft ${target.id} for ${tag}: ${target.html_url}`);
}

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

async function tagCommand(opts) {
	const branch = needBranch(opts);
	fetchOrigin();
	const tip = git('rev-parse', `origin/${branch}`);
	const sha = typeof opts.sha === 'string' ? git('rev-parse', `${opts.sha}^{commit}`) : tip;
	try {
		git('merge-base', '--is-ancestor', sha, `origin/${branch}`);
	} catch {
		misuse(`${sha.slice(0, 9)} is not on origin/${branch}`);
	}

	const version = packageVersionAt(sha);
	const tag = `v${version}`;
	if ((branch === 'rc') !== isRcTag(tag))
		misuse(`${branch} at ${sha.slice(0, 9)} carries ${version}`);

	const existing = remoteTagCommit(tag);
	if (existing) {
		if (existing === sha) {
			console.log(
				`${tag} already points at ${sha.slice(0, 9)}; nothing to push. Next: watch --tag ${tag}`
			);
			return;
		}
		misuse(
			`${tag} already exists on ${existing.slice(0, 9)}; bump ${branch} before releasing again`
		);
	}

	const { published, drafts } = releasesForTag(tag);
	if (published.length) misuse(`${tag} is already published`);
	if (drafts.length !== 1 || !(drafts[0].body || '').trim()) {
		misuse(
			drafts.length > 1
				? `${drafts.length} drafts carry ${tag}; keep only the curated one`
				: `The ${tag} draft needs its notes first: release.mjs draft --tag ${tag} --notes-file <file>`
		);
	}

	if (branch === 'rc') {
		const missing = mainCommitsMissingFrom(sha);
		if (missing.length)
			misuse(`${missing.length} origin/main commit(s) are not in rc yet; merge main into rc first`);
	}

	const deadline = Date.now() + Number(opts.waitMin ?? 0) * 60_000;
	for (;;) {
		const { runs, commit } = checksVouchingFor(sha);
		const { failed, running } = summarizeChecks(runs);
		if (failed.length) {
			fail(
				`Checks failed on ${commit.slice(0, 9)}:\n${failed.map((c) => `  ${c.name}: ${c.url}`).join('\n')}`
			);
		}
		if (running.length === 0) break;
		if (Date.now() >= deadline) {
			pending(
				`${running.length} check(s) still running on ${commit.slice(0, 9)}: ${running.map((c) => c.name).join(', ')}`
			);
		}
		await sleep(30_000);
	}

	// Pushing the tag starts the release workflow, which publishes. See header on --no-verify.
	git('push', '--no-verify', 'origin', `${sha}:refs/tags/${tag}`);
	console.log(`Pushed ${tag} on ${sha.slice(0, 9)}. The release workflow is starting.`);

	for (let i = 0; i < 12; i++) {
		const runs = releaseRuns(tag);
		if (runs.length) {
			console.log(`Release run: ${runs[0].url}`);
			break;
		}
		await sleep(5_000);
	}
	console.log(`Next: node scripts/release.mjs watch --tag ${tag}`);
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

async function watchCommand(opts) {
	const tag = needTag(opts);
	const deadline = Date.now() + Number(opts.maxMin ?? 20) * 60_000;
	let kept;
	for (;;) {
		const runs = releaseRuns(tag);
		if (runs.length === 0) {
			if (Date.now() >= deadline) pending(`No release run for ${tag} yet`);
			await sleep(15_000);
			continue;
		}
		// One tag push once started two identical runs, created in the same
		// second. The workflow now queues them (concurrency), but a twin would only
		// re-upload the same files. Follow the run that finished for real if there
		// is one, else the oldest live run, and cancel every other live run.
		const live = runs.filter((r) => r.status !== 'completed');
		const finished = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'cancelled');
		kept = finished.at(-1) ?? live[0] ?? runs.at(-1);
		for (const twin of live) {
			if (twin === kept) continue;
			gh('run', 'cancel', String(twin.databaseId), '-R', REPO);
			console.log(`Cancelled duplicate release run ${twin.url}`);
		}
		if (kept.status === 'completed' || Date.now() >= deadline) break;
		await sleep(30_000);
	}

	const jobs = ghJson('run', 'view', String(kept.databaseId), '-R', REPO, '--json', 'jobs').jobs;
	const jobLines = jobs.map((j) => `  ${j.conclusion || j.status}: ${j.name}`).join('\n');
	if (kept.status !== 'completed') pending(`Release run still going: ${kept.url}\n${jobLines}`);
	console.log(`Release run ${kept.conclusion}: ${kept.url}\n${jobLines}`);
	if (kept.conclusion !== 'success') {
		verifyCommand({ tag, quietFailure: true });
		fail(`Release run for ${tag} concluded ${kept.conclusion}`);
	}
	verifyCommand({ tag });
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function verifyCommand(opts) {
	const tag = needTag(opts);
	const version = versionOf(tag);
	const rc = isRcTag(tag);
	let { published, drafts } = releasesForTag(tag);
	const results = [];
	const check = (ok, label) => results.push(`${ok ? '✅' : '❌'} ${label}`);

	// The pre-fix workflow could publish an empty bot release and strand the
	// curated draft (with every file) behind it. Repair in the safe order:
	// unpublish the empty one, publish the real one, verify, and only then delete.
	const emptyPublished = published.filter((r) => r.assets.length === 0);
	const loadedDraft = drafts.find((d) => d.assets.length > 0);
	if (emptyPublished.length === 1 && published.length === 1 && loadedDraft) {
		if (!opts.repair) {
			fail(
				`${tag}: the public release ${emptyPublished[0].id} is empty and draft ${loadedDraft.id} holds the files. ` +
					`Re-run with --repair to swap them.`
			);
		}
		const empty = emptyPublished[0];
		ghApiWithBody('PATCH', `repos/${REPO}/releases/${empty.id}`, { draft: true });
		ghApiWithBody('PATCH', `repos/${REPO}/releases/${loadedDraft.id}`, {
			draft: false,
			prerelease: rc,
			make_latest: rc ? 'false' : 'true',
		});
		console.log(`Repaired: unpublished empty ${empty.id}, published ${loadedDraft.id}`);
		({ published, drafts } = releasesForTag(tag));
	}

	check(
		published.length === 1,
		`exactly one published release for ${tag} (found ${published.length})`
	);
	const release = published[0];
	if (release) {
		check(release.prerelease === rc, `marked ${rc ? 'prerelease' : 'full release'}`);
		const latest = ghJson('api', `repos/${REPO}/releases/latest`).tag_name;
		check(rc ? latest !== tag : latest === tag, `"latest" is ${latest}`);

		const expected = expectedAssets(version);
		const names = new Set(release.assets.map((a) => a.name));
		const missing = expected.filter((n) => !names.has(n));
		const extra = [...names].filter((n) => !expected.includes(n));
		check(
			missing.length === 0,
			`all ${expected.length} files attached${missing.length ? `; missing ${missing.join(', ')}` : ''}`
		);
		if (extra.length) results.push(`ℹ️ extra files: ${extra.join(', ')}`);
		const tiny = release.assets.filter((a) =>
			a.name.endsWith('.yml') ? a.size === 0 : a.size < 1_000_000
		);
		check(
			tiny.length === 0,
			`no empty or truncated files${tiny.length ? `: ${tiny.map((a) => a.name).join(', ')}` : ''}`
		);

		if (names.has('latest-mac.yml')) {
			const manifest = gh(
				'release',
				'download',
				tag,
				'-R',
				REPO,
				'-p',
				'latest-mac.yml',
				'-O',
				'-'
			);
			check(
				new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(manifest),
				`latest-mac.yml reads ${version}`
			);
		}

		const body = release.body || '';
		const changelogLines = body.split('\n').filter((l) => l.includes('Full Changelog'));
		if (changelogLines.length > 1 && opts.repair) {
			let kept = false;
			const deduped = body
				.split('\n')
				.filter((l) => {
					if (!l.includes('Full Changelog')) return true;
					if (kept) return false;
					kept = true;
					return true;
				})
				.join('\n');
			ghApiWithBody('PATCH', `repos/${REPO}/releases/${release.id}`, { body: deduped });
			results.push('🔧 removed a duplicate Full Changelog line');
		} else {
			check(
				changelogLines.length === 1,
				`one Full Changelog line (found ${changelogLines.length})`
			);
		}
		check(body.trim().length > 200, 'curated notes present');
	}

	const tagCommit = remoteTagCommit(tag);
	check(!!tagCommit, `tag ${tag} on ${tagCommit ? tagCommit.slice(0, 9) : '(missing)'}`);

	const strays = drafts.filter((d) => d.assets.length === 0 && d.author?.type === 'Bot');
	if (strays.length && results.every((r) => !r.startsWith('❌')) && opts.repair) {
		for (const stray of strays) gh('api', '-X', 'DELETE', `repos/${REPO}/releases/${stray.id}`);
		results.push(`🧹 deleted ${strays.length} empty bot draft(s) for ${tag}`);
	} else if (strays.length) {
		results.push(
			`ℹ️ ${strays.length} empty bot draft(s) still carry ${tag}; --repair removes them once all checks pass`
		);
	}

	console.log(`${releaseUrl(tag)}\n${results.join('\n')}`);
	if (results.some((r) => r.startsWith('❌')) && !opts.quietFailure) fail(`${tag} did not verify`);
}

// ---------------------------------------------------------------------------
// bump
// ---------------------------------------------------------------------------

function nextVersion(version) {
	const m = version.match(/^(\d+)\.(\d+)\.(\d+)(-RC)?$/);
	if (!m) misuse(`Cannot bump unrecognized version ${version}`);
	return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] ?? ''}`;
}

/** Replace the first `"version": "<old>"` occurrences, touching nothing else. */
function replaceVersion(text, oldVersion, newVersion, count) {
	let replaced = 0;
	const out = text.replace(
		new RegExp(`"version":(\\s*)"${oldVersion.replace(/\./g, '\\.')}"`, 'g'),
		(match, space) => {
			if (replaced >= count) return match;
			replaced++;
			return `"version":${space}"${newVersion}"`;
		}
	);
	if (replaced !== count)
		fail(`Expected ${count} version field(s) reading ${oldVersion}, found ${replaced}`);
	return out;
}

function bumpCommand(opts) {
	const branch = needBranch(opts);
	fetchOrigin();
	const base = git('rev-parse', `origin/${branch}`);
	const current = packageVersionAt(base);
	const tag = `v${current}`;
	const { published } = releasesForTag(tag);
	if (!published.length) misuse(`${tag} is not published yet; bump only after it ships`);
	const next = nextVersion(current);
	if (branch === 'main' && /-rc/i.test(next)) misuse('main must never carry an -RC version');

	const files = {
		'package.json': replaceVersion(git('show', `${base}:package.json`), current, next, 1),
	};
	// Match past practice: main bumps also move the lockfile's two root fields;
	// rc bumps have left the lockfile alone, so only follow it when it agrees.
	const lockText = git('show', `${base}:package-lock.json`);
	const lock = JSON.parse(lockText);
	if (lock.version === current && lock.packages?.['']?.version === current) {
		const bumped = replaceVersion(lockText, current, next, 2);
		const check = JSON.parse(bumped);
		if (check.version !== next || check.packages[''].version !== next)
			fail('Lockfile bump touched the wrong fields');
		files['package-lock.json'] = bumped;
	}

	if (opts.dryRun) {
		console.log(
			`Would bump ${branch} ${current} -> ${next} on ${base.slice(0, 9)} (${Object.keys(files).join(', ')})`
		);
		return;
	}

	// Build the commit without a working tree: temp index -> tree -> commit.
	const indexFile = path.join(os.tmpdir(), `maestro-bump-${process.pid}.index`);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		run('git', ['read-tree', base], { env });
		for (const [file, content] of Object.entries(files)) {
			const blob = run('git', ['hash-object', '-w', '--stdin'], { input: content });
			run('git', ['update-index', '--cacheinfo', `100644,${blob},${file}`], { env });
		}
		const tree = run('git', ['write-tree'], { env });
		const message = `chore(version): set version to ${next}`;
		const commit = run('git', ['commit-tree', tree, '-p', base, '-m', message]);
		git('push', '--no-verify', 'origin', `${commit}:refs/heads/${branch}`);
		console.log(
			`Pushed ${commit.slice(0, 9)} "${message}" to ${branch} (was ${base.slice(0, 9)}).`
		);
		console.log('CI runs on it now; the local checkout is untouched (pull when convenient).');
	} finally {
		fs.rmSync(indexFile, { force: true });
	}
}

// ---------------------------------------------------------------------------

const COMMANDS = {
	preflight: (opts) => preflight(opts),
	kickoff,
	draft: draftCommand,
	tag: tagCommand,
	watch: watchCommand,
	verify: verifyCommand,
	bump: bumpCommand,
};

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const handler = COMMANDS[command];
	if (!handler) {
		console.error(
			`Usage: release.mjs <${Object.keys(COMMANDS).join('|')}> [options]  (see header)`
		);
		process.exit(2);
	}
	try {
		await handler(parseArgs(rest));
	} catch (error) {
		if (error instanceof Exit) {
			console.error(`${error.code === 3 ? 'PENDING' : 'FAILED'}: ${error.message}`);
			process.exit(error.code);
		}
		console.error(`FAILED: ${error.message}`);
		process.exit(1);
	}
}

main();
