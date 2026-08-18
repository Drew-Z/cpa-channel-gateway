import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientKey, hashClientKey, normalizeClientAccess, publicClientAccess, resolveClient } from '../src/client-access.mjs'

test('client keys resolve to one enabled non-overlapping channel group', () => {
  const issued = createClientKey()
  const access = normalizeClientAccess({
    schemaVersion: 1,
    groups: [{ id: 'enterprise', channels: ['free1', 'free2'], enabled: true }],
    clients: [{ id: 'doc-agent', group: 'enterprise', keyHash: issued.keyHash, keyHint: issued.keyHint, enabled: true }]
  }, ['free1', 'free2', 'free3'])

  const resolved = resolveClient(access, issued.key)
  assert.equal(resolved.clientId, 'doc-agent')
  assert.equal(resolved.groupId, 'enterprise')
  assert.deepEqual([...resolved.allowedChannels], ['free1', 'free2'])
  assert.equal(resolveClient(access, 'wrong-key'), null)
  assert.equal(publicClientAccess(access).clients[0].keyHash, undefined)
  assert.equal(hashClientKey(issued.key), issued.keyHash)
})

test('rejects enabled group overlap, unknown channels, and duplicate key hashes', () => {
  const hash = hashClientKey('fixture-client-key')
  assert.throws(() => normalizeClientAccess({
    schemaVersion: 1,
    groups: [
      { id: 'one', channels: ['free1'], enabled: true },
      { id: 'two', channels: ['free1'], enabled: true }
    ],
    clients: []
  }, ['free1']), /overlap/)
  assert.throws(() => normalizeClientAccess({ schemaVersion: 1, groups: [{ id: 'one', channels: ['missing'] }], clients: [] }, ['free1']), /unknown channel/)
  assert.throws(() => normalizeClientAccess({
    schemaVersion: 1,
    groups: [{ id: 'one', channels: ['free1'] }],
    clients: [
      { id: 'a', group: 'one', keyHash: hash },
      { id: 'b', group: 'one', keyHash: hash }
    ]
  }, ['free1']), /Duplicate client key hash/)
})
