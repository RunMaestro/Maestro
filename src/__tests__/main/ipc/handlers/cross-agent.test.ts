/**
 * Tests for the consult budget's two entry points in the cross-agent IPC
 * handlers.
 *
 * `cross-agent:send` is where an `@mention` reaches main. The handler does not
 * admit the consult itself (the router does, see cross-agent-router.test.ts),
 * but it decides what the router is TOLD:
 * - The budget is the setting read through the normalizer (`0` is a real value).
 * - Both chains arrive as data from a renderer and are narrowed. Anything that
 *   is not a chain reads as none, so a damaged `sourceConsultChain` makes the
 *   mention a typed one rather than a spend against an id the counter refuses.
 *
 * `cross-agent:consultBudget` is the read the renderer's system prompt builder
 * makes so a tab's prompt can state what is left of the budget:
 * - The limit is the setting read through the normalizer.
 * - A chain that arrived as data is narrowed before it is used; anything that
 *   is not a chain reads as a root turn, which is what `process:spawn` does
 *   with the same value.
 * - An unreadable counter answers `null`, never a guessed figure.
 *
 * The counter itself is mocked: its default directory is the LIVE one in an
 * agent's shell (`MAESTRO_USER_DATA`), and these handlers take no directory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/cross-agent/cross-agent-router', () => ({
	startCrossAgentRequest: vi.fn(),
	cancelCrossAgentRequestsForSource: vi.fn(() => 0),
}));

vi.mock('../../../../main/peer-consults/consult-budget', () => ({
	readConsultBudgetStatus: vi.fn(),
}));

import {
	registerCrossAgentHandlers,
	resolveCrossAgentWritable,
	type CrossAgentHandlerDependencies,
} from '../../../../main/ipc/handlers/cross-agent';
import { startCrossAgentRequest } from '../../../../main/cross-agent/cross-agent-router';
import { readConsultBudgetStatus } from '../../../../main/peer-consults/consult-budget';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

let settings: Record<string, unknown>;

/** Register the handlers over the test's `settings` and return one channel's handler. */
function registerAndGetHandler(
	channel: string,
	overrides: Partial<CrossAgentHandlerDependencies> = {}
): Handler {
	registerCrossAgentHandlers({
		getProcessManager: () => null,
		getAgentDetector: () => null,
		sessionsStore: { get: vi.fn(() => []) } as never,
		agentConfigsStore: { get: vi.fn(() => ({})) } as never,
		settingsStore: {
			get: vi.fn((key: string, fallback?: unknown) => settings[key] ?? fallback),
		} as never,
		sshStore: null,
		safeSend: vi.fn(),
		...overrides,
	});

	const registration = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
	expect(registration).toBeDefined();
	return registration?.[1] as unknown as Handler;
}

beforeEach(() => {
	vi.clearAllMocks();
	settings = {};
});

describe('cross-agent:send', () => {
	const processManager = { id: 'process-manager' };
	const agentDetector = { id: 'agent-detector' };
	let send: Handler;

	/** What the renderer sends for one `@mention`. */
	const payload = (overrides: Record<string, unknown> = {}) => ({
		sourceSessionId: 'src',
		sourceAgentName: 'Source',
		sourceTabId: 'src-tab',
		targetSessionId: 'tgt',
		userPrompt: '@Target look at this',
		transcript: [],
		...overrides,
	});

	/** The request and the options the handler handed the router. */
	const routed = () => {
		expect(startCrossAgentRequest).toHaveBeenCalledOnce();
		const [request, options] = vi.mocked(startCrossAgentRequest).mock.calls[0];
		return { request, options };
	};

	beforeEach(() => {
		vi.mocked(startCrossAgentRequest).mockResolvedValue(undefined as never);
		send = registerAndGetHandler('cross-agent:send', {
			getProcessManager: () => processManager as never,
			getAgentDetector: () => agentDetector as never,
		});
	});

	it('tells the router the default budget when the setting was never written', async () => {
		await send({}, payload());

		expect(routed().options.maxConsultationsPerTurn).toBe(25);
	});

	// `0` switches peer dispatch off. A `|| 25` here would switch it back on for
	// every mention an agent makes.
	it('reads the budget through the normalizer, so 0 stays 0 and junk is the default', async () => {
		const budgets: unknown[] = [];
		for (const stored of [0, 12, 'lots', -3]) {
			vi.mocked(startCrossAgentRequest).mockClear();
			settings.maxConsultationsPerTurn = stored;
			await send({}, payload());
			budgets.push(routed().options.maxConsultationsPerTurn);
		}

		expect(budgets).toEqual([0, 12, 25, 0]);
	});

	it('passes on the place of the turn that made the mention, for the router to spend from', async () => {
		const sourceConsultChain = { chainId: 'chain-a', depth: 1 };

		await send({}, payload({ sourceConsultChain }));

		const { request } = routed();
		expect(request.sourceConsultChain).toEqual(sourceConsultChain);
		// Not as an admitted chain, which the router would not charge.
		expect(request.consultChain).toBeUndefined();
	});

	it('passes on a chain the CLI already admitted, as admitted', async () => {
		const consultChain = { chainId: 'chain-a', depth: 2 };

		await send({}, payload({ consultChain }));

		const { request } = routed();
		expect(request.consultChain).toEqual(consultChain);
		expect(request.sourceConsultChain).toBeUndefined();
	});

	it('reads a chain that is not a chain as none, on both fields', async () => {
		for (const damaged of ['chain-a', { chainId: '../escape', depth: 1 }, { depth: 3 }, 42, null]) {
			vi.mocked(startCrossAgentRequest).mockClear();
			await send({}, payload({ consultChain: damaged, sourceConsultChain: damaged }));

			const { request } = routed();
			expect(request.consultChain).toBeUndefined();
			expect(request.sourceConsultChain).toBeUndefined();
		}
	});

	// A damaged depth must not drop the chain: that would hand the mention a
	// fresh budget.
	it('keeps a chain whose depth is damaged, at depth 0', async () => {
		await send({}, payload({ sourceConsultChain: { chainId: 'chain-a', depth: 'deep' } }));

		expect(routed().request.sourceConsultChain).toEqual({ chainId: 'chain-a', depth: 0 });
	});

	// The router admits, and it is the only place that does: a second spend here
	// would charge every mention twice.
	it('does not touch the counter itself', async () => {
		await send({}, payload({ sourceConsultChain: { chainId: 'chain-a', depth: 1 } }));

		expect(readConsultBudgetStatus).not.toHaveBeenCalled();
	});

	it('answers with the id of the request it started', async () => {
		const result = (await send({}, payload())) as { requestId: string };

		expect(result.requestId).toEqual(expect.any(String));
		expect(routed().request.requestId).toBe(result.requestId);
	});

	it('forwards the consult provider snapshot and the target provider configuration', async () => {
		const stored = {
			id: 'tgt',
			toolType: 'claude-code',
			cwd: '/proj',
			providerOverrides: { codex: { customPath: '/codex' } },
			aiTabs: [{ id: 'consult', tabProvider: 'codex', agentSessionId: 'native-codex' }],
		};
		vi.mocked(ipcMain.handle).mockClear();
		send = registerAndGetHandler('cross-agent:send', {
			getProcessManager: () => processManager as never,
			getAgentDetector: () => agentDetector as never,
			sessionsStore: { get: () => [stored] } as never,
		});
		await send(
			{},
			payload({
				targetTabId: 'consult',
				targetProvider: 'codex',
				resumeAgentSessionId: 'native-codex',
			})
		);
		expect(routed().request).toMatchObject({
			targetTabId: 'consult',
			targetProvider: 'codex',
			resumeAgentSessionId: 'native-codex',
		});
		const options = vi.mocked(startCrossAgentRequest).mock.calls[0][1];
		expect(options.getTargetSession('tgt')).toMatchObject({
			aiTabs: stored.aiTabs,
			providerOverrides: stored.providerOverrides,
		});
	});
});

