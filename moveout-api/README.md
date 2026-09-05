# WI 64 Self Storage — move-out API

Cloudflare Worker behind the Move Out wizard at `https://wi64selfstorage.com/move-out`.
The site itself stays a static GitHub Pages site; this Worker owns the data.

| Piece | What it is |
|---|---|
| **D1** (`wi64_moveout`) | Requests, photo records, notification outbox |
| **R2** (`wi64-moveout-photos`) | The move-out photos themselves. Private — never public. |
| **Cloudflare Access** | Guards `/admin`. Staff sign in with their own email. |

## Routes

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/photos` | public | One photo, multipart. Returns a `photoId`. |
| POST | `/api/move-outs/scheduled` | public | Notice: name, phone, planned date. |
| POST | `/api/move-outs/completed` | public | Unit, phone, confirmations, `photoIds`. |
| GET  | `/admin` | staff | Both queues, with statuses. |
| GET  | `/admin/photo/:id` | staff | Streams one photo from R2. |
| POST | `/admin/status` | staff | New / Reviewed / Completed. |
| GET  | `/health` | public | Liveness. |

## Rules that must not be quietly broken

1. **The completed move-out timestamp comes from the server.** Never from the
   client. Anything the browser sends about a date is ignored.
2. **Photos are verified before a submission is accepted.** The server checks the
   rows exist, belong to that browser session, and cover all three required
   slots. A client cannot claim photos it did not upload.
3. **A notification failure must never fail a submission.** See `notifications.ts`.
4. **`/admin` fails closed.** Without Access configured it returns 503, not a page.
5. **No rent-roll matching.** Nothing here pretends to verify a unit or phone
   against storEDGE. The indexes for that exist; the logic deliberately does not.

## First-time setup

```bash
npm install
npx wrangler login

# Create the database, then paste the printed id into wrangler.toml
npx wrangler d1 create wi64_moveout
npx wrangler r2 bucket create wi64-moveout-photos

npm run migrate:remote     # applies migrations/ to the real D1
npm run deploy
```

Then, in the Cloudflare dashboard, create a **Zero Trust → Access → Application**
covering `<worker-host>/admin`, allow the staff emails, and set:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN   # e.g. wi64.cloudflareaccess.com
npx wrangler secret put CF_ACCESS_AUD           # the application's AUD tag
```
(or set them as `[vars]` — they are identifiers, not secrets, but keep them out
of git either way.)

Finally, point the site at the deployed Worker: set `API_BASE` at the top of
`js/move-out.js` to the Worker's URL.

## Local development

```bash
npm run migrate:local
npm run dev
```

## Checks

```bash
npm run typecheck
npm run lint
npm test          # Worker: D1 + R2 via miniflare
npm run test:web  # wizard in a real browser at iPhone widths
npm run build     # wrangler dry-run bundle
```

## What is deliberately not built

- **SMS sending.** No provider is chosen. Every confirmation is written to
  `notification_outbox` as PENDING; a provider drains it later. Adding one means
  implementing `NotificationSender` and selecting it in `getSender()` — nothing
  else changes.
- **Lease notice rules.** `CURRENT_NOTICE_POLICY` in `validation.ts` is empty, so
  no planned date is rejected for being too soon. Fill it in when the WI 64 lease
  question is settled; `checkPlannedDate` already enforces both a minimum notice
  period and month-end-only, and is unit-tested for both.
- **Rent-roll matching.** See rule 5 above.
