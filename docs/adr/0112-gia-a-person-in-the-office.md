# ADR-0112: GIA, a person in the office

- Status: Proposed
- Date: 2026-10-01
- Builds on: [ADR-0050](0050-gia-workplace.md), [ADR-0064](0064-gia-prepares-agent-tasks.md), [ADR-0109](0109-home-rebuilt-on-the-toolkit.md), [ADR-0111](0111-accessibility-pass.md)

## Context

GIA was an illustrated face in a sphere, fixed in the centre of the Home. She should be one photorealistic person, the same in the office and in her chat. She should stand where the work really puts her and walk there, never teleport.

## Decision

1. **One character, many pictures** (`gia/character.tsx`, `gia/art`). The official reference sheet is cut into separate pictures. It never ships whole.
   - Eight whole-body views at one scale: front, three-quarter, the two profiles, back, away, walking towards the viewer, walking with the tablet.
   - Three chest-up portraits: at rest, with the tablet, talking.
   - A face for small avatars.

   `GiaFigure` (body) and `GiaPortrait` (chest up) are reusable anywhere. `GiaAvatar` keeps its API and now shows her face, so every place that showed the drawing shows her. The drawn artwork and her drawn desk are removed. Her workplace shows her portrait beside the chat.

2. **Where she is comes from records** (`gia/presence.ts`).
   - When the person sends a task GIA prepared (ADR-0064), the chat records it as an engagement.
   - `giaTarget` puts her with that agent while the agent's latest task is that task and is under way (`working`) or waiting. A task sent less than two minutes ago and not yet read counts as `waiting`.
   - Otherwise she is in her room: `coordinating` while agents work, else `idle`.
   - Tasks do not yet say GIA prepared them, so engagements live in the session (sessionStorage). When the API reports a task's origin, `giaTarget` reads it from there instead.
3. **The building is walkable** (`office/scene/officeWalk.ts`).
   - The rooms form one block: every storey has a walkway along its front, and a lift shaft runs each side of the centre column.
   - Rooms are open at the front: a person steps out onto the walkway, walks along it, takes a lift and steps into another room.
   - Routes are legs in the office's measured pixels: walk or lift, each straight. Tests check that no route crosses a room.
4. **She walks only when her place changes** (`office/scene/GiaInOffice.tsx`).
   - While standing she is drawn inside her room, among its desks and under its signs. While walking she is drawn over the office, facing the way she goes, and the lift's cabin carries her.
   - The states she passes through are `walking`, `arriving` and `returning`.
   - With reduced motion, on a phone (the rooms are a list) or before the office is laid out, she is simply in the new place.
   - Her step (`gia-step`) plays only while she walks.

## Consequences

- GIA in the office, on her way, in a department and in her chat is the same person.
- Her place and state are on the office (`data-gia-activity`) and in the room links' names ("GIA is here, with Ana"), so screen readers get them too.
- **Left for later:**
  - Walk-cycle pictures would make her steps real: today she glides in the view of her direction, with a slight rise and fall.
  - The API should record a task's origin.
  - Other agents can use the same plan once they are people too.
