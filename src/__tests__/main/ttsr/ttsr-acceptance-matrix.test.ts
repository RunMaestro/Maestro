/**
 * Phase 5 - the Gate A per-agent acceptance matrix.
 *
 * Every other TTSR suite exercises a component against hand-built
 * `ParsedEvent`s. This one runs the real thing per agent: raw provider stdout
 * lines -> that agent's real parser -> the runtime tap -> matcher -> interrupt
 * driver -> corrective payload. Nothing about an agent's behaviour is asserted
 * from `TTSR_AGENT_CAPABILITIES`; the matrix is *recorded* from what actually
 * happens and only then compared to the plan's scope table, so a parser change
 * that silently downgrades an agent fails here instead of shipping.
 *
 * Four axes are measured, each with an empirical discriminator:
 * - **prose**: `live` when the abort lands before the turn's final event,
 *   `end-of-turn` when the only matchable prose is the closing event.
 * - **ast**: `full` when the edit snapshot recovers the whole written text,
 *   `partial` when only part of it survives (codex ships patches, not files),
 *   `none` when the agent emits no tool content at all.
 * - **shell**: `yes` when the command a shell tool is about to run reaches the
 *   matcher, which is what makes a "never run X" rule expressible.
 * - **resume**: `clean` when the corrective turn re-attaches to the provider
 *   conversation, `degraded` when it must respawn fresh with the goal restated.
 */

import { EventEmitter } from 'events';
import { describe, it, expect } from 'vitest';
import { TtsrRuntime } from '../../../main/ttsr/ttsr-runtime';
import { extractToolSnapshots } from '../../../main/ttsr/ttsr-tool-extract';
import type { LoadTtsrConfigResult } from '../../../main/ttsr/config/ttsr-config-loader';
import type { TtsrProcessEventSource } from '../../../main/ttsr/ttsr-spawn-registry';
import type { AgentOutputParser, ParsedEvent } from '../../../main/parsers/agent-output-parser';
import { ClaudeOutputParser } from '../../../main/parsers/claude-output-parser';
import { CodexOutputParser } from '../../../main/parsers/codex-output-parser';
import { OpenCodeOutputParser } from '../../../main/parsers/opencode-output-parser';
import { FactoryDroidOutputParser } from '../../../main/parsers/factory-droid-output-parser';
import { CopilotOutputParser } from '../../../main/parsers/copilot-output-parser';
import { GrokOutputParser } from '../../../main/parsers/grok-output-parser';
import type { AgentId } from '../../../shared/agentIds';
import {
	DEFAULT_TTSR_PROJECT_SETTINGS,
	TTSR_AGENT_CAPABILITIES,
	type LoadedTtsrRule,
	type TtsrTriggeredPayload,
} from '../../../shared/ttsr-types';

const ROOT = '/repo';
const SESSION = 'sess-ai-1';
const GOAL = 'Refactor the auth module';
/** The written file both the regex and the ast rule are aimed at. */
const EDIT_PATH = '/repo/src/a.ts';
const FULL_EDIT = 'const x = 1;\nconsole.log(x);';

/** The command the tool:bash rule is aimed at. */
const SHELL_COMMAND = 'git push --force origin main';

// ── rules ────────────────────────────────────────────────────────────────────

const ALL_AGENTS: AgentId[] = [
	'claude-code',
	'codex',
	'opencode',
	'factory-droid',
	'copilot-cli',
	'grok',
];

function rule(overrides: Partial<LoadedTtsrRule>): LoadedTtsrRule {
	const condition = overrides.condition ?? [];
	return {
		name: 'no-console-log',
		description: 'Flag stray console.log',
		condition,
		astCondition: [],
		scope: ['text', 'thinking'],
		globs: [],
		interruptMode: 'always',
		repeatMode: 'once',
		repeatGap: 3,
		agents: ALL_AGENTS,
		content: 'Use the project logger instead of console.log.',
		path: '.maestro/rules/no-console-log.md',
		...overrides,
		compiledCondition: (overrides.condition ?? condition).map((source) => new RegExp(source)),
	};
}

