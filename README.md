# Neobank onboarding — a KYC process built as a state machine

A reference implementation, not a client system: the actual artifacts, so you
can disagree with the decisions.

> **Status.** The database layer and the workflow logic are tested — 55 tests
> run the workflow's own SQL and JavaScript against real Postgres 16 (PGlite)
> with a stubbed screening service and KYC provider (`npm test`). It has **not**
> been run inside a live n8n instance or against a real KYC or screening
> provider. Treat it as a design you can execute, not a product.

| File | What it is |
|---|---|
| `onboarding.bpmn` | BPMN 2.0 — opens in [bpmn.io](https://demo.bpmn.io) or Camunda Modeler |
| `schema.sql` | Postgres: states, allowed transitions, the functions the orchestrator may call, audit, review queue |
| `workflow.n8n.json` | n8n workflow — importable; 43 nodes, 3 entry points (submit, provider callback, reconciler) |
| `openapi.yaml` | The API contract — public statuses, auth, and what each 409 means |
| `postman_collection.json` | 7 requests — 4 of them are the failure cases |
| `tests/` | `schema.test.mjs` (the rules in the database) · `workflow.test.mjs` (the workflow, executed node by node) · `harness.mjs` |

---

## The state machine

```mermaid
stateDiagram-v2
    [*] --> submitted: applicant submits
    submitted --> screening: eligible
    submitted --> rejected: ineligible (age, country)
    screening --> kyc_pending: clear
    screening --> kyc_review: sanctions / PEP hit, or screening unavailable
    kyc_pending --> approved: provider CLEAR
    kyc_pending --> rejected: provider DECLINE
    kyc_pending --> kyc_review: provider REFER, or request refused
    kyc_pending --> kyc_unknown: timeout / 5xx / callback SLA breached
    kyc_unknown --> approved: reconciled CLEAR
    kyc_unknown --> rejected: reconciled DECLINE
    kyc_unknown --> kyc_pending: never received, resubmit with the same key
    kyc_unknown --> kyc_review: reconcile budget exhausted
    kyc_review --> approved: reviewer (4 eyes)
    kyc_review --> rejected: reviewer (4 eyes)
    kyc_review --> kyc_pending: more info supplied
    approved --> account_opened
    rejected --> [*]
    account_opened --> [*]
```

(`draft` and `expired` exist in the schema for the applicant-facing side and
for ageing out; this workflow starts at `submitted`.)

**Transitions are data, not code.** `app.application_transition_allowed` holds
`(from_state, to_state, actor)`. Adding a state is a migration, not a redeploy of
every workflow that touches onboarding — and an illegal transition is refused by
the database, not by a convention someone has to remember.

---

## Eight decisions worth arguing about

**1. A timeout is `kyc_unknown`, never `rejected`.**
Declining a customer because our network hiccuped is a compliance incident, not
a bug. `kyc_unknown` is a first-class state with its own reconciliation loop,
and nothing downstream fires while an application is indeterminate. The same
applies when the provider simply never calls back: past a 6-hour SLA the
application becomes `kyc_unknown` and the reconciler asks the provider directly
(the BPMN boundary timer, implemented as `app.flag_overdue_pending`).

**2. Query first, resubmit second — and only when certain.**
The reconciler `GET`s the provider by our own `client_reference` before it
considers resubmitting. Blind resubmission is how one applicant becomes two
identities, and how you pay a KYC vendor twice for the same check. A resubmit
reuses the *same* `Idempotency-Key` as the original submit.

**3. The orchestrator never writes state — and can't.**
The workflow's database role (`service_role`) has no table privileges at all,
only `EXECUTE` on seven functions, and it may only act as `system`.
`app.transition_application()` locks the row, checks the transition table, then
writes state **and** the audit row in one transaction. It is idempotent on a
transition key — and the same key asking for a *different* target is a
`key_conflict`, not a silent duplicate. It returns
`applied | duplicate | forbidden | not_found | key_conflict` rather than raising —
an exception would roll back the caller's own bookkeeping.

**4. Intent is recorded before the side effect.**
`screening → kyc_pending` is written *before* the KYC provider is called. If
the process dies mid-call, the application is findable; a request we never
recorded making is the one nobody ever retries.

**5. `approved` has no way back.**
The only transition out of `approved` is `account_opened`. KYC approval is a
durable, audited fact; undoing it is a new case with its own record, not a
silent `UPDATE`. This is also what makes late and replayed provider callbacks
harmless — a decided application has no transition they could take, so the
database answers `forbidden` and the callback is simply acknowledged. When core
banking is unavailable *after* approval, the compensation is retry and an ops
queue — **not** un-approving the customer (the non-interrupting boundary event
on `Task_OpenAccount`).

**6. Human review is a control, not a fallback — and maker–checker is enforced, not described.**
A sanctions hit, unavailable screening, a provider `REFER` and an exhausted
reconciliation all land in `app.review_task`. The task is opened **by the
transition function** whenever an application enters `kyc_review`, so no
workflow branch can forget it, and there is at most one open task per
application. The only way out of review is two calls by two people:
`app.propose_review(task, maker, outcome, note)` then
`app.decide_review(task, checker)`. Both belong to a separate `review_app` role
that the orchestrator does not have; `decide_review` refuses a missing proposal
or a checker who is the maker, and the table's
`check (checker_id is null or (maker_id is not null and checker_id <> maker_id))`
backs that up. A decided task is closed, so the next trip into review opens a
fresh one. And a reviewer can clear a *concern*, not skip the *check*: "approve"
only approves when the provider ran a check and said `REFER`. A case raised
before KYC — a sanctions false positive, screening down — or with an unknown
KYC outcome goes on to KYC instead.

**7. KYC happens in rounds.**
One round is one check at the provider: idempotency key `<id>:kyc:<round>`,
client reference `<id>:<round>`. "More info" (or approving a case that never
reached KYC) starts a new round — attempts reset, provider reference cleared.
A late callback from an earlier round can never decide the current one: an old
`CLEAR` is recorded and ignored, but an old `DECLINE` or `REFER` is a signal
about the same person, so it moves the application to review. A scheduled step
submits any `kyc_pending` application that has no provider reference after a
2-minute lease (at most 5 times per stay), which also recovers a crash between
recording `kyc_pending` and the provider call: same round, same key, so the
provider de-duplicates. The callback SLA runs from when `kyc_pending` began,
so those re-submits can never starve it. Reconciler transition keys
carry the state version, so the same provider answer seen on a later trip is
applied, not mistaken for a duplicate.

**8. Internal states never leave the bank.**
Telling an applicant `kyc_review` after a sanctions hit is tipping-off. The API
answers with a coarse public status — `received | in_progress | approved |
declined | expired` — and the submit webhook requires an API key (n8n header
auth). Put it behind your gateway as well.

---

## Webhook hardening (`Verify HMAC (raw body)`)

Four separate concerns, all mandatory, in this order:

1. **Verify over the raw bytes, before parsing.** The callback webhook runs with
   `rawBody: true`, which keeps the exact bytes as binary `data` — `json.body` is
   already a parse. Re-serialising a parse changes bytes and the signature will
   never match, and "fixing" that by trusting the parse means no signature check
   at all. (`tests/workflow.test.mjs` signs a body with spaces in it to prove the
   raw bytes are what's verified.)
2. **Constant-time compare** (`crypto.timingSafeEqual`, with a length check first,
   because it throws on mismatched lengths).
3. **Timestamp tolerance** (±300 s) so a captured payload cannot replay forever.
4. **Only then** read the contents.

Delivery is at-least-once and unordered, so on top of the signature:
`app.apply_provider_event` records the event **and** applies its decision in one
transaction, keyed on the provider's `event_id`. If applying fails, nothing is
recorded, so the provider's redelivery is processed rather than dropped as
"already seen"; a genuine duplicate is acknowledged without touching state.
Only `CLEAR`, `DECLINE` and `REFER` move state — lifecycle events
(`check.started`, …) are recorded and acknowledged. `sequence_no` is recorded
for audit; ordering safety comes from the transition table (decision 5), not
from comparing sequence numbers.

---

## Idempotency, precisely

The submit key is derived from the **business event** — `customer + product` —
never from the attempt. If the client omits `Idempotency-Key`, the workflow
derives `sha256(customer_external_ref:product_code)`, so a client that forgets
the header still cannot create duplicates.

Same key with a **different** payload returns **409**. Silently returning the
original would hide a client bug, or an attempt to swap the applicant behind a
key that is already known. The fingerprint is a SHA-256 of the request with keys
sorted at every depth — sorting only the top level, or using
`JSON.stringify`'s replacer array (which also filters nested keys), would
fingerprint every applicant as `{}` and the 409 would never fire.

`app.submit_application` does find-or-create in one statement
(`ON CONFLICT (idempotency_key) DO UPDATE … RETURNING (xmax = 0)`), so two
concurrent submits produce one application and both callers get it back. It
returns one of:

| outcome | HTTP | meaning |
|---|---|---|
| `created` | 201 | new application; response carries the public status it reached |
| `replay` | 200 | same key, same payload — current public status, process **not** restarted |
| `key_conflict` | 409 | same key, different payload |
| `already_open` | 409 | a live application already exists for this customer + product under another key |

A rejected applicant who reapplies is a new business event: the client must send
a new `Idempotency-Key` (the derived key would replay the rejected application).

Malformed input is a **400** and creates nothing. Business ineligibility (under
18, unsupported country) creates the application and rejects it with a reason —
a decline is an audited state, not a lost HTTP error.

---

## Tests

```bash
npm install
npm test      # 55 tests, ~75 s — no database server or n8n needed
```

- `schema.test.mjs` — the orchestrator role cannot read or write any table;
  submit outcomes; illegal transitions refused; approval irreversible; one open
  review task; the orchestrator cannot act as a reviewer; propose + decide by
  two different people (and not one); a closed task makes way for a new one;
  transition-key conflicts; "approve" on a provider REFER approves, on anything
  else starts a new KYC round; `kyc_unknown` scheduled, claimed when due, backed
  off; provider events recorded and applied together.
- `workflow.test.mjs` — loads `workflow.n8n.json` and executes it node by node:
  happy path to `approved`; replay; 409 on a swapped applicant; derived key;
  `already_open`; 400; ineligible; sanctions hit (KYC never called); screening
  down or timing out; provider 5xx and a real (thrown) timeout; no internal
  state in responses; replayed, late and lifecycle callbacks; an unusable
  `client_reference`; tampered / stale / wrong-secret / missing-secret
  signatures; raw-bytes verification; the reconciler handling found,
  still-running and never-received applications in one pass with the same
  idempotency key; budget exhausted while still processing, or left at the
  limit after a crash; callback SLA; KYC rounds — reviewer approval of a
  pre-KYC case submits a new round, "more info" after a REFER or an exhausted
  budget is resubmitted and decided only by its own round, a stale round's
  CLEAR changes nothing while its DECLINE escalates to review, a crash mid-call
  is recovered with the same key, re-submits are capped and cannot starve the SLA;
  separate screening and KYC credentials.

`harness.mjs` is a small interpreter for exactly the node types this workflow
uses (Code, IF, Postgres, HTTP Request, Respond to Webhook), including n8n's
rule that a thrown HTTP error stops the execution unless the node continues on
error. It runs the workflow's own SQL and JavaScript, so a red test means the
shipped workflow is wrong — but it is not n8n, and it does not prove
n8n-specific behaviour such as retries, credentials or execution settings.

---

## Running it in n8n

```bash
psql "$DATABASE_URL" -f schema.sql
psql "$DATABASE_URL" -c "create role onboarding_app login password '…'; grant service_role to onboarding_app;"
psql "$DATABASE_URL" -c "create role review_tool login password '…'; grant review_app to review_tool;"
```

Then in n8n: **Import from file → `workflow.n8n.json`**, and

- create a Postgres credential that logs in as `onboarding_app`, and HTTP
  Header Auth credentials for the KYC provider, the screening service, and
  clients calling the submit webhook (`X-Api-Key`); assign them where the nodes
  say `REPLACE_ME`;
- set `KYC_PROVIDER_URL`, `SCREENING_URL`, `KYC_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`;
- allow the Code nodes what they use: `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, and
  `$env` access (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`) — or move the secret into
  a credential if your instance blocks environment access.

Postman: import the collection, set `baseUrl` and `webhookSecret`, run in order.
Requests 3, 6 and 7 are the ones to run first: a green happy path proves very
little; a 409 on key reuse and a 401 on a tampered body prove the controls exist.

---

## What this deliberately does not do

- **No ledger.** Onboarding does not move money, so there is nothing to
  double-entry here. A payment flow would need one, and a status column would
  not be a substitute.
- **PII still crosses the orchestrator.** The applicant is sent to the screening
  service from the workflow, and n8n retains execution payloads — for a bank,
  pass applicant data by reference and shorten execution retention.
- **No account opening or review UI.** The BPMN models them; the workflow stops
  at the decision, and the review tool is whatever calls `propose_review` /
  `decide_review`.
- **Retries cover transport errors only.** HTTP nodes return non-2xx responses
  as data (`neverError`), so `retryOnFail` retries timeouts and resets, not a
  503 — one screening blip sends the applicant to review (the safe direction).
- **Submit is synchronous.** Screening and the KYC call happen before the
  response; a production API would accept with 202 and continue asynchronously.
- **Not yet:** matching a callback's `check_id` to the stored `provider_ref`
  (the round in the client reference covers the stale-check case), webhook-secret
  rotation, and alerting on acknowledged-but-unknown references.
- **Not tuned for scale.** The reconciler claims 25 rows per pass with
  `FOR UPDATE SKIP LOCKED`; the shape is right, the numbers are illustrative.
