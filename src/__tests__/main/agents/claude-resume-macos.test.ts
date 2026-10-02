// @vitest-environment node
/**
 * Claude Code resume on macOS: where the transcript lives, and what happens to
 * it when a conversation moves from interactive (maestro-p driving the TUI on
 * the Max plan) to API mode (`claude --print --resume`).
 *
 * Runs on any host. The macOS parts are the ones that differ from the Linux
 * default: a home under `/Users/<name>`, project paths full of spaces and
 * punctuation (iCloud Drive's `Mobile Documents/com~apple~CloudDocs`), and
 * multi-account setups that point `CLAUDE_CONFIG_DIR` at `~/.claude-<name>`.
 *
 * The invariant under test is the one a TUI -> API switch depends on: the
 * sanitizer must rewrite the SAME file the spawned process wrote. If the two
 * disagree about the config dir or the project slug, the sanitizer quietly
 * no-ops on a path that does not exist, the API resume re-sends the
 * subscription-bound thinking shells, and Anthropic answers every later turn
 * with the "thinking blocks cannot be modified" 400.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { homeRef } = vi.hoisted(() => ({ homeRef: { current: '' } }));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const mocked = { ...actual, homedir: () => homeRef.current };
	return { ...mocked, default: mocked };
});

// claudeUsageStore constructs an electron-store lazily; only its pure key
// helper is used here.
vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as os from 'os';
import { resolveConfigDirKey } from '../../../main/stores/claudeUsageStore';
import {
	mergeClaudeSpawnEnvLayers,
	resolveConfigDirKeyFromEnv,
} from '../../../main/agents/claudeSpawnCore';
import { stripThinkingFromTranscript } from '../../../main/agents/claude-transcript-sanitizer';
import { buildChildProcessEnv } from '../../../main/process-manager/utils/envBuilder';
import { AGENT_DEFINITIONS } from '../../../main/agents/definitions';
import { applyAgentConfigOverrides, buildAgentArgs } from '../../../main/utils/agent-args';
import { encodeClaudeProjectPath } from '../../../shared/pathUtils';
import { cwdSlug } from '../../../maestro-p/session-watcher';
import type { AgentConfig } from '../../../main/agents';

const claudeCode = AGENT_DEFINITIONS.find((a) => a.id === 'claude-code') as unknown as AgentConfig;

/** A realistic macOS project path: iCloud Drive, spaces, a tilde, a dot. */
const ICLOUD_PROJECT = '/Users/jane/Library/Mobile Documents/com~apple~CloudDocs/My App v2.0';
const ICLOUD_SLUG = '-Users-jane-Library-Mobile-Documents-com-apple-CloudDocs-My-App-v2-0';

const SESSION_ID = '0f8b1c2e-5d4a-4e7b-9c3d-2a1b0c9d8e7f';

/**
 * The env layers a user can set CLAUDE_CONFIG_DIR at, besides the agent's own
 * (session) vars: Settings -> Shell Configuration (`global`) and the
 * provider-level agent config (`agentLevel`). A macOS multi-account setup is
 * commonly configured at either one.
 */
interface OtherLayers {
	global?: Record<string, string>;
	agentLevel?: Record<string, string>;
}

/**
 * The directory the spawned process will actually use: whatever
 * CLAUDE_CONFIG_DIR its REAL environment carries, else `~/.claude`. That is
 * claude's own rule, and maestro-p's `resolveConfigDir()` (which treats an
 * empty value as unset) - both read the child env, not Maestro's settings.
 *
 * Built through the spawn's own code, not a restatement of it:
 * `applyAgentConfigOverrides()` picks the user env set and lays it over the
 * agent defaults, then `buildChildProcessEnv()` lays that over the global vars.
 */
function configDirSeenBySpawn(
	sessionCustomEnvVars: Record<string, string> | undefined,
	layers: OtherLayers = {}
): string {
	const { effectiveCustomEnvVars } = applyAgentConfigOverrides(claudeCode, [], {
		agentConfigValues: layers.agentLevel ? { customEnvVars: layers.agentLevel } : {},
		sessionCustomEnvVars,
	});
	const childEnv = buildChildProcessEnv(effectiveCustomEnvVars, false, layers.global);
	const dir = childEnv.CLAUDE_CONFIG_DIR;
	// Resolved, since claude makes the path absolute itself (and so it compares
	// with the sanitizer's key on Windows, where `/Users/...` gains a drive).
	return path.resolve(dir && dir.length > 0 ? dir : path.join(os.homedir(), '.claude'));
}

