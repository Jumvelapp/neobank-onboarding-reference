// The n8n workflow, executed node by node (see harness.mjs) against a real
// Postgres with a stubbed screening service and KYC provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { workflow, freshDb, asAdmin, run } from './harness.mjs'

const SECRET = 'test-webhook-secret'
const env = { KYC_WEBHOOK_SECRET: SECRET, KYC_PROVIDER_URL: 'https://kyc.test', SCREENING_URL: 'https://screen.test', PUBLIC_BASE_URL: 'https://bank.test' }

const applicant = (over = {}) => ({ given_name: 'Jonas', family_name: 'Petraitis', date_of_birth: '1991-04-17', country: 'LT', ...over })
const submitItem = (body, headers = {}) => [{ json: { headers, body } }]
const clear = () => ({ statusCode: 200, body: { matches: [] } })
const accepted = (id = 'chk-1') => () => ({ statusCode: 201, body: { id } })
const submit = (db, body, { headers, http } = {}) => run('Webhook: Submit application', submitItem(body, headers), {
  db, env,
  http: { 'Sanctions / PEP screening': clear, 'Submit to KYC provider': accepted(), ...http },
})

function signed(payload, { secret = SECRET, ts = Math.floor(Date.now() / 1000), tamper } = {}) {
  const raw = Buffer.from(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest('hex')
  const sent = tamper ? Buffer.from(JSON.stringify({ ...payload, ...tamper })) : raw
  return [{ json: { headers: { 'x-provider-signature': sig, 'x-provider-timestamp': String(ts) }, body: JSON.parse(sent) },
            binary: { data: { buffer: sent } } }]
}
const callback = (db, items) => run('Webhook: KYC callback', items, { db, env })
const appRow = async (db, id) => (await asAdmin(db, 'select * from app.application where id=$1', [id]))[0]

// ---------------------------------------------------------------- structure
test('structure: every connection points at a real node, and every node is reachable', () => {
  const names = new Set(workflow.nodes.map((n) => n.name))
  const reached = new Set()
  const walk = (n) => {
    if (reached.has(n)) return
    reached.add(n)
    for (const out of workflow.connections[n]?.main ?? []) for (const t of out) {
      assert.ok(names.has(t.node), `connection to missing node "${t.node}"`)
      walk(t.node)
    }
  }
  workflow.nodes.filter((n) => /webhook$|scheduleTrigger$/.test(n.type)).forEach((n) => walk(n.name))
  assert.deepEqual([...names].filter((n) => !reached.has(n)), [])
})

test('structure: the workflow never writes tables — Postgres nodes only call app.* functions', () => {
  for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
    const sql = n.parameters.query.replace(/--.*$/gm, '')
    assert.doesNotMatch(sql, /\b(insert|update|delete)\b/i, n.name)
    assert.match(sql, /\bapp\.\w+\(/, n.name)
    const used = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))
    const given = (n.parameters.options?.queryReplacement ?? '').match(/^=\{\{\s*\[/) ? 'array' : 'none'
    assert.ok(used === 0 || given === 'array', `${n.name}: ${used} parameters need an array expression`)
  }
})

// ---------------------------------------------------------------- submit
test('happy path: submit → screened → sent to KYC → signed CLEAR → approved', async () => {
  const db = await freshDb()
  const { response, calls } = await submit(db, { customer_external_ref: 'CUST-1', product_code: 'CURRENT_ACCOUNT_EUR', applicant: applicant() })
  assert.equal(response.status, 201)
  assert.equal(response.body.status, 'in_progress')
  const id = response.body.application_id
  assert.equal((await appRow(db, id)).state, 'kyc_pending')

  const kyc = calls.find((c) => c.node === 'Submit to KYC provider')
  assert.equal(kyc.headers['Idempotency-Key'], `${id}:kyc:1`)
  assert.equal(kyc.body.client_reference, `${id}:1`)
  assert.equal((await appRow(db, id)).provider_ref, 'chk-1')

  const cb = await callback(db, signed({ event_id: 'evt-1', check_id: 'chk-1', client_reference: id, sequence: 1, decision: 'CLEAR' }))
  assert.equal(cb.response.status, 200)
  assert.equal((await appRow(db, id)).state, 'approved')

  const states = await asAdmin(db, 'select to_state from app.application_event where application_id=$1 order by id', [id])
  assert.deepEqual(states.map((s) => s.to_state), ['submitted', 'screening', 'kyc_pending', 'approved'])
})

test('replay with the same key and body returns the application and does not restart it', async () => {
  const db = await freshDb()
  const body = { customer_external_ref: 'CUST-2', product_code: 'P', applicant: applicant() }
  const first = await submit(db, body, { headers: { 'idempotency-key': 'key-1' } })
  const second = await submit(db, body, { headers: { 'idempotency-key': 'key-1' } })
  assert.equal(second.response.status, 200)
  assert.equal(second.response.body.application_id, first.response.body.application_id)
  assert.equal(second.calls.length, 0, 'no screening or KYC call on a replay')
})

test('same key, different applicant → 409 (the fingerprint covers nested fields)', async () => {
  const db = await freshDb()
  await submit(db, { customer_external_ref: 'CUST-3', product_code: 'P', applicant: applicant() }, { headers: { 'idempotency-key': 'key-3' } })
  const swap = await submit(db, { customer_external_ref: 'CUST-3', product_code: 'P', applicant: applicant({ given_name: 'SOMEONE' }) },
    { headers: { 'idempotency-key': 'key-3' } })
  assert.equal(swap.response.status, 409)
  assert.equal(swap.response.body.error, 'idempotency_key_reuse_with_different_payload')
})

test('no Idempotency-Key header: the derived key still prevents a duplicate', async () => {
  const db = await freshDb()
  const body = { customer_external_ref: 'CUST-4', product_code: 'P', applicant: applicant() }
  const a = await submit(db, body)
  const b = await submit(db, body)
  assert.equal(b.response.status, 200)
  assert.equal(b.response.body.application_id, a.response.body.application_id)
})

test('a second key for a customer who already has a live application → 409', async () => {
  const db = await freshDb()
  await submit(db, { customer_external_ref: 'CUST-5', product_code: 'P', applicant: applicant() }, { headers: { 'idempotency-key': 'a' } })
  const other = await submit(db, { customer_external_ref: 'CUST-5', product_code: 'P', applicant: applicant() }, { headers: { 'idempotency-key': 'b' } })
  assert.equal(other.response.status, 409)
  assert.equal(other.response.body.error, 'application_already_open')
})

test('malformed input → 400 and nothing is stored', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'CUST-6', product_code: 'P', applicant: { given_name: 'X' } })
  assert.equal(response.status, 400)
  assert.equal((await asAdmin(db, 'select count(*)::int n from app.application'))[0].n, 0)
})

