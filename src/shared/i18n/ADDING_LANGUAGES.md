# Adding a New Language to Maestro

Step-by-step guide for contributors adding a new translation to Maestro's i18n system.

---

## Prerequisites

- Node.js 18+ and npm installed
- A working Maestro development environment (`npm install` completed)
- Familiarity with the target language (native or near-native fluency recommended)
- Review [CONVENTIONS.md](CONVENTIONS.md) for key naming rules and patterns

---

## Step-by-Step Instructions

### 1. Add the language code to the supported languages list

Edit `src/shared/i18n/config.ts`:

```typescript
// Add your language code (use BCP-47 / ISO 639-1 codes)
export const SUPPORTED_LANGUAGES = [
	'en',
	'es',
	'fr',
	'de',
	'zh',
	'hi',
	'ar',
	'bn',
	'pt',
	'ja',
] as const;
//                                                                                          ^^^^ new
```

Also add the native display name to the `LANGUAGE_NATIVE_NAMES` map in the same file:

```typescript
export const LANGUAGE_NATIVE_NAMES: Record<SupportedLanguage, string> = {
	// ... existing entries ...
	ja: '日本語', // Always use the language's own script for its name
};
```

### 2. Create the locale directory

Create `src/shared/i18n/locales/{code}/` where `{code}` is the language's ISO 639-1 code (e.g., `ja` for Japanese, `ko` for Korean, `ru` for Russian).

```bash
mkdir src/shared/i18n/locales/{code}
```

### 3. Copy all English JSON files as starting templates

Copy every namespace file from the English locale:

```bash
cp src/shared/i18n/locales/en/*.json src/shared/i18n/locales/{code}/
```

This creates the following files in your new locale directory:

| File                 | Namespace       | Content                                        |
| -------------------- | --------------- | ---------------------------------------------- |
| `common.json`        | `common`        | Shared UI actions (Save, Cancel, Close, etc.)  |
| `settings.json`      | `settings`      | Settings modal labels and descriptions         |
| `modals.json`        | `modals`        | Dialog/modal strings                           |
| `menus.json`         | `menus`         | Hamburger menu, context menus, command palette |
| `notifications.json` | `notifications` | Toast notifications and alerts                 |
| `accessibility.json` | `accessibility` | ARIA labels and screen reader text             |
| `shortcuts.json`     | `shortcuts`     | Keyboard shortcut labels                       |

### 4. Translate all values

Open each JSON file and translate the **values** (right side). Keep all **keys** (left side) identical to English.

**Rules:**

- Translate only the values, never the keys
- Preserve all `{{variable}}` interpolation tokens exactly as-is
- Maintain the same JSON structure and nesting
- Do not add or remove keys — the set must match English exactly
- Use the language's native script and conventions (e.g., full-width punctuation for CJK)

**Example:**

```json
// English (en/common.json)
{
	"save": "Save",
	"items_count_one": "{{count}} item",
	"items_count_other": "{{count}} items",
	"status": {
		"ready": "Ready and waiting"
	}
}

// Japanese (ja/common.json)
{
	"save": "保存",
	"items_count_other": "{{count}} 件のアイテム",
	"status": {
		"ready": "準備完了"
	}
}
```

Note: Japanese uses only the `_other` form since it has no singular/plural distinction (see Pluralization below).

### 5. Handle pluralization

i18next uses [Unicode CLDR plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules) automatically based on the language code. Different languages require different plural forms.

**Plural form suffixes:**

| Suffix   | Description                                                   |
| -------- | ------------------------------------------------------------- |
| `_zero`  | Count = 0 (languages that distinguish zero as a category)     |
| `_one`   | Singular (typically count = 1)                                |
| `_two`   | Dual (count = 2, e.g., Arabic)                                |
| `_few`   | Paucal/few (e.g., Arabic 3–10, Slavic languages)              |
| `_many`  | Many (e.g., Arabic 11–99)                                     |
| `_other` | General plural / everything else (required for all languages) |

**Common plural form requirements by language family:**

| Forms needed                                       | Languages                                                  |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `_other` only                                      | Chinese, Japanese, Korean, Vietnamese, Thai                |
| `_one`, `_other`                                   | English, Spanish, German, Hindi, Bengali, Portuguese, etc. |
| `_one`, `_other` (0 uses `_one`)                   | French                                                     |
| `_one`, `_few`, `_many`, `_other`                  | Polish, Russian, Ukrainian, Czech                          |
| `_zero`, `_one`, `_two`, `_few`, `_many`, `_other` | Arabic                                                     |

**Look up your language:** Find the exact plural rules for your language at the [CLDR Plural Rules chart](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html).

**For each pluralized key in English** (keys ending in `_one` / `_other`), provide the forms your language requires. For example, if English has:

```json
{
	"items_count_one": "{{count}} item",
	"items_count_other": "{{count}} items"
}
```

A Chinese translation only needs:

```json
{
	"items_count_other": "{{count}} 个项目"
}
```

A Russian translation needs:

