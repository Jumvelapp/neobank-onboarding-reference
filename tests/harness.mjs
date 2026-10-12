// A deliberately small n8n interpreter: just enough to execute workflow.n8n.json
// node by node — Code, IF, Postgres, HTTP Request, Respond — against a real
// Postgres (PGlite) and a stubbed KYC provider. It runs the workflow's own SQL
// and JavaScript, so a test failure means the shipped workflow is wrong.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PGlite } from '@electric-sql/pglite'

const here = new URL('..', import.meta.url)
export const workflow = JSON.parse(readFileSync(new URL('workflow.n8n.json', here), 'utf8'))
export const schemaSql = readFileSync(new URL('schema.sql', here), 'utf8')
const require = createRequire(import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function freshDb() {
  const db = new PGlite()
  await db.exec(schemaSql)
  return db
}

// Superuser helpers for test setup/inspection (the workflow itself runs as service_role).
export async function asAdmin(db, sql, params = []) {
  await db.exec('reset role')
  return (await db.query(sql, params)).rows
}

// The orchestrator's view: only what service_role is granted.
export async function asService(db, sql, params = []) {
  await db.exec('set role service_role')
  try { return (await db.query(sql, params)).rows } finally { await db.exec('reset role') }
}

const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]))
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x)))

export async function run(start, startItems, { db, http = {}, env = {}, executionId = 'exec-1' }) {
  const runData = {}
  const calls = []
  let response = null
  const execution = { id: executionId }

  const accessor = (current) => (name) => ({
    first: () => {
      if (!runData[name]) throw new Error(`$('${name}') has not run`)
      return runData[name][0]
    },
    itemMatching: (i) => {
      const hit = current[i]?.lineage?.[name]
      if (!hit) throw new Error(`no paired item for $('${name}') at index ${i}`)
      return hit
    },
    get isExecuted() { return Boolean(runData[name]) },
  })

  const evaluate = (value, item, current) => {
    if (typeof value !== 'string' || !value.startsWith('=')) return value
    const tpl = value.slice(1)
    const exec = (expr) =>
      new Function('$json', '$env', '$execution', '$', `return (${expr})`)(item?.json ?? {}, env, execution, accessor(current))
    const whole = tpl.match(/^\{\{([\s\S]*)\}\}$/)
    if (whole && !whole[1].includes('}}')) return exec(whole[1])
    return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => String(exec(e)))
  }

  const withLineage = (name, json, from, extra = {}) => {
    const item = { json: plain(json), lineage: { ...(from?.lineage ?? {}) }, ...extra }
    item.lineage[name] = item
    return item
  }

  async function exec(name, input) {
    const n = byName[name]
    if (!n) throw new Error(`unknown node ${name}`)
    const p = n.parameters
    let outputs

    switch (n.type) {
      case 'n8n-nodes-base.webhook':
      case 'n8n-nodes-base.scheduleTrigger':
        outputs = [input.map((it) => withLineage(name, it.json, null, it.binary ? { binary: it.binary } : {}))]
        break

      case 'n8n-nodes-base.code': {
        const $input = { first: () => input[0], all: () => input, item: input[0] }
        const self = { helpers: { getBinaryDataBuffer: async (i, prop) => input[i].binary[prop].buffer } }
        const fn = new AsyncFunction('$input', '$', '$env', '$execution', 'require', p.jsCode)
        const result = (await fn.call(self, $input, accessor(input), env, execution, require)) ?? []
        outputs = [result.map((r, i) => {
          const from = typeof r.pairedItem === 'number' ? input[r.pairedItem]
            : result.length === input.length ? input[i] : input.length === 1 ? input[0] : null
          return withLineage(name, r.json, from)
        })]
        break
      }

      case 'n8n-nodes-base.if': {
        const t = [], f = []
        const c = p.conditions.conditions[0]
        input.forEach((it) => {
          const left = evaluate(c.leftValue, it, input)
          const right = evaluate(c.rightValue, it, input)
          ;(left === right ? t : f).push(withLineage(name, it.json, it))
        })
        outputs = [t, f]
        break
      }

      case 'n8n-nodes-base.postgres': {
        const out = []
        for (const it of input) {
          const params = p.options?.queryReplacement ? evaluate(p.options.queryReplacement, it, input) : []
          if (!Array.isArray(params)) throw new Error(`${name}: query parameters must be an array`)
          const rows = (await db.query(p.query, params)).rows
          rows.forEach((row) => out.push(withLineage(name, row, it)))
        }
        outputs = [out]
        break
      }

      case 'n8n-nodes-base.httpRequest': {
        const stub = http[name]
        if (!stub) throw new Error(`no HTTP stub for "${name}"`)
        const out = []
        for (const it of input) {
          const headers = Object.fromEntries((p.headerParameters?.parameters ?? [])
            .map((h) => [h.name, evaluate(h.value, it, input)]))
          const req = {
            method: p.method, url: evaluate(p.url, it, input), headers,
            body: p.jsonBody ? JSON.parse(evaluate(p.jsonBody, it, input)) : undefined,
          }
          calls.push({ node: name, ...req })
          let res
          try {
            res = await stub(req)
          } catch (err) {
            // n8n: a thrown error (timeout, reset) stops the execution unless the
            // node continues on error, in which case the item carries json.error.
            if (n.onError !== 'continueRegularOutput') throw err
            out.push(withLineage(name, { error: { message: err.message } }, it))
            continue
          }
          out.push(withLineage(name, { statusCode: res.statusCode, body: res.body ?? null, headers: {} }, it))
        }
        outputs = [out]
        break
      }

      case 'n8n-nodes-base.respondToWebhook': {
        const it = input[0]
        response = {
          status: Number(evaluate(p.options.responseCode, it, input)),
          body: JSON.parse(evaluate(p.responseBody, it, input)),
        }
        outputs = [[]]
        break
      }

      default:
        throw new Error(`node type not supported by the harness: ${n.type}`)
    }

    runData[name] = outputs[0]
    const targets = workflow.connections[name]?.main ?? []
    for (let o = 0; o < targets.length; o++) {
      const items = outputs[o] ?? []
      if (!items.length) continue
      for (const t of targets[o]) await exec(t.node, items)
    }
  }

  await db.exec('set role service_role')
  try {
    await exec(start, startItems)
  } finally {
    await db.exec('reset role')
  }
  return { response, runData, calls }
}
