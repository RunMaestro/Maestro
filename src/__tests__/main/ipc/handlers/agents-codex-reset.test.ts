import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withIpcErrorLogging } from '../../../../main/utils/ipcHandler';

/**
 * Regression test for Codex reset-credit IPC handlers.
 *
 * Bug: The handlers were declared with an extra `_event` parameter,
 * which caused argument shifting through withIpcErrorLogging.
 *
 * withIpcErrorLogging returns a function with signature:
 *   (_event: unknown, ...args: TArgs) => Promise<TResult>
 *
 * But it strips the event and calls handler(...args).
 *
 * If a handler incorrectly declares (_event, arg1, arg2), the event
 * gets passed as arg1, arg2 as the event (and gets lost), and arg3
 * is missing entirely.
 */

describe('Codex reset-credit IPC handlers argument passing', () => {
	let mockFetchCredits: ReturnType<typeof vi.fn>;
	let mockConsumeCredit: ReturnType<typeof vi.fn>;
	let handlerGetCredits: ReturnType<typeof withIpcErrorLogging>;
	let handlerConsumeCredit: ReturnType<typeof withIpcErrorLogging>;

	beforeEach(() => {
		mockFetchCredits = vi.fn().mockResolvedValue({ ok: true });
		mockConsumeCredit = vi.fn().mockResolvedValue({ ok: true });

		// Correct handler: no _event parameter
		handlerGetCredits = withIpcErrorLogging(
			{ context: '[Test]', operation: 'getCodexResetCredits' },
			async (codexHome: string) => {
				return mockFetchCredits(codexHome);
			}
		);

		// Correct handler: no _event parameter
		handlerConsumeCredit = withIpcErrorLogging(
			{ context: '[Test]', operation: 'consumeCodexResetCredit' },
			async (codexHome: string, creditId: string, idempotencyKey?: string) => {
				return mockConsumeCredit(codexHome, creditId, idempotencyKey);
			}
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('getCodexResetCredits passes codexHome correctly to the handler', async () => {
		// withIpcErrorLogging returns (_event, ...args) => Promise<TResult>
		// The caller (ipcMain.handle) will pass (event, codexHome)
		// withIpcErrorLogging should strip event and call handler(codexHome)
		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';

		await handlerGetCredits(event, testHome);

		// The handler should have received codexHome, not the event
		expect(mockFetchCredits).toHaveBeenCalledWith(testHome);
		expect(mockFetchCredits).toHaveBeenCalledTimes(1);
	});

	it('consumeCodexResetCredit passes all three arguments correctly', async () => {
		// withIpcErrorLogging returns (_event, ...args) => Promise<TResult>
		// The caller will pass (event, codexHome, creditId, idempotencyKey)
		// withIpcErrorLogging should strip event and call handler(codexHome, creditId, idempotencyKey)
		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';
		const creditId = 'RateLimitResetCredit_abc123';
		const idempotencyKey = 'idempotent-key-xyz';

		await handlerConsumeCredit(event, testHome, creditId, idempotencyKey);

		// The handler should have received all three arguments in order
		expect(mockConsumeCredit).toHaveBeenCalledWith(testHome, creditId, idempotencyKey);
		expect(mockConsumeCredit).toHaveBeenCalledTimes(1);
	});

	it('consumeCodexResetCredit handles optional idempotencyKey gracefully', async () => {
		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';
		const creditId = 'RateLimitResetCredit_abc123';

		// Call without idempotencyKey (it should be undefined)
		await handlerConsumeCredit(event, testHome, creditId);

		expect(mockConsumeCredit).toHaveBeenCalledWith(testHome, creditId, undefined);
		expect(mockConsumeCredit).toHaveBeenCalledTimes(1);
	});

	it('demonstrates the old buggy pattern would have failed', async () => {
		// This shows what would happen if the handler incorrectly had _event parameter
		const buggyHandler = withIpcErrorLogging(
			{ context: '[Test]', operation: 'buggyHandler' },
			// BUG: handler declares _event even though withIpcErrorLogging already strips it
			async (_event: string, codexHome: string) => {
				// _event receives the codexHome value instead!
				// codexHome receives the creditId value (or undefined)
				return { received_event: _event, received_codexHome: codexHome };
			}
		);

		const event = { sender: { send: vi.fn() } };
		const testHome = '/path/to/codex';
		const creditId = 'RateLimitResetCredit_abc123';

		// Call with (event, codexHome, creditId)
		// withIpcErrorLogging passes to handler (codexHome, creditId)
		// but handler expects (_event, codexHome)
		// so it receives: _event=codexHome, codexHome=creditId
		const result = await buggyHandler(event, testHome, creditId);

		expect(result).toEqual({
			received_event: testHome, // WRONG: got codexHome
			received_codexHome: creditId, // WRONG: got creditId
		});
	});
});
