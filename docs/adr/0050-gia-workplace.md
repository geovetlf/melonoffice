# ADR-0050: GIA's Workplace and avatar

- Status: Proposed (Fase 1b of the GIA phase)
- Date: 2026-09-28
- Builds on: ADR-0040 (the Home and the offices), ADR-0049 (the office's activity), the Master Functional Map v1 and Geovet's decisions of 2026-09-28 (GIA phase 1 scope; the avatar is a vector illustration v1, drawn by Claude and replaceable)
- Does not change: the API, permissions, credits, the AI Gateway or any data.

## Context

GIA had a placeholder page ("GIA's space is being prepared"). Geovet asked for GIA's own place: entered from the Home like a department's office, full screen, with a professional, warm female avatar with glasses, her desk, her state, her activity, her capabilities when they exist, her history and room for future actions. Nothing may be simulated, and accessibility, keyboard, focus, reduced motion and phones must hold.

## Decision

### 1. The avatar is artwork, kept apart

- `apps/web/src/gia/artwork.tsx` draws GIA v1: a vector portrait in MelonOffice's warm palette (amber and coral, never green), with glasses, shoulder-length hair and a blazer. It holds no text, state or behaviour.
- `GiaAvatar` frames it: size, a screen-reader name ("GIA, your executive assistant") or none when her name is written beside it, and unique gradient ids.
- A new illustration replaces `artwork.tsx` only.
- The only motion is a blink every few seconds, and only under `prefers-reduced-motion: no-preference`.

### 2. The Workplace

`/gia` shows GIA's Workplace, in the same frame as a department's office (breadcrumb, header, sections), and the Home's GIA card now shows her face and leads there. The page's title takes focus on arrival.

- **Desk:** a drawn desk with a screen, lamp, plant and mug. It is decoration; the screen shows the MelonOffice mark, never invented work.
- **State:** "Getting ready: the conversation with GIA arrives in the next phase". It says what is connected today and is replaced by the real state when the chat exists (Fase 1c).
- **Capabilities:** phase 1's (answer about the business, explain the activity, take you to the right screen, name the department for a request), each marked "Soon" until connected. Below them, what GIA does not do yet: send messages, change data, pay, publish.
- **History:** the office's activity (ADR-0049), filtered to what GIA did (actor `gia` or a `gia.*` action), with the same Today / This week / This month picker. With nothing, it says GIA has not done anything yet in the period.
- **Actions:** room for actions GIA will prepare for approval; nothing runs without the person's approval.

## Consequences

- No new data, route or permission: the Workplace reads only what already exists.
- A role without `activity.read` sees the Workplace without history, and no activity call is made.
