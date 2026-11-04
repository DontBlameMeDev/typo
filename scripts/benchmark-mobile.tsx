import { registerRootComponent } from 'expo'
import { useRef, useState } from 'react'
import { Button, ScrollView, Text } from 'react-native'
import { NoteSearch } from '../src/NoteSearch'
import type { Note, SearchResult } from '../src/types'
import { loadCompileFiles, pickVault, scanVaultLibrary } from '../src/vault'

type Sample = { name: string; ms: number; count?: number; maxTimerGapMs?: number }

function Benchmark() {
  const [notes, setNotes] = useState<Note[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<Sample[]>([])
  const waiting = useRef<((results: SearchResult[]) => void) | null>(null)

  async function run() {
    setBusy(true)
    const samples: Sample[] = []
    const log = (sample: Sample) => {
      samples.push(sample)
      setOutput([...samples])
      console.info(`[benchmark] ${JSON.stringify(sample)}`)
    }
    try {
      const vault = await pickVault()
      if (!vault) return
      let loaded: Note[] = []
      for (let iteration = 0; iteration < 3; iteration++) {
        let start = performance.now()
        loaded = (await scanVaultLibrary(vault)).notes
        log({ name: `scan/${iteration}`, ms: performance.now() - start, count: loaded.length })
        start = performance.now()
        const files = await loadCompileFiles(vault)
        log({ name: `inputs/${iteration}`, ms: performance.now() - start, count: files.length })
      }
      setNotes(loaded)
      for (const term of ['probability', 'unmt', 'zzq']) {
        for (let iteration = 0; iteration < 5; iteration++) {
          let last = performance.now()
          let maxTimerGapMs = 0
          const timer = setInterval(() => {
            const now = performance.now()
            maxTimerGapMs = Math.max(maxTimerGapMs, now - last)
            last = now
          }, 1)
          try {
            const start = performance.now()
            const found = await new Promise<SearchResult[]>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Search timed out.')), 30000)
              waiting.current = (results) => {
                clearTimeout(timeout)
                resolve(results)
              }
              // Alternate equivalent queries so each sample makes a round trip.
              setQuery(`${term}${iteration % 2 ? ' ' : ''}`)
            })
            const ms = performance.now() - start
            await new Promise((resolve) => setTimeout(resolve, 10))
            log({ name: `search/${term}/${iteration}`, ms, count: found.length, maxTimerGapMs })
          } finally {
            clearInterval(timer)
          }
        }
      }
    } catch (cause) {
      console.error(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <NoteSearch
        notes={notes}
        query={query}
        mode="all"
        onResults={(results) => {
          const resolve = waiting.current
          waiting.current = null
          resolve?.(results)
        }}
        onError={(message) => console.error(message)}
      />
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 60 }}>
        <Button title="Choose benchmark vault" disabled={busy} onPress={() => void run()} />
        <Text selectable>{JSON.stringify(output, null, 2)}</Text>
      </ScrollView>
    </>
  )
}

registerRootComponent(Benchmark)