const PROSE_RULE = rule({ condition: ['console\\.log\\('] });
const AST_RULE = rule({
	name: 'no-console-log-ast',
	condition: [],
	astCondition: ['console.log($$$ARGS)'],
	scope: ['tool:edit', 'tool:write'],
	path: '.maestro/rules/no-console-log-ast.md',
});
const BASH_RULE = rule({
	name: 'no-force-push',
	condition: ['git push .*--force'],
	scope: ['tool:bash'],
	content: 'Never force-push a shared branch.',
	path: '.maestro/rules/no-force-push.md',
});

// ── harness ──────────────────────────────────────────────────────────────────

interface TurnResult {
	triggered: TtsrTriggeredPayload[];
	/** `interrupt` for contextMode keep, `kill` for discard, null when nothing fired. */
	signal: 'interrupt' | 'kill' | null;
	/** Index of the raw line the abort was signalled on, or -1. */
	abortedAt: number;
	/** How many raw lines the fixture carried. */
	lineCount: number;
	/** True when the runtime went as far as reading the project's rules. */
	readRules: boolean;
}

/**
 * Feed one turn's raw stdout through the agent's parser and the TTSR runtime.
 * Feeding stops at the abort, mirroring reality: once the process is signalled
 * it stops producing output.
 */
async function runTurn(
	agentId: AgentId,
	parser: AgentOutputParser,
	lines: unknown[],
	rules: LoadedTtsrRule[],
	options: { enabled?: boolean } = {}
): Promise<TurnResult> {
	const triggered: TtsrTriggeredPayload[] = [];
	let signal: TurnResult['signal'] = null;
	let readRules = false;

	const source = new EventEmitter();
	const scheduleExit = () => setTimeout(() => source.emit('exit', SESSION, 130), 0);
	const runtime = new TtsrRuntime({
		isGloballyEnabled: () => options.enabled !== false,
		loadConfig: (): LoadTtsrConfigResult => {
			readRules = true;
			return {
				ok: true,
				errors: [],
				warnings: [],
				rules,
				settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS },
			};
		},
		interruptTarget: {
			interrupt: () => {
				signal = 'interrupt';
				scheduleExit();
				return true;
			},
			kill: () => {
				signal = 'kill';
				scheduleExit();
				return true;
			},
		},
		onTriggered: (payload) => triggered.push(payload),
	});
	runtime.attach(source as unknown as TtsrProcessEventSource);
	source.emit('spawn', {
		sessionId: SESSION,
		toolType: agentId,
		cwd: ROOT,
		command: agentId,
		args: [],
		prompt: GOAL,
		tabId: 'tab-1',
	});

	let abortedAt = -1;
	for (const [index, raw] of lines.entries()) {
		const event = parser.parseJsonObject(raw as Record<string, unknown>);
		if (event) runtime.observe(SESSION, event);
		// `astCondition` settles off the synchronous path, so a structural hit for
		// this line only reaches the driver once the pass resolves.
		await runtime.flushAst();
		if (signal !== null) {
			abortedAt = index;
			break;
		}
	}

	await runtime.flushAst();
	await runtime.flushInterrupts();
	runtime.dispose();

	return { triggered, signal, abortedAt, lineCount: lines.length, readRules };
}

// ── per-agent fixtures (real provider stdout shapes) ─────────────────────────

interface AgentFixture {
	agentId: AgentId;
	parser: () => AgentOutputParser;
	/** Provider session id the agent publishes early enough to resume from. */
	providerSessionId?: string;
	/** Raw stdout lines for a turn whose prose trips the regex rule. */
	prose: unknown[];
	/** Raw stdout line carrying an edit of {@link FULL_EDIT}, when the agent emits one. */
	edit?: unknown;
	/** Raw stdout line carrying a run of {@link SHELL_COMMAND}, when the agent emits one. */
	shell?: unknown;
}

