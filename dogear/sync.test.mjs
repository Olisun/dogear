import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibrarySync } from './public/sync.js';
import { normalizeRecord } from './public/core.js';

const entry = (url = 'https://example.com/long-read', fields = {}) => normalizeRecord({ url, title: 'A long read', updatedAt: 100, createdAt: 50, ...fields });
const response = (bookmarks = [], deleted = [], extra = {}) => ({ ok: true, status: 200, json: async () => ({ bookmarks, deleted, serverTime: Date.now(), ...extra }) });
function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
}
function harness({ records = [], storage = memory(), fetcher }) {
  let local = records;
  const states = [];
  const sync = createLibrarySync({ getLocal: () => local, setLocal: value => { local = value; }, storage, fetcher, onState: value => states.push(value) });
  return { sync, storage, states, get local() { return local; } };
}

test('failed requests retain a durable operation that a new page can retry', async () => {
  const storage = memory({ 'dogear.migrated.v1': '1' });
  const saved = entry();
  const first = harness({ records: [saved], storage, fetcher: async () => { throw new Error('Offline'); } });
  await first.sync.recordChanges([], [saved]);
  assert.equal(await first.sync.start(), false);
  assert.equal(first.sync.pending, 1);
  assert.equal(first.states.at(-1).status, 'offline');
  assert.equal(JSON.parse(storage.getItem('dogear.pending.v1')).length, 1);
  const posts = [];
  const second = harness({ records: [saved], storage, fetcher: async (_, options) => {
    if (options.method === 'GET') return response();
    const operations = JSON.parse(options.body).operations; posts.push(...operations);
    return response(operations.filter(op => op.type === 'upsert').map(op => op.record));
  } });
  assert.equal(await second.sync.start(), true);
  assert.equal(posts.length, 1);
  assert.equal(second.sync.pending, 0);
  assert.equal(second.local[0].url, saved.url);
  assert.deepEqual(JSON.parse(storage.getItem('dogear.pending.v1')), []);
});

test('an edit queued during a request survives that request acknowledgement', async () => {
  const original = entry();
  let release;
  let postStarted;
  const started = new Promise(resolve => { postStarted = resolve; });
  const posts = [];
  const subject = harness({ records: [], storage: memory({ 'dogear.migrated.v1': '1' }), fetcher: async (_, options) => {
    if (options.method === 'GET') return response();
    const operations = JSON.parse(options.body).operations; posts.push(operations);
    if (posts.length === 1) {
      postStarted();
      await new Promise(resolve => { release = resolve; });
    }
    return response(operations.map(op => op.record));
  } });
  await subject.sync.start();
  const firstFlush = subject.sync.recordChanges([], [original]);
  await started;
  const later = entry(undefined, { title: 'Updated while syncing', quote: 'A later passage' });
  subject.sync.recordChanges([original], [later]);
  release();
  await firstFlush;
  assert.equal(posts.length, 2);
  assert.equal(posts[1][0].record.title, later.title);
  assert.equal(subject.local[0].quote, later.quote);
  assert.equal(subject.sync.pending, 0);
});

test('a migrated device accepts newer cloud records without uploading its stale cache', async () => {
  const stale = entry(undefined, { note: 'Old device note' });
  const newest = entry(undefined, { updatedAt: 900, note: 'Saved on my iPhone' });
  const methods = [];
  const subject = harness({ records: [stale], storage: memory({ 'dogear.migrated.v1': '1' }), fetcher: async (_, options) => { methods.push(options.method); return response([newest]); } });
  await subject.sync.start();
  assert.deepEqual(methods, ['GET']);
  assert.equal(subject.local[0].note, newest.note);
});

test('the first migration respects cloud tombstones and does not resurrect deleted legacy records', async () => {
  const legacy = entry(undefined, { updatedAt: 100 });
  const methods = [];
  const subject = harness({ records: [legacy], fetcher: async (_, options) => { methods.push(options.method); return response([], [{ url: legacy.url, updatedAt: 200 }]); } });
  await subject.sync.start();
  assert.deepEqual(methods, ['GET']);
  assert.deepEqual(subject.local, []);
  assert.equal(subject.storage.getItem('dogear.migrated.v1'), '1');
});

