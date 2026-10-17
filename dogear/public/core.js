const MAX_URL_LENGTH = 4096;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function text(value, limit, multiline = false, wholeWords = false) {
  if (typeof value !== 'string') return '';
  const wellFormed = value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
    character => character.length === 2 ? character : '\uFFFD');
  const cleaned = multiline
    ? wellFormed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
    : wellFormed.replace(/\s+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const characters = Array.from(cleaned);
  let clipped = characters.slice(0, limit).join('');
  if (wholeWords && characters.length > limit && !/\s/.test(characters[limit])) {
    const boundary = clipped.search(/\s+\S*$/u);
    if (boundary > 0) clipped = clipped.slice(0, boundary);
  }
  return clipped.trimEnd();
}

/** Validate article links and remove text directives while keeping normal anchors. */
export function sanitizeUrl(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value || value.length > MAX_URL_LENGTH || /[\u0000-\u001F\u007F]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    url.hash = url.hash.split(':~:')[0];
    return url.href.length <= MAX_URL_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

function articleKey(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function stableId(url) {
  let first = 2166136261;
  let second = 2246822519;
  for (const character of articleKey(url)) {
    const code = character.codePointAt(0);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `dogear-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function timestamp(value, fallback) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 8640000000000000
    ? Math.floor(parsed) : fallback;
}

/** Return a fresh, allowlisted record, or null when its article URL is invalid. */
export function normalizeRecord(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !own(input, 'url')) return null;
  const url = sanitizeUrl(input.url);
  if (!url) return null;
  const read = key => own(input, key) ? input[key] : undefined;
  const source = new URL(url).hostname.replace(/^www\./i, '');
  const value = read('progress');
  const numericProgress = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  const progress = Number.isFinite(numericProgress) ? Math.round(Math.min(100, Math.max(0, numericProgress))) : 0;
  const updatedAt = timestamp(read('updatedAt'), now);
  const createdAt = Math.min(timestamp(read('createdAt'), updatedAt), updatedAt);
  const id = typeof read('id') === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(read('id'))
    ? read('id') : stableId(url);
  const status = read('status') === 'finished' ? 'finished'
    : read('status') === 'reading' ? 'reading' : progress === 100 ? 'finished' : 'reading';
  return {
    id,
    title: text(read('title'), 300) || source,
    url,
    quote: text(read('quote'), 220, false, true),
    progress,
    createdAt,
    updatedAt,
    status,
    note: text(read('note'), 3000, true),
    source,
  };
}

/** Create a browser text-fragment link for the captured passage. */
export function resumeUrl(record) {
  if (!record || typeof record !== 'object') return null;
  const article = sanitizeUrl(record.url);
  if (!article) return null;
  const quote = text(record.quote, 220, false, true);
  if (!quote) return article;
  const url = new URL(article);
  url.hash = `${url.hash}:~:text=${encodeURIComponent(quote)}`;
  return url.href;
}

/** Insert or update an article. Anchors identify positions within the same article. */
export function upsertRecord(records, input, now = Date.now()) {
  const current = Array.isArray(records) ? records.map(record => normalizeRecord(record, now)).filter(Boolean) : [];
  const incoming = normalizeRecord(input, now);
  if (!incoming) return current;
  const key = articleKey(incoming.url);
  const previous = current.find(record => articleKey(record.url) === key);
  const next = previous ? normalizeRecord({
    ...previous,
    ...input,
    id: previous.id,
    createdAt: previous.createdAt,
    updatedAt: own(input, 'updatedAt') ? input.updatedAt : now,
  }, now) : incoming;
  return [next, ...current.filter(record => articleKey(record.url) !== key)];
}

/** Generate a self-contained bookmarklet; importing this module never touches the DOM. */
export function makeBookmarklet(appUrl) {
  const destination = sanitizeUrl(appUrl);
  if (!destination) throw new TypeError('The app URL must be a valid HTTP or HTTPS address.');

  function capture(targetAddress) {
    try {
      var source = new URL(window.location.href);
      if (!/^https?:$/.test(source.protocol) || source.username || source.password) {
        window.alert('Dogear can save articles on HTTP and HTTPS websites.');
        return;
      }
      source.hash = source.hash.split(':~:')[0];
      if (source.href.length > 4096) {
        window.alert('This article address is too long to save with Dogear.');
        return;
      }
      function clean(value, limit, wholeWords) {
        var characters = Array.from(String(value || '').replace(/\s+/g, ' ').trim());
        var clipped = characters.slice(0, limit).join('');
        if (wholeWords && characters.length > limit && !/\s/.test(characters[limit])) {
          var boundary = clipped.search(/\s+\S*$/u);
          if (boundary > 0) clipped = clipped.slice(0, boundary);
        }
        return clipped.trimEnd();
      }
      var selection = window.getSelection ? window.getSelection() : null;
      var quote = clean(selection ? String(selection) : '', 220, true);
      var root = document.documentElement;
      var body = document.body;
      var viewport = window.innerHeight || root.clientHeight || 800;
      if (!quote) {
        var scope = document.querySelector('article') || document.querySelector('main') || body;
        var candidates = scope ? Array.from(scope.querySelectorAll('p, li, blockquote')) : [];
        var target = viewport / 3;
        var closest = Infinity;
        candidates.forEach(function (element) {
          var rect = element.getBoundingClientRect();
          var content = clean(element.innerText || element.textContent, 220, true);
          if (content.length < 20 || rect.width < 30 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= viewport) return;
          var distance = rect.top <= target && rect.bottom >= target ? 0 : Math.min(Math.abs(rect.top - target), Math.abs(rect.bottom - target));
          if (distance < closest) {
            quote = content;
            closest = distance;
          }
        });
      }
      var fullHeight = Math.max(root.scrollHeight || 0, body ? body.scrollHeight || 0 : 0);
      var scroll = window.scrollY || window.pageYOffset || root.scrollTop || (body ? body.scrollTop : 0) || 0;
      var progress = Math.round(Math.max(0, Math.min(100, 100 * scroll / Math.max(1, fullHeight - viewport))));
      var now = Date.now();
      var payload = {
        title: clean(document.title || source.hostname, 300),
        url: source.href,
        quote: quote,
        progress: progress,
        createdAt: now,
        updatedAt: now,
        status: 'reading'
      };
      var encoded = encodeURIComponent(JSON.stringify(payload));
      while (encoded.length > 7900 && payload.quote.length > 20) {
        payload.quote = clean(payload.quote, Math.floor(Array.from(payload.quote).length / 2), true);
        encoded = encodeURIComponent(JSON.stringify(payload));
      }
      if (encoded.length > 7900) {
        payload.quote = '';
        payload.title = clean(payload.title, 60);
        encoded = encodeURIComponent(JSON.stringify(payload));
      }
      if (encoded.length > 7900) {
        window.alert('This article address is too long to save with Dogear.');
        return;
      }
      var destination = new URL(targetAddress);
      destination.hash = 'capture=' + encoded;
      var browser = window.navigator || {};
      var userAgent = browser.userAgent || '';
      var appleTouch = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && browser.maxTouchPoints > 1);
      if (appleTouch) {
        window.location.assign(destination.href);
      } else {
        window.open(destination.href, '_blank', 'noopener');
      }
    } catch (error) {
      window.alert('Dogear could not save this page. Try a regular article page or add its link in Dogear.');
    }
  }

  return `javascript:(${capture.toString().replace(/\n\s*/g, ' ')})(${JSON.stringify(destination)});void 0`;
}
