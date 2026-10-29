import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

const requiredRequest: HarnessInteractionRequest = {
	...optionalRequest,
	requestId: 'request-required',
	questions: [{ id: 'required', question: 'Required value', allowCustom: true, options: [] }],
};

const requiredEmptyRequest: HarnessInteractionRequest = {
	...requiredRequest,
	requestId: 'request-required-empty',
	questions: [{ ...requiredRequest.questions![0], allowEmpty: true }],
};

const clearedRequest: HarnessInteractionRequest = {
	...optionalRequest,
	requestId: 'request-cleared',
	questions: [
		{
			id: 'choices',
			question: 'Choices',
			required: false,
			default: ['one'],
			multiSelect: true,
			allowEmpty: true,
			options: [{ optionId: 'one', label: 'one', kind: 'choice' }],
		},
		{
			id: 'text',
			question: 'Text',
			required: false,
			default: 'seed',
			allowCustom: true,
			allowEmpty: true,
			options: [],
		},
	],
};

const originalMaestro = window.maestro;

describe('HarnessInteractionPrompt', () => {
	afterEach(() => {
		useHarnessInteractionStore.setState({ queue: [], responding: {}, settledIds: {} });
		window.maestro = originalMaestro;
	});

	it('renders descriptions and defaults without requiring optional answers', () => {
		const respondHarnessInteraction = vi.fn().mockResolvedValue('resolved');
		window.maestro = {
			...window.maestro,
			process: {
				onHarnessInteractionRequest: vi.fn(() => vi.fn()),
				onHarnessInteractionSettled: vi.fn(() => vi.fn()),
				onExit: vi.fn(() => vi.fn()),
				listHarnessInteractions: vi.fn().mockResolvedValue([]),
				respondHarnessInteraction,
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
		const optionalInput = screen.getAllByRole('textbox')[0];
		fireEvent.change(optionalInput, { target: { value: 'temporary' } });
		fireEvent.change(optionalInput, { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
		expect(respondHarnessInteraction).toHaveBeenCalledWith({
			requestId: 'request-optional',
			outcome: 'answers',
			answers: { enabled: 'true' },
		});
	});

	it('preserves deliberate empty strings and arrays instead of restoring defaults', () => {
		const respondHarnessInteraction = vi.fn().mockResolvedValue('resolved');
		window.maestro = {
			...window.maestro,
			process: {
				onHarnessInteractionRequest: vi.fn(() => vi.fn()),
				onHarnessInteractionSettled: vi.fn(() => vi.fn()),
				onExit: vi.fn(() => vi.fn()),
				listHarnessInteractions: vi.fn().mockResolvedValue([]),
				respondHarnessInteraction,
			},
		};
		useHarnessInteractionStore.setState({ queue: [clearedRequest] });
		render(
			<LayerStackProvider>
				<HarnessInteractionPrompt theme={mockTheme} />
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('checkbox'));
		fireEvent.change(screen.getByDisplayValue('seed'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
		expect(respondHarnessInteraction).toHaveBeenCalledWith({
			requestId: 'request-cleared',
			outcome: 'answers',
			answers: { choices: [], text: '' },
		});
	});

	it('keeps legacy questions without an optional flag blocked until answered', () => {
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
		useHarnessInteractionStore.setState({ queue: [requiredRequest] });
		render(
			<LayerStackProvider>
				<HarnessInteractionPrompt theme={mockTheme} />
			</LayerStackProvider>
		);
		const answer = screen.getByRole('button', { name: 'Answer' });
		expect(answer).toBeDisabled();
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typed answer' } });
		expect(answer).toBeEnabled();
	});

	it('allows a required valid empty answer after the field is touched', () => {
		const respondHarnessInteraction = vi.fn().mockResolvedValue('resolved');
		window.maestro = {
			...window.maestro,
			process: {
				onHarnessInteractionRequest: vi.fn(() => vi.fn()),
				onHarnessInteractionSettled: vi.fn(() => vi.fn()),
				onExit: vi.fn(() => vi.fn()),
				listHarnessInteractions: vi.fn().mockResolvedValue([]),
				respondHarnessInteraction,
			},
		};
		useHarnessInteractionStore.setState({ queue: [requiredEmptyRequest] });
		render(
			<LayerStackProvider>
				<HarnessInteractionPrompt theme={mockTheme} />
			</LayerStackProvider>
		);
		const answer = screen.getByRole('button', { name: 'Answer' });
		expect(answer).toBeDisabled();
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'temporary' } });
		fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
		expect(answer).toBeEnabled();
		fireEvent.click(answer);
		expect(respondHarnessInteraction).toHaveBeenCalledWith({
			requestId: 'request-required-empty',
			outcome: 'answers',
			answers: { required: '' },
		});
	});
});
