import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import handleLibrary from './library.js';

const ENDPOINT = 'https://dogear.example/api/library';
const OWNER = 'user-one';
const source = { url: 'https://example.com/article#part-two', title: 'An article', quote: 'The sentence where I stopped.', progress: 42, note: 'A note worth preserving.', updatedAt: 1000, createdAt: 1000 };

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE reading_bookmarks (
    owner_id TEXT NOT NULL,
    url_key TEXT NOT NULL,
    record TEXT,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, url_key),
    CHECK (deleted IN (0, 1)),
    CHECK ((deleted = 1 AND record IS NULL) OR (deleted = 0 AND record IS NOT NULL))
  )`);
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return { bind(...parameters) {
        return {
          run() { statement.run(...parameters); return { success: true }; },
          async all() { return { success: true, results: statement.all(...parameters) }; },
        };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function request(operations, { method = 'POST', origin = 'https://dogear.example', contentType = 'application/json', body } = {}) {
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (contentType !== null) headers['Content-Type'] = contentType;
  return new Request(ENDPOINT, {
    method,
    headers,
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: body ?? JSON.stringify({ operations }) }),
  });
}

const upsert = record => ({ type: 'upsert', record });
const remove = (url, updatedAt) => ({ type: 'delete', url, updatedAt });
async function sync(database, operations, owner = OWNER) {
  const response = await handleLibrary(request(operations), { DB: database }, owner);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('requires trusted identity and a same-origin JSON write', async () => {
  assert.equal((await handleLibrary(request([]), {}, null)).status, 401);
  assert.equal((await handleLibrary(request([]), {}, '')).status, 401);
  assert.equal((await handleLibrary(request([], { origin: 'https://evil.example' }), {}, OWNER)).status, 403);
  assert.equal((await handleLibrary(request([], { origin: null }), {}, OWNER)).status, 403);
  const database = createDatabase();
  assert.equal((await handleLibrary(request([], { contentType: 'text/plain' }), { DB: database }, OWNER)).status, 415);
  const unsupported = await handleLibrary(request([], { method: 'DELETE' }), { DB: database }, OWNER);
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('Allow'), 'GET, POST');
  assert.equal((await handleLibrary(request([], { method: 'GET' }), {}, OWNER)).status, 503);
  database.sqlite.close();
});

test('persists normalized complete records and isolates each user library', async () => {
  const database = createDatabase();
  const first = await sync(database, [upsert({ ...source, id: 'caller-selected-id', owner_id: 'another-user', unsafe: '<script>' })]);
  assert.equal(first.bookmarks.length, 1);
  assert.equal(first.bookmarks[0].note, source.note);
  assert.equal(first.bookmarks[0].source, 'example.com');
  assert.notEqual(first.bookmarks[0].id, 'caller-selected-id');
  assert.equal(Object.hasOwn(first.bookmarks[0], 'owner_id'), false);
  assert.equal(Object.hasOwn(first.bookmarks[0], 'unsafe'), false);
  const other = await sync(database, [], 'user-two');
  assert.deepEqual(other.bookmarks, []);
  await sync(database, [upsert({ ...source, title: 'Other user’s article' })], 'user-two');
  const get = await handleLibrary(request([], { method: 'GET', origin: null }), { DB: database }, OWNER);
  assert.equal(get.status, 200);
  assert.match(get.headers.get('Cache-Control'), /no-store/);
  assert.equal(get.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await get.json()).bookmarks[0].title, source.title);
  database.sqlite.close();
});

test('a newer save replaces an older position, and the same article key ignores anchors', async () => {
  const database = createDatabase();
  await sync(database, [upsert(source)]);
  const later = { ...source, url: 'https://example.com/article#part-five', quote: 'A later sentence.', progress: 75, updatedAt: 2000 };
  await sync(database, [upsert(later)]);
  const stale = await sync(database, [upsert({ ...source, updatedAt: 1500 })]);
  assert.equal(stale.bookmarks.length, 1);
  assert.equal(stale.bookmarks[0].quote, later.quote);
  assert.equal(stale.bookmarks[0].updatedAt, 2000);
  assert.equal(stale.bookmarks[0].url, later.url);
  database.sqlite.close();
});

test('deletion tombstones prevent stale resurrection and win timestamp ties', async () => {
  const database = createDatabase();
  await sync(database, [upsert(source)]);
  const deleted = await sync(database, [remove(source.url, 2000)]);
  assert.deepEqual(deleted.bookmarks, []);
  assert.deepEqual(deleted.deleted, [{ url: 'https://example.com/article', updatedAt: 2000 }]);
  assert.equal((await sync(database, [upsert({ ...source, updatedAt: 1500 })])).bookmarks.length, 0);
  assert.equal((await sync(database, [upsert({ ...source, updatedAt: 2000 })])).bookmarks.length, 0);
  const restored = await sync(database, [upsert({ ...source, updatedAt: 2500 })]);
  assert.equal(restored.bookmarks.length, 1);
  assert.deepEqual(restored.deleted, []);
  const retriedDelete = await sync(database, [remove(source.url, 2000)]);
  assert.equal(retriedDelete.bookmarks.length, 1, 'Retrying an old deletion cannot erase a later intentional restore.');
  await sync(database, [upsert({ url: 'https://example.com/tie', updatedAt: 5000 })]);
  const tie = await sync(database, [remove('https://example.com/tie', 5000)]);
  assert.ok(tie.deleted.some(record => record.url === 'https://example.com/tie'));
  database.sqlite.close();
});

test('future clocks reject the whole batch and accepted versions stay fixed on retry', async () => {
  const database = createDatabase();
  const before = Date.now();
  const future = Date.now() + 86400000;
  const response = await handleLibrary(request([upsert(source), upsert({ ...source, url: 'https://example.com/future', updatedAt: future })]), { DB: database }, OWNER);
  assert.equal(response.status, 409);
  const error = await response.json();
  assert.equal(error.code, 'clock_skew');
  assert.ok(error.serverTime >= before);
  assert.ok(error.serverTime < future);
  assert.deepEqual((await sync(database, [])).bookmarks, []);
  const corrected = { ...source, updatedAt: error.serverTime - 1 };
  const result = await sync(database, [upsert(corrected)]);
  assert.equal(result.bookmarks[0].updatedAt, corrected.updatedAt);
  const retry = await sync(database, [upsert(corrected)]);
  assert.equal(retry.bookmarks[0].updatedAt, corrected.updatedAt);
  const futureDelete = await handleLibrary(request([remove(source.url, future)]), { DB: database }, OWNER);
  assert.equal(futureDelete.status, 409);
  assert.equal((await sync(database, [])).bookmarks.length, 1);
  database.sqlite.close();
});

test('validates the whole request before writing any operation', async () => {
  const database = createDatabase();
  for (const invalid of [
    { type: 'upsert', record: { ...source, url: 'javascript:alert(1)' } },
    { type: 'delete', url: source.url, updatedAt: 'yesterday' },
    { type: 'upsert', record: { url: source.url } },
    { type: 'unknown', record: source },
  ]) {
    const response = await handleLibrary(request([upsert(source), invalid]), { DB: database }, OWNER);
    assert.equal(response.status, 400);
  }
  assert.deepEqual((await sync(database, [])).bookmarks, []);
  assert.equal((await handleLibrary(request([], { body: '{broken' }), { DB: database }, OWNER)).status, 400);
  assert.equal((await handleLibrary(request([], { body: '{}' }), { DB: database }, OWNER)).status, 400);
  database.sqlite.close();
});

test('enforces body and operation limits and can apply a large batch atomically', async () => {
  const database = createDatabase();
  const tooMany = Array.from({ length: 2001 }, () => upsert(source));
  assert.equal((await handleLibrary(request(tooMany), { DB: database }, OWNER)).status, 413);
  const oversized = JSON.stringify({ operations: [], padding: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal((await handleLibrary(request([], { body: oversized }), { DB: database }, OWNER)).status, 413);
  const operations = Array.from({ length: 2000 }, (_, index) => upsert({ ...source, url: `https://example.com/article-${index}` }));
  const result = await sync(database, operations);
  assert.equal(result.bookmarks.length, 2000);
  database.sqlite.close();
});

