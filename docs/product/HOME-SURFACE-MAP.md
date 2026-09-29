# MelonOffice: Home surface map

- Date: 2026-09-29, main `f3c4366`.
- The Home is the Living AI Office (ADR-0040/0041/0042): the office scene with GIA at hand, and the day's panels underneath.
- This map lists every element on it, following the chain Home element → capability → component → user action → destination.

| Home element                                                | Capability (backend)                               | Component                  | User action                                 | Destination                                | Status                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------- | -------------------------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Greeting and headline ("agents working" / "ready")          | specialists (count of active)                      | `HomePage` hero            | none                                        | none                                       | real data                                                                       |
| GIA card                                                    | GIA                                                | `GiaCard`                  | click                                       | GIA desk `/gia`                            | COMPLETE                                                                        |
| Office scene: one room per department                       | departments, specialists                           | `OfficeScene`              | click a room                                | the department office `/office/<slug>`     | COMPLETE                                                                        |
| Desk with an agent (in a room)                              | specialists                                        | `WorkstationMap`           | click the agent                             | the agent page `/office/<slug>/agent/<id>` | COMPLETE (read and tasks)                                                       |
| Free desk                                                   | none                                               | `WorkstationMap` free seat | assign, move, remove                        | none                                       | "Soon": needs a seating permission decision                                     |
| GIA command bar                                             | GIA (`gia/messages`)                               | `GiaCommandBar`            | type and send                               | GIA desk with the answer                   | COMPLETE                                                                        |
| Ctrl+K / ⌘K (any page)                                      | GIA (`gia/messages`)                               | `GiaQuickAsk`              | type, Enter to send, Esc to close           | GIA desk with the answer                   | COMPLETE (block 8)                                                              |
| GIA bar: attach                                             | documents                                          | `GiaCommandBar`            | none                                        | none                                       | "Soon" (the Documents page now exists; attaching there is a next step)          |
| GIA bar: voice                                              | none                                               | `GiaCommandBar`            | none                                        | none                                       | "Soon" (no voice engine)                                                        |
| Quick actions (document, file, email, meeting, video, more) | none                                               | `QuickActions`             | none                                        | none                                       | "Soon"                                                                          |
| Today's work panel                                          | follow-ups (`follow-ups`), approvals (`approvals`) | `TodayWork`                | open a due follow-up or the approval center | Comercial follow-ups, `/approvals`         | COMPLETE (block 8): real follow-ups due today or overdue, and waiting approvals |
| Recent activity panel                                       | activity (`activity`)                              | `RecentActivity`           | read                                        | none                                       | real data                                                                       |
| Meetings panel                                              | none (no calendar)                                 | `UpcomingMeetings`         | none                                        | none                                       | says no calendar is connected; no example data (block 8)                        |
| Credits panel                                               | credits (`credits`), ai-usage                      | `CreditsUsage`             | read balance, open usage                    | `/ai-usage`                                | COMPLETE (block 1)                                                              |
| Top bar: search                                             | departments, specialists                           | `GlobalSearch`             | search, then open                           | the office or agent                        | COMPLETE                                                                        |
| Top bar: notifications bell                                 | none                                               | `TopBar`                   | none (disabled)                             | none                                       | MISSING (activity center)                                                       |
| Top bar: active agents count                                | specialists                                        | `TopBar`                   | none                                        | none                                       | real data                                                                       |

## What the Home needs next

In the block order of FEATURE-SURFACE-MAP §4:

Blocks 1, 2 and 8 are done: AI usage from the credits panel, waiting approvals in Today's work, real follow-ups in place of the example tasks, and Ctrl+K for GIA. Next:

- The bell opening an activity center, once there is one.
- Meetings, once a calendar is connected.
