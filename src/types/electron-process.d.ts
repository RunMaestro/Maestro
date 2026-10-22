// Ambient type for `process.resourcesPath`, which Electron adds to Node's process.
//
// Electron's own typings declare it, and every whole-project config reaches them.
// The maestro-lib entry's type graph is built on its own (`npm run
// build:maestro-lib`, `docs-examples.test.ts`) with Node's types only, and it
// includes `launch/interactive-mode.ts`, which reads `process.resourcesPath` to
// find a packaged app's resources. The declaration below is the same one
// Electron makes, so the two merge in the whole-project configs. Outside
// Electron the value is undefined at runtime, which that code already checks.

declare namespace NodeJS {
	interface Process {
		readonly resourcesPath: string;
	}
}