test('database errors return a safe JSON error without exposing stored content', async () => {
  const response = await handleLibrary(request([], { method: 'GET' }), {
    DB: { prepare() { throw new Error('sensitive internal database message'); }, async batch() {} },
  }, OWNER);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, 'sync_failed');
  assert.doesNotMatch(JSON.stringify(body), /sensitive/);
});

test('capture saves preserve existing notes and original save date on another device', async () => {
  const database = createDatabase();
  await sync(database, [upsert(source)]);
  const capture = { ...source, note: '', quote: 'A new sentence captured on the iPhone.', createdAt: 2000, updatedAt: 2000 };
  const result = await sync(database, [{ type: 'upsert', record: capture, preserveNote: true }]);
  assert.equal(result.bookmarks[0].note, source.note);
  assert.equal(result.bookmarks[0].createdAt, source.createdAt);
  assert.equal(result.bookmarks[0].quote, capture.quote);
  assert.equal(result.bookmarks[0].updatedAt, capture.updatedAt);
  assert.equal(Object.hasOwn(JSON.parse(database.sqlite.prepare('SELECT record FROM reading_bookmarks').get().record), 'preserveNote'), false);
  const cleared = await sync(database, [upsert({ ...capture, updatedAt: 3000, createdAt: 3000 })]);
  assert.equal(cleared.bookmarks[0].note, '', 'An explicit note edit can still clear the note.');
  assert.equal(cleared.bookmarks[0].createdAt, source.createdAt);
  const fresh = await sync(database, [{ type: 'upsert', record: { ...capture, url: 'https://example.com/new', note: 'A first note.' }, preserveNote: true }]);
  assert.equal(fresh.bookmarks.find(record => record.url === 'https://example.com/new').note, 'A first note.');
  database.sqlite.close();
});

test('a database failure rolls back earlier chunks of the same write batch', async () => {
  const database = createDatabase();
  database.sqlite.exec(`CREATE TRIGGER reject_test_article BEFORE INSERT ON reading_bookmarks
    WHEN NEW.url_key = 'https://example.com/article-149'
    BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END`);
  const operations = Array.from({ length: 150 }, (_, index) => upsert({ ...source, url: `https://example.com/article-${index}` }));
  const response = await handleLibrary(request(operations), { DB: database }, OWNER);
  assert.equal(response.status, 500);
  assert.deepEqual((await sync(database, [])).bookmarks, []);
  database.sqlite.close();
});
