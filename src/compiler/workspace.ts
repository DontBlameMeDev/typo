import { hasCurrentPdf, type Note } from '../types'
import { fingerprint, fingerprintAsync } from './fingerprint'
import { CompilerInputs } from './inputs'
import type { CompileInput, CompileResult } from './protocol'

export type PdfRecord = {
  sourceHash: string
  fontsHash: string
  dependencies: Record<string, string | null>
  uri: string
  output?: { uri: string; stamp: string }
}
export type PdfPreview = { source: string; record: PdfRecord; uri: string }
type Files = CompileInput['files']
type Snapshot = { files: Files; hashes: Map<string, string>; fontsHash: string }
type Job = { key: string; run(): Promise<void> }

type Storage = {
  read(path: string): Promise<PdfRecord | null>
  save(path: string, record: PdfRecord): Promise<void>
  cache(key: string, base64: string): Promise<string>
  base64(uri: string): Promise<string>
  stamp(uri: string): Promise<string | null>
  write(note: Note, base64: string): Promise<string>
  hash(note: Note): Promise<void>
}

export class PdfWorkspace {
  private inputs: CompilerInputs
  private snapshot: Snapshot | null = null
  private refreshing: Promise<void> | null = null
  private notes = new Map<string, Note>()
  private records = new Map<string, PdfRecord>()
  private persisted = new WeakSet<PdfRecord>()
  private invalidated = new Set<string>()
  private revision = 0
  private failures = new Map<string, { source: string; snapshot: Snapshot; error: unknown }>()
  private pending = new Map<string, { job: Job; promise: Promise<PdfPreview> }>()
  private foreground: Job[] = []
  private background: Job[] = []
  private running = false
  private disposed = false
  private active = true
  private inputListeners = new Set<() => void>()
  private statusListeners = new Set<() => void>()
  private errors = new Map<string, string>()

  constructor(
    private options: {
      readFiles(): Promise<Files>
      compile(input: CompileInput): Promise<CompileResult>
      storage: Storage
      onPdf?(note: Note): void
    }
  ) {
    this.inputs = new CompilerInputs(options.readFiles)
  }

  get status() {
    return { pending: this.pending.size, errors: this.errors.size }
  }

  storageError(path: string) {
    const error = this.errors.get(path)
    return error?.startsWith('Cannot store') ? error : null
  }

  subscribe(listener: () => void) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  subscribeInputs(listener: () => void) {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  private notify() {
    for (const listener of this.statusListeners) listener()
  }

  setActive(active: boolean) {
    this.active = active
    if (active) void this.pump()
  }

  setNotes(notes: Note[]) {
    const previous = this.notes
    const changedNotes = notes.filter((note) => previous.get(note.uri)?.source !== note.source)
    const structural = notes.some(
      (note) => !previous.has(note.uri) || previous.get(note.uri)?.path !== note.path
    )
    const changed = structural || notes.length !== previous.size || changedNotes.length > 0
    this.notes = new Map(notes.map((note) => [note.uri, note]))
    const paths = new Set(notes.map((note) => note.path))
    for (const path of this.errors.keys())
      if (path !== 'inputs' && !paths.has(path)) this.errors.delete(path)
    for (const note of this.notes.values()) if (hasCurrentPdf(note)) this.errors.delete(note.path)
    if (changed) {
      if (this.snapshot)
        for (const note of changedNotes)
          if (!hasCurrentPdf(note)) void this.render(note, note.source, false).catch(() => {})
      // An autosave changes one note. The compiler receives that source directly,
      // so a full vault read can wait for the periodic refresh.
      if (structural) void this.refresh()
    }
  }

  async refresh() {
    if (this.disposed || !this.active) return
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const files = await this.inputs.get(true)
        const previousFiles = new Map(this.snapshot?.files.map((file) => [file.path, file.base64]))
        const hashes = new Map<string, string>()
        let lastYield = performance.now()
        for (const file of files) {
          const previousHash = this.snapshot?.hashes.get(file.path)
          hashes.set(
            file.path,
            previousHash && previousFiles.get(file.path) === file.base64
              ? previousHash
              : await fingerprintAsync(file.base64)
          )
          if (performance.now() - lastYield >= 8) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            lastYield = performance.now()
          }
          if (this.disposed) return
        }
        const fontsHash = fingerprint(
          JSON.stringify([...hashes].filter(([path]) => /\.(ttf|otf|ttc)$/iu.test(path)))
        )
        const previous = this.snapshot
        const unchanged =
          previous &&
          previous.hashes.size === hashes.size &&
          [...hashes].every(([path, hash]) => previous.hashes.get(path) === hash)
        this.snapshot = unchanged ? previous : { files, hashes, fontsHash }
        if (!unchanged) this.revision++
        const recovered = this.errors.delete('inputs')
        if (!unchanged || recovered) for (const listener of this.inputListeners) listener()
        for (const note of this.notes.values())
          if (!hasCurrentPdf(note)) void this.render(note, note.source, false).catch(() => {})
      } catch (cause) {
        // A vault-wide read failure must not count against notes that need no compile.
        if ([...this.notes.values()].every(hasCurrentPdf)) this.errors.delete('inputs')
        else this.errors.set('inputs', String(cause))
        for (const listener of this.inputListeners) listener()
      } finally {
        this.notify()
      }
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async previous(note: Note): Promise<PdfPreview | null> {
    const record = await this.options.storage.read(note.path)
    return record && !this.disposed ? { source: note.source, record, uri: record.uri } : null
  }

