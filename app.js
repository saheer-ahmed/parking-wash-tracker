// Parking Wash Tracker — Firebase version with staff logins and required photos.
// Customers book without an account and only ever see their own ticket.
// Staff sign in; the owner gives each account a role (attendant or mall security) on the Staff tab.

import { firebaseConfig } from './firebase-config.js';
import { business } from './settings.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const app = initializeApp(firebaseConfig);
const fs = getFirestore(app);
const auth = getAuth(app);

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
const ROLE_LABEL = { owner: 'Owner', attendant: 'Attendant', security: 'Mall security', pending: 'Waiting for approval', none: 'No access' };
const ALLOW = { attendant: ['attendant', 'owner'], security: ['security', 'owner'], staff: ['owner'] };

// ---- state
let user = null, profile = null;
let tickets = [];                 // staff view: all recent tickets
const myTickets = new Map();      // customer view: only this device's tickets
let staff = [];
let current = 'customer';
let detailId = null;
const unsubs = { profile: null, tickets: null, staff: null, mine: new Map() };

// ---- per-device conveniences
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let mine = store.get('pwt-mine2', []);

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
const newCode = (tag) => {
  const d = new Date(); const md = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const r = tag || Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  return `FM-${md}-${r}`;
};
const code = tk => tk.code || tk.id;
const role = () => profile?.role || (user ? 'pending' : null);
const can = view => !!user && (ALLOW[view] || []).includes(role());
const addAlert = (tk, text) => [...(tk.alerts || []), { at: now(), text }].slice(-12);
// ---- WhatsApp and UPI links
const waNumber = p => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d.length >= 11 ? d : '';
};
const price = tk => Number(business.prices?.[tk.service] || 0);
function waMessage(tk) {
  const c = code(tk);
  const amt = price(tk) ? ` ₹${price(tk)}` : '';
  const upi = business.upiId ? ` to UPI ID ${business.upiId}` : '';
  return ({
    booked: `Hi, your car ${tk.plate} is booked for ${tk.service} at bay ${tk.bay}. Ticket ${c}. We'll message you when the wash starts.`,
    verified: `Hi, we've found your car ${tk.plate} at bay ${tk.bay} and will start the ${tk.service} shortly. Ticket ${c}.`,
    washing: `Your car ${tk.plate} is being washed now. Ticket ${c}. We'll message you when it's ready.`,
    ready: `Your car ${tk.plate} is ready at bay ${tk.bay}. Please pay${amt} by UPI${upi}. Ticket ${c}. Thank you!`,
  })[tk.status] || '';
}
function waLink(tk) {
  const n = waNumber(tk.phone); const m = waMessage(tk);
  return n && m ? `https://wa.me/${n}?text=${encodeURIComponent(m)}` : '';
}
function upiLink(tk) {
  if (!business.upiId) return '';
  const q = { pa: business.upiId, pn: business.payeeName || 'Parking Wash', tn: `Car wash ${code(tk)}`, cu: 'INR' };
  if (price(tk)) q.am = String(price(tk));
  return 'upi://pay?' + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const findTicket = id => tickets.find(x => x.id === id) || (myTickets.has(id) ? { id, ...myTickets.get(id) } : null);

// ---- tabs and access
const TABS = ['customer', 'attendant', 'security', 'staff'];
function show(name) {
  current = name;
  TABS.forEach(n => $('#tab-' + n).setAttribute('aria-selected', String(n === name)));
  TABS.forEach(n => { $('#v-' + n).hidden = true; });
  $('#v-signin').hidden = true;
  if (name === 'customer' || can(name)) {
    $('#v-' + name).hidden = false;
  } else {
    $('#v-signin').hidden = false;
    $('#signinCard').hidden = !!user;
    $('#pendingCard').hidden = !(user && ['pending', 'none'].includes(role()));
    $('#noAccessCard').hidden = !(user && !['pending', 'none'].includes(role()));
    if (user && role() === 'none') {
      $('#pendingCard').querySelector('p').textContent = 'Your access has been removed. Contact the owner if this is a mistake.';
    }
    $('#noAccessText').textContent = `You’re signed in as ${ROLE_LABEL[role()] || role()}. Use the ${role() === 'security' ? 'Mall security' : 'Attendant'} tab.`;
  }
  store.set('pwt-tab', name);
}
TABS.forEach(n => $('#tab-' + n).addEventListener('click', () => { if (location.hash) history.replaceState(null, '', location.pathname); show(n); }));

function refreshWho() {
  $('#whoBox').hidden = !user;
  if (user) {
    $('#whoName').textContent = profile?.name || user.email;
    $('#whoRole').textContent = ROLE_LABEL[role()] || role();
  }
  $('#tab-staff').hidden = role() !== 'owner';
  $('#exBtn').hidden = role() !== 'owner';
}

// ---- customer booking (no account needed)
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
  const ref = doc(collection(fs, 'tickets'));   // random 20-character id: only this phone knows it
  const c = newCode(); const at = now();
  const tk = { code: c, plate: prettyPlate(plate), plateKey: norm(plate), bay, phone, service: $('#f-service').value,
    status: 'booked', consent: true, bookedAt: at, alerts: [{ at, text: 'Booking confirmed with ticket ' + c }] };
  $('#bookBtn').disabled = true;
  try {
    await setDoc(ref, tk);
    mine = [ref.id, ...mine.filter(x => x !== ref.id)].slice(0, 10); store.set('pwt-mine2', mine);
    watchMine();
    $('#bookForm').reset();
  } catch {
    err.textContent = 'Booking didn’t go through. Check your connection and book again.';
    err.hidden = false;
  } finally { $('#bookBtn').disabled = false; }
});