test('ineligible applicant → audited rejection, no screening or KYC call', async () => {
  const db = await freshDb()
  const { response, calls } = await submit(db, { customer_external_ref: 'CUST-7', product_code: 'P', applicant: applicant({ date_of_birth: '2015-01-01' }) })
  assert.equal(response.status, 201)
  assert.equal(response.body.status, 'declined')
  assert.equal((await appRow(db, response.body.application_id)).reject_reason, 'under_18')
  assert.equal(calls.length, 0)
})

test('sanctions hit → human review, and the KYC provider is never called', async () => {
  const db = await freshDb()
  const { response, calls } = await submit(db, { customer_external_ref: 'CUST-8', product_code: 'P', applicant: applicant() },
    { http: { 'Sanctions / PEP screening': () => ({ statusCode: 200, body: { matches: [{ list: 'EU' }] } }) } })
  assert.equal((await appRow(db, response.body.application_id)).state, 'kyc_review')
  assert.ok(!calls.some((c) => c.node === 'Submit to KYC provider'))
  const tasks = await asAdmin(db, 'select raised_reason from app.review_task where application_id=$1', [response.body.application_id])
  assert.deepEqual(tasks.map((t) => t.raised_reason), ['sanctions_hit'])
})

test('screening unavailable is not a rejection → review', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'CUST-9', product_code: 'P', applicant: applicant() },
    { http: { 'Sanctions / PEP screening': () => ({ statusCode: 503 }) } })
  assert.equal((await appRow(db, response.body.application_id)).state, 'kyc_review')
})

