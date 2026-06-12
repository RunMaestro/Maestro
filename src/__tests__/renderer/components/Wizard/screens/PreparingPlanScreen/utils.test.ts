import { describe, expect, it } from 'vitest';
import { getFactPlainText } from '../../../../../../renderer/components/Wizard/screens/PreparingPlanScreen/utils/austinFacts';
import {
	countCreatedFileTasks,
	upsertCreatedFile,
} from '../../../../../../renderer/components/Wizard/screens/PreparingPlanScreen/utils/createdFiles';

describe('PreparingPlanScreen utils', () => {
	it('removes markdown link URLs from Austin facts', () => {
		expect(getFactPlainText('Visit [Austin](https://example.com) today')).toBe(
			'Visit Austin today'
		);
	});

	it('upserts created files by filename and counts tasks', () => {
		const files = upsertCreatedFile([], {
			filename: 'Phase-01.md',
			path: '/project/Phase-01.md',
			size: 10,
			taskCount: 2,
		});
		const updated = upsertCreatedFile(files, {
			filename: 'Phase-01.md',
			path: '/project/Phase-01.md',
			size: 20,
			taskCount: 3,
		});

		expect(updated).toHaveLength(1);
		expect(updated[0].size).toBe(20);
		expect(countCreatedFileTasks(updated)).toBe(3);
	});
});