function watchMine() {
  mine.forEach(id => {
    if (unsubs.mine.has(id)) return;
    unsubs.mine.set(id, onSnapshot(doc(fs, 'tickets', id), snap => {
      if (snap.exists()) myTickets.set(id, snap.data()); else myTickets.delete(id);
      renderCustomer();
    }, () => {}));
  });
}

// ---- staff sign in
let signUpMode = false;
function setMode(up) {
  signUpMode = up;
  $('#nameWrap').hidden = !up;
  $('#signinTitle').textContent = up ? 'Create a staff account' : 'Staff sign in';
  $('#authBtn').textContent = up ? 'Create account' : 'Sign in';
  $('#modeBtn').textContent = up ? 'Already have an account? Sign in' : 'New staff member? Create an account';
  $('#a-pass').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
  $('#authErr').hidden = true; $('#authOk').hidden = true;
}
$('#modeBtn').addEventListener('click', () => setMode(!signUpMode));
const authMsg = c => ({
  'auth/invalid-credential': 'Email or password is wrong.',
  'auth/wrong-password': 'Email or password is wrong.',
  'auth/user-not-found': 'No account with this email. Create one first.',
  'auth/email-already-in-use': 'This email already has an account. Sign in instead.',
  'auth/weak-password': 'Use a password with at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/operation-not-allowed': 'Email sign-in isn’t switched on in Firebase yet (see SETUP.md).',
}[c] || 'Something went wrong. Check your connection and try again.');

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#authErr'); err.hidden = true;
  const email = $('#a-email').value.trim(), pass = $('#a-pass').value, name = $('#a-name').value.trim();
  if (signUpMode && !name) { err.textContent = 'Enter your name. It appears on the tickets you handle.'; err.hidden = false; return; }
  $('#authBtn').disabled = true;
  try {
    if (signUpMode) {
      store.set('pwt-pending-name', name);
      await createUserWithEmailAndPassword(auth, email, pass);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
    $('#a-pass').value = '';
  } catch (x) { err.textContent = authMsg(x.code); err.hidden = false; }
  $('#authBtn').disabled = false;
});
$('#resetBtn').addEventListener('click', async () => {
  const email = $('#a-email').value.trim(); const err = $('#authErr'), ok = $('#authOk');
  err.hidden = true; ok.hidden = true;
  if (!email) { err.textContent = 'Enter your email first, then tap Forgot password.'; err.hidden = false; return; }
  try { await sendPasswordResetEmail(auth, email); ok.textContent = 'Reset link sent. Check your email.'; ok.hidden = false; }
  catch (x) { err.textContent = authMsg(x.code); err.hidden = false; }
});
$('#signOutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, u => {
  user = u; profile = null;
  ['profile', 'tickets', 'staff'].forEach(k => { if (unsubs[k]) { unsubs[k](); unsubs[k] = null; } });
  tickets = []; staff = [];
  if (!u) { refreshWho(); show(current); renderStaffViews(); return; }
  const ref = doc(fs, 'roles', u.uid);
  unsubs.profile = onSnapshot(ref, async snap => {
    if (!snap.exists()) {
      const name = store.get('pwt-pending-name', '') || u.email.split('@')[0];
      try { await setDoc(ref, { role: 'pending', name, email: u.email, createdAt: now() }); } catch {}
      return;
    }
    const prev = profile?.role;
    profile = snap.data();
    refreshWho();
    if (prev !== profile.role) startStaffFeeds();
    show(current);
  }, () => { refreshWho(); show(current); });
  refreshWho(); show(current);
});

