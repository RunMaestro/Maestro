# CLAUDE-SETTINGS.md

Style guide for anything rendered inside the Settings modal (`src/renderer/components/Settings/`).

Read this **before** adding or editing a settings section. Every rule here is derived from an audit of all 73 `.tsx` files under `src/renderer/components/Settings/` and all 21 themes in `src/shared/themes.ts`. Where a rule exists because the codebase disagrees with itself, the audit numbers are quoted so you know which side is canonical.

Related: [UI-PATTERNS.md](docs/agent-guides/UI-PATTERNS.md) (modals, layer stack, text selection), [WIDGET-LIBRARY.md](docs/agent-guides/WIDGET-LIBRARY.md) (stat cards, charts, inputs), [[CLAUDE-PATTERNS.md]] §3 (settings persistence plumbing).

---

## 1. The one rule that causes the most rework

**Never apply an `opacity-*` utility and `theme.colors.textDim` to the same text.**

This is "double-dimming". Each channel dims independently, so stacking them multiplies. It is the single most common visual defect in this tree and it is invisible on the theme you happen to be developing against.

```tsx
// WRONG - two dimming channels stacked
<div className="text-xs opacity-70" style={{ color: theme.colors.textDim }}>
	Mentioned agents may modify files in their own workspace.
</div>

// RIGHT - one dimming channel
<div className="text-xs opacity-70">
	Mentioned agents may modify files in their own workspace.
</div>
```

### Why this is not a nitpick

Measured contrast against each theme's `bgMain` (WCAG needs 3:1 for secondary text, 4.5:1 for body):

| Dimming approach                                    | Passes 3:1         | Dracula (default theme) |
| --------------------------------------------------- | ------------------ | ----------------------- |
| `opacity-70` on inherited `textMain` (the standard) | **21 / 21 themes** | 7.34:1                  |
| `textDim`, no opacity utility                       | 21 / 21 themes     | 3.03:1                  |
| `opacity-50` on inherited `textMain` (old default)  | 15 / 21 themes     | 4.52:1                  |
| `opacity-50` **+** `textDim` (double-dim)           | **4 / 21 themes**  | **1.74:1**              |

Double-dimming costs an average of **1.21 contrast points** and fails the 3:1 floor in **17 of 21 themes**. On Dracula the same sentence renders at 1.74:1 instead of 7.34:1 - roughly a **4x** readability loss. That is why one description reads fine and the one directly below it looks broken.

### Why the standard is `opacity-70`, not `opacity-50`

`opacity-50` used to be the convention and it fails 3:1 in 6 themes, **5 of which are light**. This is structural, not a per-theme accident: on a light background an opacity utility blends dark text _toward_ the background, so even a pure-black `textMain` tops out around 3.9:1. You cannot fix it by editing the theme. `opacity-70` clears 3:1 in all 21 themes (worst is `ayu-light` at 3.12:1) while still reading as clearly secondary against a 100% title.

### The trap that produces it

Double-dimming is usually inherited, not typed. It happens when:

1. You copy a neighbouring section that already has the bug, or
2. You pass a `textDim`-colored node **into** a component that already applies opacity. `ToggleSettingRow` wraps `description` in `<p className="text-xs opacity-70">`, so `description={<span style={{ color: theme.colors.textDim }}>...` is a cross-file double-dim that no per-element check would catch.

The tree is currently clean (all 31 historical instances fixed) and `settingsStyleGuide.test.ts` fails the build if one comes back. **Do not disable that test to land a change.**

---

## 2. Canonical anatomy of a settings section

Every section is: **icon heading -> card -> rows**. Nothing else.

```tsx
import { AtSign } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

export function MyFeatureSection({ theme, value, setValue }: MyFeatureSectionProps) {
	return (
		<div data-setting-id="general-my-feature">
			<SettingsSectionHeading icon={AtSign}>My Feature</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Do the thing"
					description="What happens when the thing is done."
					checked={value}
					onChange={setValue}
					clickableRow
				/>
			</SectionCard>
		</div>
	);
}
```

The outer `<div>` carries `data-setting-id` and nothing else. Do not put padding, margins, or borders on it: vertical rhythm between sections is owned by the tab root (`space-y-5`), not by sections.

