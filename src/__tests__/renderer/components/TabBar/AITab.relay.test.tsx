import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AITab } from '../../../../renderer/components/TabBar/AITab';
import { createMockAITab } from '../../../helpers/mockTab';
import { mockTheme } from '../../../helpers/mockTheme';

describe('AI tab Relay provenance', () => {
	it.each(['idle', 'busy'] as const)(
		'shows origin independently of %s state, including after reload',
		(state) => {
			const tab = JSON.parse(
				JSON.stringify(createMockAITab({ origin: 'relay', state, name: 'Conversation' }))
			);
			const props = {
				tab,
				tabId: tab.id,
				isActive: false,
				theme: mockTheme,
				canClose: true,
				onSelect: vi.fn(),
				onClose: vi.fn(),
				onDragStart: vi.fn(),
				onDragOver: vi.fn(),
				onDragEnd: vi.fn(),
				onDrop: vi.fn(),
				isDragging: false,
				isDragOver: false,
				onRename: vi.fn(),
			};
			const view = render(<AITab {...props} />);
			expect(screen.getByText('Relay')).toBeInTheDocument();
			view.rerender(<AITab {...props} tab={{ ...tab, origin: 'user' }} />);
			expect(screen.queryByText('Relay')).not.toBeInTheDocument();
		}
	);
});
