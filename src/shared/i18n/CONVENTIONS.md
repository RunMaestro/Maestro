# i18n Translation Key Conventions

This document defines the naming conventions and patterns for all translation keys in Maestro. Follow these rules when extracting strings or adding new translatable content.

---

## Key Format

```
namespace:section.action_or_description
```

- **namespace** — top-level grouping (see Namespace Assignment below)
- **section** — component or feature area within the namespace
- **action_or_description** — the specific string's purpose

Examples:

```
menus:hamburger.new_agent
settings:encore.virtuosos_title
modals:edit_agent.save_button
common:status.loading
notifications:task.completed_message
accessibility:sidebar.toggle_button
```

---

## Namespace Assignment Rules

| Namespace       | Scope                                                    |
| --------------- | -------------------------------------------------------- |
| `common`        | Reused across 3+ components (Save, Cancel, Close, etc.)  |
| `settings`      | Settings modal and all settings tabs                     |
| `modals`        | All modal components (edit agent, confirm, wizard, etc.) |
| `menus`         | Hamburger menu, context menus, command palette           |
| `notifications` | Toast messages and alerts                                |
| `accessibility` | `aria-label`, screen reader text, and a11y descriptions  |
| `shortcuts`     | Keyboard shortcut labels and descriptions                |

**Rule of thumb:** If a string appears in 3+ components, it belongs in `common`. Otherwise, place it in the most specific namespace that matches.

---

## Key Naming Rules

1. **snake_case** — all key segments use `snake_case`
   - Good: `save_changes`, `new_agent`
   - Bad: `saveChanges`, `New-Agent`

2. **Max 3 levels deep** — keys may nest up to 3 levels (namespace excluded)

   ```
   common:time.minutes_short          ✅  (2 levels)
   settings:general.theme.description  ✅  (3 levels)
   settings:general.theme.dark.label   ❌  (4 levels — flatten it)
   ```

3. **Descriptive suffixes** — use these suffixes to clarify purpose:
   - `_title` — headings and titles
   - `_description` — explanatory text
   - `_label` — form labels and field names
   - `_button` — button text
   - `_placeholder` — input placeholders
   - `_message` — body text in notifications or dialogs
   - `_tooltip` — tooltip content
   - `_error` — error messages
   - `_confirm` — confirmation prompts

---

## Interpolation

Use double-brace `{{variable}}` syntax for dynamic values:

```json
{
	"greeting": "Hello, {{name}}",
	"items_selected": "{{count}} of {{total}} selected",
	"time": {
		"minutes_short": "{{count}}m"
	}
}
```

In code:

```tsx
t('common:greeting', { name: 'Alice' });
// → "Hello, Alice"
```

---

## Pluralization

Use i18next's built-in plural suffixes, which follow CLDR/ICU plural rules:

| Suffix   | When used                                    |
| -------- | -------------------------------------------- |
| `_one`   | Singular (count = 1)                         |
| `_other` | Plural (count ≠ 1)                           |
| `_zero`  | Zero (count = 0, languages that distinguish) |

Define plural keys as siblings with the appropriate suffix:

```json
{
	"items_count_one": "{{count}} item",
	"items_count_other": "{{count}} items",
	"agents_running_one": "{{count}} agent running",
	"agents_running_other": "{{count}} agents running"
}
```

In code:

```tsx
t('common:items_count', { count: 1 });
// → "1 item"

t('common:items_count', { count: 5 });
// → "5 items"
```

i18next automatically selects the correct plural form based on the `count` value and the active locale's CLDR plural rules.

---

## Namespace Examples

### `common` — Shared UI actions and labels

```json
{
	"save": "Save",
	"cancel": "Cancel",
	"items_count_one": "{{count}} item",
	"items_count_other": "{{count}} items",
	"status": {
		"loading": "Loading",
		"error": "Error",
		"ready": "Ready"
	}
}
```

### `settings` — Settings modal

```json
{
	"general": {
		"title": "General",
		"theme_label": "Theme",
		"language_label": "Language",
		"language_description": "Select your preferred display language"
	},
	"encore": {
		"title": "Encore Features",
		"virtuosos_title": "Virtuosos"
	}
}
```

### `modals` — Dialog content

```json
{
	"edit_agent": {
		"title": "Edit Agent",
		"name_label": "Agent Name",
		"save_button": "Save Changes",
		"cancel_button": "Cancel"
	},
	"confirm_delete": {
		"title": "Confirm Deletion",
		"message": "Are you sure you want to delete {{name}}?",
		"confirm_button": "Delete"
	}
}
```

### `menus` — Menus and command palette

```json
{
	"hamburger": {
		"new_agent": "New Agent",
		"new_group_chat": "New Group Chat",
		"settings": "Settings",
		"quit": "Quit Maestro"
	},
	"context": {
		"copy": "Copy",
		"paste": "Paste",
		"rename": "Rename"
	}
}
```

### `notifications` — Toast messages

```json
{
	"task": {
		"completed_title": "Task Complete",
		"completed_message": "{{agent}} finished in {{duration}}",
		"failed_title": "Task Failed",
		"failed_message": "{{agent}} encountered an error"
	},
	"connection": {
		"lost_title": "Connection Lost",
		"restored_title": "Connection Restored"
	}
}
```

### `accessibility` — Screen reader text

```json
{
	"sidebar": {
		"toggle_button": "Toggle left panel",
		"agent_list": "Agent list"
	},
	"main_panel": {
		"output_region": "AI output region",
		"input_field": "Message input"
	}
}
```

### `shortcuts` — Keyboard shortcut labels

```json
{
	"toggle_sidebar": "Toggle Left Panel",
	"new_instance": "New Agent",
	"quick_action": "Quick Actions",
	"toggle_mode": "Switch AI/Shell Mode"
}
```

---

## File Organization

```
src/shared/i18n/
├── config.ts              # i18next initialization
├── types.ts               # TypeScript type helpers
├── resources.d.ts         # Module augmentation for autocompletion
├── constantKeys.ts        # Typed key constants for non-React contexts
├── CONVENTIONS.md          # This file
└── locales/
    ├── en/                # English (base — always complete)
    │   ├── common.json
    │   ├── settings.json
    │   ├── modals.json
    │   ├── menus.json
    │   ├── notifications.json
    │   ├── accessibility.json
    │   └── shortcuts.json
    ├── es/                # Spanish
    ├── fr/                # French
    └── ...                # Other supported locales
```

---

## Exclusions

### System Prompts

System prompts (`src/prompts/*.md`) remain in English. They are AI-facing, not user-facing. Do not extract their strings to i18n.

**Rationale:**

1. LLMs are trained primarily on English and perform best with English system prompts.
2. Users can edit these prompts — translating them creates a maintenance burden.
3. Template variables like `Maestro` are code-level identifiers, not user-facing text.

---

## Guidelines

1. **English is the source of truth.** Always add keys to `en/*.json` first. Other locales follow.
2. **Never hardcode user-facing strings.** All visible text must go through `t()`, `<T>`, or `tNotify()`.
3. **Keep keys stable.** Renaming keys requires updating all locale files. Prefer adding new keys over renaming.
4. **Don't translate technical identifiers.** Agent IDs, file paths, config keys, and log-level strings stay as-is.
5. **Group related keys.** Use nesting to group keys by feature area, but respect the 3-level max.
6. **Use context over separate keys.** If the same English word has different translations in other languages (e.g., "Open" as verb vs adjective), use distinct keys: `open_action` vs `open_state`.
