import { normalizeRecord, sanitizeUrl } from '../public/core.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OPERATIONS = 2000;
const WRITE_CHUNK_SIZE = 100;

// A deletion wins a timestamp tie. In particular, retrying a stale operation
// cannot replace a newer tombstone or overwrite a later intentional re-add.
const WRITE_SQL = `
  INSERT INTO reading_bookmarks (owner_id, url_key, record, updated_at, deleted)
  SELECT ?, json_extract(operation.value, '$.urlKey'),
         CASE WHEN current.deleted = 0 AND json_extract(operation.value, '$.deleted') = 0
           THEN json_set(json_extract(operation.value, '$.record'),
             '$.createdAt', json_extract(current.record, '$.createdAt'),
             '$.note', CASE WHEN json_extract(operation.value, '$.preserveNote') = 1
               THEN json_extract(current.record, '$.note')
               ELSE json_extract(operation.value, '$.record.note') END)
           ELSE json_extract(operation.value, '$.record') END,
         CAST(json_extract(operation.value, '$.updatedAt') AS INTEGER),
         CAST(json_extract(operation.value, '$.deleted') AS INTEGER)
  FROM json_each(?) AS operation
  LEFT JOIN reading_bookmarks AS current
    ON current.owner_id = ? AND current.url_key = json_extract(operation.value, '$.urlKey')
  WHERE 1
  ON CONFLICT (owner_id, url_key) DO UPDATE SET
    record = excluded.record,
    updated_at = excluded.updated_at,
    deleted = excluded.deleted
  WHERE excluded.updated_at > reading_bookmarks.updated_at
     OR (excluded.updated_at = reading_bookmarks.updated_at
         AND (excluded.deleted = 1 OR reading_bookmarks.deleted = 0))
`;

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extraHeaders,
    },
  });
}

function urlKey(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) {
    throw new ApiError(415, 'unsupported_media_type', 'Send the library changes as JSON.');
  }
  const declaredSize = request.headers.get('content-length');
  if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > MAX_BODY_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Library changes must be smaller than 2 MiB.');
  }
  if (!request.body) throw new ApiError(400, 'invalid_json', 'The request body must contain JSON.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let content = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'payload_too_large', 'Library changes must be smaller than 2 MiB.');
      }
      content += decoder.decode(part.value, { stream: true });
    }
    content += decoder.decode();
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'The request body must contain valid UTF-8 JSON.');
  } finally {
    reader.releaseLock();
  }
}

function operationTimestamp(value, now, index) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, 'invalid_operation', `Change ${index + 1} needs a valid updatedAt timestamp.`);
  }
  // Accepted operation versions never change on retries. Rejecting a future
  // clock before writing lets the client correct it without a moving clamp
  // that could otherwise revive an article after a newer deletion.
  if (value > now) {
    throw new ApiError(409, 'clock_skew', 'Your device clock is ahead. Refresh the sync clock and retry.', { serverTime: now });
  }
  return value;
}

function normalizeOperations(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.operations)) {
    throw new ApiError(400, 'invalid_operations', 'Send an operations array of library changes.');
  }
  if (body.operations.length > MAX_OPERATIONS) {
    throw new ApiError(413, 'too_many_operations', 'Sync at most 2,000 library changes at a time.');
  }
  return body.operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new ApiError(400, 'invalid_operation', `Change ${index + 1} is invalid.`);
    }
    if (operation.type === 'upsert') {
      const input = operation.record;
      const normalized = normalizeRecord(input, now);
      if (!normalized) throw new ApiError(400, 'invalid_operation', `Change ${index + 1} needs a valid HTTP or HTTPS article URL.`);
      const updatedAt = operationTimestamp(input.updatedAt, now, index);
      const record = normalizeRecord({ ...normalized, id: undefined, updatedAt }, now);
      return { urlKey: urlKey(record.url), record, updatedAt, deleted: 0, preserveNote: operation.preserveNote === true };
    }
    if (operation.type === 'delete') {
      const url = sanitizeUrl(operation.url);
      if (!url) throw new ApiError(400, 'invalid_operation', `Change ${index + 1} needs a valid HTTP or HTTPS article URL.`);
      const updatedAt = operationTimestamp(operation.updatedAt, now, index);
      return { urlKey: urlKey(url), record: null, updatedAt, deleted: 1 };
    }
    throw new ApiError(400, 'invalid_operation', `Change ${index + 1} has an unsupported type.`);
  });
}

async function readLibrary(database, ownerId) {
  const result = await database.prepare(`
    SELECT url_key, record, updated_at, deleted
    FROM reading_bookmarks WHERE owner_id = ?
    ORDER BY updated_at DESC, url_key ASC
  `).bind(ownerId).all();
  if (result.success === false || !Array.isArray(result.results)) throw new Error('Library read failed.');
  const bookmarks = [];
  const deleted = [];
  for (const row of result.results) {
    if (row.deleted) {
      deleted.push({ url: row.url_key, updatedAt: row.updated_at });
    } else {
      const record = normalizeRecord({ ...JSON.parse(row.record), id: undefined, updatedAt: row.updated_at });
      if (!record) throw new Error('A stored bookmark is invalid.');
      bookmarks.push(record);
    }
  }
  return { bookmarks, deleted, serverTime: Date.now() };
}

/** Authenticated, per-user D1 library API. The route supplies the trusted user ID. */
export default async function handleLibrary(request, env, userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 512 || /[\u0000-\u001F\u007F]/.test(userId)) {
    return json({ error: 'Sign in to sync your reading library.', code: 'unauthorized' }, 401);
  }
  if (!['GET', 'POST'].includes(request.method)) {
    return json({ error: 'Use GET or POST for the library.', code: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
  }
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) {
    return json({ error: 'Library changes must come from this website.', code: 'forbidden_origin' }, 403);
  }
  const database = env?.DB;
  if (!database || typeof database.prepare !== 'function' || typeof database.batch !== 'function') {
    return json({ error: 'Library sync is temporarily unavailable. Your device copy is still here.', code: 'database_unavailable' }, 503);
  }
  try {
    if (request.method === 'POST') {
      const body = await readJson(request);
      const operations = normalizeOperations(body, Date.now());
      const statements = [];
      for (let index = 0; index < operations.length; index += WRITE_CHUNK_SIZE) {
        statements.push(database.prepare(WRITE_SQL).bind(userId.trim(), JSON.stringify(operations.slice(index, index + WRITE_CHUNK_SIZE)), userId.trim()));
      }
      if (statements.length) {
        // D1 batch executes its statements in one transaction. JSON input keeps
        // this below the per-query bind limit even for a large library import.
        const results = await database.batch(statements);
        if (results.some(result => result.success === false)) throw new Error('Library write failed.');
      }
    }
    return json(await readLibrary(database, userId.trim()));
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
    return json({ error: 'The library could not be synchronized. Please try again.', code: 'sync_failed' }, 500);
  }
}
