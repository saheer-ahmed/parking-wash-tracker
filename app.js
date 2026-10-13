// Parking Wash Tracker — Firebase version
// 1) Paste your Firebase web config into firebase-config.js (see SETUP.md).
// 2) Deploy. Every phone that opens the link shares the same live tickets.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = (s, r = document) => r.querySelector(s);
const STEPS = [
  ['booked', 'Booked', 'bookedAt'],
  ['verified', 'Car verified', 'verifiedAt'],
  ['washing', 'Washing', 'startedAt'],
  ['ready', 'Ready', 'completedAt'],
  ['closed', 'Paid', 'paidAt'],
];
const ORDER = { booked: 0, verified: 1, washing: 2, ready: 3, closed: 4, cancelled: -1 };
const LABEL = { booked: 'Waiting', verified: 'Verified', washing: 'Washing', ready: 'Ready', closed: 'Paid', cancelled: 'Cancelled' };

let fs = null;              // Firestore, null when not configured
let tickets = [];
const local = new Map();    // used only when Firebase isn't configured

// ---- per-device conveniences
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let mine = store.get('pwt-mine', []);
const attInput = $('#f-att');
attInput.value = store.get('pwt-att', '');
attInput.addEventListener('input', () => store.set('pwt-att', attInput.value.trim()));

// ---- helpers
const norm = p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const prettyPlate = p => {
  const n = norm(p); const m = n.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ') : String(p || '').toUpperCase().trim();
};
const t = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–';
const now = () => new Date().toISOString();
const today = iso => iso && new Date(iso).toDateString() === new Date().toDateString();
const mask = p => { const d = String(p || '').replace(/\D/g, ''); return d ? '••••• ' + d.slice(-4) : '–'; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = (tag) => {
  const d = new Date(); const md = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const r = tag || Array.from({ length: 3 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  return `FM-${md}-${r}`;
};
const isConfigured = c => c && c.apiKey && !String(c.apiKey).startsWith('PASTE');

// ---- data layer
async function write(id, data, merge) {
  if (fs) {
    const ref = doc(fs, 'tickets', id);
    return merge ? updateDoc(ref, data) : setDoc(ref, data);
  }
  local.set(id, merge ? { ...local.get(id), ...data } : data);
  tickets = [...local].map(([id, d]) => ({ id, ...d })).sort((a, b) => b.bookedAt.localeCompare(a.bookedAt));
  render();
}
const addAlert = (tk, text) => [...(tk.alerts || []), { at: now(), text }].slice(-12);

// ---- tabs
const tabs = ['customer', 'attendant', 'security'];
function show(name) {
  tabs.forEach(n => {
    $('#tab-' + n).setAttribute('aria-selected', String(n === name));
    $('#v-' + n).hidden = n !== name;
  });
  store.set('pwt-tab', name);
}
tabs.forEach(n => $('#tab-' + n).addEventListener('click', () => show(n)));
const hashTab = location.hash.replace('#', '');
show(tabs.includes(hashTab) ? hashTab : store.get('pwt-tab', 'customer'));

// ---- booking
$('#bookForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#bookErr'); err.hidden = true;
  const plate = $('#f-plate').value.trim(), bay = $('#f-bay').value.trim(), phone = $('#f-phone').value.trim();
  const problems = [];
  if (norm(plate).length < 6) problems.push('Enter the full car number, for example KA 19 MN 4821.');
  if (!bay) problems.push('Enter the parking bay so the attendant can find the car.');
  if (phone.replace(/\D/g, '').length < 10) problems.push('Enter a 10-digit WhatsApp number for alerts.');
  if (!$('#f-consent').checked) problems.push('Tick the authorisation box to book.');
  if (problems.length) { err.textContent = problems.join(' '); err.hidden = false; return; }
  const id = newId(); const at = now();
  const tk = { plate: prettyPlate(plate), plateKey: norm(plate), bay, phone, service: $('#f-service').value,
    status: 'booked', consent: true, bookedAt: at, alerts: [{ at, text: 'Booking confirmed with ticket ' + id }] };
  $('#bookBtn').disabled = true;
  try {
    await write(id, tk);
    mine = [id, ...mine.filter(x => x !== id)].slice(0, 10); store.set('pwt-mine', mine);
    $('#bookForm').reset();
  } catch {
    err.textContent = 'Booking didn’t go through. Check your connection and book again.';
    err.hidden = false;
  } finally { $('#bookBtn').disabled = false; render(); }
});

// ---- actions
async function act(id, action, extra) {
  const tk = tickets.find(x => x.id === id); if (!tk) return '';
  const att = attInput.value.trim();
  const patch = {};
  if (action === 'verify') {
    if (!att) return 'Enter your name as attendant on duty first.';
    if (norm(extra) !== tk.plateKey) return 'Car number doesn’t match the booking. Don’t start; check the bay with the customer.';
    Object.assign(patch, { status: 'verified', verifiedAt: now(), attendant: att, alerts: addAlert(tk, `Car verified by ${att}`) });
  }
  if (action === 'start') Object.assign(patch, { status: 'washing', startedAt: now(), alerts: addAlert(tk, 'Wash started. Before-photos taken') });
  if (action === 'done') Object.assign(patch, { status: 'ready', completedAt: now(), alerts: addAlert(tk, 'Your car is ready. Pay by UPI link') });
  if (action === 'paid') Object.assign(patch, { status: 'closed', paidAt: now(), alerts: addAlert(tk, 'Payment received. Ticket closed') });
  if (action === 'cancel') Object.assign(patch, { status: 'cancelled', cancelledAt: now(), alerts: addAlert(tk, 'Booking cancelled by customer') });
  try { await write(id, patch, true); } catch { return 'Update didn’t save. Try again.'; }
  return '';
}

// Photos are shrunk to a small JPEG and stored inside the ticket, so no paid storage is needed.
function shrink(file, max = 480) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}
async function addPhoto(id, kind, file) {
  if (!file) return '';
  try {
    const data = await shrink(file);
    const tk = tickets.find(x => x.id === id);
    const photos = { ...(tk.photos || {}), [kind]: data };
    await write(id, { photos }, true);
    return '';
  } catch { return 'Photo didn’t save. Try again or take a new photo.'; }
}

