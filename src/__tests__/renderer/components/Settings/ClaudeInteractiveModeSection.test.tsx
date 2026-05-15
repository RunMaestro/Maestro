/**
 * Tests for ClaudeInteractiveModeSection
 *
 * Covers:
 *   - ToggleButtonGroup renders + click wiring for the three headlessMode states
 *   - help text changes per selected mode
 *   - SettingCheckbox aria-checked + round-trip wiring
 *   - data-setting-id present on both controls (claudeCode.headlessMode +
 *     claudeCode.autoFallbackToApiOnLimit)
 *   - empty state when no Max plan snapshots are cached
 *   - multi-row snapshot rendering with account-short-name derivation
 *   - refresh button calls the IPC and triggers a store refresh
 *   - in-flight `refreshing` flag disables the refresh button
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ClaudeInteractiveModeSection } from '../../../../renderer/components/Settings/ClaudeInteractiveModeSection';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

const refreshClaudeUsageSnapshotsMock = vi.fn();
const getClaudeUsageSnapshotsMock = vi.fn();

function renderSection(
	overrides: {
		headlessMode?: 'interactive' | 'api' | 'auto';
		onHeadlessModeChange?: (value: 'interactive' | 'api' | 'auto') => void;
		autoFallbackToApiOnLimit?: boolean;
		onAutoFallbackToApiOnLimitChange?: (value: boolean) => void;
	} = {}
) {
	return render(
		<ClaudeInteractiveModeSection
			theme={theme}
			headlessMode={overrides.headlessMode ?? 'auto'}
			onHeadlessModeChange={overrides.onHeadlessModeChange ?? (() => {})}
			autoFallbackToApiOnLimit={overrides.autoFallbackToApiOnLimit ?? true}
			onAutoFallbackToApiOnLimitChange={overrides.onAutoFallbackToApiOnLimitChange ?? (() => {})}
		/>
	);
}

beforeEach(() => {
	refreshClaudeUsageSnapshotsMock.mockReset().mockResolvedValue({ refreshed: 1 });
	getClaudeUsageSnapshotsMock.mockReset().mockResolvedValue({});

	(global as any).window = (global as any).window ?? {};
	(window as any).maestro = {
		agents: {
			getClaudeUsageSnapshots: getClaudeUsageSnapshotsMock,
			refreshClaudeUsageSnapshots: refreshClaudeUsageSnapshotsMock,
		},
	};

	useClaudeUsageStore.getState().__resetForTests();
	cleanup();
});

function seedSnapshots(snapshots: Record<string, any>) {
	useClaudeUsageStore.setState({ snapshots, loaded: true, refreshing: false } as any);
}

describe('ClaudeInteractiveModeSection — headless mode toggle', () => {
	it('renders the three mode buttons and reflects the current selection', () => {
		renderSection({ headlessMode: 'auto' });

		// Three buttons (one per option). The toggle group's active state is
		// represented via the ring-2 class, so we just confirm the labels render.
		expect(screen.getByRole('button', { name: 'Interactive' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'API' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument();
	});

	it('calls onHeadlessModeChange when a button is clicked', () => {
		const onHeadlessModeChange = vi.fn();
		renderSection({ headlessMode: 'auto', onHeadlessModeChange });

		fireEvent.click(screen.getByRole('button', { name: 'Interactive' }));
		expect(onHeadlessModeChange).toHaveBeenCalledWith('interactive');

		fireEvent.click(screen.getByRole('button', { name: 'API' }));
		expect(onHeadlessModeChange).toHaveBeenCalledWith('api');

		fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
		expect(onHeadlessModeChange).toHaveBeenCalledWith('auto');
	});

	it('renders mode-specific help text', () => {
		const { rerender } = renderSection({ headlessMode: 'interactive' });
		expect(screen.getByTestId('claude-headless-mode-help').textContent).toMatch(
			/uses your Claude Max plan quota/i
		);

		rerender(
			<ClaudeInteractiveModeSection
				theme={theme}
				headlessMode="api"
				onHeadlessModeChange={() => {}}
				autoFallbackToApiOnLimit
				onAutoFallbackToApiOnLimitChange={() => {}}
			/>
		);
		expect(screen.getByTestId('claude-headless-mode-help').textContent).toMatch(/bills per token/i);

		rerender(
			<ClaudeInteractiveModeSection
				theme={theme}
				headlessMode="auto"
				onHeadlessModeChange={() => {}}
				autoFallbackToApiOnLimit
				onAutoFallbackToApiOnLimitChange={() => {}}
			/>
		);
		expect(screen.getByTestId('claude-headless-mode-help').textContent).toMatch(
			/interactive first.*fall back to API/i
		);
	});

	it('exposes data-setting-id="claudeCode.headlessMode" for cross-tab search wiring', () => {
		const { container } = renderSection({ headlessMode: 'auto' });
		expect(
			container.querySelector('[data-setting-id="claudeCode.headlessMode"]')
		).toBeInTheDocument();
	});
});

describe('ClaudeInteractiveModeSection — auto-fallback toggle', () => {
	it('reflects checked state via aria-checked on the underlying ToggleSwitch', () => {
		renderSection({ autoFallbackToApiOnLimit: true });
		const fallbackToggle = screen.getByRole('switch', {
			name: /Auto-fall back to API when Claude limits hit/i,
		});
		expect(fallbackToggle.getAttribute('aria-checked')).toBe('true');
	});

	it('round-trips through onAutoFallbackToApiOnLimitChange when clicked', () => {
		const onAutoFallbackToApiOnLimitChange = vi.fn();
		renderSection({
			autoFallbackToApiOnLimit: true,
			onAutoFallbackToApiOnLimitChange,
		});

		const fallbackToggle = screen.getByRole('switch', {
			name: /Auto-fall back to API when Claude limits hit/i,
		});
		fireEvent.click(fallbackToggle);
		expect(onAutoFallbackToApiOnLimitChange).toHaveBeenCalledWith(false);
	});

	it('exposes data-setting-id="claudeCode.autoFallbackToApiOnLimit" for cross-tab search wiring', () => {
		const { container } = renderSection({});
		expect(
			container.querySelector('[data-setting-id="claudeCode.autoFallbackToApiOnLimit"]')
		).toBeInTheDocument();
	});
});

describe('ClaudeInteractiveModeSection — snapshot list', () => {
	it('renders the empty state when no Max plan snapshots are cached', () => {
		renderSection({});
		expect(screen.getByTestId('claude-mode-snapshots-empty')).toBeInTheDocument();
	});

	it('renders one row per cached snapshot with account-short-name derivation', () => {
		seedSnapshots({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 30, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 10, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
			'/Users/me/.claude-gmail': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude-gmail',
				session: { percent: 97, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 80, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 5, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});

		renderSection({});

		expect(screen.getByTestId('claude-mode-snapshot-row-default')).toBeInTheDocument();
		expect(screen.getByTestId('claude-mode-snapshot-row-gmail')).toBeInTheDocument();
	});
});

describe('ClaudeInteractiveModeSection — refresh wiring', () => {
	it('calls the refresh IPC and re-pulls the store on click', async () => {
		getClaudeUsageSnapshotsMock.mockResolvedValue({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T01:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				session: { percent: 11, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 2, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 1, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});

		renderSection({});
		fireEvent.click(screen.getByTestId('claude-mode-refresh'));

		await waitFor(() => {
			expect(refreshClaudeUsageSnapshotsMock).toHaveBeenCalledTimes(1);
			expect(getClaudeUsageSnapshotsMock).toHaveBeenCalledTimes(1);
		});

		await waitFor(() => {
			expect(screen.getByTestId('claude-mode-snapshot-row-default')).toBeInTheDocument();
		});
	});

	it('disables the refresh button while a refresh is in flight', () => {
		useClaudeUsageStore.setState({
			snapshots: {},
			loaded: true,
			refreshing: true,
		} as any);

		renderSection({});
		const button = screen.getByTestId('claude-mode-refresh') as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.textContent).toContain('Refreshing');
	});
});
