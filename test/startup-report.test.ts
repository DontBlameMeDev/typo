import { describe, expect, test } from 'bun:test'
import type { StartupReport } from '../scripts/startup'
import {
  compareStartup,
  FAIL_MARGIN,
  FLOOR_MS,
  type Floor,
  METHOD,
  renderComment,
  WARN_MARGIN,
} from '../scripts/startup-report'

const floor: Floor = {
  method: METHOD,
  sha: 'a'.repeat(40),
  bestMs: 500,
  medianMs: 520,
  phases: { bundle: 100, paint: 400 },
}

function report(bestMs: number, phases: Record<string, number> = {}): StartupReport {
  return {
    package: 'org.dontblameme.typo',
    runs: 5,
    bestMs,
    medianMs: bestMs + 20,
    phases,
    samples: [bestMs, bestMs + 20],
  }
}

describe('compareStartup', () => {
  test('passes at the floor', () => {
    const comparison = compareStartup(report(500, { bundle: 100, paint: 400 }), floor)
    expect(comparison.status).toBe('ok')
    expect(comparison.rows[0]).toEqual({
      name: 'Cold start',
      headMs: 500,
      floorMs: 500,
      delta: '0%',
    })
  })

  test('warns inside the fail margin', () => {
    const value = Math.round(500 * (1 + (FAIL_MARGIN + WARN_MARGIN) / 2) + FLOOR_MS)
    expect(compareStartup(report(value), floor).status).toBe('warn')
  })

  test('fails past the margin and the fixed allowance', () => {
    const value = Math.round(500 * (1 + FAIL_MARGIN) + FLOOR_MS) + 1
    expect(compareStartup(report(value), floor).status).toBe('fail')
  })

  test('treats an improvement as a pass', () => {
    expect(compareStartup(report(300), floor).status).toBe('ok')
    expect(compareStartup(report(300), floor).rows[0]?.delta).toBe('-40%')
  })

  test('pends without a floor', () => {
    const comparison = compareStartup(report(500), null)
    expect(comparison.status).toBe('pending')
    expect(comparison.rows[0]?.floorMs).toBeNull()
  })

  test('pends when the floor was measured another way', () => {
    expect(compareStartup(report(500), { ...floor, method: METHOD + 1 }).status).toBe('pending')
  })

  test('reports phases beside the cold start', () => {
    const comparison = compareStartup(report(600, { bundle: 150, paint: 500 }), floor)
    expect(comparison.rows.map((row) => row.name)).toEqual(['Cold start', 'bundle', 'paint'])
    expect(comparison.rows[1]?.delta).toBe('+50%')
  })
})

describe('renderComment', () => {
  test('starts with the comment marker and names the measurement', () => {
    const head = report(600, { bundle: 150, paint: 500 })
    const comment = renderComment(head, compareStartup(head, floor))
    expect(comment.startsWith('<!-- startup-report -->')).toBe(true)
    expect(comment).toContain('**600 ms**')
    expect(comment).toContain('| paint | 500 ms | 400 ms | +25% |')
    expect(comment).toContain('Samples: 600, 620 ms')
  })

  test('explains a missing floor', () => {
    const head = report(600)
    const comment = renderComment(head, compareStartup(head, null))
    expect(comment).toContain('becomes the floor')
    expect(comment).toContain('| Cold start | 600 ms | - | new |')
  })
})
