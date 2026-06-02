# Conversational UX Roadmap

Make sre-bot feel like **one easy chat assistant** while keeping the existing architecture: **commander speaks**, **orchestrator acts**, **security decides**.

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) · [CI-CODE-REMEDIATION-ROADMAP.md](./CI-CODE-REMEDIATION-ROADMAP.md) · **[PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md)** · [HOLMES-COMPARISON-AND-ADOPTION.md](./HOLMES-COMPARISON-AND-ADOPTION.md)

## Design principle

```text
User ↔ Commander (natural language only)
         ↓ structured intents / run updates
       Orchestrator + agents (typed tools, no free-form cluster access)
         ↓ facts, not prose
       Commander narrates outcomes back to user
```

Regex and classifiers stay **behind the curtain** as fast sensors. Users should not see tool names, internal modes, or pipeline jargon unless they ask for details.

---

## Improvement backlog

| # | Item | Impact | Status |
|---|------|--------|--------|
| **UX-1** | [Narration layer](#ux-1-narration-layer) — structured run updates → short user messages | High | **Done** |
| **UX-2** | [Telegram quick actions](#ux-2-telegram-quick-actions) — buttons for approve / details | High | **Done** |
| **UX-3** | [LLM-first routing](#ux-3-llm-first-routing) — single intent schema, regex as accelerator | High | **Done** |
| **UX-4** | [Progressive disclosure](#ux-4-progressive-disclosure) — headline + “show logs” | Medium | **Done** |
| **UX-5** | [Session-linked runs](#ux-5-session-linked-runs) — one thread for CI → PR → verify | Medium | **Done** |
| **UX-6** | [LLM-assisted CI classify](#ux-6-llm-assisted-ci-classify) — when regex confidence is low | Medium | **Done** |
| **UX-7** | [Outcome-based language](#ux-7-outcome-based-language) — hide modes from users | Medium | **Done** |
| **UX-8** | [Streaming status](#ux-8-streaming-status) — “Fetching CI logs…” | Low | **Done** |
| **UX-9** | [User prefs](#ux-9-user-preferences) — brief vs verbose | Low | **Done** |
| **UX-10** | [Coding agent persona](#ux-10-coding-agent-persona) — chat-native handoff | High | **Templates** (service = CI roadmap Phase 2) |
| **UX-11** | [LLM startup self-test](#ux-11-llm-startup-self-test) — fail loud if commander model unavailable | Medium | **Done** |
| **UX-12** | [Built-in help intent](#ux-12-built-in-help-intent) — “what can you do?” | Low | **Done** |
| **UX-13** | [Chat transcript memory](#ux-13-chat-transcript-memory) — last N turns to LLM router | High | **Done** |
| **UX-14** | [Active topic](#ux-14-active-topic) — unified session subject for follow-ups | High | **Done** |
| **UX-15** | [Clarification loop](#ux-15-clarification-loop) — ask once, bind next reply | Medium | **Done** |
| **UX-16** | [Console chat panel](#ux-16-console-chat-panel) — web assistant thread | High | **Done** |
| **UX-17** | [LLM workload-status intent](#ux-17-llm-workload-status-intent) — “is X running?” without investigate | Medium | **Done** |
| **UX-18** | [Unified outcome composer](#ux-18-unified-outcome-composer) — sync replies from structured facts | High | **Done** |

---

## UX-1: Narration layer

**Problem:** Orchestrator sends technical strings (`formatCiReport`, policy hints, deploy progress) directly to Telegram.

**Solution:**

- Define `RunUpdatePayload` in `shared/src/run-update.ts`
- Deterministic `formatRunUpdateFallback()` for offline / LLM-disabled
- Commander `POST /narrate` + optional LLM polish via fast commander model
- Orchestrator `notifyUserUpdate()` sends payloads; `/notify` narrates before delivery

**Env:**

| Variable | Default | Meaning |
|----------|---------|---------|
| `CONVERSATIONAL_NARRATE` | `true` | Use narration path vs raw message |
| `CONVERSATIONAL_NARRATE_LLM` | `true` | LLM polish; if false, fallback templates only |

**Acceptance:** CI failure message is ≤6 lines, no `cicd_rerun`, includes plain recommendation.

---

## UX-2: Telegram quick actions

**Problem:** Users must type “approve” or use HIL cards inconsistently.

**Solution (shipped):**

- `defaultQuickActionsForUpdate()` adds Approve/Reject for CI approval + `hil_required` payloads
- `postNotify()` sends Telegraf `inline_keyboard` when `quickActions` present
- Callback `id` uses existing `hil_approve_<incidentId>` / `hil_reject_<incidentId>` (commander `telegram.ts` handler)

**Depends on:** UX-1 payload shape.

**Also:** “Show logs” button (UX-4).

---

## UX-3: LLM-first routing

**Problem:** Parallel paths: LLM intent → regex → chat fallback disagreed.

**Solution (shipped):**

- **`shared/src/command-intent.ts`** — `CommandIntent` schema (`intent`, `confidence`, `userReply`, fields)
- **`classifyIntentUnified()`** — one LLM JSON call (replaces separate structured + chat classifiers)
- **`parseRegexFastPath()`** — sync fast path: catalog deploy, get, CI with repo, GitHub deploy URL, clear delete/rollback, cluster/namespace investigate
- **`commandIntentToParsed()`** — maps intent → `ParsedCommand`
- When LLM is configured: fast path → LLM → regex fallback only on LLM failure
- When LLM is offline: fast path → full `parseCommand` fallback

**Env:** uses existing `OPENROUTER_API_KEY` / `GEMINI_API_KEY` via `resolveCommanderLlm()`.

**Required for NL:** `GEMINI_COMMANDER_MODEL=gemini-2.5-flash` (or OpenRouter equivalent). Default `gemini-2.0-flash` is deprecated for new API keys — see **PLAT-1** in [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md).

---

## UX-4: Progressive disclosure

**Problem:** Long log blocks in chat.

**Solution (shipped):**

- CI diagnosis uses `detailAvailable: true` — headline only in chat
- **Show logs** inline button → `show_details_<runId>` callback
- `GET /runs/:runId/summary` on orchestrator → `formatRunSummaryForUser()`
- Follow-up phrases: “show logs”, “show details” (UX-5 session)

---

## UX-5: Session-linked runs

**Problem:** CI triage, PR, and re-verify feel disconnected.

**Solution (shipped):**

- Session store: `lastRepo`, `lastWorkflowRunId`, `lastRunId`, `lastMode`, `lastIncidentId`
- Follow-ups in `session-followups.ts`: **retry**, **did it pass?**, **show logs**, **open the PR**
- Commander router + `linkRunToSession()` after dispatch
- Status follow-up fetches orchestrator summary

---

## UX-6: LLM-assisted CI classify

**Problem:** Regex misses custom agent / odd log formats.

**Solution (shipped):**

- `diagnoseCiRun` returns `confidence` (lower when category unknown)
- If `< 0.8`, orchestrator calls brain **`POST /classify-ci`**
- Env: `CI_CLASSIFY_LLM=true`
- Still no auto-execute from classifier — only category + user message

---

## UX-7: Outcome-based language

**Problem:** Users see `ci-failure`, `pre-deploy`, tool names.

**Solution (shipped):**

- `shared/src/user-outcomes.ts` — `modeOutcomeLabel`, `actionOutcomeLabel`, `sanitizeUserFacingText`
- Run outcome notifications use `notifyUserUpdate` (not raw tool names)
- Narration + fallback templates strip jargon

---

## UX-8: Streaming status

**Problem:** Silent multi-minute runs.

**Solution (shipped):**

- `notifyProgress()` → `kind: 'progress'` updates
- CI observe: “Fetching CI logs from GitHub…”
- Deploy observe: “Gathering cluster and repository information…”

---

## UX-9: User preferences

**Solution (shipped):**

- Per-channel `verbose` flag in `channel-prefs.ts`
- Chat: **“be brief”** / **“more detail”**
- Passed into narration via `/notify` → `RunUpdatePayload.verbose`

---

## UX-10: Coding agent persona

**Solution:** Narration templates in `run-update.ts` for `coding_agent_handoff`, `coding_agent_progress`, `coding_agent_done`.

**Shipped:** Handoff message when CI diagnosis is `application_code`; full **coding-agent** service with live console panel (CI-2).

---

## UX-11: LLM startup self-test

**Problem:** When the commander model returns 404 (e.g. deprecated Gemini model), routing silently falls back to regex — natural language appears “broken” with no obvious error.

**Solution:**

- On commander boot, probe commander LLM with a tiny JSON intent request
- Log `ERROR` with model name and fix hint if probe fails
- Optional: expose `llm.ok: false` on `/health`

**Shipped:** `agents/commander/src/llm-probe.ts` runs on startup; `GET /health` returns `commanderLlmProbe` and `status: degraded` when probe fails.

---

## UX-12: Built-in help intent

**Problem:** New users don’t know supported phrasing.

**Solution (shipped):**

- `agents/commander/src/help.ts` — stable `HELP_MESSAGE` (no tool names)
- Regex fast path: `isHelpQuery()` — no LLM required
- LLM intent `help` in unified router schema
- Triggers: “help”, “what can you do?”, “how do I use this?”

---

## UX-13: Chat transcript memory

**Problem:** Each message routed in isolation — follow-ups like “is it also running in X?” fail without hand-coded patterns.

**Solution (shipped):**

- `agents/commander/src/chat-transcript.ts` — rolling transcript per platform/channel/user
- Env: `CHAT_TRANSCRIPT_MAX_TURNS` (default 10), `CHAT_TRANSCRIPT_MAX_CHARS` (default 6000)
- `classifyIntentUnified()` receives recent turns + active topic
- Telegram records turns via `recordChatUserTurn` / `recordChatReply` in `safeReply`
- **Persistence:** `CHAT_SESSION_BACKEND=redis` + `REDIS_URL` (memory fallback if Redis down)

---

## UX-14: Active topic

**Problem:** Session had many disconnected fields (`lastStatusSubject`, `lastRunId`, …).

**Solution (shipped):**

- `ActiveTopic` on session — kind + resource + namespace + label
- `syncActiveTopicFromCommand()` after every handled command
- Session follow-ups prefer `activeTopic` for pronoun resolution

---

## UX-15: Clarification loop

**Problem:** Bot asks “which namespace?” but forgets the question on the next message.

**Solution (shipped):**

- `PendingClarification` on session + `tryResolvePendingClarification()`
- Set when investigate workload unresolved or workload-status missing namespace
- User can reply `cancel` to abort

---

## UX-16: Console chat panel

**Problem:** Telegram-only chat; no Cursor-like scrollback in the web UI.

**Solution (shipped):**

- Commander `POST /chat`, `GET /chat/transcript`, `POST/GET /chat/sessions`
- Console BFF proxies `/api/chat*` → commander
- **Assistant** page (`/chat`) — conversation sidebar, **New chat**, **Start new chat** on Overview
- Requires `channelId` from `POST /api/chat/sessions` (no default shared thread)

---

## UX-18: Unified outcome composer

**Problem:** Sync commands (delete, get, status, health) returned agent-built markdown runbooks while async runs used UX-1 narration — chat felt inconsistent and “coded.”

**Solution (shipped):**

- **`shared/src/command-outcome.ts`** — structured payloads (`undeploy`, `workload_status`, `cluster_get`, `health`, `not_found`, `choice_prompt`)
- **`shared/src/compose-outcome-fallback.ts`** — deterministic brief/verbose templates (tested)
- **`agents/commander/src/compose-outcome.ts`** — `composeUserReply()` + optional LLM polish (`CONVERSATIONAL_COMPOSE_LLM`, falls back to `CONVERSATIONAL_NARRATE_LLM`)
- **GitOps `/undeploy`** returns `{ ok, outcome }` facts only (no prose)
- **Commander router** pipes delete, get, workload-status, namespace/cluster health through composer; respects UX-9 `verbose` channel pref
- **Console chat** — paragraph spacing for assistant bubbles (fewer visual gaps)

**Env:**

| Variable | Default | Meaning |
|----------|---------|---------|
| `CONVERSATIONAL_COMPOSE_LLM` | same as narrate | LLM polish for sync command replies |

**Acceptance:** “delete appache” brief reply is 2–4 sentences, states kubectl vs Helm honestly, no “if it existed” boilerplate.

---

## UX-17: LLM workload-status intent

**Problem:** “Is httpd running?” routed to investigate or failed regex on pronoun follow-ups.

**Solution (shipped):**

- `workload-status` added to `CommandIntentName` and unified LLM prompt
- `intentWorkloadStatusToParsed()` in `intent-mapper.ts`
- Regex follow-up parser + session topic (complements LLM)

---

## Implementation order (recommended)

1. ~~UX-1~~ Narration layer
2. ~~UX-2~~ Telegram buttons for HIL / CI
3. ~~UX-3~~ LLM-first routing refactor
4. ~~UX-4~~ Progressive disclosure
5. ~~UX-5~~ Session-linked runs
6. ~~UX-6~~ LLM CI classify
7. ~~UX-7–9~~ polish
8. **UX-10** Coding agent **service** (Phase 2 CI roadmap — **CI-2**)
9. ~~UX-11~~ LLM startup self-test
10. ~~UX-12–17~~ Cursor-like conversation layer
11. Platform tracks **PLAT-2–12** — see [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md)

---

## What we are not changing

- Security-agent sanitize + authorize before act
- No LLM direct kubectl/GitHub write
- Typed tool compiler + orchestrator graph
- Separate microservices

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-01 | UX-18: unified outcome composer for delete/get/status/health; gitops structured undeploy |
| 2026-06-01 | Redis chat sessions (`CHAT_SESSION_BACKEND`); console multi-conversation UI + Overview “Start new chat” |
| 2026-06-01 | UX-12–17 shipped: help, transcript, active topic, clarification, console chat, workload-status intent |
| 2026-05-29 | UX-11/12 backlog; PLAT-1 NL model fix documented; link PRODUCT-ROADMAP |
| 2026-05-29 | UX-4–9 shipped; UX-10 narration templates (handoff message) |
| 2026-05-29 | UX-3 shipped: `CommandIntent`, unified LLM router, `parseRegexFastPath` |
| 2026-05-29 | UX-2 shipped: inline Approve/Reject on CI approval notifications |
| 2026-05-29 | UX-1 shipped: `RunUpdatePayload`, commander `/narrate`, orchestrator `notifyUserUpdate` |
