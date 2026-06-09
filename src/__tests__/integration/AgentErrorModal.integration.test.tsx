import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentErrorModal, type RecoveryAction } from '../../renderer/components/AgentErrorModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { AgentError, AgentErrorType, Theme } from '../../renderer/types';

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const timestamp = new Date('2026-05-13T14:15:00Z').getTime();

const createError = (overrides: Partial<AgentError> = {}): AgentError => ({
	type: 'network_error',
	message: 'The agent could not reach the provider.',
	recoverable: true,
	agentId: 'claude-code',
	sessionId: 'session-1',
	timestamp,
	...overrides,
});

const renderModal = ({
	error = createError(),
	agentName,
	sessionName,
	recoveryActions = [],
	onDismiss = vi.fn(),
	dismissible,
}: {
	error?: AgentError;
	agentName?: string;
	sessionName?: string;
	recoveryActions?: RecoveryAction[];
	onDismiss?: () => void;
	dismissible?: boolean;
} = {}) => {
	const view = render(
		<LayerStackProvider>
			<AgentErrorModal
				theme={testTheme}
				error={error}
				agentName={agentName}
				sessionName={sessionName}
				recoveryActions={recoveryActions}
				onDismiss={onDismiss}
				dismissible={dismissible}
			/>
		</LayerStackProvider>
	);

	return { ...view, onDismiss };
};

describe('AgentErrorModal', () => {
	it.each<[AgentErrorType, string, string]>([
		['auth_expired', 'Authentication Required', 'keyround-icon'],
		['token_exhaustion', 'Context Limit Reached', 'messagesquareplus-icon'],
		['rate_limited', 'Rate Limit Exceeded', 'clock-icon'],
		['network_error', 'Connection Error', 'wifi-icon'],
		['agent_crashed', 'Agent Error', 'xcircle-icon'],
		['permission_denied', 'Permission Denied', 'shieldalert-icon'],
		['session_not_found', 'Error', 'alertcircle-icon'],
		['unknown', 'Error', 'alertcircle-icon'],
	])('renders the %s title and icon', (type, title, iconTestId) => {
		renderModal({ error: createError({ type }) });

		expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
		expect(screen.getByText(title)).toBeInTheDocument();
		expect(screen.getByTestId(iconTestId)).toBeInTheDocument();
	});

	it('renders message, timestamp, and combined agent/session context', () => {
		renderModal({
			agentName: 'Claude Agent',
			sessionName: 'Feature Work',
			error: createError({ recoverable: false }),
		});

		expect(screen.getByText('Claude Agent')).toBeInTheDocument();
		expect(screen.getByText('Feature Work')).toBeInTheDocument();
		expect(screen.getByText('The agent could not reach the provider.')).toBeInTheDocument();
		expect(screen.getByText(new Date(timestamp).toLocaleTimeString())).toBeInTheDocument();
		expect(screen.getByTestId('wifi-icon').closest('span')).toHaveStyle({
			color: testTheme.colors.error,
		});
	});

	it('renders agent-only and session-only context without requiring both labels', () => {
		const { rerender } = render(
			<LayerStackProvider>
				<AgentErrorModal
					theme={testTheme}
					error={createError()}
					agentName="Claude Agent"
					recoveryActions={[]}
					onDismiss={vi.fn()}
				/>
			</LayerStackProvider>
		);

		expect(screen.getByText('Claude Agent')).toBeInTheDocument();
		expect(screen.queryByText('Feature Work')).not.toBeInTheDocument();

		rerender(
			<LayerStackProvider>
				<AgentErrorModal
					theme={testTheme}
					error={createError()}
					sessionName="Feature Work"
					recoveryActions={[]}
					onDismiss={vi.fn()}
				/>
			</LayerStackProvider>
		);

		expect(screen.getByText('Feature Work')).toBeInTheDocument();
		expect(screen.queryByText('Claude Agent')).not.toBeInTheDocument();
	});

	it('expands and collapses parsed JSON error details', () => {
		renderModal({
			error: createError({
				parsedJson: {
					code: 'ETIMEDOUT',
					retryAfter: 30,
				},
			}),
		});

		let detailsButton = screen.getByRole('button', { name: /Error Details/ });
		expect(within(detailsButton).getByTestId('chevronright-icon')).toBeInTheDocument();
		expect(screen.queryByText('"code"')).not.toBeInTheDocument();

		fireEvent.click(detailsButton);

		detailsButton = screen.getByRole('button', { name: /Error Details/ });
		expect(within(detailsButton).getByTestId('chevrondown-icon')).toBeInTheDocument();
		expect(screen.getByText('"code"')).toBeInTheDocument();
		expect(screen.getByText('"ETIMEDOUT"')).toBeInTheDocument();

		fireEvent.click(detailsButton);

		detailsButton = screen.getByRole('button', { name: /Error Details/ });
		expect(within(detailsButton).getByTestId('chevronright-icon')).toBeInTheDocument();
		expect(screen.queryByText('"code"')).not.toBeInTheDocument();
	});

	it('renders and invokes recovery actions with primary and fallback icons', async () => {
		const retry = vi.fn();
		const signIn = vi.fn();
		renderModal({
			recoveryActions: [
				{
					id: 'retry',
					label: 'Retry',
					description: 'Try the last request again',
					onClick: retry,
				},
				{
					id: 'sign-in',
					label: 'Sign in again',
					description: 'Open authentication flow',
					primary: true,
					icon: <span data-testid="custom-auth-icon" />,
					onClick: signIn,
				},
			],
		});

		expect(screen.getByRole('button', { name: /Retry/ })).toContainElement(
			screen.getByTestId('refreshcw-icon')
		);
		expect(screen.getByText('Try the last request again')).toHaveStyle({
			color: testTheme.colors.textDim,
		});
		expect(screen.getByRole('button', { name: /Sign in again/ })).toContainElement(
			screen.getByTestId('custom-auth-icon')
		);
		expect(screen.getByText('Open authentication flow')).toHaveStyle({
			color: `${testTheme.colors.accentForeground}99`,
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Sign in again/ })).toHaveFocus();
		});

		fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
		fireEvent.click(screen.getByRole('button', { name: /Sign in again/ }));

		expect(retry).toHaveBeenCalledTimes(1);
		expect(signIn).toHaveBeenCalledTimes(1);
	});

	it('focuses the first recovery action when none are marked primary', async () => {
		const retry = vi.fn();
		const openDocs = vi.fn();

		renderModal({
			recoveryActions: [
				{ id: 'retry', label: 'Retry', onClick: retry },
				{ id: 'docs', label: 'Open docs', onClick: openDocs },
			],
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Retry/ })).toHaveFocus();
		});

		fireEvent.click(screen.getByRole('button', { name: /Open docs/ }));

		expect(openDocs).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
	});

	it('renders no recovery action section when there are no actions', () => {
		renderModal();

		expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
	});

	it('dismisses through the close and dismiss buttons when allowed', () => {
		const { onDismiss } = renderModal({
			recoveryActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
		});

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

		expect(onDismiss).toHaveBeenCalledTimes(2);
	});

	it('hides close and dismiss controls when the error is not dismissible', () => {
		renderModal({ dismissible: false });

		expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Close modal' })).not.toBeInTheDocument();
	});
});
