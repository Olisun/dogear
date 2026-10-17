import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { normalizeRecord, sanitizeUrl, resumeUrl, makeBookmarklet, upsertRecord } from './public/core.js';

const article = { url: 'https://www.example.com/long-read#chapter-2', title: 'A long read', quote: 'The place where I stopped.', progress: 46 };

test('accepts only safe absolute article URLs and removes old text directives', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//example.com', '/relative', 'https://user:password@example.com', 'https://exa\nmple.com']) {
    assert.equal(sanitizeUrl(url), null, url);
  }
  assert.equal(sanitizeUrl('  HTTPS://Example.com:443/story#part:~:text=old  '), 'https://example.com/story#part');
  assert.equal(sanitizeUrl(`https://example.com/${'a'.repeat(4096)}`), null);
});

test('normalizes an allowlisted record with limits and stable article identity', () => {
  const record = normalizeRecord({ ...article, progress: 150, title: '  A\n long   read  ', quote: '😀'.repeat(300), source: 'spoofed', dangerous: '<script>', createdAt: 10, updatedAt: 20 }, 30);
  assert.equal(record.source, 'example.com');
  assert.equal(record.title, 'A long read');
  assert.equal(record.progress, 100);
  assert.equal(record.status, 'finished');
  assert.equal(Array.from(record.quote).length, 220);
  assert.equal(record.createdAt, 10);
  assert.equal(record.updatedAt, 20);
  assert.equal(Object.hasOwn(record, 'dangerous'), false);
  assert.equal(normalizeRecord(Object.create({ url: article.url })), null);
  assert.equal(record.id, normalizeRecord({ url: 'https://www.example.com/long-read#another-anchor' }).id);
  assert.equal(normalizeRecord({ ...article, progress: 'bad' }).progress, 0);
});

test('builds an encoded text-fragment link while preserving the article anchor', () => {
  const quote = 'A comma, an ampersand & some café ☕.';
  const link = resumeUrl({ url: `${article.url}:~:text=old`, quote });
  assert.equal(link, `${article.url}:~:text=${encodeURIComponent(quote)}`);
  assert.equal(resumeUrl({ url: article.url, quote: '' }), article.url);
  assert.equal(resumeUrl({ url: 'javascript:alert(1)', quote: 'anything' }), null);
  assert.doesNotThrow(() => resumeUrl({ url: article.url, quote: '\uD800' }));
});

test('updating the same article preserves notes, ID and original save date', () => {
  const original = normalizeRecord({ ...article, note: 'Read this for the essay.\nKeep the source.', createdAt: 100, updatedAt: 100 }, 100);
  const other = normalizeRecord({ url: 'https://example.org/other', title: 'Other' }, 150);
  const updated = upsertRecord([other, original], { url: 'https://www.example.com/long-read#chapter-5', quote: 'A later passage', progress: 75 }, 200);
  assert.equal(updated.length, 2);
  assert.equal(updated[0].id, original.id);
  assert.equal(updated[0].createdAt, 100);
  assert.equal(updated[0].updatedAt, 200);
  assert.equal(updated[0].note, original.note);
  assert.equal(updated[0].title, original.title);
  assert.equal(updated[0].quote, 'A later passage');
  assert.equal(updated[0].progress, 75);
  assert.equal(original.progress, 46);
  assert.equal(upsertRecord(updated, { ...updated[0], note: '' }, 300)[0].note, '');
  assert.equal(upsertRecord(updated, { url: 'javascript:alert(1)' }, 300).length, 2);
});

function runCapture({ selection = '', href = `${article.url}:~:text=outdated`, blocks = [], title = 'The article', scrollY = 900, scrollHeight = 2700, viewport = 900, userAgent = '', maxTouchPoints = 0 } = {}) {
  const calls = [];
  const navigations = [];
  const alerts = [];
  const scope = { querySelectorAll: () => blocks.map(block => ({
    innerText: block.text,
    getBoundingClientRect: () => ({ width: 600, height: 100, ...block.rect }),
  })) };
  const window = {
    location: { href, assign: address => navigations.push(address) }, innerHeight: viewport, scrollY,
    navigator: { userAgent, maxTouchPoints },
    getSelection: () => selection === null ? null : ({ toString: () => selection }),
    open: (...args) => { calls.push(args); return null; },
    alert: message => alerts.push(message),
  };
  const document = {
    title,
    documentElement: { scrollHeight, clientHeight: viewport },
    body: { scrollHeight },
    querySelector: selector => selector === 'article' ? scope : null,
  };
  const script = makeBookmarklet('https://dogear.example/app#setup').slice('javascript:'.length);
  vm.runInNewContext(script, { window, document, URL, Date, encodeURIComponent });
  const address = navigations[0] || calls[0]?.[0];
  const url = address ? new URL(address) : null;
  const payload = url ? JSON.parse(decodeURIComponent(url.hash.slice('#capture='.length))) : null;
  return { calls, navigations, alerts, url, payload };
}

