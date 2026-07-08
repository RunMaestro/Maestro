import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	SendToAgentModal,
	type SendToAgentOptions,
} from '../../renderer/components/SendToAgentModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { MergeResult } from '../../renderer/types/contextMerge';
import type { Session, Theme, ToolType } from '../../renderer/types';
import { logger } from '../../renderer/utils/logger';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		textInverse: '#111827',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		border: '#3f3f46',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		info: '#38bdf8',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'source',
		name: 'Source Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace/source',
		fullPath: '/workspace/source',
		projectRoot: '/workspace/source',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		activeTimeMs: 0,
		executionQueue: [],
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: 'source-agent-123',
				name: 'Planning Tab',
				starred: false,
				logs: [
					{ id: 'log-1', timestamp: 1, source: 'user', text: 'Build the transfer flow.' },
					{
						id: 'log-2',
						timestamp: 2,
						source: 'ai',
						text: 'The receiving session should keep the useful context.',
					},
				],
				inputValue: '',
				stagedImages: [],
				createdAt: 1,
				state: 'idle',
			},
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		...overrides,
	} as Session;
}

function createTargetSession(
	id: string,
	name: string,
	toolType: ToolType,
	projectRoot: string,
	state: Session['state'] = 'idle'
): Session {
	return createSession({
		id,
		name,
		toolType,
		projectRoot,
		cwd: projectRoot,
		fullPath: projectRoot,
		state,
		aiTabs: [],
	});
}

const sourceSession = createSession();
const targetSessions = [
	sourceSession,
	createTargetSession('docs', 'Docs Session', 'codex', '/workspace/docs-app'),
	createTargetSession('api', 'API Session', 'opencode', '/workspace/api-service', 'busy'),
	createTargetSession('terminal', 'Terminal Session', 'terminal', '/workspace/shell'),
	createTargetSession('fallback', '', 'claude-code', '/workspace/fallback-app'),
	createTargetSession('unnamed', '', 'opencode', '/'),
];

function renderModal(overrides: Partial<React.ComponentProps<typeof SendToAgentModal>> = {}) {
	const props = {
		theme,
		isOpen: true,
		sourceSession,
		sourceTabId: 'tab-1',
		allSessions: targetSessions,
		onClose: vi.fn(),
		onSend: vi.fn<[], Promise<MergeResult>>().mockResolvedValue({ success: true }),
		...overrides,
	};

	const result = render(
		<LayerStackProvider>
			<SendToAgentModal {...props} />
		</LayerStackProvider>
	);

	return { ...result, props };
}

