/**
 * @fileoverview Tests for NudgeMessageField component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NudgeMessageField } from '../../../../renderer/components/NewInstanceModal/NudgeMessageField';
import type { Theme } from '../../../../renderer/types';

const createTheme = (): Theme =>
	({
		id: 'test-dark',
		name: 'Test Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a2e',
			bgSidebar: '#16213e',
			bgActivity: '#0f3460',
			textMain: '#e8e8e8',
			textDim: '#888888',
			accent: '#7b2cbf',
			accentDim: '#5a1f8f',
			accentForeground: '#ffffff',
			border: '#333355',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
			info: '#3b82f6',
			bgAccentHover: '#9333ea',
		},
	}) as Theme;

describe('NudgeMessageField', () => {
	it('should render textarea with provided value', () => {
		render(
			<NudgeMessageField theme={createTheme()} value="Test nudge message" onChange={vi.fn()} />
		);

		const textarea = screen.getByPlaceholderText(
			'Instructions appended to every message you send...'
		);
		expect(textarea).toBeInTheDocument();
		expect(textarea).toHaveValue('Test nudge message');
	});

	it('should call onChange when user types', () => {
		const onChange = vi.fn();
		render(<NudgeMessageField theme={createTheme()} value="" onChange={onChange} />);

		const textarea = screen.getByPlaceholderText(
			'Instructions appended to every message you send...'
		);
		fireEvent.change(textarea, { target: { value: 'Hello' } });
		expect(onChange).toHaveBeenCalledWith('Hello');
	});

	it('should show character count', () => {
		render(<NudgeMessageField theme={createTheme()} value="Hello" onChange={vi.fn()} />);

		expect(screen.getByText('5/1000')).toBeInTheDocument();
	});

	it('should render label with optional hint', () => {
		render(<NudgeMessageField theme={createTheme()} value="" onChange={vi.fn()} />);

		expect(screen.getByText('Nudge Message')).toBeInTheDocument();
		expect(screen.getByText('(optional)')).toBeInTheDocument();
	});

	it('should use custom maxLength when provided', () => {
		render(
			<NudgeMessageField theme={createTheme()} value="Hi" onChange={vi.fn()} maxLength={500} />
		);

		expect(screen.getByText('2/500')).toBeInTheDocument();
	});

	it('should truncate input to maxLength', () => {
		const onChange = vi.fn();
		render(<NudgeMessageField theme={createTheme()} value="" onChange={onChange} maxLength={5} />);

		const textarea = screen.getByPlaceholderText(
			'Instructions appended to every message you send...'
		);
		fireEvent.change(textarea, { target: { value: 'Hello World' } });
		expect(onChange).toHaveBeenCalledWith('Hello');
	});

	it('should render custom label, description, and placeholder', () => {
		render(
			<NudgeMessageField
				theme={createTheme()}
				value=""
				onChange={vi.fn()}
				label="New Session Message"
				description="Custom description text."
				placeholder="Custom placeholder..."
			/>
		);

		expect(screen.getByText('New Session Message')).toBeInTheDocument();
		expect(screen.getByText('Custom description text.')).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Custom placeholder...')).toBeInTheDocument();
	});
});