test('the generated bookmarklet captures the selection, strips text directives and opens once', () => {
  const result = runCapture({ selection: '  Here is\n exactly where I stopped.  ' });
  assert.equal(result.alerts.length, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].slice(1), ['_blank', 'noopener']);
  assert.equal(result.url.origin, 'https://dogear.example');
  assert.equal(result.payload.url, article.url);
  assert.equal(result.payload.quote, 'Here is exactly where I stopped.');
  assert.equal(result.payload.progress, 50);
  assert.equal(result.payload.status, 'reading');
  assert.equal(typeof result.payload.updatedAt, 'number');
  assert.equal(result.payload.updatedAt, result.payload.createdAt);
});

test('without a selection, capture prefers the paragraph nearest the upper third', () => {
  const result = runCapture({ blocks: [
    { text: 'A paragraph that is already above the viewport.', rect: { top: -180, bottom: -80 } },
    { text: 'A paragraph close to the bottom of the screen.', rect: { top: 700, bottom: 800 } },
    { text: 'This paragraph crosses the upper third of the screen.', rect: { top: 260, bottom: 360 } },
  ] });
  assert.equal(result.payload.quote, 'This paragraph crosses the upper third of the screen.');
});

test('capture safely handles pages without article text and clamps reading progress', () => {
  const result = runCapture({ scrollY: 4000, scrollHeight: 900 });
  assert.equal(result.payload.quote, '');
  assert.equal(result.payload.progress, 100);
  assert.equal(runCapture({ href: 'file:///private/article.html' }).calls.length, 0);
  assert.equal(runCapture({ href: 'https://user:password@example.com/article' }).calls.length, 0);
});

test('capture respects its URL-fragment budget for long and Unicode-heavy pages', () => {
  const result = runCapture({ href: `https://example.com/story?q=${'%20'.repeat(1100)}`, selection: '😀'.repeat(300), title: '😀'.repeat(300) });
  assert.equal(result.calls.length, 1);
  assert.ok(result.url.hash.length < 8000);
  assert.ok(Array.from(result.payload.quote).length <= 220);
  const refused = runCapture({ href: `https://example.com/story?q=${'&'.repeat(4000)}` });
  assert.equal(refused.calls.length, 0);
  assert.equal(refused.alerts.length, 1);
});

test('long quotes are clipped at complete words so text fragments can match', () => {
  const prefix = 'An exact sentence with ordinary words. '.repeat(5);
  const passage = prefix + 'Averylongwordthatcrossesthelimit follows here.';
  assert.ok(passage.length > 220);
  const normalized = normalizeRecord({ ...article, quote: passage });
  const captured = runCapture({ selection: passage }).payload;
  assert.equal(normalized.quote, prefix.trim());
  assert.equal(captured.quote, prefix.trim());
  assert.ok(passage.startsWith(normalized.quote + ' '));
  assert.equal(resumeUrl({ ...article, quote: passage }), `${article.url}:~:text=${encodeURIComponent(prefix.trim())}`);
});

test('iPhone Safari capture navigates in the same tab without needing a popup', () => {
  const result = runCapture({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    selection: 'This sentence was selected on an iPhone.',
  });
  assert.equal(result.calls.length, 0);
  assert.equal(result.navigations.length, 1);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.payload.url, article.url);
  assert.equal(result.payload.quote, 'This sentence was selected on an iPhone.');
  assert.equal(result.payload.progress, 50);
});

test('iPad Safari desktop mode uses the same-tab path while a Mac retains a new tab', () => {
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
  const ipad = runCapture({ userAgent, maxTouchPoints: 5 });
  assert.equal(ipad.calls.length, 0);
  assert.equal(ipad.navigations.length, 1);
  const mac = runCapture({ userAgent, maxTouchPoints: 0 });
  assert.equal(mac.calls.length, 1);
  assert.equal(mac.navigations.length, 0);
});

test('an unavailable selection falls back to visible article text', () => {
  const result = runCapture({ selection: null, blocks: [
    { text: 'A readable paragraph when no selection object is available.', rect: { top: 260, bottom: 360 } },
  ] });
  assert.equal(result.payload.quote, 'A readable paragraph when no selection object is available.');
});
