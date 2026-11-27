/**
 * What a Playwright spec needs to run Maestro against a throwaway data directory.
 *
 * Free of Playwright imports on purpose: the unit suite imports this file
 * (src/__tests__/scripts/e2e-isolation.test.ts) to pin it to the app. Specs get
 * both names from `./fixtures/electron-app`, which re-exports them.
 */

/**
 * The environment that points a launched Maestro at `dataDir` instead of the
 * real data directory.
 *
 * `MAESTRO_DEMO_DIR` is the app's real demo-mode redirect, so every persisted
 * store, including Group Chats, resolves inside `dataDir`. Redirecting `HOME`
 * does not do this: on macOS Electron derives `userData` from the account's
 * home directory and ignores `$HOME`, so a spec that only sets `HOME` runs
 * against, and overwrites, the real agents, groups and settings.
 *
 * A spec that launches the app itself spreads this into `electron.launch`'s
 * `env` rather than listing the variables again. The `electronApp` fixture
 * uses it too, so there is one definition.
 */
export function isolatedLaunchEnv(dataDir: string) {
	return {
		MAESTRO_DEMO_DIR: dataDir,
		MAESTRO_DATA_DIR: dataDir,
		// Disable hardware acceleration for CI
		ELECTRON_DISABLE_GPU: '1',
		// Set NODE_ENV to test
		NODE_ENV: 'test',
		// Ensure we're in a testing context
		MAESTRO_E2E_TEST: 'true',
	};
}

/**
 * `maestro-settings.json` content that marks the first-run modal series
 * (typography, theme, updates, agent powers) and the Windows warning as already
 * answered. A fresh data directory shows them over the UI a spec is about to
 * drive, so a spec that seeds its own stores into one writes these first.
 */
export const FIRST_RUN_SEEN_SETTINGS = {
	typographyPromptSeen: true,
	themePromptSeen: true,
	updatesPromptSeen: true,
	agentPowersPromptSeen: true,
	suppressWindowsWarning: true,
};
