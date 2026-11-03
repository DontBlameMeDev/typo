import { expect, test } from 'bun:test'
import { BackGate } from '../src/back-gate'

test('Back exits an idle library after queued input settles', () => {
  const gate = new BackGate()
  expect(gate.blockOpening()).toBe(false)
  expect(gate.begin(true)).toBe(true)
  expect(gate.finish()).toBe(true)
  expect(gate.finish()).toBe(false)
})

test('a tap delivered after Back cannot open a screen or exit the library', () => {
  const gate = new BackGate()
  expect(gate.begin(true)).toBe(true)
  expect(gate.blockOpening()).toBe(true)
  expect(gate.blockOpening()).toBe(true)
  expect(gate.finish()).toBe(false)
  expect(gate.blockOpening()).toBe(false)
})

test('closing a screen blocks its late press callback without exiting', () => {
  const gate = new BackGate()
  expect(gate.begin(false)).toBe(true)
  expect(gate.blockOpening()).toBe(true)
  expect(gate.finish()).toBe(false)
})

test('a screen close cancels an already queued library exit', () => {
  const gate = new BackGate()
  expect(gate.begin(true)).toBe(true)
  expect(gate.begin(false)).toBe(false)
  expect(gate.begin(true)).toBe(false)
  expect(gate.finish()).toBe(false)
})

test('unmounting cancels a queued Back turn and allows the next tap', () => {
  const gate = new BackGate()
  gate.begin(true)
  gate.cancel()
  expect(gate.finish()).toBe(false)
  expect(gate.blockOpening()).toBe(false)
  expect(gate.begin(true)).toBe(true)
  expect(gate.finish()).toBe(true)
})
