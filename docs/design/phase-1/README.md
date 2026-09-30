# Phase 1: tokens, contrast and white-label

- Decision: [ADR-0106](../../adr/0106-design-tokens-v1.md). Compare with the [baseline](../baseline/README.md).
- Taken with `apps/web/scripts/capture.mjs` on the local preview. `home-brand-1440` uses `?brand=1d5fa8`, a white-label colour applied the way a host's brand is.

| Screen                     | After                                      | Before                                           |
| -------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Home, office at work, 1440 | [home-active-1440](home-active-1440.jpg)   | [baseline](../baseline/home-active-1440.jpg)     |
| Home, office at work, 390  | [home-active-390](home-active-390.jpg)     | [baseline](../baseline/home-active-390.jpg)      |
| Home, new office, 1440     | [home-empty-1440](home-empty-1440.jpg)     | [baseline](../baseline/home-empty-1440.jpg)      |
| Home with a brand, 1440    | [home-brand-1440](home-brand-1440.jpg)     | none: before, the brand did not reach the office |
| GIA, 1440                  | [gia-1440](gia-1440.jpg)                   | [baseline](../baseline/gia-1440.jpg)             |
| Comercial office, 1440     | [office-sales-1440](office-sales-1440.jpg) | [baseline](../baseline/office-sales-1440.jpg)    |
| Agents, 1440               | [agents-1440](agents-1440.jpg)             | [baseline](../baseline/agents-1440.jpg)          |
| Approvals, 1440            | [approvals-1440](approvals-1440.jpg)       | [baseline](../baseline/approvals-1440.jpg)       |

## Contrast, before and after

| Where                                  | Before                 | After                                 |
| -------------------------------------- | ---------------------- | ------------------------------------- |
| Accent text on white                   | `#E0643A` 3.47:1       | `#C0451D` 5.11:1                      |
| Accent text on the background          | 3.30:1 (cream)         | 4.68:1 (porcelain)                    |
| Credit balance                         | amber `#D9901C` 2.64:1 | primary text, 16.3:1                  |
| Times and approval notes in GIA's chat | amber 2.64:1           | secondary text 6.36:1, warning 5.65:1 |
| Send and primary buttons (white text)  | on `#F2784B` 2.78:1    | on `#C0451D` 5.11:1                   |
| Notification count                     | on `#F2784B` 2.78:1    | on `#C0451D` 5.11:1                   |
| "Waiting" state light                  | `#D9901C` 2.64:1       | `#B87708` 3.70:1                      |
| Secondary text on the background       | `#5F6878` 4.97:1       | `#556072` 5.82:1                      |

`packages/ui/src/tokens.test.ts` checks these combinations, and the rest, on every surface.

## Left for later phases

- The Home's composition, header and panel hierarchy (phase 4).
- The room art, circuits and MelonMotor.
- Uppercase labels.
- The navy shadows drawn over the office art, and the department office's older dusk room.
- `working` (melon) and `attention` (red) are both warm. Phase 4 should separate them by shape as well as colour.