const FIXTURES: AgentFixture[] = [
	{
		agentId: 'claude-code',
		parser: () => new ClaudeOutputParser(),
		providerSessionId: 'claude-prov-1',
		prose: [
			{ type: 'system', subtype: 'init', session_id: 'claude-prov-1' },
			{
				type: 'assistant',
				session_id: 'claude-prov-1',
				message: { role: 'assistant', content: 'Adding console.log(x) for debugging' },
			},
			{ type: 'result', result: 'All done.', session_id: 'claude-prov-1' },
		],
		edit: {
			type: 'assistant',
			session_id: 'claude-prov-1',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'Write',
						input: { file_path: EDIT_PATH, content: FULL_EDIT },
					},
				],
			},
		},
		shell: {
			type: 'assistant',
			session_id: 'claude-prov-1',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_2',
						name: 'Bash',
						input: { command: SHELL_COMMAND, description: 'push the branch' },
					},
				],
			},
		},
	},
	{
		agentId: 'codex',
		parser: () => new CodexOutputParser(),
		providerSessionId: 'codex-prov-1',
		prose: [
			{ type: 'thread.started', thread_id: 'codex-prov-1' },
			{
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'assistant',
					phase: 'commentary',
					content: [{ type: 'output_text', text: 'I will add console.log(x) here' }],
				},
			},
			{ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'All done.' } },
		],
		// Gate A "partial": codex ships a patch, so only the added lines survive.
		edit: {
			type: 'response_item',
			payload: {
				type: 'custom_tool_call',
				name: 'apply_patch',
				call_id: 'call_1',
				arguments: JSON.stringify({
					patch: `*** Begin Patch\n*** Update File: ${EDIT_PATH}\n const x = 1;\n+console.log(x);\n*** End Patch`,
				}),
			},
		},
		shell: {
			type: 'item.started',
			item: { id: 'i2', type: 'command_execution', command: SHELL_COMMAND },
		},
	},
	{
		agentId: 'opencode',
		parser: () => new OpenCodeOutputParser(),
		providerSessionId: 'oc-prov-1',
		// No live prose: the text part only arrives once the turn is over.
		prose: [
			{ type: 'step_start', sessionID: 'oc-prov-1' },
			{
				type: 'tool_use',
				sessionID: 'oc-prov-1',
				part: { tool: 'view', state: { status: 'completed', input: { path: EDIT_PATH } } },
			},
			{ type: 'text', sessionID: 'oc-prov-1', part: { text: 'Added console.log(x) for you.' } },
		],
		edit: {
			type: 'tool_use',
			sessionID: 'oc-prov-1',
			part: {
				tool: 'write',
				state: { status: 'running', input: { path: EDIT_PATH, content: FULL_EDIT } },
			},
		},
		shell: {
			type: 'tool_use',
			sessionID: 'oc-prov-1',
			part: { tool: 'bash', state: { status: 'running', input: { command: SHELL_COMMAND } } },
		},
	},
	{
		agentId: 'factory-droid',
		parser: () => new FactoryDroidOutputParser(),
		providerSessionId: 'droid-prov-1',
		prose: [
			{ type: 'system', subtype: 'init', session_id: 'droid-prov-1' },
			{ type: 'message', role: 'assistant', text: 'Adding console.log(x) now' },
			{ type: 'completion', finalText: 'All done.', session_id: 'droid-prov-1' },
		],
		// No tool events at all - AST is infeasible, by design not by omission.
	},
	{
		agentId: 'copilot-cli',
		parser: () => new CopilotOutputParser(),
		// The session id only lands on the final event, which an aborted turn
		// never reaches -> degraded (fresh) reinject.
		prose: [
			{ type: 'assistant.message_delta', data: { deltaContent: 'Adding console.log(x) now' } },
			{ type: 'assistant.message', data: { content: 'All done.', phase: 'final_answer' } },
		],
		edit: {
			type: 'assistant.message',
			data: {
				content: '',
				phase: 'commentary',
				toolRequests: [
					{
						toolCallId: 'call_1',
						name: 'write',
						arguments: { path: EDIT_PATH, content: FULL_EDIT },
					},
				],
			},
		},
		shell: {
			type: 'tool.execution_start',
			data: { toolCallId: 'call_2', toolName: 'shell', arguments: { command: SHELL_COMMAND } },
		},
	},
	{
		agentId: 'grok',
		parser: () => new GrokOutputParser(),
		// Thinking deltas are the only structured stream; no tool telemetry.
		prose: [
			{ type: 'thought', data: 'maybe console.log(x) is enough' },
			{ type: 'text', data: 'All done.' },
		],
	},
];

