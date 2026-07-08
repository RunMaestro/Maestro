import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlaybookNameModal } from '../../../renderer/components/PlaybookNameModal';
import type { Theme } from '../../../renderer/types';

vi.mock('lucide-react', () => ({
	Save: () => <svg data-testid="save-icon" />,
	X: () => <svg data-testid="x-icon" />,
}));

vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) => (
		<div>
			{children}
			{footer}
		</div>
	),
	ModalFooter: ({ onConfirm }: { onConfirm: () => void }) => (
		<button type="button" onClick={onConfirm}>
			Mock Save
		</button>
	),
}));

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

describe('PlaybookNameModal defensive save guard', () => {
	it('does not save a whitespace-only name if the footer invokes confirm directly', () => {
		const onSave = vi.fn();

		render(<PlaybookNameModal theme={testTheme} onSave={onSave} onCancel={vi.fn()} />);

		fireEvent.change(screen.getByPlaceholderText('Enter playbook name...'), {
			target: { value: '   ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Mock Save' }));

		expect(onSave).not.toHaveBeenCalled();
	});
});