describe('SendToAgentModal integration', () => {
	beforeEach(() => {
		vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('renders real session options, excludes invalid targets, and handles fallback labels', () => {
		renderModal();

		expect(screen.getByRole('dialog', { name: 'Send Context to Agent' })).toBeInTheDocument();
		expect(screen.getByLabelText('Search sessions')).toHaveAttribute(
			'placeholder',
			'Search sessions...'
		);
		expect(screen.queryByText('Source Session')).not.toBeInTheDocument();
		expect(screen.queryByText('Terminal Session')).not.toBeInTheDocument();
		expect(screen.getByRole('option', { name: /Docs Session, Idle/ })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /API Session, Busy/ })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /fallback-app, Idle/ })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /Unnamed Session, Idle/ })).toBeInTheDocument();
		expect(screen.getByText(/Source: Planning Tab/)).toBeInTheDocument();
		expect(screen.getAllByText(/tokens/).length).toBeGreaterThan(0);
		expect(screen.getByRole('button', { name: 'Send to Session' })).toBeDisabled();
	});

	it('filters by fuzzy name and path search, resets navigation, and renders empty states', () => {
		renderModal();
		const searchInput = screen.getByLabelText('Search sessions');

		fireEvent.change(searchInput, { target: { value: 'Session' } });
		expect(screen.getAllByRole('option')).toHaveLength(3);

		fireEvent.change(searchInput, { target: { value: 'docs-app' } });
		expect(screen.getByRole('option', { name: /Docs Session/ })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /API Session/ })).not.toBeInTheDocument();

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
		expect(screen.getByRole('option', { name: /Docs Session/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);

		fireEvent.change(searchInput, { target: { value: 'no-match' } });
		expect(screen.getByText('No matching sessions found')).toBeInTheDocument();

		cleanup();
		renderModal({ allSessions: [sourceSession, targetSessions[3]] });
		expect(screen.getByText('No other sessions available')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
	});

	it('supports keyboard and click selection, send options, and successful transfer close', async () => {
		const { props } = renderModal();
		const dialog = screen.getByRole('dialog');

		fireEvent.keyDown(dialog, { key: 'ArrowUp' });
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'ArrowUp' });
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: '9' });
		fireEvent.keyDown(dialog, { key: 'Tab' });
		fireEvent.keyDown(dialog, { key: ' ' });
		expect(screen.getByRole('option', { name: /API Session/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);

		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });

		fireEvent.keyDown(dialog, { key: '1' });
		expect(screen.getByRole('option', { name: /Docs Session/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(screen.getByText('Target: Docs Session')).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText(/Clean context/));
		expect(screen.queryByText('After cleaning:')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Send to Session' }));

		await waitFor(() => {
			expect(props.onSend).toHaveBeenCalledWith('docs', {
				groomContext: false,
				targetSessionId: 'docs',
			} satisfies SendToAgentOptions);
		});
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('omits numeric quick-select labels after the ninth result', () => {
		const manySessions = Array.from({ length: 10 }, (_, index) =>
			createTargetSession(
				`agent-${index + 1}`,
				`Agent ${index + 1}`,
				'codex',
				`/workspace/agent-${index + 1}`
			)
		);

		renderModal({ allSessions: manySessions });

		expect(
			screen.getByRole('option', { name: 'Agent 9, Idle, press 9 to select' })
		).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'Agent 10, Idle' })).toBeInTheDocument();
	});

	it('handles Enter-to-select then Enter-to-send and pending send state', async () => {
		let resolveSend: ((value: MergeResult) => void) | undefined;
		const onSend = vi.fn(
			() =>
				new Promise<MergeResult>((resolve) => {
					resolveSend = resolve;
				})
		);
		const { props } = renderModal({ onSend });
		const dialog = screen.getByRole('dialog');

		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(screen.getByRole('option', { name: /Docs Session/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(onSend).not.toHaveBeenCalled();

		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(await screen.findByText('Sending...')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Sending/ })).toHaveAttribute('aria-busy', 'true');

		resolveSend?.({ success: true });
		await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
	});

	it('keeps the modal open on send failure, disables stale selections, and closes from controls', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const onSend = vi.fn().mockRejectedValueOnce(new Error('send failed'));
		const { props, rerender } = renderModal({ onSend });

		fireEvent.click(screen.getByRole('option', { name: /Docs Session/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Send to Session' }));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Send to session failed:',
				undefined,
				expect.any(Error)
			);
		});
		expect(props.onClose).not.toHaveBeenCalled();

		rerender(
			<LayerStackProvider>
				<SendToAgentModal {...props} allSessions={[sourceSession]} />
			</LayerStackProvider>
		);
		expect(screen.queryByText('Target: Docs Session')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Send to Session' })).toBeDisabled();

		fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('covers missing source tab, generated tab names, Escape close, and closed rendering', async () => {
		const generatedSource = createSession({
			aiTabs: [
				{
					...sourceSession.aiTabs[0],
					id: 'generated',
					name: null,
					agentSessionId: 'codex-session-abc',
					logs: [{ id: 'empty', timestamp: 3, source: 'ai', text: undefined as unknown as string }],
				},
			],
		});

		const { props, rerender } = renderModal({
			sourceSession: generatedSource,
			sourceTabId: 'generated',
		});
		expect(screen.getByText(/Source: CODEX/)).toBeInTheDocument();
		expect(screen.getByText('~0 tokens')).toBeInTheDocument();

		rerender(
			<LayerStackProvider>
				<SendToAgentModal
					{...props}
					sourceSession={createSession({
						aiTabs: [
							{
								...sourceSession.aiTabs[0],
								id: 'new-tab',
								name: null,
								agentSessionId: null,
								logs: [],
							},
						],
					})}
					sourceTabId="new-tab"
				/>
			</LayerStackProvider>
		);
		expect(screen.getByText(/Source: New Session/)).toBeInTheDocument();

		rerender(
			<LayerStackProvider>
				<SendToAgentModal {...props} sourceSession={generatedSource} sourceTabId="missing" />
			</LayerStackProvider>
		);
		expect(screen.getByText(/Source: Unknown/)).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());

		rerender(
			<LayerStackProvider>
				<SendToAgentModal {...props} isOpen={false} />
			</LayerStackProvider>
		);
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
});
