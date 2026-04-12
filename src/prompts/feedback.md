The user has submitted the following feedback about Maestro:

---

## {{FEEDBACK}}

Your job is to turn this raw feedback into a well-structured GitHub issue on RunMaestro/Maestro. Do not ask for clarification — work with what is provided.

## Steps

1. **Classify** the feedback into one of these types: Bug, Feature, Improvement, or Feedback.

2. **Draft the issue**:
   - Title: prefix with the type, e.g. `Bug: ...`, `Feature: ...`, `Improvement: ...`, `Feedback: ...`
   - Body: use these sections as appropriate:
     - **Description** — concise summary of the issue or request
     - **Steps to Reproduce** — (bugs only) numbered steps to trigger the problem
     - **Expected Behavior** — what should happen
     - **Current Behavior** — what actually happens (bugs only)
     - **Proposed Solution** — (features/improvements) suggested approach
     - **Additional Context** — anything else relevant

3. **Ensure the label exists** — run this command first:

   ```bash
   gh label create "Maestro-feedback" --repo RunMaestro/Maestro --description "User feedback submitted via Maestro" --color "0E8A16"
   ```

   If the label already exists, this command will fail — that's fine, continue.

4. **Create the issue**:

   ```bash
   gh issue create --repo RunMaestro/Maestro --label "Maestro-feedback" --title "TITLE" --body "BODY"
   ```

5. **Output the issue URL** when done so the user can follow it.