// ---- rendering
function stepsHTML(tk) {
  if (tk.status === 'cancelled') return '<p class="hint">This booking was cancelled before work started.</p>';
  const cur = ORDER[tk.status];
  return '<ol class="steps">' + STEPS.map(([k, name, f], i) =>
    `<li class="${i < cur || (i === cur && k === 'closed') ? 'done' : i === cur ? 'now' : ''}">${name}<time>${t(tk[f])}</time></li>`).join('') + '</ol>';
}
const safeImg = v => typeof v === 'string' && v.startsWith('data:image/jpeg;base64,') ? v : '';
function photosHTML(tk) {
  const p = tk.photos || {}; const out = [];
  if (safeImg(p.before)) out.push(`<figure><img src="${safeImg(p.before)}" alt="Before wash, ${esc(tk.plate)}">Before</figure>`);
  if (safeImg(p.after)) out.push(`<figure><img src="${safeImg(p.after)}" alt="After wash, ${esc(tk.plate)}">After</figure>`);
  return out.length ? `<div class="photos">${out.join('')}</div>` : '';
}
function headHTML(tk, showPhone) {
  const st = LABEL[tk.status] ? tk.status : 'booked';
  return `<div class="tk-head"><div class="row"><span class="plate">${esc(tk.plate)}</span>
    <span class="chip st-${st}">${LABEL[st]}</span>${tk.example ? '<span class="ex">Example</span>' : ''}</div>
    <span class="mono">${esc(tk.id)}</span></div>
    <div class="tk-meta"><span>Bay <b>${esc(tk.bay)}</b></span><span>${esc(tk.service)}</span>
    ${tk.attendant ? `<span>Attendant <b>${esc(tk.attendant)}</b></span>` : ''}
    ${showPhone ? `<span>WhatsApp <b>${esc(mask(tk.phone))}</b></span>` : ''}</div>`;
}

