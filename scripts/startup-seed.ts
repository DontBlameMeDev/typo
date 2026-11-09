// Points the app at a fixture vault so the startup measurement covers the real
// launch path: a saved folder, a cached library, and a list on screen.
//
// Usage:
//   bun scripts/startup-seed.ts --folder Documents/typo-startup --notes 200
//
// The folder is written to shared storage and picked through the system folder
// picker once. The app is cleared first, so the run never depends on whatever
// state the device was left in, and the next launch reads only the cache.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import {
  adb,
  hasText,
  screenSummary,
  tapText,
  tryAdb,
  wait,
  waitForApp,
  waitForBoot,
} from './android'

const args = new Map<string, string>()
for (let index = 0; index < process.argv.length; index++) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const next = process.argv[index + 1]
  args.set(value.slice(2), next && !next.startsWith('--') ? next : 'true')
}

const FOLDER = args.get('folder') ?? 'Download/typo-startup'
const NOTES = Number(args.get('notes') ?? 200)
const FIXTURE = 'startup-fixture-note-001'

function note(index: number) {
  const body = Array.from(
    { length: 12 },
    (_, line) => `Paragraph ${line} of note ${index}: a plain sentence with ordinary words.`
  ).join('\n')
  return `#set page(width: 12cm, height: auto)\n#set text(size: 10pt)\n\n${body}\n`
}

await waitForBoot()
// Shared storage is not writable for the shell user on every image. Root makes
// the fixture folders deterministic; a user build simply keeps the shell user.
await tryAdb('root')
await waitForBoot()

// Shared storage can take a moment to come back after adbd restarts.
const storageDeadline = Date.now() + 60_000
while (Date.now() < storageDeadline) {
  if ((await tryAdb('shell', 'ls', '/sdcard')).exitCode === 0) break
  await wait(1000)
}
await tryAdb('shell', 'rm', '-rf', `/sdcard/${FOLDER}`)
await adb('shell', 'mkdir', '-p', `/sdcard/${FOLDER}`)

const scratch = `${process.env.TMPDIR ?? '/tmp'}/typo-startup-fixture`
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })
for (let index = 1; index <= NOTES; index++) {
  const name = `startup-fixture-note-${String(index).padStart(3, '0')}.typ`
  await writeFile(`${scratch}/${name}`, note(index))
}
await adb('push', `${scratch}/.`, `/sdcard/${FOLDER}/`)
await rm(scratch, { recursive: true, force: true })

// The picker remembers the last folder it opened, so reset it to the device
// root. Otherwise the navigation below starts somewhere else on a rerun.
for (const picker of ['com.google.android.documentsui', 'com.android.documentsui'])
  await tryAdb('shell', 'pm', 'clear', picker)

const packageName = args.get('package') ?? 'org.dontblameme.typo'
await adb('shell', 'pm', 'clear', packageName)
// The emulator is still starting system services right after boot, and the
// launcher can go unresponsive under that load.
await wait(10_000)
await adb('shell', 'am', 'start', '-n', `${packageName}/.MainActivity`)
await waitForApp(packageName)

await tapText('Open a folder', 60_000)
await tapText('USE THIS FOLDER', 15_000)
const segments = FOLDER.split('/')
// The picker can start on Recent instead of the device root, so open the roots
// drawer and look again before giving up.
for (const [index, segment] of segments.entries()) {
  try {
    await tapText(segment, 10_000)
  } catch {
    if (index > 0) throw new Error(`the file picker never showed "${segment}"`)
    await tapText('Show roots')
    await tapText(segment)
  }
}
await tapText('USE THIS FOLDER')
// Providers spell the confirm button differently across API levels.
await tapText('Allow')

// The folder chip appears as soon as the picker returns, so it proves the
// grant landed before the scan is waited for.
const folder = FOLDER.slice(FOLDER.lastIndexOf('/') + 1)
const granted = Date.now() + 60_000
while (Date.now() < granted && !(await hasText(`Notes folder: ${folder}`))) await wait(1000)
if (!(await hasText(`Notes folder: ${folder}`)))
  throw new Error(`the app never opened the picked folder\nlast screen: ${await screenSummary()}`)

// The first launch indexes the vault in the background. Wait for a row to
// appear, then give the library index time to reach the cache the next launch
// reads instead of rescanning.
const deadline = Date.now() + 180_000
while (Date.now() < deadline && !(await hasText(FIXTURE))) await wait(1000)
if (!(await hasText(FIXTURE)))
  throw new Error(
    `the fixture vault never appeared in the library\nlast screen: ${await screenSummary()}`
  )
await wait(4000)
await adb('shell', 'am', 'force-stop', packageName)
console.info(`startup-seed: ${NOTES} fixture notes are indexed at /sdcard/${FOLDER}.`)