---

## 3. Use the primitives. Do not hand-roll.

All four already exist. Hand-rolling them is the root cause of the drift this guide exists to stop.

| Need                                | Use                      | Import from                                               |
| ----------------------------------- | ------------------------ | --------------------------------------------------------- |
| Uppercase section heading + icon    | `SettingsSectionHeading` | `src/renderer/components/Settings/SettingsSectionHeading` |
| The bordered card body              | `SectionCard`            | `.../tabs/DisplayTab/components/SectionCard`              |
| A labelled on/off row               | `ToggleSettingRow`       | `.../tabs/DisplayTab/components/ToggleSettingRow`         |
| A 2-4 way choice                    | `ToggleButtonGroup`      | `src/renderer/components/ToggleButtonGroup`               |
| A bare switch (inside a custom row) | `ToggleSwitch`           | `src/renderer/components/ui/ToggleSwitch`                 |

Current adoption:

| Tab            | Files | `SettingsSectionHeading` | `ToggleSettingRow` | Double-dim defects |
| -------------- | ----- | ------------------------ | ------------------ | ------------------ |
| **DisplayTab** | 21    | 16 of 18                 | 27 of 28           | **0**              |
| GeneralTab     | 21    | **18 of 18**             | 0 of 10            | **0**              |
| Settings root  | 20    | 0 of 13                  | n/a                | **0**              |
| EncoreTab      | 6     | 0 of 3                   | n/a                | **0**              |

**`DisplayTab` is the reference implementation.** When you need a template, read `ContextWarningsSection.tsx`, `WindowChromeSection.tsx`, or `TabOptionsSection.tsx`. `GeneralTab` now matches on headings and dimming but still hand-rolls its card bodies and toggle rows, so copy its heading, not its card.

### `SectionCard` note

`SectionCard` defaults to `className="space-y-3"`, which spaces its children. If you pass a custom `className` you lose that default, so re-add `space-y-3` unless you deliberately want tight packing.

---

## 4. Typography

Only these four roles exist. If you find yourself inventing a fifth, you are probably building something that should be a card of its own.

| Role                  | Classes                                                                 | Color                            |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| Section heading       | via `SettingsSectionHeading` (`text-xs font-bold opacity-70 uppercase`) | inherit (never override)         |
| Setting title         | `font-medium` (or `text-sm font-medium` inside dense rows)              | `theme.colors.textMain`          |
| Description / helper  | `text-xs opacity-70`                                                    | **inherit - do not set a color** |
| Micro-note / footnote | `text-[11px] opacity-55`                                                | inherit                          |

**There are exactly two dim levels: `opacity-70` for descriptions and `opacity-55` for micro-notes.** Do not invent a third. The tree previously carried five (`40`, `50`, `60`, `70`, `80`) across 93 sites, which is why neighbouring descriptions looked like different design languages.

Sizes: `text-xs` for descriptions, `text-sm` only inside dense rows, `text-[11px]` for a genuine third-level footnote. Never go below `text-[10px]`.

**Do not set `color` on description text.** Inheriting `textMain` and dimming once is the convention and it is what the shared primitives hard-code. Setting `textDim` on top of that is the bug in §1.

---

## 5. Color

Pull every color from `theme.colors`. Never hard-code a hex for text, borders, or surfaces: there are 21 themes including 4 light ones, and a literal will be unreadable in most of them.

| Token                     | Use for                                               |
| ------------------------- | ----------------------------------------------------- |
| `theme.colors.textMain`   | Setting titles, active control labels                 |
| `theme.colors.textDim`    | Standalone secondary text **with no opacity utility** |
| `theme.colors.border`     | Card borders, row dividers                            |
| `theme.colors.bgMain`     | Card fill                                             |
| `theme.colors.bgActivity` | Inset/well fill, inactive control fill                |
| `theme.colors.accentDim`  | Active state of a selected control                    |
| `theme.colors.warning`    | Destructive-adjacent cautions                         |
| `theme.colors.error`      | Validation failures                                   |

Hard-coded hex is acceptable only for semantic data viz where the color _is_ the meaning (the yellow/red threshold dots in `ContextWarningsSection`). Everywhere else it is a bug.

