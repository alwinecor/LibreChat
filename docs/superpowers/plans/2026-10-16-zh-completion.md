# Simplified Chinese Completion Plan

> Execute the authorized translation request using independent translation batches, followed by centralized verification.

**Goal:** Translate every remaining English catalog key into Simplified Chinese.
**Architecture:** Three disjoint temporary JSON batches are merged into the existing zh-Hans catalog. Preserve existing translations and the five corrected messages.
**Tech Stack:** JSON, i18next, Node.js, Prettier.
**Spec:** User request to complete remaining Simplified Chinese translations.

## Constraints and review focus
Preserve interpolation names, markup, URLs, technical identifiers and proper names. Keep negations, permission boundaries, counts and units accurate. Use consistent Chinese terminology; do not alter runtime code.

- [x] Translate three disjoint missing-key batches in .superpowers/sdd/zh-complete.
- [x] Review and merge into client/src/locales/zh-Hans/translation.json, preserving existing entries.
- [x] Verify zero missing keys, empty values, duplicate keys and placeholder mismatches; inspect untranslated English and markup.
- [x] Run scoped formatting, client typecheck and frontend build; report local state.

## Results
Added all 2,121 missing keys. All 3,643 English source keys are covered. Preserved the previous five corrections and repaired seven additional existing values. Catalog and real i18next interpolation validation passed; 11 locale tests, client typecheck and frontend production build passed. Independently reviewed 39 high-risk strings with no semantic findings. These results describe the original development branch.

## Port to main
The PR keeps main's existing application and shared-component translations and adds only translations for keys available on this base. All 3423 current English keys are covered. One pre-existing running-chat accessibility label was corrected to retain its count placeholder. Translation keys belonging only to excluded upstream dev features are not added.
