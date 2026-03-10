/**
 * Tests for src/renderer/utils/agentArgs.ts
 */

import { describe, it, expect } from 'vitest';
import { filterYoloArgs } from '../../../renderer/utils/agentArgs';

describe('filterYoloArgs', () => {
	it('filters --dangerously-skip-permissions from args', () => {
		const result = filterYoloArgs(['--print', '--dangerously-skip-permissions', '--verbose'], {});
		expect(result).toEqual(['--print', '--verbose']);
	});

	it('filters --dangerously-bypass-approvals-and-sandbox from args', () => {
		const result = filterYoloArgs(['--json', '--dangerously-bypass-approvals-and-sandbox'], {});
		expect(result).toEqual(['--json']);
	});

	it('filters --skip-permissions-unsafe from args', () => {
		const result = filterYoloArgs(['--skip-permissions-unsafe', '--format', 'json'], {});
		expect(result).toEqual(['--format', 'json']);
	});

	it('filters -y from args', () => {
		const result = filterYoloArgs(['--output-format', 'stream-json', '-y'], {});
		expect(result).toEqual(['--output-format', 'stream-json']);
	});

	it('includes agent-specific yoloModeArgs in the filter', () => {
		const result = filterYoloArgs(['--custom-yolo', '--safe-flag'], {
			yoloModeArgs: ['--custom-yolo'],
		});
		expect(result).toEqual(['--safe-flag']);
	});

	it('returns all args when none are YOLO flags', () => {
		const args = ['--print', '--verbose', '--format', 'json'];
		const result = filterYoloArgs(args, {});
		expect(result).toEqual(args);
	});

	it('returns empty array when all args are YOLO flags', () => {
		const result = filterYoloArgs(['--dangerously-skip-permissions', '-y'], {});
		expect(result).toEqual([]);
	});

	it('handles empty args array', () => {
		const result = filterYoloArgs([], {});
		expect(result).toEqual([]);
	});

	it('handles empty yoloModeArgs array', () => {
		const result = filterYoloArgs(['--print', '-y'], { yoloModeArgs: [] });
		expect(result).toEqual(['--print']);
	});
});
