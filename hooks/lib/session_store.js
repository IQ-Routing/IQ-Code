
import * as TaskState from './task_state.js'
import { trustedSettingsHome, pathIn, HELPER_PROCESS_ENV } from './traffic.js'
import { fileStoreTransaction, withSessionStoreLock } from './settings_store.js'

const PATH = '.claude/iq/router/sessions.json'
const MAX_CONFLICTS = 8
const snapshotValid = value => value &&
  (value.text === null && value.version === null || typeof value.text === 'string' &&
    typeof value.version === 'string' && /^[0-9a-f]{64}$/.test(value.version))

async function writeHostSession(files, path, { sid, record, nowMs }, live) {
  const bounded = text => typeof text === 'string' && text.length <= 4 * 1024 * 1024 &&
    new TextEncoder().encode(text).length <= 4 * 1024 * 1024
  const exists = await files.exists(path)
  if (exists !== true && exists !== false || !await live()) return false
  let old = exists ? await files.read(path) : ''
  if (!bounded(old) || !await live()) return false
  let damaged = exists && (old === '' || !TaskState.sessionsSnapshot(old).ok)
  if (damaged) {

    old = await files.read(path)
    if (!bounded(old) || !await live()) return false
    damaged = old === '' || !TaskState.sessionsSnapshot(old).ok
  }
  const text = TaskState.sessionsText(damaged ? '' : old, sid, record, nowMs)
  if (typeof text !== 'string' || !await live()) return false
  if (damaged) {
    await files.write(path + '.bad', old)
    if (!await live()) return false
  }
  await files.write(path, text)
  return true
}

export async function writeSessionStore(access, { sid, record, nowMs }, stillCurrent = () => true) {
  const live = async () => { try { return await stillCurrent() === true } catch (_) { return false } }
  try {

    if (!await live() || typeof TaskState.sessionsText('', sid, record, nowMs) !== 'string') return false
    const home = await trustedSettingsHome(access)
    if (!home || !await live()) return false
    if (access.sessionFiles) {


      return await withSessionStoreLock(access, home,
        () => writeHostSession(access.sessionFiles, pathIn(home, PATH), { sid, record, nowMs }, live),
        HELPER_PROCESS_ENV, live)
    }
    const common = { path: PATH, maxBytes: TaskState.POLICY.maxSessionsBytes }


    const processAccess = { ...access, run: async (argv, init) => {
      if (!await live()) throw new Error('session_save_cancelled')
      return access.run(argv, init)
    } }
    let snapshot = await fileStoreTransaction(processAccess, home, { ...common, op: 'snapshot' }, HELPER_PROCESS_ENV)
    for (let attempt = 0; attempt < MAX_CONFLICTS; attempt++) {
      if (!await live() || !snapshotValid(snapshot)) return false
      let damaged = snapshot.text !== null && (snapshot.text === '' || !TaskState.sessionsSnapshot(snapshot.text).ok)
      if (damaged) {


        if (!await live()) return false
        snapshot = await fileStoreTransaction(processAccess, home, { ...common, op: 'snapshot' }, HELPER_PROCESS_ENV)
        if (!await live() || !snapshotValid(snapshot)) return false
        damaged = snapshot.text !== null && (snapshot.text === '' || !TaskState.sessionsSnapshot(snapshot.text).ok)
      }
      const text = TaskState.sessionsText(damaged ? '' : snapshot.text ?? '', sid, record, nowMs)
      if (typeof text !== 'string' || new TextEncoder().encode(text).length > common.maxBytes || !await live()) return false


      const result = await fileStoreTransaction(processAccess, home, { ...common, op: 'compare',
        expectedVersion: snapshot.version, text, backup: damaged }, HELPER_PROCESS_ENV)
      if (result?.committed === true) return true
      if (result?.committed !== false) return false
      snapshot = result
    }
  } catch (_) {}
  return false
}
