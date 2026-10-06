import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the sentry reporter and every prompt loader so importing promptInit does
// not pull in the real (heavy) renderer graph and loader behavior is
// controllable per test.
vi.mock('../utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../stores/settingsStore', () => ({ loadSettingsStorePrompts: vi.fn() }));
vi.mock('../hooks/input/useInputProcessing', () => ({ loadInputProcessingPrompts: vi.fn() }));
vi.mock('../hooks/wizard/useWizardHandlers', () => ({ loadWizardHandlersPrompts: vi.fn() }));
vi.mock('../hooks/agent/useAgentListeners', () => ({ loadAgentListenersPrompts: vi.fn() }));
vi.mock('../hooks/batch/batchUtils', () => ({ loadBatchUtilsPrompts: vi.fn() }));
vi.mock('./contextGroomer', () => ({ loadContextGroomerPrompts: vi.fn() }));
vi.mock('./contextSummarizer', () => ({ loadContextSummarizerPrompts: vi.fn() }));
vi.mock('./inlineWizardConversation', () => ({ loadInlineWizardConversationPrompts: vi.fn() }));
vi.mock('./inlineWizardDocumentGeneration', () => ({ loadInlineWizardDocGenPrompts: vi.fn() }));
vi.mock('../components/Wizard/services/wizardPrompts', () => ({ loadWizardPrompts: vi.fn() }));
vi.mock('../components/Wizard/services/phaseGenerator', () => ({
	loadPhaseGeneratorPrompts: vi.fn(),
}));

interface BridgeWindow {
	maestro?: { prompts?: unknown };
}

function setBridge(present: boolean): void {
	(window as unknown as BridgeWindow).maestro = present ? { prompts: {} } : undefined;
}

// Each test loads a fresh module instance. resetModules() clears promptInit's
// module-level `initialized`/`initPromise` singletons so the cases are
// independent and order-free; a static import would share that state. The
// dynamic imports here exist solely for this test-isolation boundary
// (ts-no-dynamic-import test exception) and resolve the same freshly-mocked
// instances promptInit uses after the reset.
async function loadFresh() {
	vi.resetModules();
	const promptInit = await import('./promptInit');
	const { captureException } = await import('../utils/sentry');
	const { loadSettingsStorePrompts } = await import('../stores/settingsStore');
	return { ...promptInit, captureException, loadSettingsStorePrompts };
}

describe('initializeRendererPrompts bridge guard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('degrades without reporting when the preload bridge never appears', async () => {
		setBridge(false);
		const {
			initializeRendererPrompts,
			areRendererPromptsInitialized,
			captureException,
			loadSettingsStorePrompts,
		} = await loadFresh();

		vi.useFakeTimers();
		const pending = initializeRendererPrompts();
		await vi.advanceTimersByTimeAsync(1100);
		await expect(pending).resolves.toBeUndefined();

		expect(captureException).not.toHaveBeenCalled();
		expect(loadSettingsStorePrompts).not.toHaveBeenCalled();
		expect(areRendererPromptsInitialized()).toBe(false);
	});

	it('reports and rethrows when a loader fails with the bridge present', async () => {
		setBridge(true);
		const {
			initializeRendererPrompts,
			areRendererPromptsInitialized,
			captureException,
			loadSettingsStorePrompts,
		} = await loadFresh();
		vi.mocked(loadSettingsStorePrompts).mockRejectedValueOnce(new Error('prompt boom'));

		await expect(initializeRendererPrompts()).rejects.toThrow('prompt boom');

		expect(captureException).toHaveBeenCalledTimes(1);
		expect(areRendererPromptsInitialized()).toBe(false);
	});

	it('loads prompts and marks initialized when the bridge is present', async () => {
		setBridge(true);
		const {
			initializeRendererPrompts,
			areRendererPromptsInitialized,
			captureException,
			loadSettingsStorePrompts,
		} = await loadFresh();

		await expect(initializeRendererPrompts()).resolves.toBeUndefined();

		expect(loadSettingsStorePrompts).toHaveBeenCalledTimes(1);
		expect(captureException).not.toHaveBeenCalled();
		expect(areRendererPromptsInitialized()).toBe(true);
	});
});