function renderCustomer() {
  const box = $('#myTickets');
  const list = mine.map(id => tickets.find(x => x.id === id)).filter(Boolean);
  if (!list.length) { box.innerHTML = '<div class="empty">Your ticket appears here after you book, with live updates as the attendant works on your car.</div>'; return; }
  box.innerHTML = list.map(tk => `<article class="card" data-id="${esc(tk.id)}">
    <h3>Your ticket</h3>${headHTML(tk, false)}${stepsHTML(tk)}${photosHTML(tk)}
    <div><h3>WhatsApp alerts</h3><ul class="alerts">${(tk.alerts || []).slice().reverse().map(a => `<li><span class="mono">${t(a.at)}</span> ${esc(a.text)}</li>`).join('')}</ul></div>
    ${tk.status === 'booked' ? '<div class="row"><button class="btn warn" data-act="cancel">Cancel booking</button></div>' : ''}
    <p class="err" hidden></p></article>`).join('');
}

function renderQueue() {
  const box = $('#queue');
  const open = tickets.filter(x => !['closed', 'cancelled'].includes(x.status));
  if (!open.length) { box.innerHTML = '<div class="empty">No open bookings. New tickets appear here the moment a customer books.</div>'; return; }
  box.innerHTML = open.map(tk => {
    let actions = '';
    if (tk.status === 'booked') actions = `<div class="verify"><label>Car number on the plate<input class="vplate" autocomplete="off" placeholder="Type what you see"></label><button class="btn go" data-act="verify">Verify car</button></div>`;
    if (tk.status === 'verified') actions = `<div class="row"><label class="btn alt">Add before-photo<input type="file" accept="image/*" capture="environment" data-photo="before" hidden></label><button class="btn go" data-act="start">Start wash</button></div>`;
    if (tk.status === 'washing') actions = `<div class="row"><label class="btn alt">Add after-photo<input type="file" accept="image/*" capture="environment" data-photo="after" hidden></label><button class="btn go" data-act="done">Wash complete</button></div>`;
    if (tk.status === 'ready') actions = `<div class="row"><button class="btn go" data-act="paid">UPI payment received</button></div>`;
    return `<article class="card" data-id="${esc(tk.id)}">${headHTML(tk, true)}${stepsHTML(tk)}${photosHTML(tk)}${actions}<p class="err" hidden></p></article>`;
  }).join('');
}

function renderSecurity() {
  const todays = tickets.filter(x => today(x.bookedAt));
  const n = s => todays.filter(x => s.includes(x.status)).length;
  $('#stats').innerHTML = [
    ['Waiting', n(['booked'])], ['In progress', n(['verified', 'washing'])], ['Ready for owner', n(['ready'])], ['Closed today', n(['closed'])],
  ].map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('#logBody').innerHTML = todays.length ? todays.map(tk => {
    const st = LABEL[tk.status] ? tk.status : 'booked';
    return `<tr>
    <td class="t">${esc(tk.id)}${tk.example ? ' <span class="ex">Ex</span>' : ''}</td><td class="t">${esc(tk.plate)}</td><td>${esc(tk.bay)}</td><td>${esc(tk.service)}</td>
    <td><span class="chip st-${st}">${LABEL[st]}</span></td><td>${esc(tk.attendant || '–')}</td>
    <td class="t">${t(tk.bookedAt)}</td><td class="t">${t(tk.verifiedAt)}</td><td class="t">${t(tk.startedAt)}</td><td class="t">${t(tk.completedAt)}</td><td class="t">${t(tk.paidAt)}</td></tr>`;
  }).join('')
    : '<tr><td colspan="11"><div class="empty">No jobs logged today. Each booking appears here with every step timed.</div></td></tr>';
}

