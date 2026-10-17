# Bookmarking App
Dogear is an exact bookmarking app for long articles. It saves the passage where you stopped and your reading progress, so you can pick up later in Safari on your Mac or iPhone. Your private reading library stays in sync across devices.

Capture your place using a Safari bookmarklet.
Resume through browser text-fragment links, with a saved passage as a reference.
Sync articles, notes, progress, and finished reads across devices.
Queue changes while offline and merge them on reconnection.
Search, export, and import your library.
The app includes separate setup guides for Safari on Mac and iPhone, plus an original sample article.

Development

Use Node.js 24 and npm. The server tests use Node’s built-in SQLite module.
~~~ sh
npm install
npm test
npm run build
Create the local D1 database with the committed schema migration:
~~~ sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_late_randall.sql
Then start the development server:
~~~ sh
npm run dev
Open the printed local URL and visit /signin-with-chatgpt?return_to=/ to use the local test identity. Local and production databases are separate.

Project structure

public/: browser interface, capture bookmarklet, and synchronization engine.
app/: Vinext routes for the page and library API.
server/: authenticated library operations and SQLite tests.
db/ and drizzle/: schema and immutable migrations.
.openai/hosting.json: Sites deployment identity and D1 binding.
Hosting and authentication

Production hosting uses OpenAI Sites with a Cloudflare Worker and D1. Sites authenticates visitors and supplies the trusted user identity used to isolate each person’s library. Open the private app with the same ChatGPT account on each device.

The repository stores source code; it does not include your saved library, runtime database, credentials, or generated deployment output. Running the app on another host requires equivalent authentication and a D1-compatible database binding. Identity headers must come from a trusted authentication layer.

Run npm test and npm run build before publication. Sites publishes dist/, including the hosting manifest and committed Drizzle migrations.