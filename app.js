// Parking Wash Tracker — Firebase version with staff logins and required photos.
// Customers book without an account and only ever see their own ticket.
// Staff sign in; the owner gives each account a role (attendant or mall security) on the Staff tab.

import { firebaseConfig } from './firebase-config.js?v=202610161105';
import { business } from './settings.js?v=202610161105';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, limit, where,
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
const ALLOW = { attendant: ['attendant', 'owner'], security: ['security', 'owner'], staff: ['owner'], dash: ['owner'] };
// How many days of tickets each role loads.
const WINDOW_DAYS = { attendant: 2, security: 1, owner: 31 };

// ---- state
let user = null, profile = null;
let tickets = [];                 // staff view: all recent tickets
const myTickets = new Map();      // customer view: only this device's tickets
let staff = [];
let current = 'customer';
let detailId = null;
let dashRange = 7;
const photoData = new Map();   // ticket id -> { before, after, damage } images
const photoSubs = new Map();
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
// A ticket's service can hold several items joined with " + ".
const SEP = ' + ';
const items = svc => String(svc || '').split(SEP).map(x => x.trim()).filter(Boolean);
const itemPrice = name => Number(business.prices?.[name] || 0);
const price = tk => items(tk.service).reduce((sum, n) => sum + itemPrice(n), 0);
const chosen = () => [...document.querySelectorAll('#f-services input:checked')].map(i => i.value);
function updateTotal() {
  const sum = chosen().reduce((s, n) => s + itemPrice(n), 0);
  $('#f-total').textContent = '₹' + sum.toLocaleString('en-IN');
}
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
const TABS = ['customer', 'attendant', 'security', 'staff', 'dash'];
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
  $('#tab-dash').hidden = role() !== 'owner';
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
  if (!chosen().length) problems.push('Choose at least one service.');
  if (!$('#f-consent').checked) problems.push('Tick the authorisation box to book.');
  if (problems.length) { err.textContent = problems.join(' '); err.hidden = false; return; }
  const ref = doc(collection(fs, 'tickets'));   // random 20-character id: only this phone knows it
  const c = newCode(); const at = now();
  const tk = { code: c, plate: prettyPlate(plate), plateKey: norm(plate), bay, phone, service: chosen().join(SEP),
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
    const days = WINDOW_DAYS[role()] || 1;
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
    unsubs.tickets = onSnapshot(query(collection(fs, 'tickets'), where('bookedAt', '>=', since.toISOString()), orderBy('bookedAt', 'desc'), limit(2000)), snap => {
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
  } else if (action === 'rate') {
    const r = Number(extra?.rating || 0);
    if (tk.status !== 'closed' || tk.rating) return '';
    if (r < 1 || r > 5) return 'Tap a star to choose your rating.';
    const c = String(extra?.comment || '').trim().slice(0, 300);
    Object.assign(patch, { rating: r, ratedAt: now(), ...(c ? { ratingComment: c } : {}) });
  } else if (action === 'pay') {
    if (tk.status !== 'ready') return 'Payment opens when your car is ready.';
    Object.assign(patch, { status: 'closed', paidAt: now(), paidVia: 'Customer (demo)', alerts: addAlert(tk, 'Payment received. Ticket closed. Thank you!') });
  } else {
    if (!can('attendant')) return 'Only attendants can update jobs.';
    if (action === 'verify') {
      if (norm(extra) !== tk.plateKey) return 'Car number doesn’t match the booking. Don’t start; check the bay with the customer.';
      Object.assign(patch, { status: 'verified', verifiedAt: now(), attendant: by, attendantUid: user.uid, alerts: addAlert(tk, `Car verified by ${by}`) });
    }
    if (action === 'nodamage') Object.assign(patch, { damage: { found: false, at: now(), by } });
    if (action === 'damage') {
      const note = String(extra || '').trim();
      if (!note) return 'Describe the damage, for example “Scratch on rear bumper, left side”.';
      Object.assign(patch, { damage: { found: true, note: note.slice(0, 200), at: now(), by } });
    }
    if (action === 'redodamage') Object.assign(patch, { damage: null });
    if (action === 'start') {
      if (!tk.damage) return 'Do the existing-damage check first.';
      if (!tk.photos?.before) return 'Take the before-photo first.';
      Object.assign(patch, { status: 'washing', startedAt: now(), alerts: addAlert(tk, tk.damage.found ? `Wash started. Existing damage noted before starting: ${tk.damage.note}` : 'Wash started. Before-photo taken, no existing damage found') });
    }
    if (action === 'done') {
      if (!tk.photos?.after) return 'Take the after-photo first.';
      Object.assign(patch, { status: 'ready', completedAt: now(), alerts: addAlert(tk, 'Your car is ready. Pay by UPI link') });
    }
    if (action === 'paid') Object.assign(patch, { status: 'closed', paidAt: now(), paidVia: 'Cash to attendant', alerts: addAlert(tk, `Cash payment received by ${by}. Ticket closed`) });
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
// Images live in ticketPhotos/{id}; the ticket only keeps a flag and a time, so lists stay small and fast.
async function addPhoto(id, kind, file) {
  if (!file) return '';
  try {
    const data = await shrink(file);
    const tk = findTicket(id);
    await setDoc(doc(fs, 'ticketPhotos', id), { [kind]: data }, { merge: true });
    photoData.set(id, { ...(photoData.get(id) || {}), [kind]: data });
    await updateDoc(doc(fs, 'tickets', id), { photos: { ...(tk.photos || {}), [kind]: true, [kind + 'At']: now() } });
    return '';
  } catch { return 'Photo didn’t save. Try again or take a new photo.'; }
}
function ensurePhotos(id) {
  if (photoSubs.has(id) || photoSubs.size > 60) return;
  photoSubs.set(id, onSnapshot(doc(fs, 'ticketPhotos', id), snap => {
    photoData.set(id, snap.exists() ? snap.data() : {});
    rerender();
  }, () => {}));
}
let rerenderQueued = false;
function rerender() {
  if (rerenderQueued) return; rerenderQueued = true;
  requestAnimationFrame(() => { rerenderQueued = false; renderCustomer(); renderStaffViews(); });
}
function getPhoto(tk, kind) {
  const v = tk.photos?.[kind];
  if (typeof v === 'string') return safeImg(v);          // older tickets kept the image inline
  if (v === true) { ensurePhotos(tk.id); return safeImg(photoData.get(tk.id)?.[kind]); }
  return '';
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
  const fig = (kind, label) => {
    if (!p[kind]) return;
    const src = getPhoto(tk, kind);
    out.push(src ? `<figure><img src="${src}" alt="${label}, ${esc(tk.plate)}">${label} · ${t(p[kind + 'At'])}</figure>`
                 : `<figure><span class="ph">Loading…</span>${label} · ${t(p[kind + 'At'])}</figure>`);
  };
  fig('before', 'Before'); fig('after', 'After');
  return out.length ? `<div class="photos">${out.join('')}</div>` : '';
}
function damageHTML(tk, forCustomer) {
  const d = tk.damage; if (!d) return '';
  if (!d.found) return `<p class="dmg ok">Pre-wash check: no existing damage found${d.by ? ' by ' + esc(d.by) : ''} · ${t(d.at)}</p>`;
  const src = tk.photos?.damage ? getPhoto(tk, 'damage') : '';
  return `<div class="dmg found"><b>${forCustomer ? 'Existing damage noted before the wash' : 'Existing damage noted'}</b>
    <span>${esc(d.note)}</span><span class="hint">${d.by ? 'Recorded by ' + esc(d.by) + ' · ' : ''}${t(d.at)}</span>
    ${src ? `<div class="photos"><figure><img src="${src}" alt="Existing damage, ${esc(tk.plate)}">Damage photo</figure></div>` : ''}</div>`;
}
const stars = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
function ratingHTML(tk) {
  if (!tk.rating) return '';
  return `<p class="rated"><span class="stars" aria-label="${tk.rating} out of 5">${stars(tk.rating)}</span>${tk.ratingComment ? ' “' + esc(tk.ratingComment) + '”' : ''}</p>`;
}
function headHTML(tk, showPhone) {
  const st = LABEL[tk.status] ? tk.status : 'booked';
  return `<div class="tk-head"><div class="row"><span class="plate">${esc(tk.plate)}</span>
    <span class="chip st-${st}">${LABEL[st]}</span>${tk.example ? '<span class="ex">Example</span>' : ''}</div>
    <span class="mono">${esc(code(tk))}</span></div>
    <div class="tk-meta"><span>Bay <b>${esc(tk.bay)}</b></span><span>${esc(tk.service)}${price(tk) ? ` · <b>₹${price(tk)}</b>` : ''}</span>
    ${tk.attendant ? `<span>Attendant <b>${esc(tk.attendant)}</b></span>` : ''}
    ${showPhone ? `<span>WhatsApp <b>${esc(mask(tk.phone))}</b></span>` : ''}</div>`;
}
const alertsHTML = tk => `<div><h3>Updates</h3><ul class="alerts">${(tk.alerts || []).slice().reverse().map(a => `<li><span class="mono">${t(a.at)}</span> ${esc(a.text)}</li>`).join('')}</ul></div>`;

function renderCustomer() {
  const box = $('#myTickets');
  const list = mine.filter(id => myTickets.has(id)).map(id => ({ id, ...myTickets.get(id) }));
  if (!list.length) { box.innerHTML = '<div class="empty">Your ticket appears here after you book, with live updates as the attendant works on your car.</div>'; return; }
  box.innerHTML = list.map(tk => `<article class="card" data-id="${esc(tk.id)}">
    <h3>Your ticket</h3>${headHTML(tk, false)}${stepsHTML(tk)}${damageHTML(tk, true)}${photosHTML(tk)}${alertsHTML(tk)}
    ${tk.status === 'booked' ? '<div class="row"><button class="btn warn" data-act="cancel">Cancel booking</button></div>' : ''}
    ${tk.status === 'ready' ? payHTML(tk) : ''}
    ${tk.status === 'closed' ? (tk.rating ? `<div class="pay"><h3>Thanks for your rating</h3>${ratingHTML(tk)}</div>` : rateHTML()) : ''}
    <p class="err" hidden></p></article>`).join('');
}
function rateHTML() {
  return `<div class="pay rate"><h3>How was your wash?</h3>
    <div class="starpick" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star" data-rate="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" aria-pressed="false">★</button>`).join('')}</div>
    <label>Comment (optional)<input class="rcomment" maxlength="300" placeholder="Anything we should know?"></label>
    <div class="row"><button class="btn go" data-act="rate">Send rating</button></div></div>`;
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
    if (tk.status === 'verified') {
      const dmg = tk.damage
        ? `${damageHTML(tk, false)}<div class="row"><button class="link" data-act="redodamage">Change damage check</button></div>`
        : `<div class="dmgcheck"><h3>1. Existing damage check</h3><p class="hint">Walk around the car before touching it. Record any scratch, dent or crack that is already there.</p>
           <div class="row"><button class="btn alt" data-act="nodamage">No existing damage</button></div>
           <label>Or describe the damage<input class="dmgnote" maxlength="200" placeholder="Scratch on rear bumper, left side"></label>
           <div class="row"><label class="btn alt">${p.damage ? 'Retake' : 'Add'} damage photo<input type="file" accept="image/*" capture="environment" data-photo="damage" hidden></label><button class="btn alt" data-act="damage">Save damage note</button></div></div>`;
      const ready = !!(tk.damage && p.before);
      actions = `${dmg}<h3>2. Before-photo and start</h3><div class="row">${photoBtn('before', !!p.before)}<button class="btn ${ready ? 'go' : 'alt'}" data-act="start" ${ready ? '' : 'disabled'}>Start wash</button></div>${ready ? '' : `<p class="hint">${tk.damage ? '' : 'Do the damage check and '}${p.before ? '' : 'take the before-photo '}to unlock Start wash.</p>`}`;
    }
    if (tk.status === 'washing') actions = `<div class="row">${photoBtn('after', !!p.after)}<button class="btn ${p.after ? 'go' : 'alt'}" data-act="done" ${p.after ? '' : 'disabled'}>Wash complete</button></div>${p.after ? '' : '<p class="hint">Take the after-photo to unlock Wash complete.</p>'}`;
    if (tk.status === 'ready') actions = `<p class="waitpay">Waiting for the customer to pay on their ticket. This job closes by itself once they tap Pay.</p><div class="row"><button class="link" data-act="paid">Customer paid in cash instead</button></div>`;
    const wa = waLink(tk);
    const waBtn = wa ? `<a class="btn alt wa" href="${esc(wa)}" target="_blank" rel="noopener">Send WhatsApp update</a><span class="hint">Opens WhatsApp with the message ready. Tap send.</span>` : '';
    return `<article class="card" data-id="${esc(tk.id)}">${headHTML(tk, true)}${stepsHTML(tk)}${tk.status !== 'verified' ? damageHTML(tk, false) : ''}${photosHTML(tk)}${actions}${waBtn ? `<div class="row">${waBtn}</div>` : ''}<p class="err" hidden></p></article>`;
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
    <td><span class="chip st-${st}">${LABEL[st]}</span></td><td>${esc(tk.attendant || '–')}</td><td>${ph || '–'}</td><td>${tk.damage ? (tk.damage.found ? '<b class="dmgflag">Noted</b>' : 'None') : '–'}</td><td>${tk.rating ? `<span class="stars" aria-label="${tk.rating} out of 5">${stars(tk.rating)}</span>` : '–'}</td>
    <td class="t">${t(tk.bookedAt)}</td><td class="t">${t(tk.verifiedAt)}</td><td class="t">${t(tk.startedAt)}</td><td class="t">${t(tk.completedAt)}</td><td class="t">${t(tk.paidAt)}</td></tr>`;
  }).join('')
    : '<tr><td colspan="14"><div class="empty">No jobs logged today. Each booking appears here with every step timed.</div></td></tr>';
  const d = detailId && tickets.find(x => x.id === detailId);
  $('#detail').innerHTML = d ? `<article class="card"><div class="row" style="justify-content:space-between"><h3>Ticket ${esc(code(d))}</h3><button class="link" data-detail="">Close</button></div>
    ${headHTML(d, true)}${stepsHTML(d)}${damageHTML(d, false)}${photosHTML(d) || '<p class="hint">No photos yet.</p>'}${ratingHTML(d)}${alertsHTML(d)}</article>` : '';
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