```json
{
	"items_count_one": "{{count}} элемент",
	"items_count_few": "{{count}} элемента",
	"items_count_many": "{{count}} элементов",
	"items_count_other": "{{count}} элементов"
}
```

### 6. Handle RTL (right-to-left) languages

If your language is written right-to-left (Arabic, Hebrew, Persian, Urdu, etc.), add its code to the `RTL_LANGUAGES` array in `src/shared/i18n/config.ts`:

```typescript
export const RTL_LANGUAGES: SupportedLanguage[] = ['ar', 'he'];
//                                                        ^^^^ new
```

The `DirectionProvider` component at `src/renderer/components/shared/DirectionProvider.tsx` automatically applies:

- `dir="rtl"` on the document root
- `data-dir="rtl"` for CSS selectors
- CSS custom properties `--dir-start` and `--dir-end` for layout

**CSS guidelines for RTL:**

- Use logical properties (`margin-inline-start`) instead of physical ones (`margin-left`)
- Use the `[data-dir="rtl"]` CSS selector for RTL-specific overrides when logical properties aren't sufficient

### 7. Add the language to the Settings selector

The language selector in `src/renderer/components/Settings/tabs/GeneralTab.tsx` automatically renders all entries from `SUPPORTED_LANGUAGES` and `LANGUAGE_NATIVE_NAMES`. Since you updated both in Step 1, the new language will appear in the dropdown automatically — no additional UI changes needed.

### 8. Run the validation script

```bash
npm run i18n:validate
```

This checks:

- **Missing keys** — every English key must exist in your translation
- **Orphaned keys** — no extra keys that don't exist in English
- **Interpolation variables** — all `{{var}}` tokens from English are present
- **Pluralization forms** — correct plural suffixes for your language's CLDR rules
- **JSON syntax** — valid JSON in all files

Fix any reported issues before proceeding.

### 9. Run the test suite

```bash
npm run test
```

The i18n integration tests at `src/__tests__/i18n/` will verify:

- Your language loads successfully
- Fallback to English works
- Namespace loading works
- Translation completeness (all keys present)

All tests must pass.

### 10. Submit a pull request

Create a PR with a clear title: `i18n: add {Language} ({code}) translations`

Include in the PR description:

- The language and its ISO 639-1 code
- Completion percentage from `npm run i18n:validate`
- Whether the language is RTL
- Any pluralization notes specific to the language

---

## Template JSON File

Use this minimal template as a reference for the expected structure. Copy the actual English files for a complete template — this just shows the shape:

```json
{
	"simple_key": "Translated value",
	"key_with_variable": "Text with {{variable}} interpolation",
	"pluralized_key_one": "{{count}} singular form",
	"pluralized_key_other": "{{count}} plural form",
	"nested": {
		"section": {
			"key": "Nested translated value"
		}
	}
}
```

---

## PR Reviewer Checklist

Use this checklist when reviewing a new language PR:

- [ ] Language code added to `SUPPORTED_LANGUAGES` in `config.ts`
- [ ] Native name added to `LANGUAGE_NATIVE_NAMES` in `config.ts`
- [ ] If RTL, code added to `RTL_LANGUAGES` in `config.ts`
- [ ] Locale directory created at `src/shared/i18n/locales/{code}/`
- [ ] All 7 namespace files present (`common`, `settings`, `modals`, `menus`, `notifications`, `accessibility`, `shortcuts`)
- [ ] Key sets match English exactly (no missing or orphaned keys)
- [ ] All `{{variable}}` interpolation tokens preserved
- [ ] Correct plural forms for the language's CLDR rules
- [ ] `npm run i18n:validate` passes with 100% completion
- [ ] `npm run test` passes (all i18n tests green)
- [ ] No hardcoded English strings left in values
- [ ] Native speaker review completed (or noted as pending)
- [ ] Translation quality spot-checked (at least `common.json` and `settings.json`)

---

## Troubleshooting

**Language doesn't appear in the dropdown:**
Verify you added the code to both `SUPPORTED_LANGUAGES` (the array) and `LANGUAGE_NATIVE_NAMES` (the record). TypeScript will error if one is missing.

**Translations not loading:**
Maestro lazy-loads non-English languages. Check the browser console for dynamic import errors. Ensure your JSON files are valid and the directory name matches the code in `SUPPORTED_LANGUAGES`.

**Plural forms not working:**
i18next auto-detects plural rules by language code. Verify you're using the correct [CLDR plural categories](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html) for your language. Remove any plural suffixes your language doesn't use.

**RTL layout broken:**
Ensure the language code is in the `RTL_LANGUAGES` array. Check that components use logical CSS properties. Test with `document.documentElement.dir` set to `"rtl"` in DevTools.

---

## Reference Links

- [Unicode CLDR Plural Rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html)
- [i18next Pluralization Docs](https://www.i18next.com/translation-function/plurals)
- [i18next Interpolation Docs](https://www.i18next.com/translation-function/interpolation)
- [BCP-47 Language Tags](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry)
- [Maestro i18n Conventions](CONVENTIONS.md)