test('provider timeout → kyc_unknown (never rejected), scheduled for reconciliation', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'CUST-10', product_code: 'P', applicant: applicant() },
    { http: { 'Submit to KYC provider': () => ({ statusCode: 0 }) } })
  const row = await appRow(db, response.body.application_id)
  assert.equal(row.state, 'kyc_unknown')
  assert.ok(row.next_attempt_at)
  assert.equal(row.reject_reason, null)
})

// ---------------------------------------------------------------- callback
test('callback: replayed event is acknowledged and applied once', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'CUST-11', product_code: 'P', applicant: applicant() })
  const id = response.body.application_id
  const evt = signed({ event_id: 'evt-11', check_id: 'chk-1', client_reference: id, decision: 'CLEAR' })
  await callback(db, evt)
  const again = await callback(db, evt)
  assert.equal(again.response.status, 200)
  const n = await asAdmin(db, "select count(*)::int n from app.application_event where application_id=$1 and to_state='approved'", [id])
  assert.equal(n[0].n, 1)
})

test('callback: a late DECLINE after approval is acknowledged and changes nothing', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'CUST-12', product_code: 'P', applicant: applicant() })
  const id = response.body.application_id
  await callback(db, signed({ event_id: 'evt-a', check_id: 'chk-1', client_reference: id, sequence: 2, decision: 'CLEAR' }))
  const late = await callback(db, signed({ event_id: 'evt-b', check_id: 'chk-1', client_reference: id, sequence: 1, decision: 'DECLINE' }))
  assert.equal(late.response.status, 200)
  assert.equal((await appRow(db, id)).state, 'approved')
})

test('callback: tampered body, stale timestamp, wrong secret and missing secret are all 401', async () => {
  const db = await freshDb()
  const payload = { event_id: 'evt-x', check_id: 'c', client_reference: '00000000-0000-0000-0000-000000000000', decision: 'CLEAR' }
  const cases = [
    [signed(payload, { tamper: { decision: 'CLEAR', extra: 1 } }), 'bad_signature', env],
    [signed(payload, { ts: Math.floor(Date.now() / 1000) - 3600 }), 'timestamp_outside_tolerance', env],
    [signed(payload, { secret: 'not-the-secret' }), 'bad_signature', env],
    [signed(payload), 'server_misconfigured_no_secret', { ...env, KYC_WEBHOOK_SECRET: '' }],
  ]
  for (const [items, reason, e] of cases) {
    const { response } = await run('Webhook: KYC callback', items, { db, env: e })
    assert.equal(response.status, 401, reason)
    assert.equal(response.body.reason, reason)
  }
  assert.equal((await asAdmin(db, 'select count(*)::int n from app.provider_event'))[0].n, 0, 'nothing recorded from a rejected call')
})

test('callback: the signature is checked over the raw bytes, not a re-serialised parse', async () => {
  const db = await freshDb()
  const { response: sub } = await submit(db, { customer_external_ref: 'CUST-13', product_code: 'P', applicant: applicant() })
  const id = sub.body.application_id
  // Provider formats its JSON with spaces; JSON.stringify(JSON.parse(raw)) would not reproduce these bytes.
  const raw = Buffer.from(`{ "event_id": "evt-13", "check_id": "chk-1", "client_reference": "${id}", "decision": "CLEAR" }`)
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest('hex')
  const { response } = await callback(db, [{ json: { headers: { 'x-provider-signature': sig, 'x-provider-timestamp': String(ts) }, body: JSON.parse(raw) },
    binary: { data: { buffer: raw } } }])
  assert.equal(response.status, 200)
  assert.equal((await appRow(db, id)).state, 'approved')
})

// ---------------------------------------------------------------- reconcile
async function unknownApp(db, ref) {
  const { response } = await submit(db, { customer_external_ref: ref, product_code: 'P', applicant: applicant() },
    { http: { 'Submit to KYC provider': () => ({ statusCode: 504 }) } })
  return response.body.application_id
}
const makeDue = (db) => asAdmin(db, "update app.application set next_attempt_at = now() - interval '1 second' where state = 'kyc_unknown'")

