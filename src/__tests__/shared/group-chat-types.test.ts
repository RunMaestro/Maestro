import { describe, expect, it } from 'vitest';
import {
	extractCanonicalAutoRunRefs,
	extractStructuredAutoRunPaths,
} from '../../shared/group-chat-types';

describe('group-chat-types autorun helpers', () => {
	it('extracts structured AUTO_RUN_PATH lines', () => {
		expect(
			extractStructuredAutoRunPaths(
				'Done.\n\nAUTO_RUN_PATH: auto_run/qua-1613-dataplane\nAUTO_RUN_TRIGGER: !autorun @dataplane:auto_run/qua-1613-dataplane',
				'dataplane'
			)
		).toEqual(['auto_run/qua-1613-dataplane']);
	});

	it('ignores AUTO_RUN_TRIGGER lines for other participants', () => {
		expect(
			extractStructuredAutoRunPaths(
				'AUTO_RUN_TRIGGER: !autorun @controlplane:qua-1613-controlplane',
				'dataplane'
			)
		).toEqual([]);
	});

	it('builds canonical Auto Run refs from enriched content', () => {
		expect(
			extractCanonicalAutoRunRefs(
				'Implemented the change.\n\n## Maestro Auto Run Refs\nAUTO_RUN_PATH: qua-1613-controlplane\nAUTO_RUN_TRIGGER: !autorun @controlplane:qua-1613-controlplane',
				'controlplane'
			)
		).toEqual([
			{
				participantName: 'controlplane',
				relativePath: 'qua-1613-controlplane',
				triggerCommand: '!autorun @controlplane:qua-1613-controlplane',
			},
		]);
	});

	it('prefers the Maestro ref block over conflicting participant-authored AUTO_RUN lines', () => {
		expect(
			extractCanonicalAutoRunRefs(
				[
					'AUTO_RUN_PATH: wrong/path',
					'AUTO_RUN_TRIGGER: !autorun @controlplane:wrong/path',
					'',
					'## Maestro Auto Run Refs',
					'AUTO_RUN_PATH: qua-1613-controlplane',
					'AUTO_RUN_TRIGGER: !autorun @controlplane:qua-1613-controlplane',
				].join('\n'),
				'controlplane'
			)
		).toEqual([
			{
				participantName: 'controlplane',
				relativePath: 'qua-1613-controlplane',
				triggerCommand: '!autorun @controlplane:qua-1613-controlplane',
			},
		]);
	});
});