  render(note: Note, source: string, priority = true): Promise<PdfPreview> {
    if (!priority) return this.enqueue(note, source, false)
    return this.cachedPreview(note, source).then(
      (preview) => preview ?? this.enqueue(note, source, true)
    )
  }

  private matches(record: PdfRecord, sourceHash: string, snapshot: Snapshot) {
    return (
      record.sourceHash === sourceHash &&
      record.fontsHash === snapshot.fontsHash &&
      Object.entries(record.dependencies).every(
        ([path, hash]) => (snapshot.hashes.get(path) ?? null) === hash
      )
    )
  }

  private async cachedPreview(note: Note, source: string): Promise<PdfPreview | null> {
    const snapshot = this.snapshot
    if (!snapshot || this.errors.has('inputs') || this.invalidated.has(note.path)) return null
    const failed = this.failures.get(note.path)
    if (failed?.source === source && failed.snapshot === snapshot) return null
    const sourceHash = fingerprint(source)
    let record = this.records.get(note.path)
    if (!record || record.sourceHash !== sourceHash) {
      record = (await this.options.storage.read(note.path)) ?? undefined
      if (record) this.persisted.add(record)
    }
    if (
      !record ||
      !this.matches(record, sourceHash, snapshot) ||
      (await this.options.storage.stamp(record.uri)) === null
    )
      return null
    if (this.disposed) throw new Error('The workspace was closed.')
    this.records.set(note.path, record)
    return { source, record, uri: record.uri }
  }

