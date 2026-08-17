---
version: alpha
name: suheng-design-system
description: Evidence-first visual language for Suheng, an AI assistant for public-opinion intelligence, risk judgment, reporting, and action.
---

# Suheng Design System

This document is the visual source of truth for Suheng (夙衡). It applies to the Control UI and to user-facing surfaces powered by the `leading-v2` plugin. New UI should feel like a calm intelligence workspace: precise enough for analysts, readable enough for decision-makers, and warm enough to support long conversations.

The document follows the `DESIGN.md` approach popularized by [VoltAgent's Awesome DESIGN.md collection](https://github.com/VoltAgent/awesome-design-md). Its structure is informed by the collection's AI-assistant examples, while all product decisions below are specific to Suheng and its existing OpenKnot theme.

## 1. Visual Theme and Atmosphere

Suheng is an evidence desk, not a generic chatbot and not a futuristic AI demo.

The interface should communicate:

- Calm authority: conclusions feel considered, never theatrical.
- Evidence before assertion: sources, timestamps, status, and uncertainty are visible.
- Editorial clarity: long reports remain comfortable to scan and read.
- Operational readiness: tasks, alerts, and next actions are obvious.
- Human judgment: the product supports decisions without pretending certainty.

The signature visual rhythm is a near-black or cool-white canvas, restrained crimson actions, quiet neutral surfaces, and small semantic accents. Crimson represents attention and decisive action; it must not flood ordinary content.

Avoid generic AI aesthetics: neon gradients, glowing brains, robot illustrations, floating glass bubbles, excessive blur, or animated decoration without informational value.

## 2. Color Palette and Roles

Use semantic tokens instead of hard-coded colors in components. The existing CSS variables in `ui/src/styles/base.css` are the implementation source.

### Dark Mode: OpenKnot

| Role             | Token             | Value                     | Use                                   |
| ---------------- | ----------------- | ------------------------- | ------------------------------------- |
| Canvas           | `--bg`            | `#080808`                 | App background and navigation floor   |
| Subtle canvas    | `--bg-accent`     | `#0d0d0f`                 | Section bands and grouped rows        |
| Elevated surface | `--bg-elevated`   | `#141416`                 | Menus, dialogs, focused panels        |
| Card             | `--card`          | `#111113`                 | Reports, tasks, evidence, chat groups |
| Hover            | `--bg-hover`      | `#1a1a1e`                 | Interactive hover state               |
| Primary text     | `--text-strong`   | `#f5f5f7`                 | Headings and decisive conclusions     |
| Body text        | `--text`          | `#e0e0e2`                 | Reading and conversation text         |
| Muted text       | `--muted`         | `#7a7a80`                 | Metadata and supporting labels        |
| Border           | `--border`        | `#1a1a1e`                 | Quiet separation                      |
| Strong border    | `--border-strong` | `#2a2a30`                 | Focused or selected separation        |
| Primary accent   | `--accent`        | `#e5243b`                 | Primary action and active navigation  |
| Accent hover     | `--accent-hover`  | `#f03e52`                 | Hover and active action               |
| Accent wash      | `--accent-subtle` | `rgba(229, 36, 59, 0.12)` | Selected rows and low-emphasis badges |

### Light Mode: OpenKnot Light

| Role             | Token             | Value                     | Use                                   |
| ---------------- | ----------------- | ------------------------- | ------------------------------------- |
| Canvas           | `--bg`            | `#f9f9fb`                 | App background                        |
| Subtle canvas    | `--bg-accent`     | `#f2f2f5`                 | Grouped sections                      |
| Elevated surface | `--bg-elevated`   | `#ffffff`                 | Cards, dialogs, menus                 |
| Card             | `--card`          | `#ffffff`                 | Reading and task surfaces             |
| Primary text     | `--text-strong`   | `#18181b`                 | Headings and conclusions              |
| Body text        | `--text`          | `#3a3a42`                 | Body content                          |
| Muted text       | `--muted`         | `#6e6e78`                 | Metadata                              |
| Border           | `--border`        | `#e2e2e8`                 | Quiet separation                      |
| Primary accent   | `--accent`        | `#c41e30`                 | Primary action and active navigation  |
| Accent hover     | `--accent-hover`  | `#a8192a`                 | Hover and active action               |
| Accent wash      | `--accent-subtle` | `rgba(196, 30, 48, 0.08)` | Selected rows and low-emphasis badges |

### Semantic Colors

| Meaning                     | Token        | Guidance                                                        |
| --------------------------- | ------------ | --------------------------------------------------------------- |
| Verified / healthy          | `--ok`       | Successful checks, completed delivery, verified facts           |
| Watch / caution             | `--warn`     | Developing signals, incomplete evidence, approaching limits     |
| High risk / failure         | `--danger`   | Confirmed failure, destructive action, critical risk            |
| Informational               | `--info`     | Neutral system information and links                            |
| Secondary analytical accent | `--accent-2` | Evidence relationships, comparison series, secondary highlights |

Never communicate status by color alone. Pair color with a label, icon, pattern, or explicit value. Crimson primary actions and danger states must remain distinguishable through copy and iconography.

## 3. Typography Rules

### Font Families

- UI and body: `Inter`, `PingFang SC`, `Microsoft YaHei`, system sans-serif.
- Code, IDs, URLs, timestamps, and machine output: `JetBrains Mono`, system monospace.
- Do not introduce a decorative display typeface into operational screens.

### Type Scale

| Token         | Size / line height | Weight | Use                                   |
| ------------- | ------------------ | ------ | ------------------------------------- |
| Display       | `32px / 1.2`       | 650    | Rare empty-state or landing statement |
| Page title    | `24px / 1.3`       | 650    | Primary page heading                  |
| Section title | `18px / 1.4`       | 600    | Report and dashboard sections         |
| Card title    | `15px / 1.4`       | 600    | Task, evidence, and result cards      |
| Body          | `15px / 1.65`      | 400    | Conversation and report content       |
| UI body       | `14px / 1.5`       | 400    | Controls, lists, tables               |
| Label         | `13px / 1.4`       | 550    | Field labels and metadata headings    |
| Caption       | `12px / 1.4`       | 450    | Timestamps, provenance, helper text   |
| Mono          | `13px / 1.6`       | 400    | Technical values and tool output      |

Chinese body text needs generous line height. Long-form reports should target 1.7 to 1.8 line height and a reading width of 70 to 80 Chinese characters. Avoid uppercase transformations for Chinese labels.

## 4. Spacing, Shape, and Depth

### Spacing Scale

Use a 4px base unit:

`4, 8, 12, 16, 24, 32, 48, 64`

- Dense metadata groups: 4–8px.
- Control groups and card rows: 12–16px.
- Card padding: 16–24px.
- Major section separation: 32–48px.
- Editorial report chapters: 48–64px.

### Radius

Use the existing token hierarchy:

- `--radius-sm` (`6px`): badges, compact controls.
- `--radius-md` (`10px`): buttons, inputs, menus.
- `--radius-lg` (`14px`): cards, dialogs, composer.
- `--radius-xl` (`20px`): major empty states only.
- `--radius-full`: status pills and circular icon buttons.

Do not make every container a floating rounded card. Use flat sections and hairline dividers for related content; reserve cards for meaningful grouping.

### Elevation

Depth comes primarily from surface contrast and borders.

- Base: no shadow.
- Raised control: `--shadow-sm`.
- Menu or popover: `--shadow-md`.
- Modal: `--shadow-lg`.
- Accent glow: focus or exceptional live state only; never a persistent decoration.

## 5. Layout Principles

### Application Shell

- Desktop navigation: 258px expanded, 78px collapsed.
- Top bar: compact, approximately 52–58px.
- Primary content should use available width without becoming a wall of text.
- Analytical dashboards may extend to 1280px; report reading columns should remain near 760–880px.
- Keep global controls in the shell and task-specific controls next to the task.

### Information Hierarchy

For judgment and report surfaces, order content as:

1. Current state or conclusion.
2. Confidence, severity, and time scope.
3. Evidence and source provenance.
4. Reasoning or comparison.
5. Recommended actions.
6. Audit details and raw output.

Do not hide evidence behind a generic “details” disclosure when it is essential to the conclusion.

### Density

Suheng supports both scanning and deep reading:

- Dashboards: compact rows, strong alignment, visible status.
- Conversations: spacious message groups and clear turn boundaries.
- Reports: editorial rhythm, restrained controls, stable reading width.
- Tool output: collapsible technical detail, but a human summary remains visible.

## 6. Component Styling

### Navigation

- Active destination uses accent text or a narrow accent marker plus a subtle wash.
- Inactive destinations remain neutral; do not use colored icons for every item.
- Navigation labels should describe work domains, not internal module names.

### Buttons

- Primary: solid crimson, reserved for the single most important action in a region.
- Secondary: neutral surface with a visible border.
- Tertiary: text or ghost treatment for reversible local actions.
- Destructive: danger color plus explicit destructive wording.
- Minimum interactive height: 36px desktop, 44px touch.
- Loading actions retain their original width and show progress text when the wait may exceed two seconds.

### Inputs and Composer

- Inputs use quiet borders and a clearly visible focus ring.
- The chat composer is a stable work surface, not a floating novelty object.
- Attachments, tools, and send controls must remain discoverable but subordinate to the prompt.
- Multiline input growth must not push essential navigation off screen.

### Conversation

- Prefer grouped turns over chat bubbles copied from consumer messengers.
- User and Suheng turns differ through alignment, label, surface, and spacing—not saturated color blocks.
- Long answers use headings, lists, tables, citations, and callouts.
- Streaming and tool activity show a calm status line; avoid pulsing entire cards.
- Source links show domain, title, and retrieval time when available.

### Judgment Summary

Every formal judgment should support these fields:

- Conclusion label.
- Risk level.
- Confidence or evidence completeness.
- Time of judgment.
- Short rationale.
- Source count and direct evidence links.
- Recommended next action.

The conclusion is visually strongest; the risk badge is supportive, not the headline itself.

### Evidence Card

- Show source name, publication time, capture time, and URL origin.
- Quote only the minimum excerpt needed for verification.
- Distinguish source text from Suheng interpretation.
- Mark unavailable or superseded evidence explicitly.
- Use monospace only for technical identifiers, not the evidence body.

### Tasks and Progress

- Status vocabulary must remain stable: queued, running, waiting, completed, failed, canceled.
- Progress should show both current stage and last update time.
- Background jobs provide a clear return path to the originating conversation or report.
- Failure cards expose the actionable cause before raw diagnostics.

### Reports

- Begin with an executive summary and time range.
- Use a visible table of contents for long reports.
- Charts must state unit, time window, source, and update time.
- Tables use aligned numeric columns, sticky headers when long, and restrained row striping.
- Export and share actions stay near the report title, not mixed into analytical content.

### Alerts and Callouts

- Informational callout: neutral or blue edge.
- Evidence caveat: amber edge and explicit uncertainty language.
- Critical risk: crimson edge, compact fill, direct action.
- Success: green indicator, no celebratory confetti.

## 7. Data Visualization

- Use neutral gray as the baseline series and semantic colors for the few series that matter.
- Recommended sequence: crimson, teal, blue, amber, violet, then neutral gray.
- Do not use red versus green as the only comparison.
- Direct-label important lines and bars when space allows.
- Tooltips include full timestamp, value, unit, and source context.
- Trends must not imply causality without supporting evidence.
- Maps and heatmaps require legends and accessible tabular alternatives.
- Three-dimensional charts, gauge clutter, and decorative gradients are prohibited.

## 8. Interaction and Motion

- Fast feedback: 100ms.
- Standard transitions: 180ms.
- Layout transitions: up to 300ms.
- Motion should explain state change, location, or hierarchy.
- Avoid continuous ambient animation.
- Respect `prefers-reduced-motion`; remove nonessential transforms and animated scrolling.
- Preserve focus after async updates and announce important status changes to assistive technology.

## 9. Responsive Behavior

### Desktop: 1024px and above

- Expanded or collapsible navigation.
- Multi-column dashboards where comparison benefits from proximity.
- Report content remains width-constrained even on large screens.

### Tablet: 768px to 1023px

- Navigation collapses to a rail or drawer.
- Three-column content becomes two or one columns.
- Filters may wrap but primary action remains visible.

### Mobile: below 768px

- Single content column.
- Navigation becomes an accessible drawer.
- Composer and primary actions remain reachable above the safe area.
- Tables become horizontally scrollable or transform into labeled rows.
- Side-by-side evidence comparisons become stacked sections.
- Touch targets are at least 44×44px.

At all widths, preserve conclusion, evidence, and action order. Do not solve mobile layouts by hiding provenance or risk context.

## 10. Accessibility and Trust

- Target WCAG 2.1 AA contrast for text and interactive states.
- Every interactive element has keyboard focus and a programmatic label.
- Focus indicators must remain visible in both themes.
- Icon-only controls require accessible names and tooltips.
- Error text explains how to recover.
- AI-generated conclusions are visually distinct from quoted source material.
- Show uncertainty honestly; never use visual polish to imply stronger evidence than exists.
- Dates use an explicit time zone where ambiguity matters.
- Generated charts and images require useful alternative text.

## 11. Content Voice

Suheng's interface language is concise, calm, and accountable.

- Prefer “Evidence is incomplete” over “AI is unsure.”
- Prefer “3 sources support this conclusion” over “High confidence” alone.
- Prefer a direct recovery action over a generic failure apology.
- Use plain Chinese for user-facing labels; keep protocol and infrastructure jargon in diagnostics.
- Do not anthropomorphize routine system events.
- Do not use exclamation marks for ordinary success.

## 12. Do and Don't

### Do

- Make evidence and timestamps easy to find.
- Use whitespace to separate reasoning stages.
- Reserve crimson for priority and action.
- Keep status language consistent across chat, reports, and jobs.
- Design light and dark modes together.
- Prefer existing tokens and components before introducing variants.
- Verify long Chinese content, narrow screens, loading, empty, error, and partial-data states.

### Don't

- Do not imitate another company's logo, proprietary illustration, or branded copy.
- Do not turn every section into a rounded card.
- Do not use gradients as a substitute for hierarchy.
- Do not hide key evidence to make a screen look cleaner.
- Do not mix multiple accent colors in one action cluster.
- Do not use low-contrast gray for essential metadata.
- Do not fabricate a confidence score when the backend does not provide one.
- Do not let dashboards become denser than the decisions they support.

## 13. Agent Prompt Guide

When designing or implementing a Suheng interface, use this instruction:

> Use `DESIGN.md` as the visual source of truth. Build an evidence-first Suheng interface using the existing OpenKnot tokens and components. Preserve clear conclusion → evidence → action hierarchy, support dark and light modes, and include responsive, loading, empty, partial-data, error, keyboard, and reduced-motion states. Avoid generic AI gradients, decorative glass effects, and unsupported confidence claims.

Before completing UI work, verify:

- The primary conclusion is immediately identifiable.
- Evidence provenance is visible and distinct from model interpretation.
- Only one primary action dominates each region.
- Status is understandable without color.
- Both OpenKnot themes remain legible.
- Mobile retains the same decision hierarchy.
- The implementation reuses existing tokens instead of introducing isolated values.

## 14. Runtime Delivery

RabbitMQ chat turns receive a compact projection of this document only when the user explicitly asks for Suheng/OpenKnot design guidance or requests creation of a visual artifact such as a page, interface, dashboard, chart, or prototype. Ordinary analysis, search, summarization, and report turns must not receive the extra design context.

The ai-assistant chat surface safely renders GFM Markdown, including headings, lists, tables, blockquotes, highlighted code, links, images, and citations. It does not execute JavaScript, iframe content, Mermaid, or ECharts configuration, and it does not provide a live HTML preview.

Choose the delivery format accordingly:

- Present ordinary explanations and compact data in Markdown.
- Present static charts as PNG/SVG images with useful alternative text, plus a table or text summary when practical.
- Deliver runnable or interactive designs as standalone HTML/CSS/JavaScript files through the available file-sharing path, with a concise Markdown summary and download link in chat.
- Never paste a complete runnable page into the chat as raw rendered HTML.
