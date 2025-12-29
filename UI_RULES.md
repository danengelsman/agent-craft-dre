# UI Rules (AgentCraft)

## Non-negotiables
- Pages must compose shared primitives from `src/components/ui/*`.
- Do not create bespoke Tailwind-heavy layouts in pages.
- Do not inline arbitrary colors. Use CSS variables from `globals.css`.
- Use `PageShell` for page layout.
- Use `Card` for sections/panels.
- Use `Button` for all CTAs.
- Use `Input` (and shared primitives) for all form controls.
- Prefer calm whitespace and simple hierarchy.

## If new UI is needed
Extend primitives in `src/components/ui/` instead of inventing a new style pattern.
