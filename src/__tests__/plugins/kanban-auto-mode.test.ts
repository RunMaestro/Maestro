/**
 * @file kanban-auto-mode.test.ts
 * @description Adversarial suite for Phase 07's run loop and execution
 * guardrails inside `examples/plugins/maestro-kanban/main.js`:
 * `askConductor()`/`settlePlanRun()`/`onPlanRunTimeout()` (the run loop that
 * turns a dispatched prompt into a parsed plan with no polling anywhere in
 * the path), `executePlanRun()` (the engine that turns an approved row into
 * the same move/dispatch a person causes by hand, with the halt check, the
 * WIP cap, and per-row idempotency wired in), and `autoDecidePlanRun()`/
 * `autoExecuteIfNeeded()` (fully auto's own decide-then-execute pass).
 *
 * `kanban-plan-parser.test.ts` already covers `parsePlan()`'s own adversarial
 * cases (illegal columns, card creation, the cap's accept-but-defer
 * behavior, ...) with no stub SDK at all, since that contract is pure; this
 * file is the layer above it, so a plan here is deliberately simple
 * (`parsePlan()` already proved it parses correctly) and the focus is on
 * what the run loop and the execution engine DO with a parsed plan: when a
 * run settles, what a missing or mismatched plan file does to it, how a
 * decision becomes a dispatch or a move, and how the halt/cap/access
 * guardrails hold even when nobody is clicking Approve.
 *
 * Every scenario runs on a single project board (never the Global board,
 * which `kanban-conductor.test.ts` already exercises for its own reach-sync
 * concerns) with `maestro.commands.register`/`maestro.events.on` captured off
 * a stub SDK, the same shape `kanban-conductor.test.ts` and
 * `kanban-messaging.test.ts` both use. A run is driven the way the host
 * actually drives it: `ask-conductor` to dispatch, a stubbed `fs.read` to
 * stand in for what the conductor would have written, and an emitted
 * `agent.completed` event to settle it - never by calling the unexported
 * `onPlanRunEvent`/`onPlanRunTimeout` directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface PlanRunResult {
	ok: boolean;
	error: string | null;
	raw: string | null;
	planId: string | null;
	version: number | null;
	rationale: string;
	moves: { cardKey: string; toColumnId: string; overCap: boolean; capReason: string | null }[];
	messages: {
		cardKey: string;
		sessionId: string;
		tabId: string;
		prompt: string;
		needsAccess: boolean;
		overCap: boolean;
		capReason: string | null;
	}[];
	rejected: { kind: string; cardKey: string | null; reason: string }[];
	cardsTouched: number;
	deferredCount: number;
	wipCap: number;
}

interface PlanRunSnapshot {
	planId: string;
	conductorSessionId: string;
	status: 'running' | 'parsed' | 'failed' | 'not-connected';
	startedAt: number;
	finishedAt: number | null;
	result: PlanRunResult | null;
	decisions: Record<string, boolean>;
	decidedAt: number | null;
	execution: Record<string, { status: string; reason: string | null }>;
	executedAt: number | null;
}

interface KanbanPlugin {
	activate: (maestro: unknown) => Promise<void>;
	deactivate: () => unknown;
	PLAN_CONTRACT_VERSION: number;
	PLAN_RUN_TIMEOUT_MS: number;
	PLAN_MODE_APPROVE: string;
	PLAN_MODE_AUTO: string;
	planFilePath: (boardId: string, planId: string) => string;
	planRunSnapshot: (boardId: string | null) => PlanRunSnapshot | null;
	setPlanSettings: (
		boardId: string,
		patch: Record<string, unknown>
	) => Promise<{ settings: unknown; persisted: boolean }>;
	isBoardHalted: (boardId: string | null) => boolean;
}

/** Fresh module state per test: main.js keeps its card/plan-run/grant model in
 * module-level variables, so the require cache entry must be dropped before
 * every require(). Mirrors every other kanban-*.test.ts's loadMain(). */
function loadMain(): KanbanPlugin {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanPlugin;
}

