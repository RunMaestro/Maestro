import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { AgentSessionsModal } from '../../../renderer/components/AgentSessionsModal';
import { mockTheme } from '../../helpers/mockTheme';
import type { Session } from '../../../renderer/types';

const layerMock = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'layer-1'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => layerMock,
}));

vi.mock('../../../renderer/components/ToolCallCard', () => ({
	ToolCallCard: ({ toolUse }: { toolUse: unknown }) => (
		<div data-testid="tool-call-card">{JSON.stringify(toolUse)}</div>
	),
}));

function activeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent One',
		toolType: 'claude-code',
		cwd: '/repo',
		projectRoot: '/repo',
		sshRemoteId: undefined,
		...overrides,
	} as Session;
}

function storedSession(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: 'stored-1',
		projectPath: '/repo',
		timestamp: '2026-06-18T09:00:00.000Z',
		modifiedAt: '2026-06-18T10:00:00.000Z',
		firstMessage: 'First stored message',
		messageCount: 2,
		sizeBytes: 2048,
		sessionName: 'Primary Session',
		...overrides,
	};
}

function renderModal(overrides: Partial<React.ComponentProps<typeof AgentSessionsModal>> = {}) {
	const props = {
		theme: mockTheme,
		activeSession: activeSession(),
		onClose: vi.fn(),
		onResumeSession: vi.fn(),
		...overrides,
	};
	render(<AgentSessionsModal {...props} />);
	return props;
}

describe('AgentSessionsModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Element.prototype.scrollIntoView = vi.fn();
		(window as any).maestro.claude.getSessionOrigins.mockResolvedValue({
			'stored-1': { starred: true },
		});
		(window as any).maestro.claude.updateSessionStarred.mockResolvedValue(undefined);
		(window as any).maestro.agentSessions.getOrigins.mockResolvedValue({});
		(window as any).maestro.agentSessions.setSessionStarred.mockResolvedValue(undefined);
		(window as any).maestro.agentSessions.listPaginated.mockResolvedValue({
			sessions: [
				storedSession(),
				storedSession({
					sessionId: 'stored-2',
					firstMessage: 'Second message',
					sessionName: undefined,
				}),
			],
			hasMore: false,
			totalCount: 2,
			nextCursor: null,
		});
		(window as any).maestro.agentSessions.read.mockResolvedValue({
			messages: [
				{
					type: 'user',
					content: 'User prompt',
					timestamp: '2026-06-18T10:01:00.000Z',
					uuid: 'msg-1',
				},
				{
					type: 'assistant',
					content: 'Assistant response',
					timestamp: '2026-06-18T10:02:00.000Z',
					uuid: 'msg-2',
				},
			],
			total: 2,
			hasMore: false,
		});
	});

	it('registers the modal layer and loads sessions for the active project', async () => {
		renderModal();

		expect(layerMock.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({ ariaLabel: 'Agent Sessions' })
		);
		expect(await screen.findByText('Primary Session')).toBeInTheDocument();
		expect(screen.getByText('Second message')).toBeInTheDocument();
		expect((window as any).maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
			'claude-code',
			'/repo',
			{ limit: 100 },
			undefined
		);
	});

	it('filters sessions by search and shows the no-match empty state', async () => {
		renderModal();

		const input = await screen.findByPlaceholderText('Search Agent One sessions...');
		fireEvent.change(input, { target: { value: 'Second' } });
		expect(screen.queryByText('Primary Session')).not.toBeInTheDocument();
		expect(screen.getByText('Second message')).toBeInTheDocument();

		fireEvent.change(input, { target: { value: 'missing' } });
		expect(screen.getByText('No sessions match your search')).toBeInTheDocument();
	});

	it('toggles favorites through the provider origin store without opening preview', async () => {
		renderModal();

		fireEvent.click(await screen.findByTitle('Add to favorites'));

		expect((window as any).maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/repo',
			'stored-2',
			true
		);
		expect(screen.queryByText('User prompt')).not.toBeInTheDocument();
	});

	it('opens a stored session preview and resumes it', async () => {
		const props = renderModal();

		fireEvent.click(await screen.findByText('Primary Session'));

		expect(await screen.findByText('User prompt')).toBeInTheDocument();
		expect(screen.getByText('Assistant response')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Resume/i }));

		expect(props.onResumeSession).toHaveBeenCalledWith('stored-1');
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('renders tool-use messages with ToolCallCard and supports returning to the list', async () => {
		(window as any).maestro.agentSessions.read.mockResolvedValue({
			messages: [
				{
					type: 'assistant',
					content: '',
					timestamp: '2026-06-18T10:02:00.000Z',
					uuid: 'msg-tool',
					toolUse: [{ name: 'Read', input: { file_path: 'README.md' } }],
				},
			],
			total: 1,
			hasMore: false,
		});
		renderModal();

		fireEvent.click(await screen.findByText('Primary Session'));

		expect(await screen.findByTestId('tool-call-card')).toHaveTextContent('README.md');
		fireEvent.click(screen.getByLabelText('Go back'));
		expect(await screen.findByPlaceholderText('Search Agent One sessions...')).toBeInTheDocument();
	});

	it('loads earlier messages when the preview has more history', async () => {
		(window as any).maestro.agentSessions.read
			.mockResolvedValueOnce({
				messages: [
					{
						type: 'assistant',
						content: 'Latest response',
						timestamp: '2026-06-18T10:02:00.000Z',
						uuid: 'latest',
					},
				],
				total: 2,
				hasMore: true,
			})
			.mockResolvedValueOnce({
				messages: [
					{
						type: 'user',
						content: 'Earlier prompt',
						timestamp: '2026-06-18T10:00:00.000Z',
						uuid: 'earlier',
					},
				],
				total: 2,
				hasMore: false,
			});
		renderModal();

		fireEvent.click(await screen.findByText('Primary Session'));
		fireEvent.click(await screen.findByText('Load earlier messages...'));

		expect(await screen.findByText('Earlier prompt')).toBeInTheDocument();
		expect((window as any).maestro.agentSessions.read).toHaveBeenLastCalledWith(
			'claude-code',
			'/repo',
			'stored-1',
			{ offset: 1, limit: 20 },
			undefined
		);
	});

	it('shows an empty state when no sessions exist or no active cwd is available', async () => {
		(window as any).maestro.agentSessions.listPaginated.mockResolvedValue({
			sessions: [],
			hasMore: false,
			totalCount: 0,
			nextCursor: null,
		});
		const { rerender } = render(
			<AgentSessionsModal
				theme={mockTheme}
				activeSession={activeSession()}
				onClose={vi.fn()}
				onResumeSession={vi.fn()}
			/>
		);

		expect(await screen.findByText('No sessions found for this project')).toBeInTheDocument();

		rerender(
			<AgentSessionsModal
				theme={mockTheme}
				activeSession={activeSession({ cwd: '' })}
				onClose={vi.fn()}
				onResumeSession={vi.fn()}
			/>
		);
		expect(await screen.findByText('No sessions found for this project')).toBeInTheDocument();
	});
});