// ── recorded matrix ──────────────────────────────────────────────────────────

type ProseAxis = 'live' | 'end-of-turn' | 'none';
type AstAxis = 'full' | 'partial' | 'none';
type ShellAxis = 'yes' | 'none';
type ResumeAxis = 'clean' | 'degraded' | 'none';
type Status = 'pass' | 'degraded' | 'excluded';

interface MatrixRow {
	prose: ProseAxis;
	ast: AstAxis;
	shell: ShellAxis;
	resume: ResumeAxis;
	status: Status;
}

/** The plan's scope summary table, as the acceptance criteria. */
const EXPECTED_MATRIX: Record<string, MatrixRow> = {
	'claude-code': { prose: 'live', ast: 'full', shell: 'yes', resume: 'clean', status: 'pass' },
	codex: { prose: 'live', ast: 'partial', shell: 'yes', resume: 'clean', status: 'pass' },
	opencode: { prose: 'end-of-turn', ast: 'full', shell: 'yes', resume: 'clean', status: 'pass' },
	'factory-droid': { prose: 'live', ast: 'none', shell: 'none', resume: 'clean', status: 'pass' },
	'copilot-cli': {
		prose: 'live',
		ast: 'full',
		shell: 'yes',
		resume: 'degraded',
		status: 'degraded',
	},
	grok: { prose: 'live', ast: 'none', shell: 'none', resume: 'degraded', status: 'degraded' },
	terminal: { prose: 'none', ast: 'none', shell: 'none', resume: 'none', status: 'excluded' },
};

/** Measure the ast axis from what the extractor actually recovers. */
function measureAst(fixture: AgentFixture): AstAxis {
	if (!fixture.edit) return 'none';
	const event = fixture.parser().parseJsonObject(fixture.edit as Record<string, unknown>);
	const snapshots = event ? extractToolSnapshots(event) : [];
	if (snapshots.length === 0) return 'none';
	return snapshots[0].content === FULL_EDIT ? 'full' : 'partial';
}

/** Measure the shell axis from whether the command actually reaches TTSR. */
function measureShell(fixture: AgentFixture): ShellAxis {
	if (!fixture.shell) return 'none';
	const event = fixture.parser().parseJsonObject(fixture.shell as Record<string, unknown>);
	const snapshots = event ? extractToolSnapshots(event) : [];
	return snapshots.some((s) => s.source === 'tool:bash' && s.content.includes(SHELL_COMMAND))
		? 'yes'
		: 'none';
}