test('reconcile: every claimed application is handled — found, still running, never received', async () => {
  const db = await freshDb()
  const done = await unknownApp(db, 'R-1')
  const running = await unknownApp(db, 'R-2')
  const lost = await unknownApp(db, 'R-3')
  await makeDue(db)

  const provider = {
    [done]: { data: [{ id: 'chk-d', status: 'complete', result: 'CLEAR' }] },
    [running]: { data: [{ id: 'chk-r', status: 'processing' }] },
    [lost]: { data: [] },
  }
  const { calls } = await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env,
    http: {
      'Query provider by our ref': (req) => ({ statusCode: 200, body: provider[new URL(req.url).searchParams.get('client_reference').split(':')[0]] }),
      'Resubmit to KYC (same key)': () => ({ statusCode: 201, body: { id: 'chk-new' } }),
    },
  })

  assert.equal((await appRow(db, done)).state, 'approved')
  assert.equal((await appRow(db, running)).state, 'kyc_unknown')
  const relost = await appRow(db, lost)
  assert.equal(relost.state, 'kyc_pending')
  assert.equal(relost.provider_ref, 'chk-new')

  const resubmits = calls.filter((c) => c.node === 'Resubmit to KYC (same key)')
  assert.equal(resubmits.length, 1, 'only the never-received application is resubmitted')
  assert.equal(resubmits[0].headers['Idempotency-Key'], `${lost}:kyc:1`, 'same idempotency key as the original submit')
})

test('reconcile: a resubmit that times out again goes back to kyc_unknown', async () => {
  const db = await freshDb()
  const id = await unknownApp(db, 'R-4')
  await makeDue(db)
  await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env,
    http: {
      'Query provider by our ref': () => ({ statusCode: 200, body: { data: [] } }),
      'Resubmit to KYC (same key)': () => ({ statusCode: 0 }),
    },
  })
  assert.equal((await appRow(db, id)).state, 'kyc_unknown')
})

test('reconcile: budget exhausted → human review, never rejected', async () => {
  const db = await freshDb()
  const id = await unknownApp(db, 'R-5')
  await asAdmin(db, "update app.application set kyc_attempts = 7, next_attempt_at = now() - interval '1 second' where id=$1", [id])
  await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env, http: { 'Query provider by our ref': () => ({ statusCode: 503 }) },
  })
  assert.equal((await appRow(db, id)).state, 'kyc_review')
  const tasks = await asAdmin(db, 'select raised_reason from app.review_task where application_id=$1', [id])
  assert.deepEqual(tasks.map((t) => t.raised_reason), ['reconcile_exhausted'])
})

test('reconcile: no callback within the SLA → kyc_unknown, then the provider is asked directly', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'R-6', product_code: 'P', applicant: applicant() })
  const id = response.body.application_id
  assert.equal((await appRow(db, id)).state, 'kyc_pending')
  await asAdmin(db, "update app.application set pending_since = now() - interval '7 hours' where id=$1", [id])

  const http = { 'Query provider by our ref': () => ({ statusCode: 200, body: { data: [{ id: 'chk-1', status: 'complete', result: 'CLEAR' }] } }) }
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http })
  assert.equal((await appRow(db, id)).state, 'kyc_unknown', 'SLA breach is an unknown, not a decision')

  await makeDue(db)
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http })
  assert.equal((await appRow(db, id)).state, 'approved')
})

test('reconcile: an application still inside the SLA is left alone', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'R-7', product_code: 'P', applicant: applicant() })
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: {} })
  assert.equal((await appRow(db, response.body.application_id)).state, 'kyc_pending')
})

// ---------------------------------------------------------------- review 2026-10-12 (architect findings)
const timeout = () => { throw new Error('ETIMEDOUT') }

test('structure: every HTTP node continues on error, so a timeout reaches the classifier', () => {
  for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
    assert.equal(n.onError, 'continueRegularOutput', n.name)
  }
})

test('structure: the submit webhook requires authentication', () => {
  const wh = workflow.nodes.find((n) => n.name === 'Webhook: Submit application')
  assert.equal(wh.parameters.authentication, 'headerAuth')
})

