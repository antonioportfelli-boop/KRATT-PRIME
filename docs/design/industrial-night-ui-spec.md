# Industrial Night UI — Design Specification
Status: DESIGN SPECIFICATION — NOT IMPLEMENTED
Date: 2026-11-05

## Creative direction
Translate the user's supplied night photographs into a distinct operational interface:
- industrial silhouettes and chimney geometry become navigation and panel framing
- red aviation lights become rare critical-state markers
- cold cyan light beams become active selection, focus, and data-flow cues
- sodium amber becomes secondary action / caution
- wet asphalt reflections become restrained depth and layered surfaces
- analog grain becomes subtle surface texture, not visual noise

Do not reproduce the photographs as literal backgrounds. Use them as a visual grammar.

## Application shell
1. Persistent left rail on desktop with expandable module groups.
2. Compact mobile navigation with explicit active module and accessible labels.
3. Top status strip: environment, connectivity, local/remote runtime, sync state.
4. Main module workspace with breadcrumb, title, capability state, primary action, evidence panel.
5. Global assistant launcher anchored away from primary navigation and mobile safe areas.
6. Runtime Observatory entry always reachable from shell.

## Module workspace contract
Every module route should expose:
- stable module ID and display name
- capability state and source of truth
- supported actions and permissions
- health/evidence link
- loading, empty, error, offline, and unbound states
- responsive layout metadata
- independent route with breadcrumb and back navigation

## Visual hierarchy
- Primary content surfaces are matte graphite, not glass-heavy.
- Use cyan for active/focused/connected; never for all decorative borders.
- Red only for critical faults, denied security actions, or destructive confirmation.
- Amber for caution, pending review, or degraded state.
- Use monospaced typography only for IDs, timestamps, code, and telemetry.
- Keep body text at readable contrast and avoid tiny metadata on mobile.

## Motion and accessibility
- Motion should communicate state transitions and data flow, not decorate every element.
- Honor `prefers-reduced-motion`.
- No flashing warning indicators.
- Visible keyboard focus, semantic landmarks, accessible names, and predictable focus return.
- Touch targets should be comfortable on phone screens.
- Charts must have textual summaries and empty states.

## Acceptance checklist
- [ ] 360px narrow viewport: no horizontal page overflow.
- [ ] 768px tablet: navigation and workspace remain distinct.
- [ ] Desktop wide viewport: module content does not stretch beyond readable width.
- [ ] Keyboard-only navigation works through shell and assistant.
- [ ] Reduced-motion disables nonessential animation.
- [ ] All state colors have text/icon labels, not color alone.
- [ ] Assistant launcher does not obscure primary actions.
- [ ] Mock/unbound/not-run states are visually unmistakable.
