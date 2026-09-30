# Phase 3: components

- Decision: [ADR-0108](../../adr/0108-components.md). Audit and plan: [AUDIT.md](AUDIT.md).
- Screenshots: `before/` on `main` at `6f5bab2`, and `after/` on this branch, both taken with `apps/web/scripts/capture-components.mjs`.

## The toolkit

Every component in every state, in the gallery (`apps/web/components.html`):

- at [1440](after/gallery-1440.jpg), [1024](after/gallery-1024.jpg), [768](after/gallery-768.jpg) and [390](after/gallery-390.jpg);
- states, at 2x:
  - hover: [primary](after/state-hover-primary.jpg), [secondary](after/state-hover-secondary.jpg), [chip](after/state-hover-chip.jpg), [menu item](after/state-hover-menu-item.jpg);
  - pressed: [primary](after/state-pressed-primary.jpg);
  - keyboard focus: [button](after/state-focus-button.jpg), [field](after/state-focus-field.jpg).

## Before and after

| Screen or overlay                            | Before                                                                                                                                                             | After                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversations (fields, tabs)                 | [1440](before/conversations-1440.jpg), [390](before/conversations-390.jpg)                                                                                         | [1440](after/conversations-1440.jpg), [390](after/conversations-390.jpg)                                                                                       |
| Memory (form, filters)                       | [1440](before/memory-1440.jpg), [390](before/memory-390.jpg)                                                                                                       | [1440](after/memory-1440.jpg), [390](after/memory-390.jpg)                                                                                                     |
| Agents                                       | [1440](before/agents-1440.jpg), [1024](before/agents-1024.jpg), [768](before/agents-768.jpg), [390](before/agents-390.jpg)                                         | [1440](after/agents-1440.jpg), [1024](after/agents-1024.jpg), [768](after/agents-768.jpg), [390](after/agents-390.jpg)                                         |
| Approvals                                    | [1440](before/approvals-1440.jpg), [1024](before/approvals-1024.jpg), [768](before/approvals-768.jpg), [390](before/approvals-390.jpg)                             | [1440](after/approvals-1440.jpg), [1024](after/approvals-1024.jpg), [768](after/approvals-768.jpg), [390](after/approvals-390.jpg)                             |
| AI usage                                     | [1440](before/ai-usage-1440.jpg), [390](before/ai-usage-390.jpg)                                                                                                   | [1440](after/ai-usage-1440.jpg), [390](after/ai-usage-390.jpg)                                                                                                 |
| Documents, automations, connections, reports | [documents](before/documents-1440.jpg), [automations](before/automations-1440.jpg), [connections](before/connections-1440.jpg), [reports](before/reports-1440.jpg) | [documents](after/documents-1440.jpg), [automations](after/automations-1440.jpg), [connections](after/connections-1440.jpg), [reports](after/reports-1440.jpg) |
| GIA and the Comercial office                 | [GIA](before/gia-1440.jpg), [office](before/office-sales-1440.jpg)                                                                                                 | [GIA](after/gia-1440.jpg), [office](after/office-sales-1440.jpg)                                                                                               |
| Account menu                                 | [before](before/home-account-menu-1440.jpg)                                                                                                                        | [after](after/home-account-menu-1440.jpg)                                                                                                                      |
| Notifications                                | [before](before/home-notifications-1440.jpg)                                                                                                                       | [after](after/home-notifications-1440.jpg)                                                                                                                     |
| Search                                       | [before](before/home-search-1440.jpg)                                                                                                                              | [after](after/home-search-1440.jpg)                                                                                                                            |
| Agent card                                   | [1440](before/home-agent-card-1440.jpg), [390](before/home-agent-card-390.jpg)                                                                                     | [1440](after/home-agent-card-1440.jpg), [390](after/home-agent-card-390.jpg)                                                                                   |
| MelonMotor panel                             | [before](before/home-motor-panel-1440.jpg)                                                                                                                         | [after](after/home-motor-panel-1440.jpg)                                                                                                                       |
| GIA's quick ask (Ctrl+K)                     | [before](before/home-quick-ask-1440.jpg)                                                                                                                           | [after](after/home-quick-ask-1440.jpg)                                                                                                                         |
| Keyboard focus on the Home                   | [before](before/home-focus-1440.jpg)                                                                                                                               | [after](after/home-focus-1440.jpg)                                                                                                                             |
| Phone menu                                   | [before](before/home-phone-menu-390.jpg)                                                                                                                           | [after](after/home-phone-menu-390.jpg)                                                                                                                         |

## What was checked

| Check                 | Result                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Alignment and spacing | Controls share two heights (44 and 32 px) and one padding scale, and the gallery's rows line up at every width.                          |
| Corners               | Controls, chips and badges are pills; fields and menu items are medium; cards large; panels, sheets and dialogs extra large.             |
| Shadows               | Three: resting (panels, cards, buttons), raised (hovered card), overlay (menus, sheets, dialogs). Menus lost the frosted glass.          |
| Contrast              | Field outlines are 3:1; the soft tones carry their text at 4.5:1 or more (tested); disabled controls are marked by opacity and cursor.   |
| Interactive states    | Hover, pressed, focus, disabled and busy on buttons; hover, focus, disabled and invalid on fields; selected on chips, segments and tabs. |
| Responsive            | No screen scrolls sideways at 390 (checked on 12 screens). The sheet is a bottom sheet on a phone.                                       |
| Nothing else changed  | Routes, APIs, permissions, data, GIA, MelonMotor, the Harness, the CRM and the Home's composition are unchanged. All tests pass.         |
