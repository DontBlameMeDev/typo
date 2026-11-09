import { describe, expect, test } from 'bun:test'
import { isProcessStart, logcatTime, median, parseMarks, summarize } from '../scripts/startup'

describe('logcatTime', () => {
  test('reads the device clock from an epoch logcat line', () => {
    expect(logcatTime('1762680729.080  27676  27676 I ReactNativeJS: Running "main"')).toBe(
      1762680729080
    )
  })

  test('ignores the buffer header', () => {
    expect(logcatTime('--------- beginning of main')).toBeNull()
  })
})

describe('isProcessStart', () => {
  const line = (fields: string) => `1762680729.080  649  677 I am_proc_start: [${fields}]`

  test('matches the app process', () => {
    expect(
      isProcessStart(
        line(
          '0,30482,10241,org.dontblameme.typo,next-top-activity,{org.dontblameme.typo/.MainActivity}'
        ),
        'org.dontblameme.typo'
      )
    ).toBe(true)
  })

  test('ignores a WebView sandbox process that names the app', () => {
    expect(
      isProcessStart(
        line(
          '0,30529,99053,com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0,bound-service,{org.dontblameme.typo/org.chromium.content.app.SandboxedProcessService0:0}'
        ),
        'org.dontblameme.typo'
      )
    ).toBe(false)
  })

  test('ignores other events', () => {
    expect(isProcessStart(line('0,1,2,org.other,activity,{}'), 'org.dontblameme.typo')).toBe(false)
  })
})

describe('parseMarks', () => {
  test('reads the probe line', () => {
    expect(
      parseMarks('11-09 I ReactNativeJS: [startup] {"bundle":82,"paint":260,"bad":"x","nan":null}')
    ).toEqual({ bundle: 82, paint: 260 })
  })

  test('ignores lines without a probe payload', () => {
    expect(parseMarks('11-09 I ReactNativeJS: Running "main"')).toBeNull()
    expect(parseMarks('[startup] not json')).toBeNull()
  })
})

describe('summarize', () => {
  test('reports the fastest launch and the median phases', () => {
    const report = summarize('org.dontblameme.typo', [
      { coldStartMs: 500, phases: { bundle: 100, paint: 400 } },
      { coldStartMs: 420, phases: { bundle: 90, paint: 330 } },
      { coldStartMs: 480, phases: { bundle: 110, paint: 380 } },
    ])
    expect(report.bestMs).toBe(420)
    expect(report.medianMs).toBe(480)
    expect(report.phases).toEqual({ bundle: 100, paint: 380 })
    expect(report.samples).toEqual([500, 420, 480])
  })

  test('refuses an empty run', () => {
    expect(() => summarize('org.dontblameme.typo', [])).toThrow()
    expect(() => median([])).toThrow()
  })
})