/**
 * The directory the API-resume sanitizer looks in: `process.ts` keys it on
 * `mergeClaudeSpawnEnvLayers()` of the same layers, as configured (before any
 * spawn-time normalization, which `resolveConfigDirKey` then applies).
 */
function configDirSeenBySanitizer(
	sessionCustomEnvVars: Record<string, string> | undefined,
	layers: OtherLayers = {}
): string {
	return resolveConfigDirKey(
		mergeClaudeSpawnEnvLayers({
			agentDefaultEnvVars: claudeCode.defaultEnvVars,
			globalShellEnvVars: layers.global,
			agentCustomEnvVars: layers.agentLevel,
			sessionCustomEnvVars,
		})
	);
}

function transcriptPath(configDir: string, cwd: string, sessionId = SESSION_ID): string {
	return path.join(configDir, 'projects', encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`);
}

function jsonl(rows: unknown[]): string {
	return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function readRows(file: string): Array<Record<string, any>> {
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

/**
 * What maestro-p leaves behind for one interactive turn: a user prompt, then
 * an assistant row whose only content is a signature-only thinking shell
 * (bound to the subscription account), then the visible answer as a separate
 * assistant row threaded off the shell, then a tool result threaded off that.
 */
function interactiveTurn(prefix: string, parentUuid: string | null) {
	return [
		{
			type: 'user',
			uuid: `${prefix}-user`,
			parentUuid,
			sessionId: SESSION_ID,
			message: { role: 'user', content: [{ type: 'text', text: `${prefix} prompt` }] },
		},
		{
			type: 'assistant',
			uuid: `${prefix}-shell`,
			parentUuid: `${prefix}-user`,
			sessionId: SESSION_ID,
			message: {
				role: 'assistant',
				content: [{ type: 'thinking', thinking: '', signature: 'sub-account-sig' }],
			},
		},
		{
			type: 'assistant',
			uuid: `${prefix}-answer`,
			parentUuid: `${prefix}-shell`,
			sessionId: SESSION_ID,
			message: {
				role: 'assistant',
				content: [
					{ type: 'redacted_thinking', signature: 'sub-account-sig-2' },
					{ type: 'text', text: `${prefix} answer` },
				],
			},
		},
	];
}

describe('Claude Code resume on macOS', () => {
	let root: string;
	const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

	beforeEach(() => {
		const realTmp = fs.realpathSync(require('os').tmpdir());
		root = fs.mkdtempSync(path.join(realTmp, 'maestro-claude-resume-'));
		homeRef.current = path.join(root, 'Users', 'jane');
		fs.mkdirSync(homeRef.current, { recursive: true });
		delete process.env.CLAUDE_CONFIG_DIR;
	});

	afterEach(() => {
		if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe('transcript location', () => {
		it('slugs a macOS iCloud project path the way claude names its project folder', () => {
			expect(encodeClaudeProjectPath(ICLOUD_PROJECT)).toBe(ICLOUD_SLUG);
			// A projectRoot saved with a trailing slash must land in the same folder.
			expect(encodeClaudeProjectPath(`${ICLOUD_PROJECT}/`)).toBe(ICLOUD_SLUG);
		});

		it('agrees with maestro-p on the slug, so both modes read one transcript', () => {
			for (const cwd of [
				ICLOUD_PROJECT,
				`${ICLOUD_PROJECT}/`,
				'/Users/jane/Code/maestro',
				'/Volumes/External SSD/work/app',
				'/Users/jane/Projects/café-ü',
			]) {
				expect(cwdSlug(cwd)).toBe(encodeClaudeProjectPath(cwd));
			}
		});

		it('defaults the config dir to ~/.claude under the macOS home', () => {
			expect(configDirSeenBySanitizer({})).toBe(path.join(homeRef.current, '.claude'));
			expect(transcriptPath(configDirSeenBySanitizer({}), ICLOUD_PROJECT)).toBe(
				path.join(homeRef.current, '.claude', 'projects', ICLOUD_SLUG, `${SESSION_ID}.jsonl`)
			);
		});

		// Each case is a CLAUDE_CONFIG_DIR a macOS user can configure on an agent.
		// The sanitizer must end up in the directory the spawned process uses.
		it.each([
			['unset', {}],
			['an absolute account dir', { CLAUDE_CONFIG_DIR: '/Users/jane/.claude-work' }],
			['a ~/ account dir (expanded at spawn)', { CLAUDE_CONFIG_DIR: '~/.claude-work' }],
			['a blank value (the env editor means "unset")', { CLAUDE_CONFIG_DIR: '' }],
			['a whitespace-only value', { CLAUDE_CONFIG_DIR: '   ' }],
		])('looks for the transcript where the spawn writes it: %s', (_label, customEnvVars) => {
			const vars = customEnvVars as Record<string, string>;
			expect(configDirSeenBySanitizer(vars)).toBe(configDirSeenBySpawn(vars));
		});

		it('lets a blank agent value cancel an inherited CLAUDE_CONFIG_DIR, as the spawn does', () => {
			process.env.CLAUDE_CONFIG_DIR = '/Users/jane/.claude-personal';
			const vars = { CLAUDE_CONFIG_DIR: '' };
			expect(configDirSeenBySpawn(vars)).toBe(path.join(homeRef.current, '.claude'));
			expect(configDirSeenBySanitizer(vars)).toBe(configDirSeenBySpawn(vars));
		});

		// CLAUDE_CONFIG_DIR is not only set on the agent itself. The two other
		// layers the child receives used to be left out of the key, so the
		// sanitizer looked in ~/.claude while claude wrote to the configured dir.
		describe("layers beyond the agent's own vars", () => {
			const home = () => homeRef.current;
			const at = (...parts: string[]) => path.resolve(home(), ...parts);

			it.each<[string, Record<string, string> | undefined, OtherLayers, () => string]>([
				[
					'a global Shell Configuration dir',
					undefined,
					{ global: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
					() => at('.claude-work'),
				],
				[
					'a provider-level (agent config) dir',
					undefined,
					{ agentLevel: { CLAUDE_CONFIG_DIR: '~/.claude-team' } },
					() => at('.claude-team'),
				],
				[
					'the provider level over the global layer',
					undefined,
					{
						global: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
						agentLevel: { CLAUDE_CONFIG_DIR: '~/.claude-team' },
					},
					() => at('.claude-team'),
				],
				[
					"the agent's own dir over the provider level",
					{ CLAUDE_CONFIG_DIR: '~/.claude-mine' },
					{ agentLevel: { CLAUDE_CONFIG_DIR: '~/.claude-team' } },
					() => at('.claude-mine'),
				],
				[
					// The agent's own vars REPLACE the provider-level set; they do not
					// layer over it. Setting any unrelated var drops the team dir.
					"the agent's unrelated vars replacing the provider-level set",
					{ SOME_OTHER_VAR: '1' },
					{
						global: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
						agentLevel: { CLAUDE_CONFIG_DIR: '~/.claude-team' },
					},
					() => at('.claude-work'),
				],
				[
					'a blank provider-level value cancelling the global dir',
					undefined,
					{
						global: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
						agentLevel: { CLAUDE_CONFIG_DIR: '' },
					},
					() => at('.claude'),
				],
				[
					'a blank agent value cancelling both lower layers',
					{ CLAUDE_CONFIG_DIR: '  ' },
					{
						global: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
						agentLevel: { CLAUDE_CONFIG_DIR: '~/.claude-team' },
					},
					() => at('.claude'),
				],
			])('honors %s', (_label, session, layers, expected) => {
				expect(configDirSeenBySpawn(session, layers)).toBe(expected());
				expect(configDirSeenBySanitizer(session, layers)).toBe(expected());
			});
		});

		it('keys the desktop and the CLI identically (the CLI uses resolveConfigDirKeyFromEnv)', () => {
			for (const value of [undefined, '/Users/jane/.claude-work', '~/.claude-work', '', '  ']) {
				const env: NodeJS.ProcessEnv = value === undefined ? {} : { CLAUDE_CONFIG_DIR: value };
				expect(resolveConfigDirKeyFromEnv(env)).toBe(resolveConfigDirKey(env));
			}
		});
	});

	describe('interactive -> API transition', () => {
		function writeInteractiveTranscript(configDir: string, turns = 1): string {
			const file = transcriptPath(configDir, ICLOUD_PROJECT);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const rows: unknown[] = [];
			let parent: string | null = null;
			for (let t = 1; t <= turns; t++) {
				rows.push(...interactiveTurn(`t${t}`, parent));
				parent = `t${t}-answer`;
			}
			fs.writeFileSync(file, jsonl(rows));
			return file;
		}

		it('strips the subscription shells from the transcript the TUI wrote, keeping the thread intact', () => {
			const configDir = configDirSeenBySpawn({ CLAUDE_CONFIG_DIR: '~/.claude-work' });
			const file = writeInteractiveTranscript(configDir, 2);

			const result = stripThinkingFromTranscript(
				transcriptPath(
					configDirSeenBySanitizer({ CLAUDE_CONFIG_DIR: '~/.claude-work' }),
					ICLOUD_PROJECT
				)
			);

			expect(result).toMatchObject({ sanitized: true, droppedRows: 2, strippedBlocks: 2 });
			const rows = readRows(file);
			expect(rows.map((r) => r.uuid)).toEqual(['t1-user', 't1-answer', 't2-user', 't2-answer']);
			// The answers re-thread onto the user rows their dropped shells hung off.
			expect(rows.find((r) => r.uuid === 't1-answer')?.parentUuid).toBe('t1-user');
			expect(rows.find((r) => r.uuid === 't2-answer')?.parentUuid).toBe('t2-user');
			// Turn 2 still continues from turn 1's visible answer.
			expect(rows.find((r) => r.uuid === 't2-user')?.parentUuid).toBe('t1-answer');
			for (const row of rows) {
				const blocks = row.message.content as Array<{ type: string }>;
				expect(blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')).toBe(
					false
				);
			}
		});

		it('sanitizes the transcript under a globally configured config dir', () => {
			const layers: OtherLayers = { global: { CLAUDE_CONFIG_DIR: '~/.claude-work' } };
			const file = writeInteractiveTranscript(configDirSeenBySpawn(undefined, layers));

			const result = stripThinkingFromTranscript(
				transcriptPath(configDirSeenBySanitizer(undefined, layers), ICLOUD_PROJECT)
			);

			expect(result).toMatchObject({ sanitized: true, droppedRows: 1 });
			expect(file.startsWith(path.join(homeRef.current, '.claude-work'))).toBe(true);
		});

		it('keeps API-signed thinking (non-empty reasoning) that the next API turn must re-send verbatim', () => {
			const configDir = configDirSeenBySpawn({});
			const file = transcriptPath(configDir, ICLOUD_PROJECT);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const apiThinking = {
				type: 'thinking',
				thinking: 'Plan: read the file.',
				signature: 'api-sig',
			};
			fs.writeFileSync(
				file,
				jsonl([
					...interactiveTurn('t1', null),
					{
						type: 'assistant',
						uuid: 't2-api',
						parentUuid: 't1-answer',
						message: { role: 'assistant', content: [apiThinking, { type: 'text', text: 'done' }] },
					},
				])
			);

			stripThinkingFromTranscript(transcriptPath(configDirSeenBySanitizer({}), ICLOUD_PROJECT));

			const apiRow = readRows(file).find((r) => r.uuid === 't2-api');
			expect(apiRow?.message.content[0]).toEqual(apiThinking);
		});

		it('backs the original up once and is a byte-for-byte no-op on the next API resume', () => {
			const configDir = configDirSeenBySpawn({});
			const file = writeInteractiveTranscript(configDir);
			const original = fs.readFileSync(file, 'utf8');

			const first = stripThinkingFromTranscript(file);
			expect(first.backupPath).toBe(`${file}.maestro-presanitize.bak`);
			expect(fs.readFileSync(first.backupPath!, 'utf8')).toBe(original);

			const sanitized = fs.readFileSync(file, 'utf8');
			const second = stripThinkingFromTranscript(file);
			expect(second).toMatchObject({ sanitized: false, backupPath: null });
			expect(fs.readFileSync(file, 'utf8')).toBe(sanitized);
			// No temp file left in the project folder.
			expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(
				[`${SESSION_ID}.jsonl`, `${SESSION_ID}.jsonl.maestro-presanitize.bak`].sort()
			);
		});

		it('handles ping-pong: API resume, another interactive turn, then API resume again', () => {
			const configDir = configDirSeenBySpawn({});
			const file = writeInteractiveTranscript(configDir);
			const original = fs.readFileSync(file, 'utf8');
			stripThinkingFromTranscript(file);

			// Quota resets; the next turn runs interactive again and maestro-p
			// appends a fresh shell-bearing turn to the same transcript.
			fs.appendFileSync(file, jsonl(interactiveTurn('t2', 't1-answer')));

			const again = stripThinkingFromTranscript(file);
			expect(again).toMatchObject({ sanitized: true, droppedRows: 1, strippedBlocks: 1 });
			expect(readRows(file).map((r) => r.uuid)).toEqual([
				't1-user',
				't1-answer',
				't2-user',
				't2-answer',
			]);
			// The one-time backup still holds the ORIGINAL, not an intermediate state.
			expect(fs.readFileSync(`${file}.maestro-presanitize.bak`, 'utf8')).toBe(original);
		});

		it('is a harmless no-op when the resumed session has no transcript on this Mac', () => {
			const missing = transcriptPath(configDirSeenBySanitizer({}), ICLOUD_PROJECT, 'never-written');
			expect(stripThinkingFromTranscript(missing)).toMatchObject({ sanitized: false });
			expect(fs.existsSync(path.dirname(missing))).toBe(false);
		});
	});

	describe('resume arguments across modes', () => {
		it('continues the API turn with --resume <id> after the stream-json flags', () => {
			const args = buildAgentArgs(claudeCode, {
				baseArgs: claudeCode.apiModeArgs ?? claudeCode.args,
				prompt: 'continue',
				cwd: ICLOUD_PROJECT,
				agentSessionId: SESSION_ID,
			});
			expect(args).toEqual([
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--dangerously-skip-permissions',
				'--resume',
				SESSION_ID,
			]);
		});

		it('hands maestro-p the same --resume <id>, so it tails the existing transcript', () => {
			const maestroP = '/Applications/Maestro.app/Contents/Resources/maestro-p/maestro-p.js';
			const args = buildAgentArgs(claudeCode, {
				baseArgs: [maestroP, ...(claudeCode.interactiveModeArgs ?? [])],
				prompt: 'continue',
				cwd: ICLOUD_PROJECT,
				agentSessionId: SESSION_ID,
			});
			expect(args).toEqual([maestroP, '--dangerously-skip-permissions', '--resume', SESSION_ID]);
		});

		it('starts a fresh conversation (no --resume) when there is no session id yet', () => {
			const args = buildAgentArgs(claudeCode, {
				baseArgs: claudeCode.apiModeArgs ?? claudeCode.args,
				prompt: 'hello',
				cwd: ICLOUD_PROJECT,
			});
			expect(args).not.toContain('--resume');
		});

		it('keeps read-only (plan) mode on a resumed turn in both modes', () => {
			for (const baseArgs of [
				claudeCode.apiModeArgs ?? claudeCode.args,
				['/path/maestro-p.js', ...(claudeCode.interactiveModeArgs ?? [])],
			]) {
				const args = buildAgentArgs(claudeCode, {
					baseArgs,
					prompt: 'look only',
					cwd: ICLOUD_PROJECT,
					readOnlyMode: true,
					agentSessionId: SESSION_ID,
				});
				expect(args).toEqual(
					expect.arrayContaining(['--permission-mode', 'plan', '--resume', SESSION_ID])
				);
			}
		});
	});
});