describe('TTSR Gate A acceptance matrix', () => {
	const recorded: Record<string, MatrixRow> = {};

	describe.each(FIXTURES)('$agentId', (fixture) => {
		it('interrupts the turn and emits a corrective payload', async () => {
			const turn = await runTurn(fixture.agentId, fixture.parser(), fixture.prose, [PROSE_RULE]);

			expect(turn.signal).toBe('interrupt');
			expect(turn.abortedAt).toBeGreaterThanOrEqual(0);
			expect(turn.triggered).toHaveLength(1);

			const payload = turn.triggered[0];
			expect(payload.agentId).toBe(fixture.agentId);
			expect(payload.rules.map((ref) => ref.name)).toEqual(['no-console-log']);
			expect(payload.injectionPrompt).toContain('Use the project logger instead of console.log.');
			expect(payload.originalGoal).toBe(GOAL);
			expect(payload.contextMode).toBe('keep');

			if (fixture.providerSessionId) {
				// Clean resume: the corrective turn re-attaches to the conversation, so
				// the goal does not need restating.
				expect(payload.mode).toBe('resume');
				expect(payload.providerSessionId).toBe(fixture.providerSessionId);
			} else {
				// Degraded: no id was published before the abort, so the corrective
				// turn respawns fresh and has to carry the goal itself.
				expect(payload.mode).toBe('fresh');
				expect(payload.providerSessionId).toBeUndefined();
				expect(payload.injectionPrompt).toContain(GOAL);
			}

			recorded[fixture.agentId] = {
				prose: turn.abortedAt < turn.lineCount - 1 ? 'live' : 'end-of-turn',
				ast: measureAst(fixture),
				shell: measureShell(fixture),
				resume: payload.mode === 'resume' ? 'clean' : 'degraded',
				status: payload.mode === 'resume' ? 'pass' : 'degraded',
			};
		});

		it('matches structurally on edits exactly where the parser surfaces content', async () => {
			const ast = measureAst(fixture);
			const turn = await runTurn(
				fixture.agentId,
				fixture.parser(),
				fixture.edit ? [fixture.edit] : [],
				[AST_RULE]
			);

			if (ast === 'none') {
				// No tool content reaches TTSR, so an astCondition rule is inert here -
				// the plan's stated limit for factory-droid and grok, not a regression.
				expect(turn.signal).toBeNull();
				expect(turn.triggered).toEqual([]);
				return;
			}

			expect(turn.signal).toBe('interrupt');
			expect(turn.triggered).toHaveLength(1);
			expect(turn.triggered[0].rules.map((ref) => ref.name)).toEqual(['no-console-log-ast']);
		});

		it('matches shell commands exactly where the parser surfaces them', async () => {
			const shell = measureShell(fixture);
			const turn = await runTurn(
				fixture.agentId,
				fixture.parser(),
				fixture.shell ? [fixture.shell] : [],
				[BASH_RULE]
			);

			if (shell === 'none') {
				// factory-droid and grok emit no tool events, so "never run X" is not
				// expressible for them - a stated Gate A limit, not a regression.
				expect(turn.signal).toBeNull();
				expect(turn.triggered).toEqual([]);
				return;
			}

			expect(turn.signal).toBe('interrupt');
			expect(turn.triggered).toHaveLength(1);
			expect(turn.triggered[0].rules.map((ref) => ref.name)).toEqual(['no-force-push']);
		});

		it('is a total no-op with the feature gate off', async () => {
			const lines = fixture.edit ? [...fixture.prose, fixture.edit] : fixture.prose;
			const turn = await runTurn(fixture.agentId, fixture.parser(), lines, [PROSE_RULE, AST_RULE], {
				enabled: false,
			});

			expect(turn.signal).toBeNull();
			expect(turn.triggered).toEqual([]);
			// Not even the project's rules are read: the gate short-circuits ahead of
			// every filesystem and matching cost, so an off feature is free.
			expect(turn.readRules).toBe(false);
		});
	});

	it('excludes terminal: nothing is registered, so the tap never runs', async () => {
		const turn = await runTurn(
			'terminal',
			new ClaudeOutputParser(),
			[{ type: 'assistant', message: { role: 'assistant', content: 'console.log(x)' } }],
			[PROSE_RULE]
		);

		expect(turn.signal).toBeNull();
		expect(turn.triggered).toEqual([]);
		recorded.terminal = {
			prose: 'none',
			ast: 'none',
			shell: 'none',
			resume: 'none',
			status: 'excluded',
		};
	});

	it('records the matrix the plan promises, measured rather than declared', () => {
		expect(recorded).toEqual(EXPECTED_MATRIX);

		// The recorded behaviour and the Gate A table have to agree; a drift here
		// means one of the two is lying about what an agent can do.
		for (const [agentId, row] of Object.entries(recorded)) {
			const cap = TTSR_AGENT_CAPABILITIES[agentId as AgentId];
			expect({ agentId, ast: row.ast }).toEqual({ agentId, ast: cap.ast });
			expect({ agentId, resume: row.resume }).toEqual({ agentId, resume: cap.resume });
			// `shellEvents` is what the loader defaults a tool:bash rule's agents
			// from, so a parser that stops surfacing commands must fail here rather
			// than leave those rules silently inert.
			expect({ agentId, shell: row.shell === 'yes' }).toEqual({
				agentId,
				shell: cap.shellEvents,
			});
			if (row.status !== 'excluded') {
				expect({ agentId, live: row.prose === 'live' }).toEqual({
					agentId,
					live: cap.liveProse || cap.liveThinking,
				});
			}
		}
	});
});