function render() { renderCustomer(); renderQueue(); renderSecurity(); }

// ---- delegated events
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const card = b.closest('[data-id]'); const id = card.dataset.id;
  const errEl = card.querySelector('.err');
  b.disabled = true;
  const extra = b.dataset.act === 'verify' ? card.querySelector('.vplate').value : undefined;
  const msg = await act(id, b.dataset.act, extra);
  b.disabled = false;
  if (msg && errEl) { errEl.textContent = msg; errEl.hidden = false; }
});
document.addEventListener('change', async e => {
  const inp = e.target.closest('[data-photo]'); if (!inp) return;
  const card = inp.closest('[data-id]');
  const msg = await addPhoto(card.dataset.id, inp.dataset.photo, inp.files[0]);
  if (msg) { const el = card.querySelector('.err'); el.textContent = msg; el.hidden = false; }
});

// ---- download today's log
$('#dlBtn').addEventListener('click', () => {
  const rows = [['Ticket', 'Car', 'Bay', 'Service', 'Status', 'Attendant', 'Booked', 'Verified', 'Started', 'Completed', 'Paid', 'Consent']];
  tickets.filter(x => today(x.bookedAt)).forEach(tk => rows.push([tk.id, tk.plate, tk.bay, tk.service, LABEL[tk.status] || tk.status, tk.attendant || '',
    tk.bookedAt || '', tk.verifiedAt || '', tk.startedAt || '', tk.completedAt || '', tk.paidAt || '', tk.consent ? 'Yes' : 'No']));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `wash-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---- example tickets for demos (marked "Example")
$('#exBtn').addEventListener('click', async () => {
  const d = new Date(); const at = m => new Date(d.getTime() - m * 60000).toISOString();
  const ex = [
    [newId('EX1'), { plate: 'KA 19 MN 4821', plateKey: 'KA19MN4821', bay: 'B1 – 12', service: 'Exterior eco wash', status: 'closed', attendant: 'Example attendant',
      bookedAt: at(100), verifiedAt: at(96), startedAt: at(94), completedAt: at(72), paidAt: at(60) }],
    [newId('EX2'), { plate: 'KA 19 P 7350', plateKey: 'KA19P7350', bay: 'B2 – 47', service: 'Full wash, inside and out', status: 'washing', attendant: 'Example attendant',
      bookedAt: at(40), verifiedAt: at(34), startedAt: at(32) }],
    [newId('EX3'), { plate: 'KA 19 AB 1093', plateKey: 'KA19AB1093', bay: 'B1 – 30', service: 'Steam interior cleaning', status: 'booked', bookedAt: at(5) }],
  ];
  $('#exBtn').disabled = true;
  try {
    for (const [id, tk] of ex) await write(id, { ...tk, example: true, phone: '9800000000', consent: true, alerts: [{ at: tk.bookedAt, text: 'Booking confirmed with ticket ' + id }] });
  } catch {}
  $('#exBtn').disabled = false;
});

render();

// ---- connect
const setLive = (on, text) => { $('#liveDot').classList.toggle('on', on); $('#liveText').textContent = text; };
if (isConfigured(firebaseConfig)) {
  try {
    fs = getFirestore(initializeApp(firebaseConfig));
    onSnapshot(query(collection(fs, 'tickets'), orderBy('bookedAt', 'desc'), limit(300)), snap => {
      tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setLive(true, 'Live: all screens update together');
      render();
    }, () => setLive(false, 'Can’t reach the database. Check the setup steps.'));
    setLive(false, 'Connecting…');
  } catch {
    fs = null; setLive(false, 'Firebase settings are invalid. Check firebase-config.js.');
    $('#offline').hidden = false;
  }
} else {
  setLive(false, 'This screen only');
  $('#offline').hidden = false;
}
