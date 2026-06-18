/**
 * Tests for Cue-specific template variable substitution.
 *
 * Validates that substituteTemplateVariables correctly handles all CUE_* prefixed
 * variables for file.changed, agent.completed, task.pending, github.*, and base
 * event contexts.
 */

import { describe, it, expect } from 'vitest';
import {
	substituteTemplateVariables,
	type TemplateContext,
} from '../../../shared/templateVariables';

function makeContext(cue: TemplateContext['cue'] = {}): TemplateContext {
	return {
		session: {
			id: 'session-1',
			name: 'Test Agent',
			toolType: 'claude-code',
			cwd: '/projects/test',
		},
		cue,
	};
}

describe('Cue template variable substitution', () => {
	it('substitutes all file.changed variables', () => {
		const ctx = makeContext({
			filePath: '/projects/test/src/app.ts',
			fileName: 'app.ts',
			fileDir: '/projects/test/src',
			fileExt: '.ts',
			fileChangeType: 'change',
		});
		const template =
			'File {{CUE_FILE_PATH}} name={{CUE_FILE_NAME}} dir={{CUE_FILE_DIR}} ext={{CUE_FILE_EXT}} change={{CUE_FILE_CHANGE_TYPE}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'File /projects/test/src/app.ts name=app.ts dir=/projects/test/src ext=.ts change=change'
		);
	});

	it('substitutes all agent.completed variables', () => {
		const ctx = makeContext({
			sourceSession: 'worker-1',
			sourceOutput: 'Build succeeded',
			sourceStatus: 'completed',
			sourceExitCode: '0',
			sourceDuration: '12345',
			sourceTriggeredBy: 'file-watcher-sub',
		});
		const template = [
			'session={{CUE_SOURCE_SESSION}}',
			'output={{CUE_SOURCE_OUTPUT}}',
			'status={{CUE_SOURCE_STATUS}}',
			'exit={{CUE_SOURCE_EXIT_CODE}}',
			'duration={{CUE_SOURCE_DURATION}}',
			'trigger={{CUE_SOURCE_TRIGGERED_BY}}',
		].join(' ');
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'session=worker-1 output=Build succeeded status=completed exit=0 duration=12345 trigger=file-watcher-sub'
		);
	});

	it('substitutes all task.pending variables', () => {
		const ctx = makeContext({
			taskFile: '/projects/test/tasks/todo.md',
			taskFileName: 'todo.md',
			taskFileDir: '/projects/test/tasks',
			taskCount: '3',
			taskList: '- [ ] task one\n- [ ] task two\n- [ ] task three',
			taskContent: '# TODO\n- [ ] task one\n- [ ] task two\n- [ ] task three',
		});
		const template = [
			'file={{CUE_TASK_FILE}}',
			'name={{CUE_TASK_FILE_NAME}}',
			'dir={{CUE_TASK_FILE_DIR}}',
			'count={{CUE_TASK_COUNT}}',
			'list={{CUE_TASK_LIST}}',
			'content={{CUE_TASK_CONTENT}}',
		].join(' ');
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'file=/projects/test/tasks/todo.md name=todo.md dir=/projects/test/tasks count=3 list=- [ ] task one\n- [ ] task two\n- [ ] task three content=# TODO\n- [ ] task one\n- [ ] task two\n- [ ] task three'
		);
	});

	it('substitutes all github variables', () => {
		const ctx = makeContext({
			ghType: 'pull_request',
			ghNumber: '42',
			ghTitle: 'Add feature X',
			ghAuthor: 'alice',
			ghUrl: 'https://github.com/owner/repo/pull/42',
			ghBody: 'This PR adds feature X',
			ghLabels: 'enhancement,priority',
			ghState: 'open',
			ghRepo: 'owner/repo',
			ghBranch: 'feature-x',
			ghBaseBranch: 'main',
			ghAssignees: 'bob,charlie',
			ghMergedAt: '2026-03-15T12:00:00Z',
		});
		const template = [
			'type={{CUE_GH_TYPE}}',
			'num={{CUE_GH_NUMBER}}',
			'title={{CUE_GH_TITLE}}',
			'author={{CUE_GH_AUTHOR}}',
			'url={{CUE_GH_URL}}',
			'body={{CUE_GH_BODY}}',
			'labels={{CUE_GH_LABELS}}',
			'state={{CUE_GH_STATE}}',
			'repo={{CUE_GH_REPO}}',
			'branch={{CUE_GH_BRANCH}}',
			'base={{CUE_GH_BASE_BRANCH}}',
			'assignees={{CUE_GH_ASSIGNEES}}',
			'merged={{CUE_GH_MERGED_AT}}',
		].join(' ');
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'type=pull_request num=42 title=Add feature X author=alice url=https://github.com/owner/repo/pull/42 body=This PR adds feature X labels=enhancement,priority state=open repo=owner/repo branch=feature-x base=main assignees=bob,charlie merged=2026-03-15T12:00:00Z'
		);
	});

	it('substitutes base event variables', () => {
		const ctx = makeContext({
			eventType: 'file.changed',
			eventTimestamp: '2026-03-15T10:30:00Z',
			triggerName: 'watch-src',
			runId: 'abc-123-def',
		});
		const template =
			'event={{CUE_EVENT_TYPE}} ts={{CUE_EVENT_TIMESTAMP}} trigger={{CUE_TRIGGER_NAME}} run={{CUE_RUN_ID}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe(
			'event=file.changed ts=2026-03-15T10:30:00Z trigger=watch-src run=abc-123-def'
		);
	});

	it('produces empty string for missing cue context fields', () => {
		const ctx = makeContext({});
		const template =
			'event={{CUE_EVENT_TYPE}} file={{CUE_FILE_PATH}} session={{CUE_SOURCE_SESSION}} task={{CUE_TASK_FILE}} gh={{CUE_GH_TYPE}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe('event= file= session= task= gh=');
	});

	it('handles special characters in variable values', () => {
		const ctx = makeContext({
			sourceOutput: 'Line 1\nLine "2"\nCurly {braces} and {{double}}',
		});
		const template = 'output={{CUE_SOURCE_OUTPUT}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toBe('output=Line 1\nLine "2"\nCurly {braces} and {{double}}');
	});

	it('preserves 5000-char sourceOutput without truncation', () => {
		const longOutput = 'x'.repeat(5000);
		const ctx = makeContext({ sourceOutput: longOutput });
		const template = '{{CUE_SOURCE_OUTPUT}}';
		const result = substituteTemplateVariables(template, ctx);
		expect(result).toHaveLength(5000);
		expect(result).toBe(longOutput);
	});
});
