# @nexray/lib

> Simplicity WhatsApp Bot, built on top of [zapo-js](https://github.com/vinikjkkj/zapo).

`@nexray/lib` is a thin compatibility layer over the `zapo-js` engine. It gives
plugins a stable public API — the familiar `sock.sendMessage`, `sock.groupMetadata`,
`Utils`, and the high-level send helpers — while every protocol call is delegated
to the injected engine.

- ✅ ESM **and** CommonJS
- ✅ Raw `Proto.IMessage` passthrough (interactive, buttons, carousel, …)
- ✅ Baileys-compatible `sock` facade + event bridge
- ✅ Session backends: `local` (JSON), `sqlite`, `mysql`, `postgres`, `mongo`, `redis`
- ✅ `Utils` contract, sticker EXIF, link previews, media thumbnails

## Install

```bash
npm install @nexray/lib zapo-js
```

Node.js **>= 20.9.0** (same baseline as zapo-js).

## Quick start

```js
import * as zapo from 'zapo-js'
import { Client, Utils } from '@nexray/lib'

const waSocket = new Client({
  presence: true,
  online: true,
  bypass_disappearing: true,
  pairing: {
    state: true,          // true = pairing code, false = QR
    number: '6285xxxxxxx',
    code: 'NEOXRBOT'      // optional 8-char custom code
  },
  create_session: { type: 'local', session: 'session' },
  custom_id: 'neoxr',
  bot: (id) => (id.startsWith('3EB0') && id.length === 40) || id.startsWith('BAE'),
  engines: [zapo],        // first engine is the primary engine
  debug: false
}, {
  version: [2, 3000, 1027023507],
  browser: ['Ubuntu', 'Firefox', '20.0.00']
})
```

CommonJS:

```js
const { Client, Utils } = require('@nexray/lib')
```

## Options (`ConnectionOpts`)

| Field | Meaning |
|-------|---------|
| `engines` | **required** — `[zapo]` engine namespace |
| `create_session` | **required** — `{ type, session, config? }` |
| `pairing` | `{ state, number, code? }` pairing code vs QR |
| `custom_id` | bot namespace / default AI label |
| `bot` | predicate detecting bot/system message ids |
| `newsletterAnnotation` | global newsletter annotation injected on supported sends |
| `ai` | global AI label (`forwardedAiBotMessageInfo`) |
| `metaLabel` | business/meta invoker (`messageContextInfo.botMessageInvokerJid`) on any send; `true` uses `custom_id` |
| `stealth` | device fingerprint hint: `ios` / `android` / `web` / `desktop` |
| `debug` | verbose adapter trail |

Engine options (second argument) are validated against the real `WaClientOptions`
surface; unknown keys are dropped with a debug warning rather than passed to the
engine. `browser: [os, name, version]` is translated to the engine's device
identity fields.

## Events

Compatibility events (via `waSocket.on(...)` or `waSocket.ev.on(...)`):

```js
waSocket.on('connect', () => {})
waSocket.on('ready', () => {})
waSocket.on('message', (m) => m.reply('pong'))
waSocket.on('group.add', (ctx) => {})
waSocket.on('poll', (ctx) => {})
waSocket.on('presence.update', (ctx) => {})
waSocket.on('lid-mapping', (ctx) => {})
waSocket.on('error', (error) => {})
```

Native zapo events are re-emitted verbatim on the same emitter (full event pipe):

```js
waSocket.ev.on('history_sync_chunk', (update) => {})
waSocket.ev.on('messages.upsert', (update) => {})
waSocket.ev.on('group-participants.update', (update) => {})
```

## Messaging helpers

```js
const sock = waSocket.sock

await sock.reply(jid, 'Hello!', m)
await sock.sendReact(jid, '💀', m.key)
await sock.sendFile(jid, source, 'image.jpg', 'Caption', m, { document: true })
await sock.sendSticker(jid, source, m, { packname: 'Sticker by', author: 'me' })
await sock.sendPoll(jid, 'Question?', { options: ['Yes', 'No'] }, m)
await sock.pollResult(jid, { name: 'Result', votes: [{ name: 'A', count: 3 }] }, m)
await sock.sendContact(jid, [{ name: 'A', number: '6285…', about: 'Owner' }], m, { org: 'Nexray' })
await sock.sendIAMessage(jid, buttons, m, { header: '', content: 'Hi!', footer: '' })
await sock.sendCarousel(jid, cards, m, { content: 'Hi!' })
await sock.sendFromAI(jid, 'Hi!', m)
await sock.copyNForward(jid, m)
```

## Raw proto

Advanced features are sent as raw proto and are **never reinterpreted**:

```js
await sock.sendMessage(jid, {
  interactiveMessage: {
    body: { text: 'Choose' },
    nativeFlowMessage: {
      buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Menu', id: '.menu' }) }]
    }
  }
})
```

Geometry such as `polygonVertices` is preserved verbatim.

Advanced media fields pass through high-level media sends too:

```js
await sock.sendMessage(jid, {
  image,
  caption: 'Tap the tag',
  imageSourceType: 1,
  contextInfo: { mentionedJids: [jid] },
  interactiveAnnotations: [{ polygonVertices: [{ x: 1, y: 2 }] }]
})
```

A live/motion photo is one `sendFile` call whose input is the clip — the still
that tags it is grabbed from the clip (or taken from `thumbnail`), then both
halves go out through the engine's own media path with `pairedMediaType`:

```js
await sock.sendFile(jid, clip, 'live.mp4', 'Caption', m, {
  photo_live: true,
  thumbnail: stillJpeg, // optional; a frame is extracted when omitted
  stillMaxEdge: 480,    // still frame size cap (default 480)
  stillQuality: 55      // still JPEG quality (default 55)
})
```

## Utils

```js
Utils.size(bytes)                 // "2.00 KB" | boolean with threshold
await Utils.sharp(buffer)         // 300x300 cover JPEG Buffer
Utils.random(arr)
Utils.texted('bold', 'x')         // *x*
Utils.example('.', 'menu', 'help')
Utils.isURL / isUrlValid / isUrlInText / extractLink
Utils.jsonFormat(data)            // circular-safe pretty JSON
```

## Architecture

```text
lib/
├── index.js            CJS entry
├── index.mjs           ESM bridge (createRequire -> index.js, forwards zapo-js)
├── core/               public Client lifecycle + messaging helpers
├── constant/           stable error codes + logs
├── types/              public data contracts
├── utils/              reusable helpers
└── internal/zapo/      protocol adapter
    ├── socket.js           Baileys-compatible facade
    ├── content.js          content translation + raw proto passthrough
    ├── events.js           event bridge
    ├── store.js            create_session -> zapo createStore
    ├── mediaProcessor.js   thumbnails / probe (WaMediaProcessor)
    ├── migrate.js          Baileys -> zapo auth migration
    └── websocket-polyfill.js
```

## Tests

```bash
npm test
```

## License

MIT
# tester-zapo
