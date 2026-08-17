# Control UI Guide

This directory owns Control UI-specific guidance that should not live in the repo root.

## i18n Rules

- Foreign-language locale bundles in `ui/src/i18n/locales/*.ts` are generated output.
- Do not hand-edit non-English locale bundles or `ui/src/i18n/.i18n/*` unless a targeted generated-output fix is explicitly requested.
- The source of truth is `ui/src/i18n/locales/en.ts` plus the generator/runtime wiring in:
  - `scripts/control-ui-i18n.ts`
  - `ui/src/i18n/lib/types.ts`
  - `ui/src/i18n/lib/registry.ts`
- Pipeline: update English strings and locale wiring here, then run `pnpm ui:i18n:sync` and commit the regenerated locale bundles plus `.i18n` metadata.
- If locale outputs drift, regenerate them. Do not manually translate or hand-maintain generated locale files by default.

## Scope

- Keep UI-specific rules here.
- Leave repo-global architecture, verification, and git workflow rules in the root `AGENTS.md`.

## Suheng Design System

- Treat the root `DESIGN.md` as the visual source of truth for Suheng user-facing UI.
- Reuse the existing OpenKnot theme tokens and components before adding new visual variants.
- When product requirements conflict with `DESIGN.md`, preserve accessibility, evidence provenance, and explicit risk semantics, then update the design document with the approved decision.
