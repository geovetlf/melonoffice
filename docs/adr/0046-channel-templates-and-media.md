# ADR-0046: Channel templates and media

- Status: Proposed (CV-6D phase 2, pending Geovet's review)
- Date: 2026-09-28
- Amends: [ADR-0044](0044-integration-engine.md) (outbound content, capabilities) and [ADR-0045](0045-channel-delivery-limits-and-retries.md) (audited content type)
- Builds on: ADR-0020 (audit), ADR-0029 (`outcome_unknown` is never retried), ADR-0034 (sending through the tool gate), ADR-0043 (last check before send)
- Does not change: the tool gate, the AI Gateway, the runtime, credits, the rate limit and retry policy, plans, credentials or infrastructure.

## Context

CV-6C and CV-6D phase 1 send text only. Geovet's phase 2 brief asks for templates, images, documents and audio/video through the same engine, with four rules:

- templates are never invented: the organization brings its own, approved by Meta;
- a missing variable or a misconfigured template never reaches Meta;
- outside the 24-hour window, free content is refused before the adapter;
- media stays provider-agnostic, and nothing sensitive is logged or audited.

## Decision

### 1. One content union, one path

Outbound content is one of three kinds, carried unchanged from the API to the adapter:

| Kind       | Content                                                                   | Capability          |
| ---------- | ------------------------------------------------------------------------- | ------------------- |
| `text`     | text                                                                      | `outboundText`      |
| `media`    | `{type: image\|document\|audio\|video, url, filename?}`, optional caption | `outboundMedia`     |
| `template` | a registered template id and its values                                   | `outboundTemplates` |

```
Person → API → Tool Gate → message_send executor
  → Integration Engine: connection, lifecycle, capability(kind), window(kind), credential,
                        template resolution
      loop: rate limit → last check → adapter.send → classify → (backoff → loop)
  → WhatsApp adapter → Meta Graph API
```

The runtime and the conversation agent know no kind but text: agents stay text-only, and the executor refuses anything else from the runtime. Rate limit, retries, `outcome_unknown`, idempotency and credits are phase 1's, unchanged.

### 2. Templates are registered, then confirmed by Meta

A template is a record in `channelTemplates/{id}`, where the id is a SHA-256 of the organization, the connection, the name and the language. A person with `channel.update` registers it by **name and language only**; nothing about its content is typed in. It starts `pending`.

A check reads Meta's own record with the connection's token:

1. `GET /{waba}/phone_numbers`: the WhatsApp Business Account must own the connection's number (`account_mismatch` otherwise). The connection needs its `businessAccountId`, which can now be set once on an existing connection.
2. `GET /{waba}/message_templates?name=…`: the name, then the language, then status `APPROVED`. Any other status gives `template_<status>`.
3. What it needs is read from its components: header none, text (`{{1}}`…), image, document or video; body `{{1}}`…`{{n}}`; URL buttons with one variable. Named parameters, gaps, location headers, flow buttons, carousels and other components are refused, never guessed.

| Result           | Status                                      |
| ---------------- | ------------------------------------------- |
| approved         | `active`, with its spec                     |
| refused          | `invalid`, with the reason code             |
| Meta unreachable | unchanged (an active template stays active) |

`disable` turns it off for good. Every step is audited (`channel.template_registered`, `channel.template_checked`, `channel.template_disabled`, target `channel_template`).

### 3. Values are checked before Meta

A send names the template id and its values. `resolveTemplate` requires an active template on the same connection, exactly as many header and body values as the spec, the header media's own type, and one value per URL button. Any mismatch is `template_parameters_invalid` with a stable reason (`template_not_active`, `template_header_mismatch`, `template_parameter_missing`, `template_parameter_extra`). It is audited as a refusal, sends nothing and is not retried.

### 4. The 24-hour window

The engine decides before the adapter. Outside the customer-service window, `text` and `media` are refused with `outside_messaging_window`; `template` is allowed, as Meta allows it.

### 5. Media by link

Media is sent by an https link only: a host name (no IP address, `localhost` or `.internal`), no user or password, at most 2 048 characters. `filename` is for documents only; a caption is at most 1 024 characters and never on audio. The link is checked when the request arrives and again in the adapter.

MelonOffice does not store or upload media in this phase. The link is kept on the message (so a retry sends the same thing), but it is never returned in API views, logs or audit events.

### 6. Meta errors

New final codes, never retried: 131052 `media_download_failed`, 131053 `media_upload_failed`, 132000/132012 `template_parameter_mismatch`, 132001 `template_not_found`, 132005 `template_text_too_long`, 132007 `template_policy_violation`, 132015 `template_paused`, 132016 `template_disabled`.

### 7. Audit

Delivery and message events gain `message: {type, template?, language?}`: the kind, and for a template its name and language. Never the values, the text, the link, a phone number or a secret.

### 8. Takeover for human sends

A person's send now also re-checks, before each retry, that the conversation still exists, is open and may be answered by a person. An agent taking over during a wait stops the retry.

## Consequences

- A template works only after the organization gives the connection's WABA id and Meta confirms the template approved there.
- Meta template errors (paused, disabled, not found) fail the send but do not yet change the stored template; a new check does.
- Only existing conversations can receive a template; starting a conversation with a new contact is not in this phase.
- No web UI for templates or media: API only.
- No Terraform change: `channelTemplates` is created on first write, and the services already have Firestore access.

## Activation

- **Existing connections.** A connection stored before this change keeps its old capabilities (text only). It gains media and templates only when it is checked again: pause it, then connect it (the web's own buttons, or `POST …/pause` then `POST …/connect`). No data migration runs by itself.
- **Templates.** Set the connection's `businessAccountId` once (`PATCH …/channel-connections/:id`), then register each approved template by name and language (`POST …/templates`).

## Implemented, and prepared but not active

| Implemented and active for people                                                                 | Prepared, not active                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Text, media (image, document, audio, video) and template sends by a person, through the tool gate | Agents sending media or templates: the content union and the engine accept them, but the executor keeps runtime sends text-only |
| Template registration, check against Meta, disable (API)                                          | A web screen for templates                                                                                                      |
| 24-hour window per kind in the engine                                                             | Starting a conversation with a new contact by template                                                                          |
| Media by public https link                                                                        | MelonOffice media storage or upload                                                                                             |
|                                                                                                   | Updating a stored template from Meta's send errors (paused, disabled)                                                           |

## Not in this ADR

Media storage or upload, templates or media sent by agents, conversations started by template, finish/tool actions (phase 3) and a second channel (phase 4).
