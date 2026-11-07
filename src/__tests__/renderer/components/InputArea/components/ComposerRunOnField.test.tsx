import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunOnFieldProps } from '../../../../../renderer/components/shared/RunOnField';
import { ComposerRunOnField } from '../../../../../renderer/components/InputArea/components/ComposerRunOnField';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useTabStore } from '../../../../../renderer/stores/tabStore';
import { projectTabProvider } from '../../../../../renderer/utils/providerTabSessions';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { inputAreaTheme } from '../_fixtures';

vi.mock('../../../../../renderer/components/shared/RunOnField', () => ({
	RunOnField: (props: RunOnFieldProps) => (
		<>
			<span>
				{props.toolType}:{props.value.type === 'source' ? props.value.model : 'cloud'}
			</span>
			<button onClick={() => props.onChange({ type: 'provider' })}>Use cloud</button>
			{props.error && <p role="alert">{props.error}</p>}
		</>
	),
}));

describe('ComposerRunOnField', () => {
	afterEach(() => vi.restoreAllMocks());

	it('displays the projected harness target and writes to that tab through the shared action', async () => {
		const session = createMockSession({
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [
				createMockAITab({
					tabProvider: 'codex',
					runOn: { type: 'source', endpointId: 'server', model: 'local-model' },
				}),
			],
		});
		useSessionStore.setState({ sessions: [session] });
		const save = vi.spyOn(useTabStore.getState(), 'setTabSettings').mockResolvedValue();
		const projected = projectTabProvider(session, session.aiTabs[0]);
		render(<ComposerRunOnField theme={inputAreaTheme} agent={projected.agent} tabId="tab-1" />);
		expect(screen.getByText('codex:local-model')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Use cloud' }));
		await waitFor(() =>
			expect(save).toHaveBeenCalledWith('agent', 'tab-1', {
				runOn: { type: 'provider' },
			})
		);
	});

	it('refuses stale controls after the selected harness changes', () => {
		const session = createMockSession({
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [createMockAITab()],
		});
		useSessionStore.setState({ sessions: [session] });
		const save = vi.spyOn(useTabStore.getState(), 'setTabSettings').mockResolvedValue();
		render(<ComposerRunOnField theme={inputAreaTheme} agent={session} tabId="tab-1" />);
		useSessionStore
			.getState()
			.updateSession('agent', { aiTabs: [{ ...session.aiTabs[0], tabProvider: 'codex' }] });
		fireEvent.click(screen.getByRole('button', { name: 'Use cloud' }));
		expect(save).not.toHaveBeenCalled();
		expect(screen.getByRole('alert')).toHaveTextContent('Tab provider changed');
	});

	it('surfaces validation failures without changing the displayed target', async () => {
		const session = createMockSession({ id: 'agent', aiTabs: [createMockAITab()] });
		useSessionStore.setState({ sessions: [session] });
		vi.spyOn(useTabStore.getState(), 'setTabSettings').mockRejectedValue(
			new Error('Source unavailable')
		);
		render(<ComposerRunOnField theme={inputAreaTheme} agent={session} tabId="tab-1" />);
		fireEvent.click(screen.getByRole('button', { name: 'Use cloud' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Source unavailable');
	});
});
