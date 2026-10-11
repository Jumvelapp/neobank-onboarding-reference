// The database layer on its own: the rules that hold no matter which
// orchestrator calls them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, asAdmin, asService } from './harness.mjs'

const submit = (db, key, fp = 'fp1', cust = 'C1', product = 'P1') =>
  asService(db, 'select * from app.submit_application($1,$2,$3::jsonb,$4,$5)', [cust, product, '{}', key, fp])
    .then((r) => r[0])
const move = (db, id, to, key, actor = 'system') =>
  asService(db, 'select * from app.transition_application($1::uuid,null,$2::app.application_state,$3,null,$4,$5)',
    [id, to, actor, 'test', key]).then((r) => r[0])

test('the orchestrator role cannot touch tables, only call functions', async () => {
  const db = await freshDb()
  for (const sql of [
    "insert into app.application(customer_external_ref,product_code,idempotency_key,request_fingerprint) values('a','b','c','d')",
    "update app.application set state='approved'",
    'select * from app.application',
    "insert into app.review_task(application_id,raised_reason) values(gen_random_uuid(),'x')",
  ]) {
    await assert.rejects(asService(db, sql), /permission denied/, sql)
  }
})

test('submit: created, replay, key conflict, already open', async () => {
  const db = await freshDb()
  const a = await submit(db, 'k1')
  assert.equal(a.outcome, 'created')
  assert.equal(a.state, 'submitted')

  const replay = await submit(db, 'k1')
  assert.equal(replay.outcome, 'replay')
  assert.equal(replay.application_id, a.application_id)

  const conflict = await submit(db, 'k1', 'DIFFERENT')
  assert.equal(conflict.outcome, 'key_conflict')

  const open = await submit(db, 'k2')            // same customer + product, new key
  assert.equal(open.outcome, 'already_open')
  assert.equal(open.application_id, a.application_id)

  const [{ n }] = await asAdmin(db, 'select count(*)::int n from app.application')
  assert.equal(n, 1)
})

test('a rejected customer can reapply under a new key', async () => {
  const db = await freshDb()
  const a = await submit(db, 'k1')
  assert.equal((await move(db, a.application_id, 'rejected', 'r')).result, 'applied')
  const again = await submit(db, 'k2')
  assert.equal(again.outcome, 'created')
  assert.notEqual(again.application_id, a.application_id)
})

test('transitions follow the table; illegal ones are refused, not raised', async () => {
  const db = await freshDb()
  const { application_id: id } = await submit(db, 'k1')

  assert.equal((await move(db, id, 'kyc_pending', 't0')).result, 'forbidden')   // must screen first
  assert.equal((await move(db, id, 'screening', 't1')).result, 'applied')
  assert.equal((await move(db, id, 'kyc_pending', 't2')).result, 'applied')
  const approved = await move(db, id, 'approved', 't3')
  assert.deepEqual([approved.result, approved.state, approved.version], ['applied', 'approved', 3])

  // Replaying a transition key is a no-op that reports the current state.
  assert.equal((await move(db, id, 'approved', 't3')).result, 'duplicate')

  // Approval is durable: no path back.
  assert.equal((await move(db, id, 'rejected', 't4')).result, 'forbidden')
  assert.equal((await move(db, id, 'kyc_review', 't5')).result, 'forbidden')

  // A reviewer-only transition is refused for the system actor.
  const b = await submit(db, 'k9', 'fp', 'C2')
  await move(db, b.application_id, 'screening', 'b1')
  await move(db, b.application_id, 'kyc_review', 'b2')
  assert.equal((await move(db, b.application_id, 'approved', 'b3')).result, 'forbidden')
  assert.equal((await move(db, b.application_id, 'approved', 'b4', 'reviewer')).result, 'applied')

  const events = await asAdmin(db, 'select to_state from app.application_event where application_id=$1 order by id', [id])
  assert.deepEqual(events.map((e) => e.to_state), ['submitted', 'screening', 'kyc_pending', 'approved'])
})

test('entering kyc_review opens exactly one open review task', async () => {
  const db = await freshDb()
  const { application_id: id } = await submit(db, 'k1')
  await move(db, id, 'screening', 's')
  await move(db, id, 'kyc_review', 'r1')
  await move(db, id, 'kyc_pending', 'p', 'reviewer')
  await move(db, id, 'kyc_review', 'r2')          // back into review while the task is open
  const tasks = await asAdmin(db, 'select raised_reason from app.review_task where application_id=$1', [id])
  assert.equal(tasks.length, 1)
})

test('four eyes: the checker cannot be the maker', async () => {
  const db = await freshDb()
  const { application_id: id } = await submit(db, 'k1')
  await assert.rejects(
    asAdmin(db, "insert into app.review_task(application_id,raised_reason,maker_id,checker_id) values($1,'x','alice','alice')", [id]),
    /review_four_eyes/)
})

test('kyc_unknown is scheduled, claimed when due, and backed off', async () => {
  const db = await freshDb()
  const { application_id: id } = await submit(db, 'k1')
  await move(db, id, 'screening', 's')
  await move(db, id, 'kyc_pending', 'p')
  await move(db, id, 'kyc_unknown', 'u')

  const [row] = await asAdmin(db, 'select next_attempt_at from app.application where id=$1', [id])
  assert.ok(row.next_attempt_at, 'entering kyc_unknown must schedule the reconciler')

  assert.equal((await asService(db, 'select * from app.claim_unknown_applications(25)')).length, 0, 'not due yet')
  await asAdmin(db, "update app.application set next_attempt_at = now() - interval '1 second' where id=$1", [id])
  const claimed = await asService(db, 'select * from app.claim_unknown_applications(25)')
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].kyc_attempts, 1)
  assert.ok(new Date(claimed[0].next_attempt_at) > new Date(), 'claiming pushes the next attempt out')
  assert.equal((await asService(db, 'select * from app.claim_unknown_applications(25)')).length, 0, 'claimed rows are not re-claimed immediately')

  // Leaving kyc_unknown clears the schedule.
  await move(db, id, 'kyc_pending', 'rearm')
  const [after] = await asAdmin(db, 'select next_attempt_at from app.application where id=$1', [id])
  assert.equal(after.next_attempt_at, null)
})

test('provider events are de-duplicated atomically', async () => {
  const db = await freshDb()
  const rec = () => asService(db, 'select * from app.record_provider_event($1,$2,$3,$4::bigint,$5::jsonb)',
    ['evt-1', 'chk-1', 'CLEAR', null, '{}']).then((r) => r[0].is_new)
  assert.equal(await rec(), true)
  assert.equal(await rec(), false)
})