function renderStaffViews() { renderQueue(); renderSecurity(); renderStaff(); renderDash(); }

// ---- owner dashboard
const mins = (a, b) => (a && b) ? (new Date(b) - new Date(a)) / 60000 : null;
const avg = xs => { const v = xs.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
const fmtMin = m => m == null ? '–' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');

function renderDash() {
  const box = $('#v-dash'); if (!box || role() !== 'owner') return;
  document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === dashRange)));
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (dashRange - 1));
  const list = tickets.filter(x => !x.example && x.bookedAt && new Date(x.bookedAt) >= from);
  const closed = list.filter(x => x.status === 'closed');
  const priced = Object.values(business.prices || {}).some(v => Number(v) > 0);
  const revenue = closed.reduce((s, x) => s + price(x), 0);
  const rated = closed.filter(x => x.rating);
  const avgRating = avg(rated.map(x => x.rating));
  const tiles = [
    ['Washes completed', String(closed.length), `${list.length} booked`],
    ['Revenue', priced ? inr(revenue) : '–', priced ? 'From paid tickets' : 'Add prices in settings.js'],
    ['Average wash time', fmtMin(avg(closed.map(x => mins(x.startedAt, x.completedAt)))), 'Start to finish'],
    ['Average wait', fmtMin(avg(closed.map(x => mins(x.bookedAt, x.startedAt)))), 'Booking to start'],
    ['Customer rating', avgRating == null ? '–' : avgRating.toFixed(1) + ' / 5', `${rated.length} rating${rated.length === 1 ? '' : 's'}`],
    ['Damage found before wash', String(list.filter(x => x.damage?.found).length), `${list.filter(x => x.status === 'cancelled').length} cancelled`],
  ];
  $('#dashStats').innerHTML = tiles.map(([l, v, s]) => `<div class="stat"><span>${l}</span><b>${v}</b><small>${s}</small></div>`).join('');

  // Bookings by hour of day
  const counts = Array(24).fill(0);
  list.forEach(x => { counts[new Date(x.bookedAt).getHours()]++; });
  const used = counts.map((c, h) => c ? h : null).filter(h => h != null);
  const h0 = Math.min(8, ...used), h1 = Math.max(21, ...used);
  const hours = []; for (let h = h0; h <= h1; h++) hours.push(h);
  const max = Math.max(1, ...counts);
  const step = max <= 4 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5);
  const top = Math.ceil(max / step) * step;
  const W = 640, H = 260, L = 44, R = 8, T = 14, B = 36;
  const bw = (W - L - R) / hours.length;
  const y = v => T + (H - T - B) * (1 - v / top);
  let svg = '';
  for (let v = 0; v <= top; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 7}" text-anchor="end" class="ax">${v}</text>`;
  hours.forEach((h, i) => {
    const c = counts[h], x = L + i * bw + 2, w = Math.max(2, bw - 4);
    const label = `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 · ${c} booking${c === 1 ? '' : 's'}`;
    if (c) {
      const yy = y(c), hh = H - B - yy, r = Math.min(4, w / 2, hh);
      svg += `<path class="bar" d="M${x},${H - B} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${H - B} Z"><title>${label}</title></path>`;
    }
    svg += `<rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" class="hit"><title>${label}</title></rect>`;
    if ((h - h0) % 2 === 0) svg += `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle" class="ax">${h}:00</text>`;
  });
  svg += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="base"/>`;
  $('#hourChart').innerHTML = list.length
    ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bookings by hour of day">${svg}</svg><p class="hint">Hour of day the car was booked. Hover or tap a bar for the count.</p>`
    : '<div class="empty">No bookings in this period yet.</div>';

  // Attendants
  const byAtt = new Map();
  closed.forEach(x => { const k = x.attendant || '–'; if (!byAtt.has(k)) byAtt.set(k, []); byAtt.get(k).push(x); });
  $('#attBody').innerHTML = byAtt.size ? [...byAtt].sort((a, b) => b[1].length - a[1].length).map(([n, xs]) => {
    const r = avg(xs.map(x => x.rating));
    return `<tr><td>${esc(n)}</td><td class="num">${xs.length}</td><td class="num">${fmtMin(avg(xs.map(x => mins(x.startedAt, x.completedAt))))}</td><td class="num">${r == null ? '–' : r.toFixed(1)}</td><td class="num">${xs.filter(x => x.damage?.found).length}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="hint">No completed washes yet.</td></tr>';

  // Services
  const bySvc = new Map();
  closed.forEach(x => items(x.service).forEach(n => bySvc.set(n, (bySvc.get(n) || 0) + 1)));
  $('#svcBody').innerHTML = bySvc.size ? [...bySvc].sort((a, b) => b[1] - a[1]).map(([sv, c]) =>
    `<tr><td>${esc(sv)}</td><td class="num">${c}</td><td class="num">${priced ? inr(c * itemPrice(sv)) : '–'}</td></tr>`).join('')
    : '<tr><td colspan="3" class="hint">No completed washes yet.</td></tr>';

  // Comments
  const cm = rated.filter(x => x.ratingComment).sort((a, b) => (b.ratedAt || '').localeCompare(a.ratedAt || '')).slice(0, 8);
  $('#comments').innerHTML = cm.length ? cm.map(x => `<li><span class="stars" aria-label="${x.rating} out of 5">${stars(x.rating)}</span> “${esc(x.ratingComment)}” <span class="hint">${esc(x.plate)} · ${new Date(x.ratedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></li>`).join('')
    : '<li class="hint">Customer comments appear here after they rate a wash.</li>';
}

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
  const star = e.target.closest('[data-rate]');
  if (star) {
    const card = star.closest('[data-id]'); card.dataset.rating = star.dataset.rate;
    card.querySelectorAll('[data-rate]').forEach(s => s.setAttribute('aria-pressed', String(Number(s.dataset.rate) <= Number(star.dataset.rate))));
    return;
  }
  const rg = e.target.closest('[data-range]');
  if (rg) { dashRange = Number(rg.dataset.range); renderDash(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const card = b.closest('[data-id]'); const id = card.dataset.id;
  const errEl = card.querySelector('.err');
  b.disabled = true;
  const a = b.dataset.act;
  const extra = a === 'verify' ? card.querySelector('.vplate').value
    : a === 'damage' ? card.querySelector('.dmgnote').value
    : a === 'rate' ? { rating: card.dataset.rating, comment: card.querySelector('.rcomment')?.value } : undefined;
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
  const rows = [['Ticket', 'Car', 'Bay', 'Service', 'Status', 'Attendant', 'Before photo', 'After photo', 'Booked', 'Verified', 'Started', 'Completed', 'Paid', 'Paid via', 'Existing damage', 'Damage note', 'Rating', 'Comment', 'Consent']];
  tickets.filter(x => today(x.bookedAt)).forEach(tk => rows.push([code(tk), tk.plate, tk.bay, tk.service, LABEL[tk.status] || tk.status, tk.attendant || '',
    tk.photos?.before ? 'Yes' : 'No', tk.photos?.after ? 'Yes' : 'No',
    tk.bookedAt || '', tk.verifiedAt || '', tk.startedAt || '', tk.completedAt || '', tk.paidAt || '', tk.paidVia || '', tk.damage ? (tk.damage.found ? 'Yes' : 'No') : '', tk.damage?.note || '', tk.rating || '', tk.ratingComment || '', tk.consent ? 'Yes' : 'No']));
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
// Show each service's price and keep the total up to date.
document.querySelectorAll('#f-services .svc').forEach(l => {
  const pr = itemPrice(l.querySelector('input').value);
  l.querySelector('[data-price]').textContent = pr ? '₹' + pr : '';
});
$('#f-services').addEventListener('change', updateTotal);
$('#bookForm').addEventListener('reset', () => setTimeout(updateTotal, 0));
updateTotal();
setMode(false);
const hashTab = location.hash.replace('#', '');
show(TABS.includes(hashTab) ? hashTab : store.get('pwt-tab', 'customer'));
watchMine();
renderCustomer(); renderStaffViews();
$('#liveDot').classList.add('on');
$('#liveText').textContent = 'Live updates on';
window.addEventListener('offline', () => { $('#liveDot').classList.remove('on'); $('#liveText').textContent = 'Offline'; });
window.addEventListener('online', () => { $('#liveDot').classList.add('on'); $('#liveText').textContent = 'Live updates on'; });
