// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/cli/services/agent-run-lock.test.ts
// Source: src/__tests__/cli/services/agent-run-store-concurrency.test.ts
// Source: src/__tests__/cli/services/mcp-bridge.test.ts
// Source: src/__tests__/cli/services/pianola-store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as s1_fs from 'fs';
import * as s1_os from 'os';
import * as s1_path from 'path';
import { withStoreLock } from '../../../cli/services/agent-run-lock';
import * as s2_fs from 'fs';
import * as s2_os from 'os';
import * as s2_path from 'path';
import {
	appendAgentRunEvent,
	readAgentRunEvents,
	readAgentRuns,
	readCampaigns,
	upsertAgentRun,
	writeAgentRuns,
	writeCampaigns,
	type AgentRun,
	type AgentRunEvent,
	type Campaign,
} from '../../../cli/services/agent-run-store';
import * as s3_fs from 'node:fs';
import * as s3_path from 'node:path';
import * as ts from 'typescript';
import { createMcpBridge, MCP_CALL_TIMEOUT_MS } from '../../../cli/services/mcp-bridge';
import * as s4_fs from 'fs';
import * as s4_os from 'os';
import * as s4_path from 'path';
import {
	readPianolaRules,
	appendPianolaDecision,
	readPianolaDecisions,
} from '../../../cli/services/pianola-store';
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	type PianolaDecisionRecord,
} from '../../../shared/pianola/storage';
// Source: src/__tests__/cli/services/agent-run-lock.test.ts
describe('', () => {
	const LOCK_DIR_NAME = 'maestro-agent-store.lock';
	const STALE_LOCK_MS = 30000;
	let tmpDir: string;
	let lockDir: string;
	let holderPath: string;
	let prevEnv: string | undefined;
	beforeEach(() => {
		prevEnv = process.env.MAESTRO_USER_DATA;
		tmpDir = s1_fs.mkdtempSync(s1_path.join(s1_os.tmpdir(), 'agent-run-lock-'));
		process.env.MAESTRO_USER_DATA = tmpDir;
		lockDir = s1_path.join(tmpDir, LOCK_DIR_NAME);
		holderPath = s1_path.join(lockDir, 'holder');
	});
	afterEach(() => {
		if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = prevEnv;
		s1_fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	describe('withStoreLock', () => {
		it('runs fn, returns its value, and releases the lock dir', () => {
			expect(s1_fs.existsSync(lockDir)).toBe(false);
			let sawLockHeld = false;
			const result = withStoreLock(() => {
				// The lock dir must exist while fn runs.
				sawLockHeld = s1_fs.existsSync(lockDir);
				return 42;
			});
			expect(result).toBe(42);
			expect(sawLockHeld).toBe(true);
			expect(s1_fs.existsSync(lockDir)).toBe(false);
		});
		it('releases the lock dir even when fn throws, and propagates the throw', () => {
			expect(() =>
				withStoreLock(() => {
					throw new Error('boom from inside fn');
				})
			).toThrow('boom from inside fn');
			expect(s1_fs.existsSync(lockDir)).toBe(false);
		});
		it('times out and throws when a fresh lock dir is already held, without running fn', () => {
			// A just-created (fresh) lock dir: not stale, so it cannot be stolen.
			s1_fs.mkdirSync(lockDir);
			let fnRan = false;
			const start = Date.now();
			expect(() =>
				withStoreLock(
					() => {
						fnRan = true;
					},
					{ timeoutMs: 50 }
				)
			).toThrow(/agent-run store lock timeout after 50ms/);
			const elapsed = Date.now() - start;
			expect(fnRan).toBe(false);
			// It actually waited for (roughly) the timeout rather than failing instantly.
			expect(elapsed).toBeGreaterThanOrEqual(40);
			// The contended lock belongs to the (simulated) other holder: not deleted.
			expect(s1_fs.existsSync(lockDir)).toBe(true);
		});
		it('steals a stale lock dir and runs fn to completion', () => {
			// A lock left behind by a crashed holder: dir present, mtime far in the past.
			s1_fs.mkdirSync(lockDir);
			s1_fs.writeFileSync(holderPath, JSON.stringify({ token: 'dead-holder', pid: 999 }), 'utf-8');
			const past = new Date(Date.now() - (STALE_LOCK_MS + 60000));
			s1_fs.utimesSync(lockDir, past, past);
			let fnRan = false;
			const result = withStoreLock(
				() => {
					fnRan = true;
					return 'stolen-and-ran';
				},
				{ timeoutMs: 200 }
			);
			expect(fnRan).toBe(true);
			expect(result).toBe('stolen-and-ran');
			// Our acquisition owned the fresh lock and released it in finally.
			expect(s1_fs.existsSync(lockDir)).toBe(false);
		});
		it('does not delete the lock dir in finally once ownership has changed hands', () => {
			// Simulate our lock being declared stale and stolen mid-run: the holder token
			// no longer matches ours, so finally must NOT destroy the new owner's lock.
			withStoreLock(() => {
				s1_fs.writeFileSync(
					holderPath,
					JSON.stringify({ token: 'a-different-owner', pid: 12345 }),
					'utf-8'
				);
			});
			expect(s1_fs.existsSync(lockDir)).toBe(true);
			const holder = JSON.parse(s1_fs.readFileSync(holderPath, 'utf-8')) as {
				token?: string;
			};
			expect(holder.token).toBe('a-different-owner');
		});
	});
});
// Source: src/__tests__/cli/services/agent-run-store-concurrency.test.ts
describe('', () => {
	const AGENT_RUN_EVENTS_FILE = 'maestro-agent-run-events.jsonl';
	let tmpDir: string;
	let prevEnv: string | undefined;
	beforeEach(() => {
		prevEnv = process.env.MAESTRO_USER_DATA;
		tmpDir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'agent-run-store-conc-'));
		process.env.MAESTRO_USER_DATA = tmpDir;
	});
	afterEach(() => {
		if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = prevEnv;
		s2_fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
		id: 'run-1',
		createdAt: 100,
		updatedAt: 100,
		provider: 'claude-code',
		status: 'queued',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		...overrides,
	});
	const event = (overrides: Partial<AgentRunEvent> = {}): AgentRunEvent => ({
		id: 'event-1',
		runId: 'run-1',
		timestamp: 200,
		type: 'status',
		...overrides,
	});
	const campaign = (overrides: Partial<Campaign> = {}): Campaign => ({
		id: 'campaign-1',
		title: 'Campaign One',
		createdAt: 100,
		updatedAt: 100,
		status: 'queued',
		runIds: [],
		tasks: [],
		...overrides,
	});
	describe('agent-run store write-safety', () => {
		it('persists two sequential upserts of different run ids without dropping either', () => {
			// The classic lost-update shape: the second upsert must re-read the snapshot
			// the first one committed, not an empty in-memory baseline.
			upsertAgentRun(run({ id: 'run-a' }));
			upsertAgentRun(run({ id: 'run-b' }));
			const ids = readAgentRuns()
				.map((entry) => entry.id)
				.sort();
			expect(ids).toEqual(['run-a', 'run-b']);
		});
		it('appends events for two different runs: both JSONL lines land and each snapshot updates', () => {
			writeAgentRuns([
				run({ id: 'run-a', status: 'running', updatedAt: 100 }),
				run({ id: 'run-b', status: 'running', updatedAt: 100 }),
			]);
			appendAgentRunEvent(
				event({ id: 'ev-a', runId: 'run-a', type: 'status', status: 'completed', timestamp: 500 })
			);
			appendAgentRunEvent(
				event({ id: 'ev-b', runId: 'run-b', type: 'status', status: 'failed', timestamp: 600 })
			);
			// The JSONL append is additive: both lines survive on disk in order.
			const rawLines = s2_fs
				.readFileSync(s2_path.join(tmpDir, AGENT_RUN_EVENTS_FILE), 'utf-8')
				.trim()
				.split('\n');
			expect(rawLines.map((line) => (JSON.parse(line) as AgentRunEvent).id)).toEqual([
				'ev-a',
				'ev-b',
			]);
			// Each run's events are retrievable independently through the public reader.
			expect(readAgentRunEvents('run-a').map((e) => e.id)).toEqual(['ev-a']);
			expect(readAgentRunEvents('run-b').map((e) => e.id)).toEqual(['ev-b']);
			// Each run snapshot picked up its own event's status + timestamp, no cross-talk.
			const runs = new Map(readAgentRuns().map((entry) => [entry.id, entry]));
			expect(runs.get('run-a')).toMatchObject({ status: 'completed', updatedAt: 500 });
			expect(runs.get('run-b')).toMatchObject({ status: 'failed', updatedAt: 600 });
		});
		it('round-trips writeAgentRuns full-snapshot writes through readAgentRuns', () => {
			writeAgentRuns([
				run({ id: 'run-a', status: 'running', updatedAt: 10 }),
				run({ id: 'run-b', status: 'completed', updatedAt: 20 }),
			]);
			const persisted = new Map(readAgentRuns().map((entry) => [entry.id, entry]));
			expect([...persisted.keys()].sort()).toEqual(['run-a', 'run-b']);
			expect(persisted.get('run-a')).toMatchObject({ status: 'running', updatedAt: 10 });
			expect(persisted.get('run-b')).toMatchObject({ status: 'completed', updatedAt: 20 });
		});
		it('round-trips writeCampaigns full-snapshot writes through readCampaigns', () => {
			writeCampaigns([
				campaign({ id: 'campaign-a', title: 'Alpha', status: 'running', updatedAt: 10 }),
				campaign({ id: 'campaign-b', title: 'Beta', status: 'complete', updatedAt: 20 }),
			]);
			const persisted = new Map(readCampaigns().map((entry) => [entry.id, entry]));
			expect([...persisted.keys()].sort()).toEqual(['campaign-a', 'campaign-b']);
			expect(persisted.get('campaign-a')).toMatchObject({ title: 'Alpha', status: 'running' });
			expect(persisted.get('campaign-b')).toMatchObject({ title: 'Beta', status: 'complete' });
		});
	});
});
// Source: src/__tests__/cli/services/mcp-bridge.test.ts
describe('', () => {
	const serverInfo = { name: 'maestro-plugins', version: '1.0.0' };
	const log = (): void => {};
	describe('createMcpBridge - listTools', () => {
		it('maps app tool entries to MCP defs with a default inputSchema', async () => {
			const request = vi.fn(async () => ({
				tools: [{ name: 'p__a', toolId: 'p/a', description: 'd' }],
			}));
			const tools = await createMcpBridge({ serverInfo, request, log }).listTools();
			expect(tools).toEqual([{ name: 'p__a', description: 'd', inputSchema: { type: 'object' } }]);
		});
		it('de-collides duplicate sanitized names and routes the call to the right toolId', async () => {
			const request = vi.fn();
			request.mockResolvedValueOnce({
				tools: [
					{ name: 'p__a', toolId: 'p/a' },
					{ name: 'p__a', toolId: 'p/a2' },
				],
			});
			const bridge = createMcpBridge({ serverInfo, request, log });
			const tools = await bridge.listTools();
			expect(tools.map((t) => t.name)).toEqual(['p__a', 'p__a__2']);
			request.mockResolvedValueOnce({ ok: true, result: 'R' });
			await bridge.callTool('p__a__2', {});
			expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
				type: 'plugins_call_tool',
				toolId: 'p/a2',
			});
		});
		it('advertises zero tools when the app is unreachable', async () => {
			const request = vi.fn(async () => {
				throw new Error('Not connected to Maestro');
			});
			const tools = await createMcpBridge({ serverInfo, request, log }).listTools();
			expect(tools).toEqual([]);
		});
	});
	describe('createMcpBridge - callTool', () => {
		it('maps a risk-gate block to an isError result', async () => {
			const request = vi.fn();
			request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
			const bridge = createMcpBridge({ serverInfo, request, log });
			await bridge.listTools();
			request.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'high-risk prompt' });
			const r = await bridge.callTool('p__a', {});
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toContain('risk gate');
		});
		it('maps a tool failure to an isError result', async () => {
			const request = vi.fn();
			request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
			const bridge = createMcpBridge({ serverInfo, request, log });
			await bridge.listTools();
			request.mockResolvedValueOnce({ ok: false, error: 'boom' });
			const r = await bridge.callTool('p__a', {});
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toContain('boom');
		});
		it('rejects an unmapped tool name without calling the app', async () => {
			const request = vi.fn();
			const r = await createMcpBridge({ serverInfo, request, log }).callTool('never-listed', {});
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toContain('Unknown tool');
			expect(request).not.toHaveBeenCalled();
		});
		it('maps a success to text content, with mapped toolId and the long call timeout', async () => {
			const request = vi.fn();
			request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
			const bridge = createMcpBridge({ serverInfo, request, log });
			await bridge.listTools();
			request.mockResolvedValueOnce({ ok: true, result: { v: 1 } });
			const r = await bridge.callTool('p__a', { q: 2 });
			expect(r.isError).toBeUndefined();
			expect(r.content[0].text).toBe(JSON.stringify({ v: 1 }));
			const lastCall = request.mock.calls.at(-1);
			expect(lastCall?.[0]).toMatchObject({
				type: 'plugins_call_tool',
				toolId: 'p/a',
				args: { q: 2 },
			});
			expect(lastCall?.[2]).toBe(MCP_CALL_TIMEOUT_MS);
		});
		it('forwards the opaque run proof separately from model arguments', async () => {
			const request = vi.fn();
			request.mockResolvedValueOnce({ tools: [{ name: 'p__send', toolId: 'p/send' }] });
			const bridge = createMcpBridge({ serverInfo, request, log, runToken: 'a'.repeat(64) });
			await bridge.listTools();
			request.mockResolvedValueOnce({ ok: true, result: 'sent' });
			await bridge.callTool('p__send', { agentId: 'forged' });
			expect(request.mock.calls.at(-1)?.[0]).toEqual({
				type: 'plugins_call_tool',
				toolId: 'p/send',
				args: { agentId: 'forged' },
				runToken: 'a'.repeat(64),
			});
		});
	});
	describe('actual mcpServe proof configuration', () => {
		it.each([
			{ file: undefined, content: undefined, configured: false, token: undefined },
			{
				file: '/synthetic/proof',
				content: 'a'.repeat(64),
				configured: true,
				token: 'a'.repeat(64),
			},
			{ file: '/synthetic/missing', content: new Error('ENOENT'), configured: true, token: null },
			{ file: '/synthetic/denied', content: new Error('EACCES'), configured: true, token: null },
			{ file: '/synthetic/empty', content: '', configured: true, token: '' },
			{ file: '/synthetic/malformed', content: 'malformed', configured: true, token: 'malformed' },
		])(
			'separates absent configuration from unusable proof $file',
			async ({ file, content, configured, token }) => {
				const source = s3_fs.readFileSync(
					s3_path.join(__dirname, '../../../cli/commands/mcp.ts'),
					'utf8'
				);
				const sf = ts.createSourceFile('mcp.ts', source, ts.ScriptTarget.Latest, true);
				let argument: ts.Expression | undefined;
				const visit = (node: ts.Node): void => {
					if (ts.isCallExpression(node) && node.expression.getText(sf) === 'createMcpBridge')
						argument = node.arguments[0];
					ts.forEachChild(node, visit);
				};
				visit(sf);
				expect(argument).toBeDefined();
				const request = vi.fn().mockResolvedValue({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
				const readFileSync = vi.fn(() => {
					if (content instanceof Error) throw content;
					return content;
				});
				const js = ts.transpileModule(`const captured = ${argument!.getText(sf)};`, {
					compilerOptions: { target: ts.ScriptTarget.ES2024 },
				}).outputText;
				const deps = new Function('process', 'fs', 'client', 'log', `${js};return captured;`)(
					{ env: file ? { MAESTRO_PLUGIN_RUN_TOKEN_FILE: file } : {} },
					{ readFileSync },
					{ sendCommand: request },
					log
				) as Parameters<typeof createMcpBridge>[0];
				expect(Object.prototype.hasOwnProperty.call(deps, 'runToken')).toBe(configured);
				expect(deps.runToken).toBe(token);
				expect(readFileSync).toHaveBeenCalledTimes(file ? 1 : 0);
				const bridge = createMcpBridge(deps);
				await bridge.listTools();
				request.mockResolvedValue({ ok: true, result: 'synthetic' });
				const result = await bridge.callTool('p__a', {});
				const invalid = configured && (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token));
				expect(result.isError === true).toBe(invalid);
				expect(request).toHaveBeenCalledTimes(invalid ? 1 : 2);
				if (!configured) expect(request.mock.calls.at(-1)?.[0]).not.toHaveProperty('runToken');
			}
		);
	});
});
// Source: src/__tests__/cli/services/pianola-store.test.ts
describe('', () => {
	let tmpDir: string;
	let prevEnv: string | undefined;
	beforeEach(() => {
		prevEnv = process.env.MAESTRO_USER_DATA;
		tmpDir = s4_fs.mkdtempSync(s4_path.join(s4_os.tmpdir(), 'pianola-store-'));
		process.env.MAESTRO_USER_DATA = tmpDir;
	});
	afterEach(() => {
		if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = prevEnv;
		s4_fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	function writeRulesFile(content: string): void {
		s4_fs.writeFileSync(s4_path.join(tmpDir, PIANOLA_RULES_FILENAME), content, 'utf-8');
	}
	function decisionRecord(id: string): PianolaDecisionRecord {
		return {
			id,
			timestamp: '2026-01-01T00:00:00.000Z',
			tabId: 'tab-1',
			agentId: 'agent-1',
			classification: {
				kind: 'question',
				risk: 'low',
				topic: 'tabs',
				confidence: 'medium',
				evidence: { messageId: 'm1', reason: 'test', structured: false },
			},
			decision: { action: 'escalate', matchedRuleId: null, reason: 'default' },
			dispatched: false,
			dryRun: true,
		};
	}
	describe('readPianolaRules', () => {
		it('returns [] when the rules file is missing', () => {
			expect(readPianolaRules()).toEqual([]);
		});
		it('reads a bare array of rules', () => {
			writeRulesFile(
				JSON.stringify([
					{
						id: 'r1',
						enabled: true,
						scope: 'global',
						match: { maxRisk: 'low' },
						action: 'auto_answer',
						answer: 'ok',
						priority: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				])
			);
			expect(readPianolaRules().map((r) => r.id)).toEqual(['r1']);
		});
		it('reads an electron-store style { rules: [...] } object', () => {
			writeRulesFile(
				JSON.stringify({
					rules: [
						{
							id: 'r2',
							enabled: true,
							scope: 'global',
							match: {},
							action: 'escalate',
							priority: 1,
							createdAt: 1,
							updatedAt: 1,
						},
					],
				})
			);
			expect(readPianolaRules().map((r) => r.id)).toEqual(['r2']);
		});
		it('returns [] for malformed JSON', () => {
			writeRulesFile('{ not json');
			expect(readPianolaRules()).toEqual([]);
		});
		it('drops individual invalid rules', () => {
			writeRulesFile(
				JSON.stringify([
					{
						id: 'good',
						enabled: true,
						scope: 'global',
						action: 'escalate',
						priority: 1,
						createdAt: 1,
						updatedAt: 1,
					},
					{ id: 'bad', scope: 'planet' },
				])
			);
			expect(readPianolaRules().map((r) => r.id)).toEqual(['good']);
		});
	});
	describe('decision audit log', () => {
		it('returns [] when the log is missing', () => {
			expect(readPianolaDecisions()).toEqual([]);
		});
		it('appends and reads back records in order', () => {
			appendPianolaDecision(decisionRecord('d1'));
			appendPianolaDecision(decisionRecord('d2'));
			expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
		});
		it('honors a tail limit', () => {
			appendPianolaDecision(decisionRecord('d1'));
			appendPianolaDecision(decisionRecord('d2'));
			appendPianolaDecision(decisionRecord('d3'));
			expect(readPianolaDecisions(2).map((r) => r.id)).toEqual(['d2', 'd3']);
		});
		it('skips a corrupt line without failing the read', () => {
			appendPianolaDecision(decisionRecord('d1'));
			s4_fs.appendFileSync(s4_path.join(tmpDir, PIANOLA_DECISIONS_FILENAME), 'not json\n', 'utf-8');
			appendPianolaDecision(decisionRecord('d2'));
			expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
		});
		it('skips a schema-invalid JSON line', () => {
			appendPianolaDecision(decisionRecord('d1'));
			s4_fs.appendFileSync(
				s4_path.join(tmpDir, PIANOLA_DECISIONS_FILENAME),
				'{"foo":1}\n',
				'utf-8'
			);
			expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1']);
		});
		it('folds an intent and outcome record sharing an id (last wins, position kept)', () => {
			const intent = { ...decisionRecord('same'), dispatched: false };
			const outcome = { ...decisionRecord('same'), dispatched: true };
			appendPianolaDecision(decisionRecord('first'));
			appendPianolaDecision(intent);
			appendPianolaDecision(outcome);
			const records = readPianolaDecisions();
			expect(records.map((r) => r.id)).toEqual(['first', 'same']);
			expect(records[1].dispatched).toBe(true);
		});
	});
});