### Warnings

A warning is an icon plus text, colored with `theme.colors.warning`, placed **above** the control it qualifies so it is read before the choice is made:

```tsx
<div className="flex items-start gap-1.5 text-xs mb-2" style={{ color: theme.colors.warning }}>
	<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
	<span>A consulted agent can change files on its own.</span>
</div>
```

`flex-shrink-0 mt-0.5` on the icon is required: without it the icon squashes on narrow modals and sits misaligned against the first text line.

---

## 6. Spacing and order

| Level                  | Rule                                           |
| ---------------------- | ---------------------------------------------- |
| Between sections       | `space-y-5` on the tab root (owned by the tab) |
| Between rows in a card | `space-y-3` (the `SectionCard` default)        |
| Heading -> card        | `mb-2` (baked into `SettingsSectionHeading`)   |
| Title -> description   | `mt-0.5`                                       |
| Description -> control | `mb-2`                                         |

`EncoreTab` uses `space-y-6`; that is a deliberate exception for its larger feature blocks. New tabs use `space-y-5`.

### Vertical order inside a row is fixed

**Title -> description -> warning (if any) -> control.**

Controls go last and full width. Do not put a wide control in a `justify-between` header row beside the title: it renders narrow and right-aligned, which reads as a different design language from every other section. A `ToggleSwitch` is the one exception - it is small and belongs inline on the right, which is exactly what `ToggleSettingRow` does.

`ToggleButtonGroup` buttons are `flex-1`, so they span the container automatically. The component does **not** accept a `className` prop; wrap it in a spacing div if you need margin.

---

## 7. Choosing a control

| Situation                      | Control                                                 |
| ------------------------------ | ------------------------------------------------------- |
| Boolean                        | `ToggleSettingRow` (with `clickableRow`)                |
| 2-4 mutually exclusive options | `ToggleButtonGroup`                                     |
| 5+ options                     | Native `<select>`, themed                               |
| Bounded numeric with feel      | `<input type="range">`                                  |
| Precise numeric                | `<input type="number">` in a themed wrapper             |
| Free text / paths              | `FormInput` from `src/renderer/components/ui/FormInput` |

Set `clickableRow` on `ToggleSettingRow` so the whole row is a hit target. It already wires `role="button"`, `tabIndex`, and Enter/Space handling; do not re-implement that.

---

## 8. Copy

- **Titles**: sentence case, no trailing period. "Automatically name tabs based on first message".
- **Descriptions**: complete sentences with a period. Say what happens, not what the control is.
- **Never hard-code modifier keys.** Use `formatMetaKey()` / `formatShortcutKeys()` from `src/renderer/utils/shortcutFormatter` or the copy is wrong on the other platform.
- **No em-dashes or en-dashes** anywhere (repo-wide rule). Spaced hyphen, comma, or two sentences.
- Descriptions that change with state should read as the _current_ state, not the available action.

---

## 9. Registration checklist

A settings control is not done when it renders. All six steps or it will not persist, will not survive restart, or will not be findable:

1. `src/shared/settingsMetadata.ts` - add to `SETTINGS_METADATA` with `description`, `type`, `default`, `category`.
2. `src/renderer/stores/settingsStore.ts` - **five** edits: interface field, setter signature, initial-state default, setter action (which must call `window.maestro.settings.set`), and the `allSettings[...]` hydration mapping. Skipping hydration is the classic "setting resets on restart" bug.
3. `src/renderer/hooks/settings/useSettings.ts` - add the field and setter to `UseSettingsReturn`. The store is spread at runtime, but the type is curated, so TS fails without this.
4. `src/main/stores/defaults.ts` - **only** if `MaestroSettings` requires the key. Editor/input-behavior settings deliberately do not live here; their default comes from `settingsMetadata.ts`.
5. `src/renderer/components/Settings/searchableSettings.ts` - add a `SearchableSetting` whose `id` exactly matches the `data-setting-id` on your section root. Put every user-visible string from the section into `keywords`.
6. Render it and thread props from the tab.

`searchableSettings.test.ts` enforces DOM parity in both directions: a `data-setting-id` with no registry entry fails, and a registry entry with no `data-setting-id` fails. It also asserts that specific user-typed phrases surface your section, so add your visible strings to that `it.each` table.