function startStaffFeeds() {
  ['tickets', 'staff'].forEach(k => { if (unsubs[k]) { unsubs[k](); unsubs[k] = null; } });
  tickets = []; staff = [];
  if (['attendant', 'security', 'owner'].includes(role())) {
    unsubs.tickets = onSnapshot(query(collection(fs, 'tickets'), orderBy('bookedAt', 'desc'), limit(300)), snap => {
      tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderStaffViews();
    }, () => { $('#offline').hidden = false; });
  }
  if (role() === 'owner') {
    unsubs.staff = onSnapshot(collection(fs, 'roles'), snap => {
      staff = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      renderStaff();
    }, () => {});
  }
  renderStaffViews();
}

// ---- job actions (attendant or owner)
async function act(id, action, extra) {
  const tk = findTicket(id); if (!tk) return '';
  const patch = {};
  const by = profile?.name || 'Staff';
  if (action === 'cancel') {
    Object.assign(patch, { status: 'cancelled', cancelledAt: now(), alerts: addAlert(tk, 'Booking cancelled') });
  } else if (action === 'pay') {
    if (tk.status !== 'ready') return 'Payment opens when your car is ready.';
    Object.assign(patch, { status: 'closed', paidAt: now(), paidVia: 'Customer (demo)', alerts: addAlert(tk, 'Payment received. Ticket closed. Thank you!') });
  } else {
    if (!can('attendant')) return 'Only attendants can update jobs.';
    if (action === 'verify') {
      if (norm(extra) !== tk.plateKey) return 'Car number doesn’t match the booking. Don’t start; check the bay with the customer.';
      Object.assign(patch, { status: 'verified', verifiedAt: now(), attendant: by, attendantUid: user.uid, alerts: addAlert(tk, `Car verified by ${by}`) });
    }
    if (action === 'start') {
      if (!tk.photos?.before) return 'Take the before-photo first.';
      Object.assign(patch, { status: 'washing', startedAt: now(), alerts: addAlert(tk, 'Wash started. Before-photo taken') });
    }
    if (action === 'done') {
      if (!tk.photos?.after) return 'Take the after-photo first.';
      Object.assign(patch, { status: 'ready', completedAt: now(), alerts: addAlert(tk, 'Your car is ready. Pay by UPI link') });
    }
    if (action === 'paid') Object.assign(patch, { status: 'closed', paidAt: now(), alerts: addAlert(tk, 'Payment received. Ticket closed') });
  }
  try { await updateDoc(doc(fs, 'tickets', id), patch); } catch { return 'Update didn’t save. Check your connection and try again.'; }
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
    const tk = findTicket(id);
    await updateDoc(doc(fs, 'tickets', id), { photos: { ...(tk.photos || {}), [kind]: data, [kind + 'At']: now() } });
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
  if (safeImg(p.before)) out.push(`<figure><img src="${safeImg(p.before)}" alt="Before wash, ${esc(tk.plate)}">Before · ${t(p.beforeAt)}</figure>`);
  if (safeImg(p.after)) out.push(`<figure><img src="${safeImg(p.after)}" alt="After wash, ${esc(tk.plate)}">After · ${t(p.afterAt)}</figure>`);
  return out.length ? `<div class="photos">${out.join('')}</div>` : '';
}
function headHTML(tk, showPhone) {
  const st = LABEL[tk.status] ? tk.status : 'booked';
  return `<div class="tk-head"><div class="row"><span class="plate">${esc(tk.plate)}</span>
    <span class="chip st-${st}">${LABEL[st]}</span>${tk.example ? '<span class="ex">Example</span>' : ''}</div>
    <span class="mono">${esc(code(tk))}</span></div>
    <div class="tk-meta"><span>Bay <b>${esc(tk.bay)}</b></span><span>${esc(tk.service)}</span>
    ${tk.attendant ? `<span>Attendant <b>${esc(tk.attendant)}</b></span>` : ''}
    ${showPhone ? `<span>WhatsApp <b>${esc(mask(tk.phone))}</b></span>` : ''}</div>`;
}
const alertsHTML = tk => `<div><h3>WhatsApp alerts</h3><ul class="alerts">${(tk.alerts || []).slice().reverse().map(a => `<li><span class="mono">${t(a.at)}</span> ${esc(a.text)}</li>`).join('')}</ul></div>`;