test('a real timeout (thrown, not a status code) → kyc_unknown', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'T-1', product_code: 'P', applicant: applicant() },
    { http: { 'Submit to KYC provider': timeout } })
  const id = response.body.application_id
  assert.equal((await appRow(db, id)).state, 'kyc_unknown')
})

test('screening timeout → review, never a decision', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'T-2', product_code: 'P', applicant: applicant() },
    { http: { 'Sanctions / PEP screening': timeout } })
  assert.equal((await appRow(db, response.body.application_id)).state, 'kyc_review')
})

test('responses never expose internal compliance states (no tipping-off)', async () => {
  const db = await freshDb()
  const hit = await submit(db, { customer_external_ref: 'T-3', product_code: 'P', applicant: applicant() },
    { http: { 'Sanctions / PEP screening': () => ({ statusCode: 200, body: { matches: [{ list: 'EU' }] } }) } })
  assert.equal(hit.response.body.state, undefined)
  assert.equal(hit.response.body.status, 'in_progress')
  const replay = await submit(db, { customer_external_ref: 'T-3', product_code: 'P', applicant: applicant() })
  assert.equal(replay.response.body.status, 'in_progress')
  assert.ok(!JSON.stringify(replay.response.body).includes('kyc_'))
})

test('reconcile: still processing on the last attempt → review, not stuck', async () => {
  const db = await freshDb()
  const id = await unknownApp(db, 'T-4')
  await asAdmin(db, "update app.application set kyc_attempts = 7, next_attempt_at = now() - interval '1 second' where id=$1", [id])
  await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env, http: { 'Query provider by our ref': () => ({ statusCode: 200, body: { data: [{ id: 'c', status: 'processing' }] } }) },
  })
  assert.equal((await appRow(db, id)).state, 'kyc_review')
})

test('reconcile: an application left at the attempt limit (e.g. after a crash) is still claimed and reviewed', async () => {
  const db = await freshDb()
  const id = await unknownApp(db, 'T-5')
  await asAdmin(db, "update app.application set kyc_attempts = 8, next_attempt_at = now() - interval '1 second' where id=$1", [id])
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: { 'Query provider by our ref': timeout } })
  assert.equal((await appRow(db, id)).state, 'kyc_review')
})

test('callback: a lifecycle event without a decision is acknowledged and changes nothing', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'T-6', product_code: 'P', applicant: applicant() })
  const id = response.body.application_id
  const cb = await callback(db, signed({ event_id: 'evt-started', check_id: 'chk-1', client_reference: id, event_type: 'check.started' }))
  assert.equal(cb.response.status, 200)
  assert.equal((await appRow(db, id)).state, 'kyc_pending')
  assert.equal((await asAdmin(db, 'select count(*)::int n from app.review_task where application_id=$1', [id]))[0].n, 0)
})

test('callback: an unusable client_reference is acknowledged, not crashed on', async () => {
  const db = await freshDb()
  const cb = await callback(db, signed({ event_id: 'evt-bad', check_id: 'c', client_reference: 'not-a-uuid', decision: 'CLEAR' }))
  assert.equal(cb.response.status, 200)
})

