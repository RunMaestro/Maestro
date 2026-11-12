import { describe, expect, it } from 'vitest';
import {
	countTasks,
	countTotalTasks,
	extractDocumentDescription,
} from '../../../../../renderer/components/InlineWizard/DocumentGenerationView/utils/documentStats';

describe('DocumentGenerationView document stats', () => {
	it('counts simple markdown task rows', () => {
		expect(countTasks('- [ ] One\n- [x] Two\n- [X] ignored by legacy UI regex')).toBe(2);
	});

	it('counts total tasks across documents', () => {
		expect(
			countTotalTasks([
				{ filename: 'a.md', content: '- [ ] One', taskCount: 1 },
				{ filename: 'b.md', content: '- [ ] Two\n- [x] Three', taskCount: 2 },
			])
		).toBe(3);
	});

	it('extracts the first non-heading non-list paragraph', () => {
		expect(extractDocumentDescription('# Title\n\n- [ ] Task\n\nFirst useful paragraph.')).toBe(
			'First useful paragraph.'
		);
	});

	it('truncates long descriptions', () => {
		const description = extractDocumentDescription('a'.repeat(160));
		expect(description).toHaveLength(150);
		expect(description?.endsWith('...')).toBe(true);
	});
});