function renderCustomer() {
  const box = $('#myTickets');
  const list = mine.filter(id => myTickets.has(id)).map(id => ({ id, ...myTickets.get(id) }));
  if (!list.length) { box.innerHTML = '<div class="empty">Your ticket appears here after you book, with live updates as the attendant works on your car.</div>'; return; }
  box.innerHTML = list.map(tk => `<article class="card" data-id="${esc(tk.id)}">
    <h3>Your ticket</h3>${headHTML(tk, false)}${stepsHTML(tk)}${photosHTML(tk)}${alertsHTML(tk)}
    ${tk.status === 'booked' ? '<div class="row"><button class="btn warn" data-act="cancel">Cancel booking</button></div>' : ''}
    ${tk.status === 'ready' ? payHTML(tk) : ''}
    <p class="err" hidden></p></article>`).join('');
}
function payHTML(tk) {
  const amt = price(tk) ? ` ₹${price(tk)}` : '';
  return `<div class="pay"><div class="row"><button class="btn go" data-act="pay">Pay${amt} now</button></div>
    <p class="hint">Demo payment: tapping marks the ticket as paid. No money is taken.</p></div>`;
}

function photoBtn(kind, has) {
  return `<label class="btn ${has ? 'alt' : 'go'}">${has ? 'Retake' : 'Take'} ${kind}-photo<input type="file" accept="image/*" capture="environment" data-photo="${kind}" hidden></label>`;
}
function renderQueue() {
  const box = $('#queue');
  const open = tickets.filter(x => !['closed', 'cancelled'].includes(x.status));
  if (!open.length) { box.innerHTML = '<div class="empty">No open bookings. New tickets appear here the moment a customer books.</div>'; return; }
  box.innerHTML = open.map(tk => {
    const p = tk.photos || {};
    let actions = '';
    if (tk.status === 'booked') actions = `<div class="verify"><label>Car number on the plate<input class="vplate" autocomplete="off" placeholder="Type what you see"></label><button class="btn go" data-act="verify">Verify car</button></div>`;
    if (tk.status === 'verified') actions = `<div class="row">${photoBtn('before', !!p.before)}<button class="btn ${p.before ? 'go' : 'alt'}" data-act="start" ${p.before ? '' : 'disabled'}>Start wash</button></div>${p.before ? '' : '<p class="hint">Take the before-photo to unlock Start wash.</p>'}`;
    if (tk.status === 'washing') actions = `<div class="row">${photoBtn('after', !!p.after)}<button class="btn ${p.after ? 'go' : 'alt'}" data-act="done" ${p.after ? '' : 'disabled'}>Wash complete</button></div>${p.after ? '' : '<p class="hint">Take the after-photo to unlock Wash complete.</p>'}`;
    if (tk.status === 'ready') actions = `<div class="row"><button class="btn go" data-act="paid">UPI payment received</button></div>`;
    const wa = waLink(tk);
    const waBtn = wa ? `<a class="btn alt wa" href="${esc(wa)}" target="_blank" rel="noopener">Send WhatsApp update</a>` : '';
    return `<article class="card" data-id="${esc(tk.id)}">${headHTML(tk, true)}${stepsHTML(tk)}${photosHTML(tk)}${actions}${waBtn ? `<div class="row">${waBtn}</div>` : ''}<p class="err" hidden></p></article>`;
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
    const ph = (tk.photos?.before ? 'Before' : '') + (tk.photos?.before && tk.photos?.after ? ' + ' : '') + (tk.photos?.after ? 'After' : '');
    return `<tr>
    <td class="t"><button class="link mono" data-detail="${esc(tk.id)}">${esc(code(tk))}</button>${tk.example ? ' <span class="ex">Ex</span>' : ''}</td><td class="t">${esc(tk.plate)}</td><td>${esc(tk.bay)}</td><td>${esc(tk.service)}</td>
    <td><span class="chip st-${st}">${LABEL[st]}</span></td><td>${esc(tk.attendant || '–')}</td><td>${ph || '–'}</td>
    <td class="t">${t(tk.bookedAt)}</td><td class="t">${t(tk.verifiedAt)}</td><td class="t">${t(tk.startedAt)}</td><td class="t">${t(tk.completedAt)}</td><td class="t">${t(tk.paidAt)}</td></tr>`;
  }).join('')
    : '<tr><td colspan="12"><div class="empty">No jobs logged today. Each booking appears here with every step timed.</div></td></tr>';
  const d = detailId && tickets.find(x => x.id === detailId);
  $('#detail').innerHTML = d ? `<article class="card"><div class="row" style="justify-content:space-between"><h3>Ticket ${esc(code(d))}</h3><button class="link" data-detail="">Close</button></div>
    ${headHTML(d, true)}${stepsHTML(d)}${photosHTML(d) || '<p class="hint">No photos yet.</p>'}${alertsHTML(d)}</article>` : '';
}