test('structure: the callback records and applies the event in one database call', () => {
  const pgNames = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres').map((n) => n.parameters.query)
  assert.ok(pgNames.some((q) => /app\.apply_provider_event\(/.test(q)))
  assert.ok(!pgNames.some((q) => /app\.record_provider_event\(/.test(q)), 'no separate "seen" step before applying')
})

// ---------------------------------------------------------------- re-review 2026-10-12: KYC rounds
const asReview = async (db, sql, p = []) => { await db.exec('set role review_app'); try { return (await db.query(sql, p)).rows } finally { await db.exec('reset role') } }
async function decide(db, id, outcome) {
  const [t] = await asAdmin(db, 'select id from app.review_task where application_id=$1 and checker_at is null', [id])
  await asReview(db, 'select * from app.propose_review($1,$2,$3,$4)', [t.id, 'alice', outcome, 'note'])
  return (await asReview(db, 'select * from app.decide_review($1,$2)', [t.id, 'bob']))[0]
}
const age = (db, id, interval) => asAdmin(db, `update app.application set updated_at = now() - interval '${interval}' where id=$1`, [id])
const submitted = (calls) => calls.filter((c) => c.node === 'Submit pending KYC round')

test('approving a review that was raised BEFORE any KYC check starts KYC — it never approves blind', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'K-1', product_code: 'P', applicant: applicant() },
    { http: { 'Sanctions / PEP screening': () => ({ statusCode: 200, body: { matches: [{ list: 'EU', false_positive: true }] } }) } })
  const id = response.body.application_id
  const d = await decide(db, id, 'approve')
  assert.equal(d.state, 'kyc_pending')
  const row = await appRow(db, id)
  assert.deepEqual([row.state, row.kyc_round, row.provider_ref], ['kyc_pending', 2, null])

  await age(db, id, '3 minutes')
  const { calls } = await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env, http: { 'Submit pending KYC round': () => ({ statusCode: 201, body: { id: 'chk-r2' } }) },
  })
  const sent = submitted(calls)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers['Idempotency-Key'], `${id}:kyc:2`)
  assert.equal(sent[0].body.client_reference, `${id}:2`)
  assert.equal((await appRow(db, id)).provider_ref, 'chk-r2')
})

test('more info after a REFER: a new round is submitted, and only its decision counts', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'K-2', product_code: 'P', applicant: applicant() })
  const id = response.body.application_id
  await callback(db, signed({ event_id: 'r1-refer', check_id: 'chk-1', client_reference: `${id}:1`, decision: 'REFER' }))
  assert.equal((await appRow(db, id)).state, 'kyc_review')

  assert.equal((await decide(db, id, 'request_more_info')).state, 'kyc_pending')
  await age(db, id, '3 minutes')
  await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env, http: { 'Submit pending KYC round': () => ({ statusCode: 201, body: { id: 'chk-2' } }) },
  })

  // A late (benign) callback from round 1 must not decide round 2.
  // (An adverse one escalates to a human — see the earlier-round test below.)
  await callback(db, signed({ event_id: 'r1-late', check_id: 'chk-1', client_reference: `${id}:1`, decision: 'CLEAR' }))
  assert.equal((await appRow(db, id)).state, 'kyc_pending')

  await callback(db, signed({ event_id: 'r2-clear', check_id: 'chk-2', client_reference: `${id}:2`, decision: 'CLEAR' }))
  assert.equal((await appRow(db, id)).state, 'approved')
})

test('more info after the reconcile budget ran out: attempts reset, new round submitted, nothing stuck', async () => {
  const db = await freshDb()
  const id = await unknownApp(db, 'K-3')
  await asAdmin(db, "update app.application set kyc_attempts = 7, next_attempt_at = now() - interval '1 second' where id=$1", [id])
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: { 'Query provider by our ref': () => ({ statusCode: 503 }) } })
  assert.equal((await appRow(db, id)).state, 'kyc_review')

  await decide(db, id, 'request_more_info')
  const row = await appRow(db, id)
  assert.deepEqual([row.state, row.kyc_round, row.kyc_attempts], ['kyc_pending', 2, 0])
  await age(db, id, '3 minutes')
  const { calls } = await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env, http: { 'Submit pending KYC round': () => ({ statusCode: 201, body: { id: 'chk-3' } }) },
  })
  assert.equal(submitted(calls).length, 1)
  assert.equal((await appRow(db, id)).provider_ref, 'chk-3')
})

test('reconcile keys are per state version: a second trip through the same branch is applied, not "duplicate"', async () => {
  const db = await freshDb()
  const id = await unknownApp(db, 'K-4')
  const refer = { 'Query provider by our ref': () => ({ statusCode: 200, body: { data: [{ id: 'chk-x', status: 'complete', result: 'REFER' }] } }) }
  await makeDue(db)
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: refer })
  assert.equal((await appRow(db, id)).state, 'kyc_review')
  await decide(db, id, 'request_more_info')
  await age(db, id, '3 minutes')
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: { 'Submit pending KYC round': () => ({ statusCode: 504 }) } })
  assert.equal((await appRow(db, id)).state, 'kyc_unknown')
  await makeDue(db)
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: refer })
  assert.equal((await appRow(db, id)).state, 'kyc_review', 'same provider answer, new version → applied again')
})