test('a rejected future timestamp is calibrated once and retries keep the corrected timestamp', async () => {
  const legacy = entry(undefined, { updatedAt: Date.now() + 3600000 });
  const posts = [];
  const subject = harness({ records: [legacy], fetcher: async (_, options) => {
    if (options.method === 'GET') return response();
    const operations = JSON.parse(options.body).operations; posts.push(operations);
    if (posts.length === 1) return { ok: false, status: 409, json: async () => ({ code: 'clock_skew', serverTime: Date.now() - 5000 }) };
    if (posts.length === 2) throw new Error('Connection failed after write');
    return response(operations.map(op => op.record));
  } });
  assert.equal(await subject.sync.start(), false);
  const corrected = posts[1][0].record.updatedAt;
  assert.ok(corrected < legacy.updatedAt);
  assert.equal(subject.sync.pending, 1);
  assert.equal(await subject.sync.flush(), true);
  assert.equal(posts[2][0].record.updatedAt, corrected);
});

test('a later capture does not replace an explicit pending note edit with preserveNote', async () => {
  const initial = entry(undefined, { note: 'Original' });
  const edited = entry(undefined, { note: 'My unsynced note' });
  const captured = entry(undefined, { note: '', quote: 'Where I paused' });
  const subject = harness({ records: [initial], fetcher: async () => { throw new Error('Offline'); } });
  await subject.sync.recordChanges([initial], [edited]);
  await subject.sync.recordChanges([edited], [captured], { preserveNote: true });
  const [pending] = JSON.parse(subject.storage.getItem('dogear.pending.v1'));
  assert.equal(pending.record.note, edited.note);
  assert.equal(pending.preserveNote, undefined);
});

test('two tabs preserve each other’s unsent work and acknowledge only exact sent tokens', async () => {
  const storage = memory({ 'dogear.migrated.v1': '1' });
  const first = entry('https://example.com/first');
  const second = entry('https://example.com/second');
  let releaseFirst, releaseSecond, signalFirst, signalSecond;
  const firstPosted = new Promise(resolve => { signalFirst = resolve; });
  const secondPosted = new Promise(resolve => { signalSecond = resolve; });
  const cloud = new Map();
  let requestsA = 0;
  let postsB = 0;
  const tabA = harness({ storage, fetcher: async (_, options) => {
    if (options.method === 'GET') return response([...cloud.values()]);
    const operations = JSON.parse(options.body).operations;
    requestsA++;
    if (requestsA === 1) { signalFirst(); await new Promise(resolve => { releaseFirst = resolve; }); }
    else { signalSecond(); await new Promise(resolve => { releaseSecond = resolve; }); }
    for (const operation of operations) cloud.set(operation.record.url, operation.record);
    return response([...cloud.values()]);
  } });
  // B exists before A queues anything, which gives it a stale in-memory queue.
  const tabB = harness({ storage, fetcher: async (_, options) => { if (options.method === 'POST') postsB++; return response([...cloud.values()]); } });
  await tabA.sync.recordChanges([], [first]);
  const running = tabA.sync.start();
  await firstPosted;
  await tabB.sync.recordChanges([], [second]);
  assert.equal(JSON.parse(storage.getItem('dogear.pending.v1')).length, 2);
  releaseFirst();
  await secondPosted;
  const remaining = JSON.parse(storage.getItem('dogear.pending.v1'));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].record.url, second.url);
  releaseSecond();
  await running;
  assert.deepEqual(JSON.parse(storage.getItem('dogear.pending.v1')), []);
  // B must also discard stale copies of operations another tab acknowledged.
  await tabB.sync.flush();
  assert.equal(postsB, 0);
  assert.equal(tabB.local.length, 2);
});
