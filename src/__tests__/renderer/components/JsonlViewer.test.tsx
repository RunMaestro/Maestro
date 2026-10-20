import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JsonlViewer } from '../../../renderer/components/JsonlViewer';
import { mockTheme } from '../../helpers/mockTheme';
// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

const TABULAR_JSONL = '{"name":"alpha","size":1}\n{"name":"beta","size":2}';

describe('JsonlViewer', () => {
	describe('scroll container', () => {
		it('pins the table header inside the content area that scrolls both axes', () => {
			// A horizontal-only wrapper around the table would be the header's
			// nearest scrolling ancestor while never scrolling vertically, so the
			// header would scroll away with the rows.
			render(<JsonlViewer content={TABULAR_JSONL} theme={mockTheme} />);

			const header = screen.getByText('name').closest('th');
			expect(header).toHaveStyle({ position: 'sticky', top: '0px' });
			const scroller = header?.closest('[data-preview-scroller]');
			expect(scroller).toHaveClass('overflow-auto');
			expect(header?.closest('.overflow-x-auto')).toBeNull();
		});
	});
});
