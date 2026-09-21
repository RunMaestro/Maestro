const os = require('os');
const path = require('path');

/**
 * The throwaway data directory Showcase Mode seeds and the dev app reads.
 *
 * Resolved through `os.tmpdir()` rather than a hardcoded `/tmp/...`, which does
 * not exist on Windows. This mirrors the same fix in `scripts/dev-demo.mjs`.
 * An explicit MAESTRO_DEMO_DIR from the caller still wins, so a contributor can
 * point a capture run at a directory they can keep.
 *
 * setup.js WRITES this directory and launch.js hands it to the dev server, so
 * the two must never resolve it independently.
 */
const SHOWCASE_DIR = process.env.MAESTRO_DEMO_DIR || path.join(os.tmpdir(), 'maestro-showcase');

module.exports = { SHOWCASE_DIR };
