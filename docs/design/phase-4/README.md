# Phase 4: the Home

- Decision: [ADR-0109](../../adr/0109-home-rebuilt-on-the-toolkit.md).
- Taken with `apps/web/scripts/capture.mjs` (the Home) and `capture-components.mjs` (its overlays), on the local preview.
- Before: the [baseline](../baseline/README.md) (phase 0) and [phase 3](../phase-3/README.md).

| Home                 | Before (phase 0)                                                                                                                                               | After                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Office at work, 1440 | [baseline](../baseline/home-active-1440.jpg)                                                                                                                   | [home-active-1440](home-active-1440.jpg)                                                                       |
| Office at work, 1024 | [baseline](../baseline/home-active-1024.jpg)                                                                                                                   | [home-active-1024](home-active-1024.jpg)                                                                       |
| Office at work, 768  | [baseline](../baseline/home-active-768.jpg)                                                                                                                    | [home-active-768](home-active-768.jpg)                                                                         |
| Office at work, 390  | [baseline](../baseline/home-active-390.jpg)                                                                                                                    | [home-active-390](home-active-390.jpg)                                                                         |
| New office           | [1440](../baseline/home-empty-1440.jpg), [1024](../baseline/home-empty-1024.jpg), [768](../baseline/home-empty-768.jpg), [390](../baseline/home-empty-390.jpg) | [1440](home-empty-1440.jpg), [1024](home-empty-1024.jpg), [768](home-empty-768.jpg), [390](home-empty-390.jpg) |

| Overlays on the Home | Before (phase 3)                                                                                   | After                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| MelonMotor's panel   | [before](../phase-3/after/home-motor-panel-1440.jpg)                                               | [after](home-motor-panel-1440.jpg)                               |
| An agent's card      | [1440](../phase-3/after/home-agent-card-1440.jpg), [390](../phase-3/after/home-agent-card-390.jpg) | [1440](home-agent-card-1440.jpg), [390](home-agent-card-390.jpg) |
| Notifications        | [before](../phase-3/after/home-notifications-1440.jpg)                                             | [after](home-notifications-1440.jpg)                             |
| GIA's quick ask      | [before](../phase-3/after/home-quick-ask-1440.jpg)                                                 | [after](home-quick-ask-1440.jpg)                                 |
| Phone menu           | [before](../phase-3/after/home-phone-menu-390.jpg)                                                 | [after](home-phone-menu-390.jpg)                                 |
| Keyboard focus       | [before](../phase-3/after/home-focus-1440.jpg)                                                     | [after](home-focus-1440.jpg)                                     |

## What was checked

| Check                | Result                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real data only       | Title, context line, chips, room plates, tasks, activity and credits come from the records. Empty states say so. There is no meter without an allotment.    |
| 3×3 and the 3D art   | Unchanged: the same rooms, in the same places, with the same links and agent buttons.                                                                       |
| Hierarchy            | Activity leads the side panel, tasks follow, meetings are quiet and credits compact. GIA is the building's warm centre, and MelonMotor is sober.            |
| Motion               | Only real work moves: task pulses, working lights, live screens. Idle breathing, rings and glows are still. Reduced motion stops all of it.                 |
| Tokens               | `home.css` has no hard-coded colour. Shadows, corners, layers and motion come from the tokens, and the type tests still pass.                               |
| Responsive           | 1440 and 1024 fit the window. At 768 the Home is 2768 px tall, where it was 3303. 390 is unchanged. No width scrolls sideways.                              |
| Accessibility        | The same links and buttons with their labels. The status dots stay beside their words, and focus is visible on every control.                               |
| Nothing else changed | Authentication, backend, APIs, the Harness, the CRM, GIA's and MelonMotor's logic, departments, routes, permissions and data are unchanged. All tests pass. |
