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
