import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { AgentErrorModal } from '../../../renderer/components/AgentErrorModal';
import type { Theme, AgentError } from '../../../renderer/types';

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
		cursor: '#ffffff',
		terminalBg: '#1a1a1a',
	},
};

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

describe('AgentErrorModal', () => {
	it('should show rate limit info when headers are present in parsedJson', () => {
		const error: AgentError = {
			type: 'rate_limited',
			message: 'Usage credits exhausted (billing/quota).',
			recoverable: false,
			agentId: 'claude-code',
			timestamp: Date.now(),
			parsedJson: {
				headers: {
					'retry-after': '30',
					'x-ratelimit-remaining-requests': '0',
					'x-ratelimit-limit-requests': '100',
					'x-ratelimit-reset-requests': '10',
					'x-ratelimit-remaining-tokens': '0',
					'x-ratelimit-limit-tokens': '1000',
					'x-ratelimit-reset-tokens': '10',
				},
			},
		};

		render(
			<AgentErrorModal
				theme={mockTheme}
				error={error}
				agentName="Claude Code"
				sessionName="Test Session"
				recoveryActions={[]}
				onDismiss={vi.fn()}
				dismissible={false}
			/>,
			{ wrapper: TestWrapper }
		);

		expect(screen.getByText('Usage Limit Reached')).toBeInTheDocument();
		expect(screen.getByText('Rate limit info')).toBeInTheDocument();
		expect(screen.getByText('Retry after: 30s')).toBeInTheDocument();
		expect(screen.getByText('Requests: 0/100 (in 10s)')).toBeInTheDocument();
		expect(screen.getByText('Tokens: 0/1,000 (in 10s)')).toBeInTheDocument();
	});

	it('should not show rate limit info for non-rate-limited errors', () => {
		const error: AgentError = {
			type: 'network_error',
			message: 'Connection failed.',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: Date.now(),
			parsedJson: {
				headers: {
					'retry-after': '30',
				},
			},
		};

		render(
			<AgentErrorModal
				theme={mockTheme}
				error={error}
				agentName="Claude Code"
				sessionName="Test Session"
				recoveryActions={[]}
				onDismiss={vi.fn()}
				dismissible={true}
			/>,
			{ wrapper: TestWrapper }
		);

		expect(screen.queryByText('Rate limit info')).toBeNull();
	});

	it('should parse nested tuple-style header containers', () => {
		const error: AgentError = {
			type: 'rate_limited',
			message: 'Usage limit reached.',
			recoverable: false,
			agentId: 'codex',
			timestamp: Date.now(),
			parsedJson: {
				error: {
					response_headers: [
						['retry-after', 'Wed, 21 Oct 2030 07:28:00 GMT'],
						['x-ratelimit-remaining-requests', '1'],
						['x-ratelimit-limit-requests', '100'],
					],
				},
			},
		};

		render(
			<AgentErrorModal
				theme={mockTheme}
				error={error}
				agentName="Codex"
				sessionName="Test Session"
				recoveryActions={[]}
				onDismiss={vi.fn()}
				dismissible={false}
			/>,
			{ wrapper: TestWrapper }
		);

		expect(screen.getByText('Rate limit info')).toBeInTheDocument();
		expect(screen.getByText(/^Retry after: at /)).toBeInTheDocument();
		expect(screen.getByText('Requests: 1/100')).toBeInTheDocument();
	});
});