function renderStaff() {
  const body = $('#staffBody');
  if (!staff.length) { body.innerHTML = '<tr><td colspan="4"><div class="empty">No staff accounts yet.</div></td></tr>'; return; }
  const rank = { pending: 0, attendant: 1, security: 2, owner: 3, none: 4 };
  body.innerHTML = staff.slice().sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9)).map(s => {
    const self = s.uid === user?.uid;
    const btns = self || s.role === 'owner' ? '<span class="hint">–</span>' : ['attendant', 'security', 'none']
      .filter(r => r !== s.role)
      .map(r => `<button class="btn ${r === 'none' ? 'warn' : 'alt'} sm" data-role="${r}" data-uid="${esc(s.uid)}">${r === 'none' ? 'Remove access' : 'Make ' + ROLE_LABEL[r].toLowerCase()}</button>`).join(' ');
    return `<tr><td>${esc(s.name || '–')}${self ? ' (you)' : ''}</td><td>${esc(s.email || '')}</td>
      <td><span class="chip ${s.role === 'pending' ? 'st-booked' : s.role === 'none' ? 'st-closed' : 'st-ready'}">${esc(ROLE_LABEL[s.role] || s.role)}</span></td><td><div class="row">${btns}</div></td></tr>`;
  }).join('');
}

function renderStaffViews() { renderQueue(); renderSecurity(); renderStaff(); }

// ---- delegated events
document.addEventListener('click', async e => {
  const det = e.target.closest('[data-detail]');
  if (det) { detailId = det.dataset.detail || null; renderSecurity(); if (detailId) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const rb = e.target.closest('[data-role]');
  if (rb) {
    rb.disabled = true;
    try { await updateDoc(doc(fs, 'roles', rb.dataset.uid), { role: rb.dataset.role, changedAt: now() }); } catch {}
    rb.disabled = false; return;
  }
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
  const rows = [['Ticket', 'Car', 'Bay', 'Service', 'Status', 'Attendant', 'Before photo', 'After photo', 'Booked', 'Verified', 'Started', 'Completed', 'Paid', 'Consent']];
  tickets.filter(x => today(x.bookedAt)).forEach(tk => rows.push([code(tk), tk.plate, tk.bay, tk.service, LABEL[tk.status] || tk.status, tk.attendant || '',
    tk.photos?.before ? 'Yes' : 'No', tk.photos?.after ? 'Yes' : 'No',
    tk.bookedAt || '', tk.verifiedAt || '', tk.startedAt || '', tk.completedAt || '', tk.paidAt || '', tk.consent ? 'Yes' : 'No']));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `wash-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---- example tickets for demos (owner only, marked "Example")
$('#exBtn').addEventListener('click', async () => {
  const d = new Date(); const at = m => new Date(d.getTime() - m * 60000).toISOString();
  const ex = [
    ['EX1', { plate: 'KA 19 MN 4821', plateKey: 'KA19MN4821', bay: 'B1 – 12', service: 'Exterior eco wash', status: 'closed', attendant: 'Example attendant',
      bookedAt: at(100), verifiedAt: at(96), startedAt: at(94), completedAt: at(72), paidAt: at(60) }],
    ['EX2', { plate: 'KA 19 P 7350', plateKey: 'KA19P7350', bay: 'B2 – 47', service: 'Full wash, inside and out', status: 'verified', attendant: 'Example attendant',
      bookedAt: at(40), verifiedAt: at(34) }],
    ['EX3', { plate: 'KA 19 AB 1093', plateKey: 'KA19AB1093', bay: 'B1 – 30', service: 'Steam interior cleaning', status: 'booked', bookedAt: at(5) }],
  ];
  $('#exBtn').disabled = true;
  try {
    for (const [tag, tk] of ex) {
      const c = newCode(tag);
      await setDoc(doc(collection(fs, 'tickets')), { ...tk, code: c, example: true, phone: '9800000000', consent: true, alerts: [{ at: tk.bookedAt, text: 'Booking confirmed with ticket ' + c }] });
    }
  } catch {}
  $('#exBtn').disabled = false;
});

// ---- start
setMode(false);
const hashTab = location.hash.replace('#', '');
show(TABS.includes(hashTab) ? hashTab : store.get('pwt-tab', 'customer'));
watchMine();
renderCustomer(); renderStaffViews();
$('#liveDot').classList.add('on');
$('#liveText').textContent = 'Live updates on';
window.addEventListener('offline', () => { $('#liveDot').classList.remove('on'); $('#liveText').textContent = 'Offline'; });
window.addEventListener('online', () => { $('#liveDot').classList.add('on'); $('#liveText').textContent = 'Live updates on'; });
