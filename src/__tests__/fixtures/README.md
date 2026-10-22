# Test fixtures

Small, committed assets used by automated tests live alongside this file
(currently just `maestro-test-image.png`).

## Large preview fixtures (not committed)

The 26 synthetic files used to manually verify the tiered FilePreview
pipeline (Rich / Fast / Giant) are too big to commit. Place (or generate)
them outside the repo at a location convenient for you - the suggested
sibling layout is:

```
<your-workspace>/AgentTesting/demo-vue-calculator/preview-test-files/
```

The author of this README keeps them at the path above as a peer of the
Maestro checkout, but any directory works. That directory ships with
`_generate.mjs`, a Node script that regenerates every fixture
(deterministic output, no network). If you don't yet have the directory,
copy `_generate.mjs` from another developer's setup or recreate it from
the fixture descriptions below; then run:

```bash
cd <your-workspace>/AgentTesting/demo-vue-calculator/preview-test-files
node _generate.mjs
```

### Coverage at a glance

The fixture set covers each tier boundary plus deliberately pathological
inputs:

- **Rich** (≤ 256 KB, ≤ 5k lines): small markdown with frontmatter, Mermaid,
  XSS attempts, wiki links, GFM tables.
- **Fast** (≤ 8 MB, ≤ 500k lines, no line > 10k chars): 300k-line markdown,
  1M-line `.log`, 50k-line `.ts`, large GFM tables.
- **Giant** (above any Fast cap): 50 MB code files, 67 MB logs, the
  `edge-one-huge-line.txt` (single 488 KB line that escalates to Giant via
  the long-line threshold).

Use these for manual perf sweeps in `npm run dev` - open each in FilePreview
and watch for: first-paint time, scroll FPS, search count stability,
prev/next precision (lands on the matched word, not just the block), tier
chip override persistence across tab switch.

## `fake-agent.mjs`

A provider stand-in: it replays one recorded turn (stdout chunks, stderr, and
how the process ended) and ignores the arguments it was started with, so it
can take the place of any provider's binary. The run layer's tests and the
headless program's test start it as a real process. Its header comment lists
the environment variables that drive it.

## `fake-llama-server.mjs`

A stand-in for llama.cpp's `llama-server` in router mode. It takes the
arguments the model server supervisor starts the real binary with (`--host`,
`--port`, `--api-key-file`, `--models-preset`, `--models-max`) and answers
`/health`, `/models` and `/models/load` in the real server's shapes, so the
supervisor's tests start, stop, crash and load models against a real process
without a real model. Its header comment lists the environment variables that
drive it.

## `dataview-vault/`

The shared Obsidian-style vault the Dataview tests run against. Its own
`README.md` maps each note to the requirement it covers, lists the expected
results of the spec's two motivating queries, and explains why every note
carries a frontmatter `created` date.
