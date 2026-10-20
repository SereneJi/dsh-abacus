/**
 * The plugin body itself: `lib/index.js`.
 *
 * Every other suite imports a piece (the ledger, the service, the routes, the
 * probe service, the browser artifact). This one imports the module the Host
 * actually loads, because that is the only place the pieces are wired to each
 * other — and a mistake there is invisible to all of them. It is also the
 * expensive kind of mistake: the host half needs a dsh restart to take effect,
 * so a wiring error costs the user a restart to discover.
 *
 * Nothing here touches the network or the real `$DSH_HOME`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-plugin-'))
process.env.DSH_HOME = HOME
after(() => rmSync(HOME, { recursive: true, force: true }))

const plugin = await import('../lib/index.js')

/** A host context with just enough surface for this plugin to mount. */
function createCtx() {
  const registered = []
  const listeners = []
  const effects = []
  return {
    registered,
    listeners,
    effects,
    ctx: {
      webServer: {
        register(route) {
          registered.push(route)
          return () => {
            route.disposed = true
          }
        },
      },
      on(event, handler) {
        listeners.push({ event, handler })
        return () => {}
      },
      effect(setup, label) {
        effects.push({ label, dispose: setup() })
        return () => {}
      },
      get(service) {
        if (service === 'credentials') return { readRecord: () => undefined, resolve: () => undefined }
        if (service === 'settings') return { get: () => undefined }
        return undefined
      },
    },
  }
}

test('the plugin body mounts a service, a probe service and nine routes', async () => {
  const { ctx, registered, listeners, effects } = createCtx()

  plugin.apply(ctx)

  assert.equal(plugin.name, 'dsh-abacus')
  assert.deepEqual(plugin.inject, ['webServer'], 'the host half needs the web server and nothing else')

  // One effect, and it is the runtime: everything else is created inside it, so
  // a fiber teardown disposes the whole plugin.
  assert.equal(effects.length, 1)
  assert.equal(effects[0].label, 'dsh-abacus: runtime')

  // The routes are the contract the browser half talks to. If one is missing the
  // client's tab shows an error, so the list is asserted by path.
  const paths = registered.map((route) => route.path)
  assert.deepEqual(paths.sort(), [
    '/api/abacus/backfill',
    '/api/abacus/config',
    '/api/abacus/day',
    '/api/abacus/overview',
    '/api/abacus/probe',
    '/api/abacus/providers',
    '/api/abacus/range',
    '/api/abacus/refresh',
    '/api/abacus/session',
  ])
  for (const route of registered) {
    assert.equal(typeof route.handler, 'function', `${route.path} has a handler`)
    assert.ok(route.kind === 'exact' || route.kind === 'prefix', `${route.path} declares a kind`)
  }

  // The ledger subscribes to the session event stream; that is its only source.
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'session/event')
  assert.equal(typeof listeners[0].handler, 'function')

  const stopping = effects[0].dispose()
  assert.ok(stopping instanceof Promise, 'the disposer hands back its final flush')
  await stopping
  assert.equal(existsSync(join(HOME, 'abacus')), true, 'the state directory is created on mount')
})

test('a second mount in the same process is refused rather than duplicated', async () => {
  // A duplicate mount would register the same exact route twice — a boot failure
  // — and fold every model call twice. The guard is keyed on a global symbol so
  // it holds across module instances.
  const first = createCtx()
  plugin.apply(first.ctx)
  const second = createCtx()
  plugin.apply(second.ctx)

  assert.equal(second.effects.length, 0, 'the guard short-circuits before any effect is created')
  assert.equal(second.registered.length, 0, 'and before any route is registered')

  await first.effects[0].dispose()
})

test('after a teardown the plugin can mount again', async () => {
  // A hot reload mounts the new fiber before the old one is disposed, so the
  // guard must be released on dispose — otherwise a reload leaves the plugin
  // permanently absent.
  const first = createCtx()
  plugin.apply(first.ctx)
  await first.effects[0].dispose()

  const second = createCtx()
  plugin.apply(second.ctx)

  assert.equal(second.effects.length, 1, 'the released guard lets a reload mount')
  assert.equal(second.registered.length, 9)
  await second.effects[0].dispose()
})