interface StubOptions {
	storage?: Record<string, string>;
	tabsList?: () => Promise<unknown>;
	sessionsRequestAccess?: (sessionId: string) => Promise<unknown>;
	agentsDispatch?: (sessionId: string, prompt: string, opts?: unknown) => Promise<unknown>;
}

/** An in-memory `maestro.storage`/stubbed `maestro.sessions`/`maestro.tabs`/
 * `maestro.agents`/`maestro.fs`, mirroring `kanban-conductor.test.ts`'s own
 * `createStubMaestro()` (this file needs the identical `sessions.create/get`
 * pair to stand up a conductor) plus `fsFiles`, a plain path->text map that
 * backs `fs.read`/`fs.write` directly - the plan file a conductor "writes" is
 * nothing more than a test setting an entry in this map before emitting the
 * completion event, and a board file no test ever writes stays absent, which
 * is exactly the ENOENT that makes every board here fall back to
 * `DEFAULT_COLUMNS`. */
function createStubMaestro(options: StubOptions = {}) {
	const storageStore = new Map<string, string>(Object.entries(options.storage ?? {}));
	const commandHandlers = new Map<string, (args?: unknown) => unknown>();
	const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
	const existingSessionIds = new Set<string>();
	const fsFiles = new Map<string, string>();
	let createCounter = 0;

	const maestro = {
		events: {
			on: vi.fn((topic: string, handler: (payload: unknown) => void) => {
				let set = eventHandlers.get(topic);
				if (!set) {
					set = new Set();
					eventHandlers.set(topic, set);
				}
				set.add(handler);
			}),
			subscribe: vi.fn(() => Promise.resolve({ ok: true })),
			unsubscribe: vi.fn(() => Promise.resolve({ ok: true })),
		},
		commands: {
			register: vi.fn((commandId: string, handler: (args?: unknown) => unknown) => {
				commandHandlers.set(commandId, handler);
			}),
		},
		sessions: {
			list: vi.fn(() => Promise.resolve([])),
			focus: vi.fn(() => Promise.resolve({ ok: true })),
			requestAccess: vi.fn(
				options.sessionsRequestAccess ?? (() => Promise.resolve({ granted: true }))
			),
			create: vi.fn((params: Record<string, unknown>) => {
				createCounter += 1;
				const id = 'conductor-' + createCounter;
				existingSessionIds.add(id);
				return Promise.resolve({ id, ...params });
			}),
			get: vi.fn((id: string) => Promise.resolve(existingSessionIds.has(id) ? { id } : null)),
			update: vi.fn(() => Promise.resolve({ ok: true })),
		},
		agents: {
			dispatch: vi.fn(options.agentsDispatch ?? (() => Promise.resolve({ ok: true }))),
			list: vi.fn(() => Promise.resolve([])),
		},
		tabs: {
			list: vi.fn(options.tabsList ?? (() => Promise.resolve([]))),
		},
		transcripts: {
			read: vi.fn(() => Promise.resolve([])),
		},
		ui: {
			panelPost: vi.fn((_panelId: string, _message: unknown) => Promise.resolve({ ok: true })),
			togglePanel: vi.fn(() => Promise.resolve({ ok: true })),
		},
		notifications: {
			toast: vi.fn(() => Promise.resolve({ ok: true })),
		},
		fs: {
			read: vi.fn((path: string) => {
				if (fsFiles.has(path)) return Promise.resolve(fsFiles.get(path)!);
				return Promise.reject(new Error('ENOENT: no such file or directory, ' + path));
			}),
			write: vi.fn((path: string, content: string) => {
				fsFiles.set(path, content);
				return Promise.resolve({ ok: true });
			}),
		},
		storage: {
			get: vi.fn((key: string) =>
				Promise.resolve(storageStore.has(key) ? storageStore.get(key) : null)
			),
			set: vi.fn((key: string, value: string) => {
				storageStore.set(key, value);
				return Promise.resolve({ ok: true });
			}),
			delete: vi.fn((key: string) => {
				storageStore.delete(key);
				return Promise.resolve({ ok: true });
			}),
			keys: vi.fn(() => Promise.resolve(Array.from(storageStore.keys()))),
		},
	};

	return { maestro, storageStore, commandHandlers, eventHandlers, fsFiles, existingSessionIds };
}

