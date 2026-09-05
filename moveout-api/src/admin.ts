import type { MoveOutRow, PhotoRow } from './types';

const SLOT_LABEL: Record<string, string> = {
  INSIDE: 'Inside the unit',
  FLOOR: 'Floor / empty unit',
  DOOR: 'Door + unit number, lock removed',
  EXTRA: 'Additional photo',
};

export function photoResponseHeaders(photo: PhotoRow): Record<string, string> {
  return {
    'Content-Type': photo.content_type,
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `inline; filename="${photo.slot.toLowerCase()}-${photo.id}.jpg"`,
    'X-Content-Type-Options': 'nosniff',
  };
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

function fmtDate(isoDate: string | null): string {
  if (!isoDate) return '—';
  return new Date(isoDate + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function statusPill(status: string): string {
  const tone = status === 'NEW' ? 'new' : status === 'REVIEWED' ? 'rev' : 'done';
  const label = status === 'NEW' ? 'New' : status === 'REVIEWED' ? 'Reviewed' : 'Completed';
  return `<span class="pill ${tone}">${label}</span>`;
}

function statusForm(row: MoveOutRow, back: string): string {
  const options = (['NEW', 'REVIEWED', 'COMPLETED'] as const)
    .map((s) => `<option value="${s}"${row.status === s ? ' selected' : ''}>${s === 'NEW' ? 'New' : s === 'REVIEWED' ? 'Reviewed' : 'Completed'}</option>`)
    .join('');
  return `<form method="post" action="/admin/status?back=${encodeURIComponent(back)}" class="sf">
    <input type="hidden" name="id" value="${esc(row.id)}">
    <select name="status" aria-label="Status">${options}</select>
    <button type="submit">Save</button>
  </form>`;
}

export interface AdminView {
  rows: MoveOutRow[];
  counts: Map<string, number>;
  filterType: string;
  filterStatus: string;
  detailId: string | null;
  detailPhotos: PhotoRow[];
  viewer: string;
}

export function adminPage(v: AdminView): string {
  const scheduled = v.rows.filter((r) => r.type === 'SCHEDULED_MOVE_OUT');
  const completed = v.rows.filter((r) => r.type === 'COMPLETED_MOVE_OUT');
  const backQS = `/admin?type=${encodeURIComponent(v.filterType)}&status=${encodeURIComponent(v.filterStatus)}`;

  const detailRow = v.detailId ? v.rows.find((r) => r.id === v.detailId) : undefined;

  const detail = detailRow
    ? `<section class="detail">
         <div class="dhead">
           <h2>Unit ${esc(detailRow.unit_number ?? '—')} · ${esc(detailRow.phone_display)}</h2>
           <a class="close" href="${esc(backQS)}">Close ✕</a>
         </div>
         <dl class="kv">
           <div><dt>Move-out date</dt><dd>${fmtDateTime(detailRow.completed_at)}</dd></div>
           <div><dt>Submitted</dt><dd>${fmtDateTime(detailRow.submitted_at)}</dd></div>
           <div><dt>Status</dt><dd>${statusPill(detailRow.status)}</dd></div>
           <div><dt>Confirmations</dt><dd>${
             detailRow.confirmed_empty && detailRow.confirmed_swept && detailRow.confirmed_lock_removed
               ? '✅ Empty &nbsp; ✅ Swept &nbsp; ✅ Lock removed'
               : '⚠️ Incomplete'
           }</dd></div>
         </dl>
         <div class="shots">
           ${v.detailPhotos.length === 0 ? '<p class="empty">No photos attached.</p>' : ''}
           ${v.detailPhotos.map((p) => `
             <figure>
               <a href="/admin/photo/${esc(p.id)}" target="_blank" rel="noopener">
                 <img src="/admin/photo/${esc(p.id)}" alt="${esc(SLOT_LABEL[p.slot] ?? p.slot)}" loading="lazy">
               </a>
               <figcaption>${esc(SLOT_LABEL[p.slot] ?? p.slot)}<span>${Math.round(p.bytes / 1024)} KB</span></figcaption>
             </figure>`).join('')}
         </div>
       </section>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Move-Out Requests · WI 64</title>
<style>
:root{--bg:#F4F6F1;--card:#fff;--ink:#161B12;--ink2:#4A5344;--grey:#79826F;
      --line:#DFE4D9;--green:#2E7D32;--green-wash:#E9F2E7;--amber:#B4560A;--amber-wash:#FBEEE1;--blue:#1B4F72}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{background:var(--green);color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
header h1{margin:0;font-size:18px;letter-spacing:-.01em}
header .who{font-size:12.5px;opacity:.85}
main{padding:22px;max-width:1280px;margin:0 auto}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.filters a{font-size:13px;font-weight:600;text-decoration:none;color:var(--ink2);background:var(--card);
  border:1px solid var(--line);border-radius:99px;padding:7px 14px}
.filters a.on{background:var(--green);border-color:var(--green);color:#fff}
h2{font-size:16px;margin:26px 0 10px;letter-spacing:-.01em}
h2 .n{color:var(--grey);font-weight:400;font-size:13px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:760px;font-size:14px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--grey);background:#F8FAF6;font-weight:600}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#FBFCFA}
.mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.unit{font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em}
.pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  border-radius:99px;padding:3px 10px}
.pill.new{background:var(--amber-wash);color:var(--amber)}
.pill.rev{background:#E7EFF6;color:var(--blue)}
.pill.done{background:var(--green-wash);color:var(--green)}
.sf{display:flex;gap:6px}
.sf select{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line);border-radius:7px;background:#fff}
.sf button{font:inherit;font-size:13px;font-weight:600;padding:5px 12px;border:1px solid var(--green);
  background:var(--green);color:#fff;border-radius:7px;cursor:pointer}
a.view{font-weight:600;color:var(--green);text-decoration:none}
a.view:hover{text-decoration:underline}
.empty{color:var(--grey);padding:22px 14px;margin:0}
.detail{background:var(--card);border:2px solid var(--green);border-radius:10px;padding:20px 22px;margin-bottom:26px}
.dhead{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
.dhead h2{margin:0}
.close{font-size:13px;font-weight:600;color:var(--grey);text-decoration:none}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:16px 0 20px}
.kv dt{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--grey);margin-bottom:3px}
.kv dd{margin:0;font-weight:600}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.shots figure{margin:0}
.shots img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;border:1px solid var(--line);display:block;background:#EEE}
.shots figcaption{font-size:12px;color:var(--ink2);margin-top:6px;display:flex;justify-content:space-between;gap:8px}
.shots figcaption span{color:var(--grey)}
.note{font-size:12.5px;color:var(--grey);margin:22px 0 0}
</style></head>
<body>
<header>
  <h1>Move-Out Requests · WI 64 Self Storage</h1>
  <span class="who">${esc(v.viewer)}</span>
</header>
<main>
  <div class="filters">
    <a href="/admin" class="${!v.filterType && !v.filterStatus ? 'on' : ''}">All</a>
    <a href="/admin?status=NEW" class="${v.filterStatus === 'NEW' ? 'on' : ''}">New only</a>
    <a href="/admin?type=COMPLETED_MOVE_OUT" class="${v.filterType === 'COMPLETED_MOVE_OUT' ? 'on' : ''}">Completed move-outs</a>
    <a href="/admin?type=SCHEDULED_MOVE_OUT" class="${v.filterType === 'SCHEDULED_MOVE_OUT' ? 'on' : ''}">Scheduled notices</a>
  </div>

  ${detail}

  <h2>Completed move-outs <span class="n">${completed.length}</span></h2>
  <div class="wrap"><table>
    <thead><tr><th>Unit</th><th>Phone</th><th>Move-out date</th><th>Photos</th><th>Confirmations</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${completed.length === 0 ? '<tr><td colspan="7" class="empty">Nothing here yet.</td></tr>' : ''}
      ${completed.map((r) => `<tr>
        <td class="unit">${esc(r.unit_number)}</td>
        <td class="mono">${esc(r.phone_display)}</td>
        <td class="mono">${fmtDateTime(r.completed_at)}</td>
        <td>${v.counts.get(r.id) ?? 0}</td>
        <td>${r.confirmed_empty && r.confirmed_swept && r.confirmed_lock_removed ? '✅ all three' : '⚠️'}</td>
        <td>${statusPill(r.status)}</td>
        <td><a class="view" href="${esc(backQS)}&id=${esc(r.id)}">View photos</a> ${statusForm(r, backQS)}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>

  <h2>Scheduled move-out notices <span class="n">${scheduled.length}</span></h2>
  <div class="wrap"><table>
    <thead><tr><th>Name</th><th>Phone</th><th>Planned move-out</th><th>Notice submitted</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${scheduled.length === 0 ? '<tr><td colspan="6" class="empty">Nothing here yet.</td></tr>' : ''}
      ${scheduled.map((r) => `<tr>
        <td>${esc(r.customer_name)}</td>
        <td class="mono">${esc(r.phone_display)}</td>
        <td class="mono">${fmtDate(r.planned_move_out_date)}</td>
        <td class="mono">${fmtDateTime(r.submitted_at)}</td>
        <td>${statusPill(r.status)}</td>
        <td>${statusForm(r, backQS)}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>

  <p class="note">Times shown in Central. Submissions are not matched to the rent roll — verify the unit and phone in storEDGE before processing.</p>
</main>
</body></html>`;
}
