/**
 * E2E Tests: Role-Based Dispatch Pipeline (#426)
 *
 * Full pipeline coverage: runner → reviewer → merger workflow with the
 * reject→fixer loop.
 *
 * DEFERRED: This spec is a placeholder. Implementation requires the pipeline
 * state machine (role transitions, requiredRole enforcement, role-specific
 * prompts) tracked in the follow-up issue to #426.
 *
 * Prerequisites (once implemented):
 *   npm run build:main && npm run build:renderer
 */
import { test } from './fixtures/electron-app';

test.describe.skip('Role-based dispatch pipeline', () => {
	test.skip('runner agent picks up a role-gated work item', async () => {
		// TODO: Create a WorkItem with pipeline.currentRole = 'runner'
		// TODO: Register a fleet agent with dispatchProfile.roles = ['runner']
		// TODO: Trigger auto-pickup and assert the runner agent claims the item
	});

	test.skip('reviewer agent is not eligible for a runner-gated item', async () => {
		// TODO: Create a WorkItem with pipeline.currentRole = 'runner'
		// TODO: Register a fleet agent with dispatchProfile.roles = ['reviewer']
		// TODO: Trigger auto-pickup and assert no claim is made
	});

	test.skip('pipeline advances from runner to reviewer on completion', async () => {
		// TODO: Complete the runner stage and assert currentRole transitions to 'reviewer'
	});

	test.skip('reviewer rejection routes to fixer via pipeline state machine', async () => {
		// TODO: Reviewer rejects → assert currentRole becomes 'fixer'
	});

	test.skip('merger finalises the pipeline and marks item done', async () => {
		// TODO: Complete runner→reviewer→merger and assert WorkItem status = 'done'
	});
});
