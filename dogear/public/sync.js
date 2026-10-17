import { normalizeRecord, sanitizeUrl } from './core.js';

const PENDING_KEY = 'dogear.pending.v1';
const MIGRATED_KEY = 'dogear.migrated.v1';
const keyOf = url => { const parsed = new URL(url); parsed.hash = ''; return parsed.href; };
const versionOf = operation => operation.type === 'upsert' ? operation.record.updatedAt : operation.updatedAt;
const sameRecord = (first, second) => JSON.stringify(first) === JSON.stringify(second);

/** Durable, incremental library synchronization. Importing this module has no browser side effects. */
export function createLibrarySync({ getLocal, setLocal, onState = () => {}, storage, fetcher, endpoint = '/api/library' }) {
  if (typeof getLocal !== 'function' || typeof setLocal !== 'function') throw new TypeError('Local library access is required.');
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  fetcher ||= (...args) => globalThis.fetch(...args);
  let queue = new Map();
  const dirtyTokens = new Set();
  const acknowledgedTokens = new Set();
  let migrated = false;
  let started = false;
  let initialRead = false;
  let flight = null;
  let requested = false;
  let offset = 0;
  let lastStamp = 0;
  let serial = 0;
  let durabilityError = false;
  let latestSnapshot = null;
  const token = () => `${Date.now()}-${++serial}-${Math.random().toString(36).slice(2)}`;
  const state = (status, error) => onState({ status, pending: queue.size, ...(error ? { error: String(error.message || error) } : {}) });
  const localRecords = () => (Array.isArray(getLocal()) ? getLocal() : []).map(record => normalizeRecord(record)).filter(Boolean);
  function enqueue(key, operation) {
    queue.set(key, operation);
    dirtyTokens.add(operation.token);
  }
  function durable() {
    try {
      if (!storage?.setItem) throw new Error('Browser storage is unavailable. Keep this page open until your changes sync.');
      const saved = JSON.parse(storage.getItem(PENDING_KEY) || '[]');
      const merged = new Map();
      if (!Array.isArray(saved)) throw new Error('The saved sync queue is invalid.');
      for (const raw of saved) {
        const operation = normalizeOperation(raw);
        if (operation && !acknowledgedTokens.has(operation.token)) merged.set(keyOf(operation.record?.url || operation.url), operation);
      }
      // Only locally changed entries override the latest stored queue. Other
      // tabs can acknowledge or add work while this instance is awaiting fetch.
      for (const [key, operation] of queue) if (dirtyTokens.has(operation.token) && !acknowledgedTokens.has(operation.token)) {
        const stored = merged.get(key);
        if (!stored || versionOf(operation) > versionOf(stored) ||
            (versionOf(operation) === versionOf(stored) && (operation.type === 'delete' || stored.type !== 'delete'))) {
          merged.set(key, operation);
        }
      }
      storage.setItem(PENDING_KEY, JSON.stringify([...merged.values()]));
      queue = merged;
      dirtyTokens.clear();
      acknowledgedTokens.clear();
      durabilityError = false;
      return true;
    } catch (error) { durabilityError = true; state('offline', error); return false; }
  }
  function normalizeOperation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'upsert') {
      const record = normalizeRecord(raw.record);
      return record ? { type: 'upsert', record, ...(raw.preserveNote === true ? { preserveNote: true } : {}), token: typeof raw.token === 'string' ? raw.token : token() } : null;
    }
    const url = raw.type === 'delete' && sanitizeUrl(raw.url);
    return url && Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= 0
      ? { type: 'delete', url, updatedAt: raw.updatedAt, token: typeof raw.token === 'string' ? raw.token : token() } : null;
  }
  try {
    const saved = JSON.parse(storage?.getItem(PENDING_KEY) || '[]');
    if (Array.isArray(saved)) for (const raw of saved) {
      const operation = normalizeOperation(raw);
      if (operation) queue.set(keyOf(operation.record?.url || operation.url), operation);
    }
    migrated = storage?.getItem(MIGRATED_KEY) === '1';
  } catch (error) { durabilityError = true; state('offline', error); }
  function calibrate(serverTime) {
    if (Number.isFinite(serverTime)) {
      offset = Math.floor(serverTime) - Date.now();
      lastStamp = Math.max(lastStamp, Math.floor(serverTime));
    }
  }
  function nextStamp() {
    const now = Math.max(0, Math.floor(Date.now() + offset));
    lastStamp = Math.max(now, lastStamp + 1);
    return lastStamp;
  }
  function apply(snapshot) {
    const records = new Map();
    for (const input of snapshot.bookmarks) {
      const record = normalizeRecord(input);
      if (record) {
        const key = keyOf(record.url);
        if (!records.has(key) || records.get(key).updatedAt <= record.updatedAt) records.set(key, record);
      }
    }
    const deleted = new Map();
    for (const entry of snapshot.deleted) {
      const url = sanitizeUrl(entry?.url);
      if (url && Number.isFinite(entry.updatedAt)) deleted.set(keyOf(url), entry.updatedAt);
    }
    for (const [key, stamp] of deleted) if (records.get(key)?.updatedAt <= stamp) records.delete(key);
    // A queued operation has not been acknowledged yet. Keep it visible even
    // when another device has a newer version; the POST response settles it.
    for (const [key, operation] of queue) {
      if (operation.type === 'delete') records.delete(key);
      else {
        const cloud = records.get(key);
        records.set(key, operation.preserveNote && cloud
          ? normalizeRecord({ ...operation.record, note: cloud.note, createdAt: cloud.createdAt })
          : operation.record);
      }
    }
    setLocal([...records.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  }
  async function request(method, operations) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Library sync timed out. Your changes are saved on this device.')); }, 10000); });
    let response;
    try { response = await Promise.race([fetcher(endpoint, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ operations }) } : {}),
    }), timeout]);
    } catch (error) { clearTimeout(timer); throw error; }
    let body;
    try {
      try { body = await Promise.race([response.json(), timeout]); }
      catch (error) { if (controller.signal.aborted) throw error; body = {}; }
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const error = new Error(body.error || `Library sync failed (${response.status}).`);
      error.status = response.status; error.code = body.code; error.serverTime = body.serverTime;
      throw error;
    }
    if (!Array.isArray(body.bookmarks) || !Array.isArray(body.deleted) || !Number.isFinite(body.serverTime)) throw new Error('The server returned an invalid library.');
    calibrate(body.serverTime);
    return body;
  }
  function migrate(snapshot, legacy) {
    if (migrated) return;
    const cloud = new Map(snapshot.bookmarks.map(record => [keyOf(record.url), record.updatedAt]));
    const tombstones = new Set();
    for (const deletion of snapshot.deleted) {
      const url = sanitizeUrl(deletion.url);
      if (url) { tombstones.add(keyOf(url)); cloud.set(keyOf(url), Math.max(cloud.get(keyOf(url)) || 0, deletion.updatedAt)); }
    }
    for (const record of legacy) {
      const key = keyOf(record.url);
      // Never upload the device's stale cache over a known cloud version or
      // tombstone. An intentional later edit already has its own queue entry.
      if (!queue.has(key) && !tombstones.has(key) && (!cloud.has(key) || record.updatedAt > cloud.get(key))) {
        enqueue(key, { type: 'upsert', record, token: token() });
      }
    }
    durable();
  }
  function markMigrated() {
    if (migrated || queue.size) return;
    try { storage?.setItem(MIGRATED_KEY, '1'); migrated = true; }
    catch (error) { durabilityError = true; state('offline', error); }
  }
  function fixFutureVersions(serverTime) {
    calibrate(serverTime);
    const future = [...queue.entries()].filter(([,operation]) => versionOf(operation) > serverTime)
      .sort((a, b) => versionOf(a[1]) - versionOf(b[1]));
    // The rejected batch was never written. Shift its future versions together
    // into the server's past, retaining operation order and fixed retry stamps.
    const first = Math.max(0, Math.floor(serverTime) - future.length + 1);
    future.forEach(([key, operation], index) => {
      const updatedAt = first + index;
      acknowledgedTokens.add(operation.token);
      enqueue(key, operation.type === 'upsert'
        ? { ...operation, record: normalizeRecord({ ...operation.record, updatedAt }), token: token() }
        : { ...operation, updatedAt, token: token() });
    });
    lastStamp = Math.floor(serverTime);
    durable();
  }
  async function run() {
    state('syncing');
    try {
      durable();
      if (!initialRead || requested) {
        requested = false;
        const legacy = localRecords();
        latestSnapshot = await request('GET');
        migrate(latestSnapshot, legacy);
        initialRead = true;
        apply(latestSnapshot);
      }
      let skewRetries = 0;
      while (queue.size) {
        const sent = [...queue.entries()].slice(0, 100);
        const operations = sent.map(([,operation]) => { const { token: ignored, ...wire } = operation; return wire; });
        let snapshot;
        try { snapshot = await request('POST', operations); }
        catch (error) {
          if (error.status === 409 && error.code === 'clock_skew' && Number.isFinite(error.serverTime) && skewRetries++ < 3) {
            fixFutureVersions(error.serverTime);
            continue;
          }
          throw error;
        }
        skewRetries = 0;
        for (const [key, operation] of sent) {
          acknowledgedTokens.add(operation.token);
          if (queue.get(key)?.token === operation.token) queue.delete(key);
        }
        durable();
        latestSnapshot = snapshot;
        apply(snapshot);
      }
      markMigrated();
      state(durabilityError ? 'offline' : 'synced');
      return true;
    } catch (error) {
      state(error.status === 401 || error.status === 403 ? 'signin' : 'offline', error);
      return false;
    }
  }
  function schedule(refresh = false) {
    if (refresh) requested = true;
    if (flight) return flight;
    flight = run().finally(() => {
      flight = null;
      // Refreshes requested during a network round trip get their own read.
      if (requested) { requested = false; schedule(true); }
    });
    return flight;
  }
  function recordChanges(previous, next, { preserveNote = false } = {}) {
    const before = new Map((Array.isArray(previous) ? previous : []).map(input => normalizeRecord(input)).filter(Boolean).map(record => [keyOf(record.url), record]));
    const after = new Map((Array.isArray(next) ? next : []).map(input => normalizeRecord(input)).filter(Boolean).map(record => [keyOf(record.url), record]));
    for (const [key, record] of after) {
      if (!before.has(key) || !sameRecord(before.get(key), record)) {
        const updatedAt = nextStamp();
        const queued = queue.get(key);
        const explicitNote = preserveNote && queued?.type === 'upsert' && !queued.preserveNote;
        const keepCloudNote = preserveNote && !explicitNote;
        enqueue(key, { type: 'upsert', record: normalizeRecord({ ...record, ...(explicitNote ? { note: queued.record.note } : {}), updatedAt }), ...(keepCloudNote ? { preserveNote: true } : {}), token: token() });
      }
    }
    for (const [key, record] of before) if (!after.has(key)) enqueue(key, { type: 'delete', url: record.url, updatedAt: nextStamp(), token: token() });
    durable();
    if (started) return schedule();
    return Promise.resolve(true);
  }
  return {
    start() { started = true; return schedule(true); },
    recordChanges,
    refresh() { started = true; return schedule(true); },
    flush() { started = true; return schedule(); },
    get pending() { return queue.size; },
  };
}
