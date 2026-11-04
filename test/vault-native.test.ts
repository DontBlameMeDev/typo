import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type * as Bridge from '../src/vault-native'

const bundle = await Bun.build({
  entrypoints: ['src/vault-native.ts'],
  target: 'node',
  format: 'cjs',
  external: ['expo-modules-core'],
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot bundle the native vault bridge')
const source = await bundle.outputs[0].text()

function bridge(native: unknown): typeof Bridge {
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name: string) => {
      expect(name).toBe('expo-modules-core')
      return {
        requireOptionalNativeModule: (name: string) => {
          expect(name).toBe('TypoVault')
          return native
        },
      }
    },
  })
  return module.exports as typeof Bridge
}

test('Expo Go returns null only for an absent native module', async () => {
  const api = bridge(null)
  expect(await api.listVaultEntries('tree')).toBeNull()
  expect(api.readVaultText('file')).toBeNull()
  expect(api.readVaultBase64('file', 32)).toBeNull()
})

test('native empty directories and empty files never request a fallback', async () => {
  const calls: string[] = []
  const api = bridge({
    listChildren: async (uri: string) => {
      calls.push(uri)
      return []
    },
    readText: async (uri: string) => {
      calls.push(uri)
      return ''
    },
    readBase64: async (uri: string, maxBytes: number) => {
      calls.push(`${uri}:${maxBytes}`)
      return ''
    },
  })
  expect(await api.listVaultEntries('tree')).toEqual([])
  expect(await api.readVaultText('text')).toBe('')
  expect(await api.readVaultBase64('binary', 32)).toBe('')
  expect(calls).toEqual(['tree', 'text', 'binary:32'])
})

test('native metadata and read failures propagate without silently falling back', async () => {
  const error = new Error('Access revoked')
  const fail = async () => {
    throw error
  }
  const api = bridge({ listChildren: fail, readText: fail, readBase64: fail })
  await expect(api.listVaultEntries('tree')).rejects.toBe(error)
  await expect(api.readVaultText('text')).rejects.toBe(error)
  await expect(api.readVaultBase64('binary', 32)).rejects.toBe(error)
})