function emit(
	eventHandlers: Map<string, Set<(payload: unknown) => void>>,
	topic: string,
	payload: unknown
) {
	const set = eventHandlers.get(topic);
	if (!set) return;
	for (const handler of set) handler(payload);
}

function aiTab(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tab-1',
		sessionId: 'session-1',
		type: 'ai',
		title: 'My Tab',
		status: 'idle',
		createdAt: 1,
		...overrides,
	};
}

/** `sessionId::tabId` - the exact format `cardKey()` builds in main.js. */
function ck(sessionId: string, tabId: string): string {
	return sessionId + '::' + tabId;
}

const PROJECT_PATH = '/Users/dev/projects/widgets';

/** A project board with the given tabs already on screen. Mirrors
 * `kanban-conductor.test.ts`'s own `globalStub()`, but scoped to one project
 * board rather than the Global board: this phase's execution guardrails
 * (legality, the cap, the halt, access) do not depend on the aggregation
 * Phase 03 adds, so a project board is the simpler fixture. */
function projectStub(extra: StubOptions = {}) {
	return createStubMaestro({
		...extra,
		storage: { 'selected-board': PROJECT_PATH, ...(extra.storage ?? {}) },
		tabsList: extra.tabsList ?? (() => Promise.resolve([])),
	});
}

/** Minimal, valid plan JSON for the board this file always asks for, with the
 * given moves/messages spliced in - the same shape `kanban-plan-parser.test.ts`'s
 * own `planText()` builds. */
function planJson(plugin: KanbanPlugin, planId: string, body: Record<string, unknown>): string {
	return JSON.stringify({
		version: plugin.PLAN_CONTRACT_VERSION,
		planId: planId,
		rationale: 'test rationale',
		moves: [],
		messages: [],
		...body,
	});
}

/** Stands up a conductor for `PROJECT_PATH` and returns its session id. */
async function createConductor(
	commandHandlers: Map<string, (args?: unknown) => unknown>
): Promise<string> {
	await commandHandlers.get('conductor-config')!({ boardId: PROJECT_PATH, agentId: 'claude-code' });
	const result = (await commandHandlers.get('create-conductor')!({ boardId: PROJECT_PATH })) as {
		ok: boolean;
		conductorId: string;
	};
	expect(result.ok).toBe(true);
	return result.conductorId;
}

/** Asks the conductor for a plan and returns its freshly minted `planId`.
 * Resets `agents.dispatch`'s call history right after, so a caller's own
 * dispatch-count assertions start from the card-message dispatches this plan
 * eventually causes, not the conductor's own ask. */
async function askConductor(
	commandHandlers: Map<string, (args?: unknown) => unknown>
): Promise<string> {
	const result = (await commandHandlers.get('ask-conductor')!({ boardId: PROJECT_PATH })) as {
		ok: boolean;
		planId: string;
	};
	expect(result.ok).toBe(true);
	return result.planId;
}

/** Writes the conductor's plan file and settles the run the way the host
 * actually would: emit `agent.completed` for the conductor's session, then
 * flush the microtasks `settlePlanRun()` chains off of it. */
async function settle(
	plugin: KanbanPlugin,
	fsFiles: Map<string, string>,
	eventHandlers: Map<string, Set<(payload: unknown) => void>>,
	conductorId: string,
	planId: string,
	body: Record<string, unknown>
) {
	fsFiles.set(plugin.planFilePath(PROJECT_PATH, planId), planJson(plugin, planId, body));
	emit(eventHandlers, 'agent.completed', { sessionId: conductorId });
	await vi.advanceTimersByTimeAsync(0);
}