---

## 10. Review checklist

Before you call a settings change done:

- [ ] No element has both an `opacity-*` utility and `theme.colors.textDim`
- [ ] No `textDim`-colored node passed into `ToggleSettingRow`'s `description`
- [ ] Dim levels are only `opacity-70` (description) or `opacity-55` (micro-note)
- [ ] `SettingsSectionHeading` used, with a Lucide icon
- [ ] `SectionCard` used for the body
- [ ] Order is title -> description -> warning -> control
- [ ] Control spans full width (except an inline `ToggleSwitch`)
- [ ] No hard-coded hex, no hard-coded `Cmd`/`Ctrl`
- [ ] `data-setting-id` matches the `searchableSettings.ts` entry
- [ ] Checked against a light theme (`ayu-light` is the tightest at 3.12:1) and `solarized-dark`
- [ ] `settingsStyleGuide.test.ts` passes
- [ ] `npm run lint` and `lint:eslint` clean

---

## 11. Remediation log and remaining debt

### Resolved

| Item                      | What was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Double-dim defects**    | All 31 sites fixed by deleting the redundant `theme.colors.textDim` override. Two decorative icons were deliberately left alone (their opacity is intentional de-emphasis, not text dimming).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Regression guard**      | `src/__tests__/renderer/components/Settings/settingsStyleGuide.test.ts` parses every JSX tag in the tree and fails on any element combining an unconditional `opacity-*` with `textDim`. It also fails on hand-rolled headings in `GeneralTab`, bans `opacity-60` on text (the value the tree keeps drifting back to, which invalidates the contrast measurement below), and re-measures every theme so a `themes.ts` edit cannot push dimmed description text back under 3:1. The opacity rule additionally reaches `FontConfigurationPanel.tsx` and `ui/FontSizeStepper.tsx`, which render into the tree from outside it. |
| **`GeneralTab` headings** | All 18 migrated to `SettingsSectionHeading`. `LogLevelSection` had no icon and was given `ScrollText`. `GeneralTab` now has zero hand-rolled headings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Opacity scale**         | 84 sites collapsed from five values (`40/50/60/70/80`) to two: `opacity-70` for descriptions, `opacity-55` for micro-notes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Low-contrast themes**   | `solarized-light`'s `textMain` raised from `#5f737b` (4.61:1) to Solarized base02 `#073642` (12.05:1). With `opacity-70`, **all 21 themes now clear 3:1** (worst: `ayu-light` at 3.12:1).                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Note on the theme fix: the original plan was to brighten all six failing themes, but the measurement showed no theme's `textDim` was ever below 3:1 and five of the six failures were _light_ themes, where an opacity utility blends text toward the background and even pure-black `textMain` caps near 3.9:1. That is a property of the dimming approach, not of the themes, so raising the description opacity was the actual fix. Only `solarized-light` additionally needed a theme edit.

### Remaining

- **`GeneralTab` still hand-rolls its card bodies and toggle rows** - 10 raw `ToggleSwitch` rows and no `SectionCard`. Migrating these normalises padding and border color, but each row's click/keyboard behaviour needs verifying, so it deserves its own PR. Do it opportunistically when you are already in a section, or as one deliberate pass.
- **Other tabs still hand-roll section headings** - `EncoreTab` (3), `DisplayTab` (2), plus `SettingsModal`, `MaestroPromptsTab`, `ShortcutsTab`, `ThemeTab`, `EnvironmentTab`, `SshRemoteModal`. The style-guide test currently only enforces `GeneralTab`; widen its scope as each tab is migrated.
- **`SettingsSectionHeading` has no `description` slot** - about 12 sections follow the heading with an intro paragraph and each styles it slightly differently. An optional slot would collapse that.

---

## 12. Where the canon lives

If this guide and the code disagree, the code wins **only** for `DisplayTab`, which is the audited reference. Anywhere else, this guide wins and the code is debt.

When you establish a genuinely new pattern, add it here in the same turn. A pattern that is not written down is a pattern the next agent will re-invent slightly differently, which is how the tree reached ten heading variants.
