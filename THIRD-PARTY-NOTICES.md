# Third-Party Notices

Maestro is distributed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)).
Most of its dependencies are permissively licensed and are listed, with their license texts, in
their own packages under `node_modules/`. This file records the components that need a notice of
their own because their terms differ from what their package metadata says.

## espeak-ng (inside the `phonemizer` package)

- **Used for:** the grapheme-to-phoneme step of the Kokoro local voice
  (`src/main/acappella/providers/local/kokoro/espeak.ts`). It is loaded only when a Kokoro voice is
  about to speak.
- **Package:** [`phonemizer`](https://www.npmjs.com/package/phonemizer) 1.2.1
  ([xenova/phonemizer.js](https://github.com/xenova/phonemizer.js)), whose own code is Apache-2.0.
- **What it embeds:** a build of [espeak-ng](https://github.com/espeak-ng/espeak-ng) compiled to
  JavaScript, together with espeak-ng's English voice data. espeak-ng is licensed under the
  **GNU General Public License, version 3 or later**. The `phonemizer` package ships only an
  Apache-2.0 license file and does not carry espeak-ng's notice, so it is stated here.
- **Source:** the corresponding source for espeak-ng is at
  <https://github.com/espeak-ng/espeak-ng>. The JavaScript build is produced by the
  `phonemizer.js` project linked above.
- **Compatibility:** GPL-3.0-or-later code may be combined with a work under AGPL-3.0 (section 13
  of both licenses).

## Model weights

Local models are downloaded by the user, never bundled. Each model's license is shown on its row
in Settings -> Local Models and recorded in `src/shared/local-models/model-catalog.ts`.
