import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HarnessInteractionPrompt } from '../../../renderer/components/HarnessInteractionPrompt/HarnessInteractionPrompt';
import { useHarnessInteractionStore } from '../../../renderer/stores/harnessInteractionStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';
import { mockTheme } from '../../helpers/mockTheme';

const optionalRequest: HarnessInteractionRequest = {
	requestId: 'request-optional',
	sessionId: 'session-a',
	spawnGeneration: 1,
	kind: 'elicitation',
	provider: 'copilot-cli',
	title: 'Provider settings',
	options: [],
	questions: [
		{
			id: 'optional',
			question: 'Optional value',
			description: 'Optional guidance',
			required: false,
			allowCustom: true,
			options: [],
		},
		{
			id: 'enabled',
			question: 'Enabled',
			required: false,
			default: 'true',
			allowCustom: true,
			options: [],
		},
	],
	createdAt: 1,
};

const originalMaestro = window.maestro;

describe('HarnessInteractionPrompt', () => {
	afterEach(() => {
		useHarnessInteractionStore.setState({ queue: [], responding: {}, settledIds: {} });
		window.maestro = originalMaestro;
	});

	it('renders descriptions and defaults without requiring optional answers', () => {
		window.maestro = {
			...window.maestro,
			process: {
				onHarnessInteractionRequest: vi.fn(() => vi.fn()),
				onHarnessInteractionSettled: vi.fn(() => vi.fn()),
				onExit: vi.fn(() => vi.fn()),
				listHarnessInteractions: vi.fn().mockResolvedValue([]),
				respondHarnessInteraction: vi.fn().mockResolvedValue('resolved'),
			},
		};
		useHarnessInteractionStore.setState({ queue: [optionalRequest] });
		render(
			<LayerStackProvider>
				<HarnessInteractionPrompt theme={mockTheme} />
			</LayerStackProvider>
		);

		expect(screen.getByText('Optional guidance')).toBeInTheDocument();
		expect(screen.getByDisplayValue('true')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Answer' })).toBeEnabled();
	});
});
