import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEnv, serializeEnv } from '../src/env.mjs'

test('env parser preserves URLs and quoted values without interpolation', () => {
  const values = parseEnv('URL=https://example.test/v1\nKEY="a b$c"\n# comment\n')
  assert.deepEqual(values, { URL: 'https://example.test/v1', KEY: 'a b$c' })
  assert.deepEqual(parseEnv(serializeEnv(values)), values)
})