describe('maestro-kanban Phase 07 run loop and execution guardrails', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('a plan run', () => {
		it('dispatches exactly once, settles off the completion event rather than polling, and reads the plan file rather than calling transcripts.read', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub();
			await plugin.activate(maestro);
			const conductorId = await createConductor(commandHandlers);

			const planId = await askConductor(commandHandlers);
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1);
			expect(maestro.agents.dispatch).toHaveBeenCalledWith(conductorId, expect.any(String));
			expect(plugin.planRunSnapshot(PROJECT_PATH)!.status).toBe('running');

			// No event has fired yet: five seconds of elapsed virtual time must not
			// flip the run on its own, since this run loop never polls session or
			// tab state to decide a turn is done.
			await vi.advanceTimersByTimeAsync(5000);
			expect(plugin.planRunSnapshot(PROJECT_PATH)!.status).toBe('running');
			expect(maestro.transcripts.read).not.toHaveBeenCalled();

			const planPath = plugin.planFilePath(PROJECT_PATH, planId);
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {});

			expect(maestro.fs.read).toHaveBeenCalledWith(planPath);
			expect(maestro.transcripts.read).not.toHaveBeenCalled();
			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.status).toBe('parsed');
			expect(run.result!.ok).toBe(true);
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1);
		});
	});

	describe('a completion with no plan file', () => {
		it('lands in the specific "finished without writing" failure state, never an empty plan', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers, eventHandlers } = projectStub();
			await plugin.activate(maestro);
			const conductorId = await createConductor(commandHandlers);
			await askConductor(commandHandlers);

			// No fsFiles entry is ever written for this planId: the conductor
			// "finished" its turn but never wrote the file askConductor() asked for.
			emit(eventHandlers, 'agent.completed', { sessionId: conductorId });
			await vi.advanceTimersByTimeAsync(0);

			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.status).toBe('failed');
			expect(run.result!.ok).toBe(false);
			expect(run.result!.error).toContain('finished without writing this plan');
		});
	});

	describe('a completion with a mismatched planId', () => {
		it('lands in a specific failure state rather than executing a plan for a different request', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub();
			await plugin.activate(maestro);
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);

			// The file is written at the right path, but its own `planId` field
			// answers a different request than the one this run asked for.
			fsFiles.set(
				plugin.planFilePath(PROJECT_PATH, planId),
				planJson(plugin, 'plan-some-other-request', {})
			);
			emit(eventHandlers, 'agent.completed', { sessionId: conductorId });
			await vi.advanceTimersByTimeAsync(0);

			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.status).toBe('failed');
			expect(run.result!.ok).toBe(false);
			expect(run.result!.error).toContain('a different request');
		});
	});

	describe('a turn that never completes', () => {
		it('times out into a failure state rather than waiting forever', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = projectStub();
			await plugin.activate(maestro);
			await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);

			expect(plugin.planRunSnapshot(PROJECT_PATH)!.status).toBe('running');
			await vi.advanceTimersByTimeAsync(plugin.PLAN_RUN_TIMEOUT_MS + 1000);

			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.status).toBe('failed');
			expect(run.result!.ok).toBe(false);
			expect(run.result!.error).toContain('did not finish this plan within the time');
			// A timeout never touches the plan file at all. Asserted against THIS
			// run's real plan id: a hardcoded placeholder id passes whether or not
			// the timeout reads anything, since no call could ever name it.
			expect(maestro.fs.read).not.toHaveBeenCalledWith(
				expect.stringContaining(plugin.planFilePath(PROJECT_PATH, planId))
			);
		});
	});

	describe('approval', () => {
		it('executes only the checked rows, leaving an unchecked one undone', async () => {
			const plugin = loadMain();
			const cardAKey = ck('session-a', 'tab-a');
			const cardBKey = ck('session-b', 'tab-b');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath: PROJECT_PATH }),
						aiTab({ id: 'tab-b', sessionId: 'session-b', projectPath: PROJECT_PATH }),
					]),
			});
			await plugin.activate(maestro);
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				moves: [
					{ cardKey: cardAKey, toColumnId: 'in-progress', why: 'ready' },
					{ cardKey: cardBKey, toColumnId: 'review', why: 'also ready' },
				],
			});

			await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['move:' + cardAKey],
			});

			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.decisions['move:' + cardAKey]).toBe(true);
			expect(run.decisions['move:' + cardBKey]).toBe(false);
			expect(run.execution['move:' + cardAKey]).toMatchObject({ status: 'moved' });
			expect(run.execution['move:' + cardBKey]).toBeUndefined();

			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				columns: { id: string; cards: { key: string }[] }[];
			};
			const columnOf = (key: string) =>
				snapshot.columns.find((column) => column.cards.some((card) => card.key === key))?.id;
			expect(columnOf(cardAKey)).toBe('in-progress');
			expect(columnOf(cardBKey)).toBe('backlog');
		});
	});

	describe('approving a needsAccess row', () => {
		it('requests access exactly once and dispatches only once access is granted', async () => {
			const plugin = loadMain();
			const cardCKey = ck('session-c', 'tab-c');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-c', sessionId: 'session-c', projectPath: PROJECT_PATH }),
					]),
				sessionsRequestAccess: () => Promise.resolve({ granted: true }),
			});
			await plugin.activate(maestro);
			// Deliberately never calls 'request-access' for session-c: this card
			// stays ungranted until the approval itself asks on its behalf.
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				messages: [{ cardKey: cardCKey, prompt: 'please add a test', why: 'coverage gap' }],
			});
			expect(plugin.planRunSnapshot(PROJECT_PATH)!.result!.messages[0]!.needsAccess).toBe(true);

			await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['message:' + cardCKey],
			});

			expect(maestro.sessions.requestAccess).toHaveBeenCalledTimes(1);
			expect(maestro.sessions.requestAccess).toHaveBeenCalledWith('session-c');
			expect(maestro.agents.dispatch).toHaveBeenCalledWith('session-c', 'please add a test', {
				tabId: 'tab-c',
			});
			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.execution['message:' + cardCKey]).toMatchObject({ status: 'sent' });
		});
	});

	describe('declining access for a needsAccess row', () => {
		it('records declined-access and never dispatches the message', async () => {
			const plugin = loadMain();
			const cardCKey = ck('session-c', 'tab-c');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-c', sessionId: 'session-c', projectPath: PROJECT_PATH }),
					]),
				sessionsRequestAccess: () => Promise.resolve({ granted: false }),
			});
			await plugin.activate(maestro);
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				messages: [{ cardKey: cardCKey, prompt: 'please add a test', why: 'coverage gap' }],
			});

			await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['message:' + cardCKey],
			});

			expect(maestro.sessions.requestAccess).toHaveBeenCalledTimes(1);
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1); // the conductor's own ask only
			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.execution['message:' + cardCKey]).toMatchObject({ status: 'declined-access' });
		});
	});

	describe('fully auto', () => {
		it('decides and executes every row except a needsAccess message, which is left pending for a person', async () => {
			const plugin = loadMain();
			const cardAKey = ck('session-a', 'tab-a');
			const cardGrantedKey = ck('session-granted', 'tab-granted');
			const cardUngrantedKey = ck('session-ungranted', 'tab-ungranted');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath: PROJECT_PATH }),
						aiTab({
							id: 'tab-granted',
							sessionId: 'session-granted',
							projectPath: PROJECT_PATH,
						}),
						aiTab({
							id: 'tab-ungranted',
							sessionId: 'session-ungranted',
							projectPath: PROJECT_PATH,
						}),
					]),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-granted' });
			await plugin.setPlanSettings(PROJECT_PATH, { mode: plugin.PLAN_MODE_AUTO });
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);
			// Only the explicit grant above may have asked for access so far;
			// clear it so the assertion below is about what settling the plan
			// itself does, not what the test's own setup already did.
			maestro.sessions.requestAccess.mockClear();

			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				moves: [{ cardKey: cardAKey, toColumnId: 'in-progress', why: 'ready' }],
				messages: [
					{ cardKey: cardGrantedKey, prompt: 'granted message', why: 'ok' },
					{ cardKey: cardUngrantedKey, prompt: 'ungranted message', why: 'needs OK' },
				],
			});

			// No approve-plan call anywhere above: fully auto decided and executed
			// this on its own the instant the plan parsed.
			expect(maestro.sessions.requestAccess).not.toHaveBeenCalled();
			let run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.execution['move:' + cardAKey]).toMatchObject({ status: 'moved' });
			expect(run.execution['message:' + cardGrantedKey]).toMatchObject({ status: 'sent' });
			expect(run.decisions['message:' + cardUngrantedKey]).toBeUndefined();
			expect(run.execution['message:' + cardUngrantedKey]).toBeUndefined();
			// A needsAccess row left undecided must not block the run from ever
			// being marked executed once a person deals with it.
			expect(run.executedAt).toBeNull();

			// A person later approves that one remaining row by hand, through the
			// exact same action the plan-and-approve surface uses.
			await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['message:' + cardUngrantedKey],
			});
			expect(maestro.sessions.requestAccess).toHaveBeenCalledTimes(1);
			expect(maestro.sessions.requestAccess).toHaveBeenCalledWith('session-ungranted');
			run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.execution['message:' + cardUngrantedKey]).toMatchObject({ status: 'sent' });
			expect(run.executedAt).not.toBeNull();
		});
	});

	describe('the WIP cap', () => {
		it('bounds in-flight dispatches during execution and leaves the excess pending, never dropped', async () => {
			const plugin = loadMain();
			const cardOneKey = ck('session-1', 'tab-1');
			const cardTwoKey = ck('session-2', 'tab-2');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath: PROJECT_PATH }),
						aiTab({ id: 'tab-2', sessionId: 'session-2', projectPath: PROJECT_PATH }),
					]),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
			await commandHandlers.get('request-access')!({ sessionId: 'session-2' });
			await plugin.setPlanSettings(PROJECT_PATH, { wipCap: 1 });
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				messages: [
					{ cardKey: cardOneKey, prompt: 'first', why: 'a' },
					{ cardKey: cardTwoKey, prompt: 'second', why: 'b' },
				],
			});
			const parsed = plugin.planRunSnapshot(PROJECT_PATH)!.result!;
			expect(parsed.messages[0]!.overCap).toBe(false);
			expect(parsed.messages[1]!.overCap).toBe(true);
			// Only the conductor's own ask has dispatched so far; clear it so the
			// assertion below counts only what executing this plan dispatches.
			maestro.agents.dispatch.mockClear();

			await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['message:' + cardOneKey, 'message:' + cardTwoKey],
			});

			// Only the in-cap row was ever dispatched.
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1);
			expect(maestro.agents.dispatch).toHaveBeenCalledWith('session-1', 'first', {
				tabId: 'tab-1',
			});
			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.execution['message:' + cardOneKey]).toMatchObject({ status: 'sent' });
			expect(run.execution['message:' + cardTwoKey]).toMatchObject({ status: 'pending-cap' });
			// A row held as pending still counts as resolved for idempotency: a
			// repeat approval must not dispatch the held row either.
			expect(run.executedAt).not.toBeNull();
		});
	});

	describe('a halt', () => {
		it('stops execution mid-plan, leaving every row not yet reached untouched', async () => {
			const plugin = loadMain();
			const cardOneKey = ck('session-1', 'tab-1');
			const cardTwoKey = ck('session-2', 'tab-2');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath: PROJECT_PATH }),
						aiTab({ id: 'tab-2', sessionId: 'session-2', projectPath: PROJECT_PATH }),
					]),
				// The first dispatch's own resolution is where a second command (a
				// halt) lands while this plan's execution loop is still awaiting
				// it - the exact race executePlanRun()'s own halt re-check guards.
				agentsDispatch: async (sessionId: string, prompt: string, opts?: unknown) => {
					if (sessionId === 'session-1') {
						await plugin.setPlanSettings(PROJECT_PATH, { halted: true });
					}
					return { ok: true };
				},
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
			await commandHandlers.get('request-access')!({ sessionId: 'session-2' });
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				messages: [
					{ cardKey: cardOneKey, prompt: 'first', why: 'a' },
					{ cardKey: cardTwoKey, prompt: 'second', why: 'b' },
				],
			});
			// Only the conductor's own ask has dispatched so far; clear it so the
			// assertion below counts only what executing this plan dispatches.
			maestro.agents.dispatch.mockClear();

			await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['message:' + cardOneKey, 'message:' + cardTwoKey],
			});

			expect(plugin.isBoardHalted(PROJECT_PATH)).toBe(true);
			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.execution['message:' + cardOneKey]).toMatchObject({ status: 'sent' });
			// The second row was approved but never reached: no entry at all,
			// never a "failed" or "declined" outcome manufactured for it.
			expect(run.execution['message:' + cardTwoKey]).toBeUndefined();
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1);
			// Left unfinished on purpose: clearing the halt and re-approving still
			// has the second row to finish.
			expect(run.executedAt).toBeNull();
		});

		it('persists across a restart', async () => {
			const plugin = loadMain();
			const { maestro } = projectStub();
			await plugin.activate(maestro);
			await plugin.setPlanSettings(PROJECT_PATH, { halted: true });
			expect(plugin.isBoardHalted(PROJECT_PATH)).toBe(true);

			plugin.deactivate();
			const restarted = loadMain();
			await restarted.activate(maestro);

			expect(restarted.isBoardHalted(PROJECT_PATH)).toBe(true);
		});
	});

	describe('fully auto still enforces the halt', () => {
		it('a halt set after the ask but before the plan settles blocks execution entirely', async () => {
			const plugin = loadMain();
			const cardAKey = ck('session-a', 'tab-a');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath: PROJECT_PATH }),
					]),
			});
			await plugin.activate(maestro);
			await plugin.setPlanSettings(PROJECT_PATH, { mode: plugin.PLAN_MODE_AUTO });
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);

			// The halt lands after the conductor was asked but before its plan
			// settles - the same "a second command arrives mid-flight" race the
			// manual halt test above exercises, just ahead of execution instead of
			// inside it.
			await plugin.setPlanSettings(PROJECT_PATH, { halted: true });
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				moves: [{ cardKey: cardAKey, toColumnId: 'in-progress', why: 'ready' }],
			});

			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.status).toBe('parsed');
			expect(run.execution).toEqual({});
			expect(run.executedAt).toBeNull();
			// Only the conductor's own ask ever reached agents.dispatch.
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1);
		});
	});

	describe('a plan proposing a new card', () => {
		it('executes nothing: the whole plan is rejected before there is anything to run', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath: PROJECT_PATH }),
					]),
			});
			await plugin.activate(maestro);
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);

			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				cards: [{ title: 'A brand new card' }],
			});

			const run = plugin.planRunSnapshot(PROJECT_PATH)!;
			expect(run.status).toBe('failed');
			expect(run.result!.ok).toBe(false);
			expect(run.result!.error).toContain('"cards"');
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1); // the ask only
			expect(maestro.sessions.requestAccess).not.toHaveBeenCalled();

			const approveResult = (await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: [],
			})) as { ok: boolean; reason?: string };
			expect(approveResult.ok).toBe(false);
			expect(approveResult.reason).toContain('did not parse');
		});
	});

	describe('re-executing the same plan id', () => {
		it('is a no-op: a second approval neither re-dispatches nor re-requests access', async () => {
			const plugin = loadMain();
			const cardAKey = ck('session-a', 'tab-a');
			const { maestro, commandHandlers, eventHandlers, fsFiles } = projectStub({
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath: PROJECT_PATH }),
					]),
			});
			await plugin.activate(maestro);
			const conductorId = await createConductor(commandHandlers);
			const planId = await askConductor(commandHandlers);
			await settle(plugin, fsFiles, eventHandlers, conductorId, planId, {
				messages: [{ cardKey: cardAKey, prompt: 'hello', why: 'ok' }],
			});

			await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['message:' + cardAKey],
			});
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(2); // the ask, then the message
			expect(maestro.sessions.requestAccess).toHaveBeenCalledTimes(1);

			const second = (await commandHandlers.get('approve-plan')!({
				boardId: PROJECT_PATH,
				planId: planId,
				approvedKeys: ['message:' + cardAKey],
			})) as { ok: boolean; reason?: string };

			expect(second.ok).toBe(false);
			expect(second.reason).toContain('already been executed');
			expect(maestro.agents.dispatch).toHaveBeenCalledTimes(2);
			expect(maestro.sessions.requestAccess).toHaveBeenCalledTimes(1);
		});
	});
});