  private enqueue(note: Note, source: string, priority: boolean): Promise<PdfPreview> {
    if (this.disposed) return Promise.reject(new Error('The workspace was closed.'))
    const key = `${this.revision}:${note.uri}:${fingerprint(source)}`
    const existing = this.pending.get(key)
    if (existing) {
      if (priority) {
        const index = this.background.indexOf(existing.job)
        if (index >= 0) {
          this.background.splice(index, 1)
          this.foreground.push(existing.job)
        }
      }
      return existing.promise
    }
    const job: Job = {
      key,
      run: async () => {},
    }
    const promise = new Promise<PdfPreview>((resolve, reject) => {
      job.run = async () => {
        try {
          if (this.disposed) throw new Error('The workspace was closed.')
          if (!priority && this.notes.get(note.uri)?.source !== source)
            throw new Error('Superseded compilation.')
          if (!this.snapshot) await this.refresh()
          const snapshot = this.snapshot
          if (!snapshot || this.errors.has('inputs'))
            throw new Error(this.errors.get('inputs') || 'Cannot read compiler inputs.')
          const failed = this.failures.get(note.path)
          if (failed?.source === source && failed.snapshot === snapshot) throw failed.error
          const sourceHash = fingerprint(source)
          let record = this.records.get(note.path)
          if (!record || record.sourceHash !== sourceHash) {
            record = (await this.options.storage.read(note.path)) ?? undefined
            if (record) this.persisted.add(record)
          }
          if (this.invalidated.delete(note.path)) record = undefined
          const valid =
            record &&
            this.matches(record, sourceHash, snapshot) &&
            (await this.options.storage.stamp(record.uri)) !== null
          if (!valid) {
            try {
              const result = await this.options.compile({
                path: note.path,
                source,
                files: snapshot.files,
              })
              const dependencies = Object.fromEntries(
                result.dependencies
                  .filter((path) => path !== note.path)
                  .map((path) => [path, snapshot.hashes.get(path) ?? null])
              )
              const cacheKey = fingerprint(
                JSON.stringify([note.path, sourceHash, snapshot.fontsHash, dependencies])
              )
              record = {
                sourceHash,
                fontsHash: snapshot.fontsHash,
                dependencies,
                uri: await this.options.storage.cache(cacheKey, result.base64),
              }
              this.failures.delete(note.path)
            } catch (error) {
              this.failures.set(note.path, { source, snapshot, error })
              throw error
            }
          }
          if (!record || this.disposed) throw new Error('The workspace was closed.')
          this.records.set(note.path, record)
          const preview = { source, record, uri: record.uri }
          resolve(preview)
          const saved = this.notes.get(note.uri)
          if (saved?.source === source && this.snapshot === snapshot) {
            try {
              const output = record.output
              if (!output || (await this.options.storage.stamp(output.uri)) !== output.stamp) {
                const base64 = await this.options.storage.base64(record.uri)
                if (this.disposed || this.notes.get(note.uri)?.source !== source) return
                const uri = await this.options.storage.write(saved, base64)
                const stamp = await this.options.storage.stamp(uri)
                if (!stamp) throw new Error('Cannot verify the stored PDF.')
                record.output = { uri, stamp }
                this.persisted.delete(record)
              }
              if (this.disposed || this.notes.get(note.uri)?.source !== source) return
              if (!this.persisted.has(record)) {
                await this.options.storage.save(note.path, record)
                this.persisted.add(record)
              }
              if (this.disposed || this.notes.get(note.uri)?.source !== source) return
              await this.options.storage.hash(saved)
              if (record.output && saved.pdfUri !== record.output.uri)
                this.options.onPdf?.({ ...saved, pdfUri: record.output.uri })
              this.errors.delete(note.path)
            } catch (cause) {
              this.errors.set(note.path, `Cannot store the current PDF: ${String(cause)}`)
            }
          }
        } catch (error) {
          if (!this.disposed && this.notes.get(note.uri)?.source === source)
            this.errors.set(note.path, String(error))
          reject(error)
        }
      }
    })
    this.pending.set(key, { job, promise })
    const jobs = priority ? this.foreground : this.background
    jobs.push(job)
    this.notify()
    void this.pump()
    return promise
  }

  retry(path: string) {
    this.failures.delete(path)
    this.records.delete(path)
    this.invalidated.add(path)
  }

  dispose() {
    this.disposed = true
    this.active = true
    void this.pump()
    this.inputListeners.clear()
    this.statusListeners.clear()
  }

  private async pump() {
    if (this.running || !this.active) return
    this.running = true
    let lastYield = performance.now()
    try {
      while (this.active) {
        const job = this.foreground.shift() ?? this.background.shift()
        if (!job) break
        await job.run()
        this.pending.delete(job.key)
        this.notify()
        if (performance.now() - lastYield >= 8) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          lastYield = performance.now()
        }
      }
    } finally {
      this.running = false
    }
  }
}
