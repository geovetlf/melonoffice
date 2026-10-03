# ADR-0122: An abandoned conversation turn goes back to a person (AE-9)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0043](0043-conversation-agent.md), [ADR-0121](0121-automatic-sweep-of-abandoned-work.md)

## Context

ADR-0121 left conversation agent turns out of the automatic sweep. A turn whose job was lost does not hand its conversation to a person, because the stop hook only runs when the runtime stops the turn. So the customer waits with no reply, and nobody on the team sees that the conversation needs them.

## Decision

1. **Turns are in the sweep.** A conversation turn (`turnOf`) is a candidate like an agent task or a plan step, under the same rules:
   - 24 hours without progress;
   - no live lease;
   - no pending approval that has not expired;
   - not paused.
2. **Its stop hook handles `stale_execution`.**
   - The conversation is handed to a person with the reason `unresolved`, like an unknown outcome.
   - The hand-off is skipped, as before, if a person or a newer turn already took the conversation.
3. **The reserved reply is never sent late, and never marked wrong.**
   - If its send never started (its node has no idempotency key and is not running), it is settled `failed` with `stale_execution`.
   - If its send had started, it is settled `unknown`, because it may have gone out. An unknown reply is never sent again.
4. **Nothing new runs.** No model is called and no credits are charged. The person sees the conversation in the inbox as escalated.

## Consequences

- No new infrastructure. It uses the same sweep, the same index and the same route as ADR-0121.
