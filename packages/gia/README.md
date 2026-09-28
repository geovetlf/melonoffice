# @melonoffice/gia

GIA's chat ([ADR-0052](../../docs/adr/0052-gia-chat.md)). A person asks, and GIA answers through the one AI Gateway, which picks the model by its named policy (`gia_assist`), charges the credits and audits the call. She reads as that person:

- a few Company Brain facts chosen for the question;
- today's activity;
- what she still needs to learn;
- the organization's departments.

GIA answers, explains, and points to a screen and a department. She never acts. What the person tells her about the business is kept only as Company Brain proposals, for a person to confirm. Server only.

- `catalogue.ts`: the screens she may point to, locales, limits and rate limits.
- `prompt.ts`: the messages sent to the model (every input marked as data) and the closed answer shape.
- `service.ts`: `createGia` and its `ask`. It checks the input and permission, replays repeated clicks, reads the context, calls the gateway, checks the answer, keeps proposals and audits `gia.message_answered`.