test('a crash between recording kyc_pending and the provider call is recovered with the SAME round key', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'K-5', product_code: 'P', applicant: applicant() },
    { http: { 'Submit to KYC provider': () => ({ statusCode: 201, body: {} }) } })   // 2xx but no id: as if we never got the ref
  const id = response.body.application_id
  assert.equal((await appRow(db, id)).provider_ref, null)
  await age(db, id, '3 minutes')
  const { calls } = await run('Every 5 min: reconcile', [{ json: {} }], {
    db, env, http: { 'Submit pending KYC round': () => ({ statusCode: 200, body: { id: 'chk-dedup' } }) },
  })
  assert.equal(submitted(calls)[0].headers['Idempotency-Key'], `${id}:kyc:1`, 'same key → the provider de-duplicates')
  assert.equal((await appRow(db, id)).provider_ref, 'chk-dedup')
})

test('a fresh kyc_pending (inside the lease) is not resubmitted', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'K-6', product_code: 'P', applicant: applicant() },
    { http: { 'Submit to KYC provider': () => ({ statusCode: 201, body: {} }) } })
  const { calls } = await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: {} })
  assert.equal(submitted(calls).length, 0)
  assert.ok(response.body.application_id)
})

test('structure: screening and KYC use separate credentials', () => {
  const cred = (name) => workflow.nodes.find((n) => n.name === name).credentials.httpHeaderAuth.name
  assert.notEqual(cred('Sanctions / PEP screening'), cred('Submit to KYC provider'))
})

// ---------------------------------------------------------------- third review 2026-10-12
test('a DECLINE from an earlier round reaches a human; an old CLEAR changes nothing', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'S-1', product_code: 'P', applicant: applicant() })
  const id = response.body.application_id
  await callback(db, signed({ event_id: 's1-refer', check_id: 'chk-1', client_reference: `${id}:1`, decision: 'REFER' }))
  await decide(db, id, 'request_more_info')                       // round 2, kyc_pending
  await callback(db, signed({ event_id: 's1-old-clear', check_id: 'chk-1', client_reference: `${id}:1`, decision: 'CLEAR' }))
  assert.equal((await appRow(db, id)).state, 'kyc_pending')
  await callback(db, signed({ event_id: 's1-old-decline', check_id: 'chk-1', client_reference: `${id}:1`, decision: 'DECLINE' }))
  assert.equal((await appRow(db, id)).state, 'kyc_review')
  const tasks = await asAdmin(db, 'select raised_reason from app.review_task where application_id=$1 and checker_at is null', [id])
  assert.deepEqual(tasks.map((t) => t.raised_reason), ['earlier_round_DECLINE'])
})

test('the callback SLA runs from entering kyc_pending — pending re-submits cannot starve it', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'S-2', product_code: 'P', applicant: applicant() },
    { http: { 'Submit to KYC provider': () => ({ statusCode: 202, body: { check_id: 'no-id-field' } }) } })
  const id = response.body.application_id
  await asAdmin(db, "update app.application set pending_since = now() - interval '7 hours', updated_at = now() - interval '3 minutes' where id=$1", [id])
  await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: { 'Submit pending KYC round': () => ({ statusCode: 202, body: {} }) } })
  assert.equal((await appRow(db, id)).state, 'kyc_unknown')
})

test('pending re-submits are capped', async () => {
  const db = await freshDb()
  const { response } = await submit(db, { customer_external_ref: 'S-3', product_code: 'P', applicant: applicant() },
    { http: { 'Submit to KYC provider': () => ({ statusCode: 202, body: {} }) } })
  const id = response.body.application_id
  let sent = 0
  for (let i = 0; i < 8; i++) {
    await age(db, id, '3 minutes')
    const { calls } = await run('Every 5 min: reconcile', [{ json: {} }], { db, env, http: { 'Submit pending KYC round': () => ({ statusCode: 202, body: {} }) } })
    sent += submitted(calls).length
  }
  assert.equal(sent, 5)
})
