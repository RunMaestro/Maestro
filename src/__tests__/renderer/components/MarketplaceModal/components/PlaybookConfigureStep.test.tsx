/**
 * PlaybookConfigureStep: the Exchange's step after Install and Run. The row
 * above Run prices the run, an unlimited loop shows as capped, and Run saves
 * the answers and loop cap to the record, launches through the Auto Run
 * entry point with `launchSource: 'exchange'`, and closes the Exchange only
 * once the run is running.
 */

import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => toast(...args),
}));

import { PlaybookConfigureStep } from '../../../../../renderer/components/MarketplaceModal/components/PlaybookConfigureStep';
import { useBatchStore } from '../../../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import type { Playbook } from '../../../../../shared/types';
import { createMockSession } from '../../../../helpers/mockSession';
import { mockTheme } from '../../../../helpers/mockTheme';

const update = () => window.maestro.playbooks.update as ReturnType<typeof vi.fn>;

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'pb-1',
		name: 'Refactor',
		createdAt: 0,
		updatedAt: 0,
		documents: [
			{ filename: 'refactor/one', resetOnCompletion: false },
			{ filename: 'refactor/progress', resetOnCompletion: true },
		],
		loopEnabled: true,
		maxLoops: 10,
		prompt: '<!-- CONFIGURE: The area to refactor -->\n**AREA:** `src`',
		provenance: {
			kind: 'marketplace',
			marketplaceId: 'development-refactor',
			targetFolderName: 'refactor',
			importedAt: 0,
			documentHashes: {},
		},
		...overrides,
	};
}

function renderStep(props: Partial<ComponentProps<typeof PlaybookConfigureStep>> = {}) {
	const onRunPlaybook = (props.onRunPlaybook ?? vi.fn().mockResolvedValue(true)) as ReturnType<
		typeof vi.fn
	>;
	const onClose = vi.fn();
	render(
		<PlaybookConfigureStep
			theme={mockTheme}
			playbook={makePlaybook()}
			sessionId="agent-1"
			onClose={onClose}
			{...props}
			onRunPlaybook={onRunPlaybook}
		/>
	);
	return { onRunPlaybook, onClose };
}

const runButton = () => screen.getByTestId('parameter-sheet-run') as HTMLButtonElement;

describe('PlaybookConfigureStep', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		update().mockResolvedValue({ success: true, playbook: {} });
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'agent-1', name: 'Backend', customModel: 'opus' })],
		});
		useBatchStore.setState({ batchRunStates: {} });
		useSettingsStore.setState({ autoRunDisabled: false });
	});

	afterEach(() => {
		useSessionStore.setState({ sessions: [] });
		useBatchStore.setState({ batchRunStates: {} });
	});

	it('prices the run above Run: documents, loops, and the target agent and model', () => {
		renderStep();
		expect(screen.getByTestId('playbook-run-summary-documents').textContent).toContain(
			'2 documents'
		);
		expect(screen.getByTestId('playbook-run-summary-loops').textContent).toContain(
			'Up to 10 loops'
		);
		const agent = screen.getByTestId('playbook-run-summary-agent').textContent;
		expect(agent).toContain('Backend');
		expect(agent).toContain('opus');
		expect(screen.queryByTestId('playbook-run-summary-cap')).toBeNull();
		expect(runButton().textContent).toContain('Run');
	});

	it('shows the loop cap when the import capped an unlimited loop', () => {
		renderStep({ importCappedLoops: true });
		expect(screen.getByTestId('playbook-run-summary-cap')).toBeTruthy();
	});

	it('caps a stored unlimited loop and runs with the cap', async () => {
		const { onRunPlaybook } = renderStep({ playbook: makePlaybook({ maxLoops: null }) });
		expect(screen.getByTestId('playbook-run-summary-cap')).toBeTruthy();
		expect(screen.getByTestId('playbook-run-summary-loops').textContent).toContain(
			'Up to 10 loops'
		);

		fireEvent.click(runButton());
		await waitFor(() => expect(onRunPlaybook).toHaveBeenCalled());
		expect(onRunPlaybook.mock.calls[0][1].maxLoops).toBe(10);
		expect(update()).toHaveBeenCalledWith('agent-1', 'pb-1', {
			parameterValues: {},
			maxLoops: 10,
		});
	});

	it('runs a raised cap', async () => {
		const { onRunPlaybook } = renderStep({ importCappedLoops: true });
		fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } });
		fireEvent.click(runButton());
		await waitFor(() => expect(onRunPlaybook).toHaveBeenCalled());
		expect(onRunPlaybook.mock.calls[0][1].maxLoops).toBe(30);
	});

	it('says when the playbook configures the machine', () => {
		renderStep({ playbook: makePlaybook({ scope: 'machine' }) });
		expect(screen.getByTestId('playbook-run-summary-machine')).toBeTruthy();
	});

	it('launches on the owning agent with the exchange launch source, then closes', async () => {
		const { onRunPlaybook, onClose } = renderStep();
		fireEvent.click(runButton());

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(onRunPlaybook).toHaveBeenCalledTimes(1);
		const [sessionId, config] = onRunPlaybook.mock.calls[0];
		expect(sessionId).toBe('agent-1');
		expect(config).toMatchObject({
			loopEnabled: true,
			maxLoops: 10,
			launchSource: 'exchange',
			playbook: {
				id: 'pb-1',
				ownerSessionId: 'agent-1',
				marketplaceId: 'development-refactor',
				parameterValues: {},
			},
		});
		expect(config.documents.map((doc: { filename: string }) => doc.filename)).toEqual([
			'refactor/one',
			'refactor/progress',
		]);
		// The answers are saved before the launch, so a Resume reads the same values.
		expect(update().mock.invocationCallOrder[0]).toBeLessThan(
			onRunPlaybook.mock.invocationCallOrder[0]
		);
	});

	it('stays open when the run does not start', async () => {
		const onRunPlaybook = vi.fn().mockResolvedValue(false);
		const { onClose } = renderStep({ onRunPlaybook });
		fireEvent.click(runButton());
		await waitFor(() => expect(onRunPlaybook).toHaveBeenCalled());
		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not launch when the record cannot be saved', async () => {
		update().mockResolvedValue({ success: false, error: 'disk full' });
		const { onRunPlaybook, onClose } = renderStep();
		fireEvent.click(runButton());
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Playbook not saved' }))
		);
		expect(onRunPlaybook).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('blocks Run while an Auto Run is already going on the agent', () => {
		useBatchStore.setState({ batchRunStates: { 'agent-1': { isRunning: true } as never } });
		renderStep();
		expect(runButton().disabled).toBe(true);
		expect(screen.getByTestId('parameter-sheet-blocked').textContent).toBe(
			'An Auto Run is already going on Backend.'
		);
	});

	it('blocks Run when Auto Run is disabled', () => {
		useSettingsStore.setState({ autoRunDisabled: true });
		renderStep();
		expect(runButton().disabled).toBe(true);
		expect(screen.getByTestId('parameter-sheet-blocked').textContent).toBe(
			'Auto Run is disabled in Settings.'
		);
	});
});