describe('cross-agent:consultBudget', () => {
	let consultBudget: Handler;

	beforeEach(() => {
		vi.mocked(readConsultBudgetStatus).mockImplementation(({ chain, limit }) => ({
			limit,
			spent: chain ? 7 : 0,
		}));
		consultBudget = registerAndGetHandler('cross-agent:consultBudget');
	});

	it('answers a root turn (no chain) with the default budget and nothing spent', async () => {
		expect(await consultBudget({}, {})).toEqual({ limit: 25, spent: 0 });
		expect(await consultBudget({}, undefined)).toEqual({ limit: 25, spent: 0 });
		expect(readConsultBudgetStatus).toHaveBeenCalledWith({ chain: undefined, limit: 25 });
	});

	it('reads the chain of a delegated turn', async () => {
		const consultChain = { chainId: 'chain-a', depth: 2 };

		expect(await consultBudget({}, { consultChain })).toEqual({ limit: 25, spent: 7 });
		expect(readConsultBudgetStatus).toHaveBeenCalledWith({ chain: consultChain, limit: 25 });
	});

	it('reads the limit through the normalizer, so 0 stays 0 and junk is the default', async () => {
		settings.maxConsultationsPerTurn = 0;
		expect(await consultBudget({}, {})).toEqual({ limit: 0, spent: 0 });

		settings.maxConsultationsPerTurn = 12;
		expect(await consultBudget({}, {})).toEqual({ limit: 12, spent: 0 });

		settings.maxConsultationsPerTurn = 'lots';
		expect(await consultBudget({}, {})).toEqual({ limit: 25, spent: 0 });
	});

	it('reads anything that is not a chain as a root turn, the way the spawn does', async () => {
		for (const consultChain of ['chain-a', { chainId: '../escape', depth: 1 }, 42, null]) {
			expect(await consultBudget({}, { consultChain })).toEqual({ limit: 25, spent: 0 });
		}
	});

	it('answers null when the counter cannot be read', async () => {
		vi.mocked(readConsultBudgetStatus).mockReturnValue(undefined);

		expect(await consultBudget({}, { consultChain: { chainId: 'chain-a', depth: 1 } })).toBeNull();
	});
});

/**
 * A consult and a hand-off have separate write switches with opposite defaults:
 * a consult answers a question (read-only unless opted in), a hand-off passes
 * work on (may write unless opted out).
 */
describe('resolveCrossAgentWritable', () => {
	/** A settings store holding only `values`; anything else gets the caller's default. */
	function store(values: Record<string, unknown>) {
		return {
			get: <T>(key: string, defaultValue?: T): T =>
				(key in values ? values[key] : defaultValue) as T,
		};
	}

	it('keeps a consult read-only and lets a hand-off write when nothing is set', () => {
		expect(resolveCrossAgentWritable({}, store({}))).toBe(false);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, store({}))).toBe(true);
	});

	it('reads each kind from its own switch only', () => {
		const settings = store({ crossAgentMentionsWritable: true, crossAgentHandoffsWritable: false });

		expect(resolveCrossAgentWritable({}, settings)).toBe(true);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, settings)).toBe(false);
	});

	it('treats an empty answer as a hand-off, not a consult', () => {
		// The field's presence is the marker; an agent can legitimately answer with "".
		expect(resolveCrossAgentWritable({ handoffAnswer: '' }, store({}))).toBe(true);
	});
});
