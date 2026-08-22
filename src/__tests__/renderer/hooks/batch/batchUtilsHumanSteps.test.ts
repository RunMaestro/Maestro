import { describe, expect, it } from 'vitest';
import { findHumanOnlyTasks } from '../../../../renderer/hooks/batch/batchUtils';

describe('findHumanOnlyTasks', () => {
	it('returns nothing for a document of machine-executable tasks', () => {
		const content = [
			'# Phase 01',
			'',
			'- [ ] Create `src/auth/LoginForm.tsx` with email and password validation.',
			'- [ ] Run `npm run lint` and `npm test`, then fix any failures.',
			'- [ ] Verify dark mode works: toggle switches themes, preference persists after reload.',
		].join('\n');
		expect(findHumanOnlyTasks(content)).toEqual([]);
	});

	it('flags a manual-action task', () => {
		const content = '- [ ] Manually test the login flow in the browser';
		const found = findHumanOnlyTasks(content);
		expect(found).toHaveLength(1);
		expect(found[0].line).toBe(0);
		expect(found[0].text).toBe('Manually test the login flow in the browser');
		expect(found[0].reason).toContain('manual action');
	});

	it('flags visual verification but not ordinary verification', () => {
		const content = [
			'- [ ] Visually verify the spacing on the settings panel',
			'- [ ] Verify the migration applies cleanly by running `npm run migrate`',
		].join('\n');
		const found = findHumanOnlyTasks(content);
		expect(found).toHaveLength(1);
		expect(found[0].line).toBe(0);
	});

	it('flags approval gates and waiting on a person', () => {
		const content = [
			'- [ ] Get approval from the team before proceeding',
			'- [ ] Ask the user which database they prefer',
		].join('\n');
		expect(findHumanOnlyTasks(content).map((t) => t.line)).toEqual([0, 1]);
	});

	it('flags credentials a person must obtain', () => {
		const content = '- [ ] Sign up for a SendGrid account and add the API key to .env';
		expect(findHumanOnlyTasks(content)).toHaveLength(1);
	});

	it('flags a task where a person is the actor', () => {
		const content = '- [ ] The user must confirm the checkout page renders correctly';
		expect(findHumanOnlyTasks(content)).toHaveLength(1);
	});

	it('reports every matching signal for one task', () => {
		const content = '- [ ] Manually walk the flow and get sign-off from the owner';
		const [found] = findHumanOnlyTasks(content);
		expect(found.reason).toContain('manual action');
		expect(found.reason).toContain('approval gate');
	});

	it('ignores checked tasks - they can no longer stall the run', () => {
		const content = '- [x] Manually test the login flow in the browser';
		expect(findHumanOnlyTasks(content)).toEqual([]);
	});

	it('ignores plain bullets, so a trailing manual checklist is safe', () => {
		const content = [
			'- [ ] Add Playwright coverage for the login flow and run `npm run e2e`.',
			'',
			'## Manual Follow-Up (not executed by Auto Run)',
			'',
			'- Manually verify the login screen on a physical iPhone.',
			'- Get design sign-off before launch.',
		].join('\n');
		expect(findHumanOnlyTasks(content)).toEqual([]);
	});

	it('ignores tasks inside fenced code blocks', () => {
		const content = [
			'Do not write tasks like this:',
			'',
			'```markdown',
			'- [ ] Manually test the login flow',
			'```',
			'',
			'- [ ] Add unit tests for `src/auth/session.ts`.',
		].join('\n');
		expect(findHumanOnlyTasks(content)).toEqual([]);
	});

	it('reports 0-indexed line numbers within the document', () => {
		const content = [
			'# Phase 02',
			'',
			'- [ ] Build the checkout flow.',
			'- [ ] Visually confirm the payment step looks right.',
		].join('\n');
		expect(findHumanOnlyTasks(content).map((t) => t.line)).toEqual([3]);
	});

	it('handles CRLF line endings', () => {
		const content = '# Phase\r\n\r\n- [ ] Manually test the flow\r\n';
		expect(findHumanOnlyTasks(content).map((t) => t.line)).toEqual([2]);
	});
});
