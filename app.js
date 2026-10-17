// Parking Wash Tracker — Firebase version with staff logins and required photos.
// Customers book without an account and only ever see their own ticket.
// Staff sign in; the owner gives each account a role (attendant or mall security) on the Staff tab.

import { firebaseConfig } from './firebase-config.js?v=202610171021';
import { business } from './settings.js?v=202610171021';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, getDocs, onSnapshot, query, orderBy, limit, where,
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
const ORDER = { booked: 0, verified: 1, washing: 2, ready: 3, closed: 4, cancelled: -1, noshow: -1 };
const LABEL = { booked: 'Waiting', verified: 'Verified', washing: 'Washing', ready: 'Ready', closed: 'Paid', cancelled: 'Cancelled', noshow: 'Not done' };
const NOSHOW_REASONS = ['Car not in the bay', 'Customer left before the wash', 'Customer cancelled in person', 'Booking details were wrong'];
const ROLE_LABEL = { owner: 'Owner', attendant: 'Attendant', security: 'Mall security', pending: 'Waiting for approval', none: 'No access' };
const ALLOW = { attendant: ['attendant', 'owner'], security: ['security', 'owner'], staff: ['owner'], dash: ['owner'] };
// How many days of tickets each role loads.
const WINDOW_DAYS = { attendant: 2, security: 1, owner: 62 };

// ---- state
let user = null, profile = null;
let tickets = [];                 // staff view: all recent tickets
const myTickets = new Map();      // customer view: only this device's tickets
let staff = [];
let current = 'customer';
let detailId = null;
let dashRange = 7;
let dashSite = 'all';
let bookOpen = false;              // customer tapped "Book another car"
let openJob;                        // attendant: the job card that is expanded (undefined = pick one)
const dmgOpen = new Set();          // attendant: jobs where "Found damage" was tapped
const lastSeen = { customer: new Map(), queue: new Map() };   // status last drawn, to flash changes
let soundOn = true;
let shifts = [];                  // owner: today's shifts; attendant: own shift
const visits = new Map();         // ticket id -> earlier paid washes by the same car (for loyalty)
const photoData = new Map();   // ticket id -> { before, after, damage } images
const photoSubs = new Map();
const unsubs = { profile: null, tickets: null, staff: null, shifts: null, mine: new Map() };

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
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SITES = business.sites?.length ? business.sites : [{ id: 'main', name: 'Main site', sharePct: 0, zones: [] }];
const DEFAULT_SITE = business.defaultSite || SITES[0].id;
const siteOf = id => SITES.find(x => x.id === id) || SITES.find(x => x.id === DEFAULT_SITE) || SITES[0];
const siteName = id => siteOf(id).name;
const mySite = () => profile?.site || DEFAULT_SITE;
// Booking QR codes carry ?site=…&zone=…
const params = new URLSearchParams(location.search);
const urlSite = SITES.some(x => x.id === params.get('site')) ? params.get('site') : DEFAULT_SITE;
const urlZone = (siteOf(urlSite).zones || []).includes(params.get('zone')) ? params.get('zone') : '';
const bayText = tk => [tk.zone, tk.bay].filter(Boolean).join(' · ');
const brand = business.name || 'Parking Wash';
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
// The service list lives in Firestore (config/main) so the owner can edit it from the dashboard.
// settings.js is the starting point until the first save.
let catalog = [];
function applyCatalog(cfg) {
  const src = cfg?.services?.length ? cfg.services : (business.services || []);
  catalog = src.map(x => ({ name: String(x.name || '').trim(), kind: x.kind === 'addon' ? 'addon' : 'wash', desc: String(x.desc || ''),
    price: Math.max(0, Math.round(Number(x.price) || 0)), checklist: (x.checklist || []).map(String).filter(Boolean), active: x.active !== false })).filter(x => x.name);
  business.prices = { ...(business.prices || {}), ...Object.fromEntries(catalog.map(x => [x.name, x.price])) };
  business.checklists = { ...(business.checklists || {}), ...Object.fromEntries(catalog.map(x => [x.name, x.checklist])) };
  if (cfg?.loyalty) business.loyalty = { every: Number(cfg.loyalty.every) || 0, discountPct: Number(cfg.loyalty.discountPct) || 0 };
  business.offer = cfg?.offer || business.offer || { active: false, label: '', pct: 0 };
}
applyCatalog(null);
const activeCatalog = () => catalog.filter(x => x.active);
const offerOn = () => !!(business.offer?.active && Number(business.offer.pct) > 0);
const itemPrice = name => Number(business.prices?.[name] || 0);
// Prices are fixed on the ticket when the attendant verifies the car, so later price changes don't alter old tickets.
// Add-ons the customer accepted during the wash carry their own price.
const lineItems = tk => [
  ...items(tk.service).map(n => [n, Number(tk.prices?.[n] ?? itemPrice(n))]),
  ...(tk.suggests || []).filter(x => x.status === 'accepted').flatMap(x => (x.items || []).map(i => [i.n, Number(i.p) || 0])),
];
const gross = tk => lineItems(tk).reduce((sum, [, p]) => sum + p, 0);
// Before the car is verified, show the running offer so the ticket matches what the booking page said.
const pctOf = tk => Number(tk.discountPct || 0) || (tk.status === 'booked' && offerOn() ? Number(business.offer.pct) : 0);
const discount = tk => Math.round(gross(tk) * (pctOf(tk) / 100));
const discountName = tk => tk.discountLabel || 'Loyalty discount';
const discChip = tk => tk.discountPct ? `<span class="chip st-ready">${esc(tk.discountLabel ? tk.discountLabel.split(' (')[0] : 'Loyalty')} −${tk.discountPct}%</span>` : '';
const price = tk => gross(tk) - discount(tk);
const chosen = () => [...document.querySelectorAll('#f-services input:checked')].map(i => i.value);
function updateTotal() {
  const sum = chosen().reduce((s, n) => s + itemPrice(n), 0);
  const off = offerOn() ? Math.round(sum * Number(business.offer.pct) / 100) : 0;
  $('#f-total').textContent = '₹' + (sum - off).toLocaleString('en-IN');
  $('#f-totlabel').textContent = off ? `Total · ${business.offer.pct}% off` : 'Total';
}
function waMessage(tk) {
  const c = code(tk);
  const amt = price(tk) ? ` ₹${price(tk)}` : '';
  const upi = business.upiId ? ` to UPI ID ${business.upiId}` : '';
  return ({
    booked: `Hi, your car ${tk.plate} is booked for ${tk.service} at ${bayText(tk)}. Ticket ${c}. We'll message you when the wash starts.`,
    verified: `Hi, we've found your car ${tk.plate} at ${bayText(tk)} and will start the ${tk.service} shortly. Ticket ${c}.`,
    washing: `Your car ${tk.plate} is being washed now. Ticket ${c}. We'll message you when it's ready.`,
    ready: `Your car ${tk.plate} is ready at ${bayText(tk)}. Please pay${amt} by UPI${upi}. Ticket ${c}. Thank you!`,
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

// ---- service checklist, return time, plate masking
const checklistFor = tk => [...new Set(lineItems(tk).flatMap(([n]) => business.checklists?.[n] || []))];
const checklistDone = tk => checklistFor(tk).every(i => tk.checklist?.[i]);
const isLate = tk => !!(tk.backBy && !DONE.includes(tk.status) && tk.status !== 'ready' && new Date(tk.backBy) < new Date());
const maskPlate = p => { const g = String(p || '').split(' '); return g.length >= 3 ? `${g[0]} ${g[1]} ·· ${g[g.length - 1]}` : String(p || '').replace(/^(.{2}).*(.{4})$/, '$1 ·· $2'); };
const ISSUE_TYPES = ['Damage to my car', 'Not cleaned properly', 'Payment problem', 'Attendant behaviour', 'Something else'];

const findTicket = id => tickets.find(x => x.id === id) || (myTickets.has(id) ? { id, ...myTickets.get(id) } : null);

// ---- tabs and access
const TABS = ['customer', 'attendant', 'security', 'staff', 'dash'];
const homeTab = () => ({ security: 'security', attendant: 'attendant', owner: 'attendant' })[role()] || 'customer';
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
    $('#noAccessText').textContent = `You’re signed in as ${ROLE_LABEL[role()] || role()}. Use the ${role() === 'security' ? 'Security log' : 'Jobs'} tab.`;
  }
  document.body.classList.toggle('wide', ['security', 'dash', 'staff'].includes(name));
  $('#walkFab').hidden = !(name === 'attendant' && can('attendant'));
  setBrandSite();
  store.set('pwt-tab', name);
}
function setBrandSite() {
  const staffView = current !== 'customer' && user;
  $('#brandSite').textContent = !staffView ? `${siteName(urlSite)}${urlZone ? ' · ' + urlZone : ''}`
    : role() === 'owner' && SITES.length > 1 ? 'All sites' : siteName(mySite());
}
TABS.forEach(n => $('#tab-' + n).addEventListener('click', () => { if (location.hash) history.replaceState(null, '', location.pathname); show(n); }));

function refreshWho() {
  $('#whoBox').hidden = !user;
  if (user) {
    $('#whoName').textContent = profile?.name || user.email;
    $('#whoRole').textContent = ROLE_LABEL[role()] || role();
  }
  const r = role();
  $('#tabs').hidden = !['owner', 'attendant', 'security'].includes(r);
  $('#tab-attendant').hidden = !['attendant', 'owner'].includes(r);
  $('#tab-security').hidden = !['security', 'owner'].includes(r);
  $('#tab-customer').hidden = r !== 'owner';
  $('#tab-staff').hidden = r !== 'owner';
  $('#tab-dash').hidden = r !== 'owner';
  $('#toolsBox').hidden = r !== 'owner';
  $('#staffFoot').hidden = !!user;
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
    site: urlSite, zone: urlZone, day: dayKey(), status: 'booked', consent: true, bookedAt: at,
    alerts: [{ at, text: 'Booking confirmed with ticket ' + c }] };
  const back = Number($('#f-back').value);
  if (back) tk.backBy = new Date(Date.now() + back * 60000).toISOString();
  const eta = etaMin();
  if (eta) tk.estReadyAt = new Date(Date.now() + eta * 60000).toISOString();
  $('#bookBtn').disabled = true;
  try {
    await setDoc(ref, tk);
    mine = [ref.id, ...mine.filter(x => x !== ref.id)].slice(0, 10); store.set('pwt-mine2', mine);
    watchMine();
    saveCar({ plate: tk.plate, phone, services: tk.service.split(SEP) });
    $('#bookForm').reset();
    bookOpen = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    err.textContent = 'Booking didn’t go through. Check your connection and book again.';
    err.hidden = false;
  } finally { $('#bookBtn').disabled = false; }
});

// Live queue figures for the booking page. Staff phones keep public/{site} up to date.
let pub = null;
function etaMin() {
  if (!pub || !pub.updatedAt || Date.now() - new Date(pub.updatedAt) > 30 * 60000) return 0;
  const m = ((pub.ahead || 0) / Math.max(1, pub.workers || 1) + 1) * (pub.avgMin || 30) + 5;
  return Math.ceil(m / 5) * 5;
}
function renderEta() {
  const box = $('#f-eta'); if (!box) return;
  const m = etaMin();
  if (!m) { box.hidden = true; return; }
  const ahead = pub.ahead || 0;
  const back = Number($('#f-back').value);
  box.hidden = false;
  box.className = 'eta' + (back && back < m ? ' tight' : '');
  box.innerHTML = `<b>Ready in about ${fmtMin(m)}</b><span>${ahead ? `${ahead} car${ahead === 1 ? '' : 's'} ahead of you` : 'No queue right now'}</span>${back && back < m ? `<span>That’s tight. We may need a little longer than ${fmtMin(back)} right now.</span>` : ''}`;
}
function watchPublic(site, cb) {
  return onSnapshot(doc(fs, 'public', site), snap => cb(snap.exists() ? snap.data() : null), () => cb(null));
}

function renderBookServices(pick) {
  const box = $('#f-services'); if (!box) return;
  const was = pick || chosen();
  const tile = x => `<label class="svc"><input type="checkbox" value="${esc(x.name)}" ${was.includes(x.name) ? 'checked' : ''}><span>${esc(x.name)}</span>${x.desc && x.kind === 'wash' ? `<small>${esc(x.desc)}</small>` : ''}<b>${x.price ? '₹' + x.price : ''}</b></label>`;
  const washes = activeCatalog().filter(x => x.kind === 'wash'), adds = activeCatalog().filter(x => x.kind === 'addon');
  box.innerHTML = `<legend>Choose your wash</legend><div class="svcgrid">${washes.map(tile).join('')}</div>${adds.length ? `<p class="svchead">Add-ons</p><div class="svcgrid addons">${adds.map(tile).join('')}</div>` : ''}`;
  if (!box.querySelector('input:checked') && !pick) box.querySelector('input')?.setAttribute('checked', '');
  const oi = $('#offerInfo');
  if (oi) { oi.hidden = !offerOn(); oi.textContent = offerOn() ? `${business.offer.label || 'Offer'} · ${business.offer.pct}% off today` : ''; }
  updateTotal();
}

// ---- saved cars on this phone, for quick repeat bookings
const cars = () => store.get('pwt-cars', []);
function saveCar(c) { store.set('pwt-cars', [c, ...cars().filter(x => norm(x.plate) !== norm(c.plate))].slice(0, 3)); }
function fillCar(c, keepBay) {
  if (!c) return;
  $('#f-plate').value = c.plate || ''; $('#f-phone').value = c.phone || '';
  if (!keepBay) $('#f-bay').value = '';
  const want = (c.services || []).filter(n => activeCatalog().some(x => x.name === n));
  if (want.length) renderBookServices(want);
}
function renderCars() {
  const box = $('#myCars'); if (!box) return;
  const list = cars();
  box.hidden = !list.length;
  box.innerHTML = list.length ? `<span class="hint">Your cars</span>${list.map((c, i) => `<button type="button" class="carchip${norm($('#f-plate').value) === norm(c.plate) ? ' on' : ''}" data-car="${i}">${esc(c.plate)}</button>`).join('')}<button type="button" class="link" data-car="forget">Forget</button>` : '';
}

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
$('#signOutBtn').addEventListener('click', () => { current = 'customer'; signOut(auth); });
$('#staffLink').addEventListener('click', () => { show('attendant'); window.scrollTo({ top: 0 }); });
$('#backBook').addEventListener('click', () => show('customer'));

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
    const prev = `${profile?.role}|${profile?.site}`;
    profile = snap.data();
    refreshWho();
    if (prev !== `${profile.role}|${profile.site}`) {
      startStaffFeeds();
      if (current === 'customer' || !can(current)) current = homeTab();
    }
    show(current);
  }, () => { refreshWho(); show(current); });
  refreshWho(); show(current);
});

function startStaffFeeds() {
  ['tickets', 'staff', 'shifts'].forEach(k => { if (unsubs[k]) { unsubs[k](); unsubs[k] = null; } });
  tickets = []; staff = []; shifts = [];
  const r = role();
  seenBooked.clear(); seededBooked = false; seenIssues.clear(); seededIssues = false;
  const onTickets = snap => {
    tickets = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.bookedAt || '').localeCompare(a.bookedAt || ''));
    checkNewBookings(); checkNewIssues(); publishSoon();
    $('#offline').hidden = true;
    renderStaffViews();
  };
  const onErr = () => { $('#offline').hidden = false; };
  if (r === 'owner') {
    // The owner sees every site, for the dashboard and monthly report.
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (WINDOW_DAYS.owner - 1));
    unsubs.tickets = onSnapshot(query(collection(fs, 'tickets'), where('bookedAt', '>=', since.toISOString()), orderBy('bookedAt', 'desc'), limit(3000)), onTickets, onErr);
    unsubs.staff = onSnapshot(collection(fs, 'roles'), snap => {
      staff = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      renderStaff(); renderDash();
    }, () => {});
    unsubs.shifts = onSnapshot(query(collection(fs, 'shifts'), where('day', '==', dayKey())), snap => {
      shifts = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderDash(); renderShift();
    }, () => {});
  } else if (r === 'attendant' || r === 'security') {
    // Staff see only their own site: today (and yesterday for attendants finishing late jobs).
    const y = new Date(); y.setDate(y.getDate() - 1);
    const days = r === 'attendant' ? [dayKey(), dayKey(y)] : [dayKey()];
    unsubs.tickets = onSnapshot(query(collection(fs, 'tickets'), where('site', '==', mySite()), where('day', 'in', days)), onTickets, onErr);
    if (r === 'attendant') {
      unsubs.shifts = onSnapshot(doc(fs, 'shifts', `${user.uid}_${dayKey()}`), snap => {
        shifts = snap.exists() ? [{ id: snap.id, ...snap.data() }] : []; renderShift();
      }, () => {});
    }
  }
  renderStaffViews();
}

// ---- public queue figures and the live board (no customer data beyond a masked plate and bay)
const lastPub = new Map();
function boardData(siteId) {
  const day = dayKey(); const since24 = Date.now() - 86400000; const since3h = Date.now() - 3 * 3600000;
  const list = tickets.filter(x => !x.example && (x.site || DEFAULT_SITE) === siteId);
  const todays = list.filter(x => (x.day || dayKey(new Date(x.bookedAt))) === day);
  const open = list.filter(x => !DONE.includes(x.status) && new Date(x.bookedAt) > since24)
    .sort((a, b) => (a.bookedAt || '').localeCompare(b.bookedAt || ''));
  const recent = list.filter(x => x.status === 'closed' && x.startedAt && x.completedAt).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).slice(0, 20);
  const a = avg(recent.map(x => mins(x.startedAt, x.completedAt)));
  const doneT = todays.filter(x => x.status === 'closed');
  const at = avg(doneT.map(x => mins(x.startedAt, x.completedAt)));
  return {
    ahead: open.filter(x => x.status !== 'ready').length,
    avgMin: Math.min(120, Math.max(10, Math.round(a || 30))),
    workers: Math.max(1, new Set(list.filter(x => x.attendantUid && x.verifiedAt && new Date(x.verifiedAt) > since3h).map(x => x.attendantUid)).size),
    jobs: open.slice(0, 40).map(x => ({ p: maskPlate(x.plate), z: x.zone || '', b: x.bay || '', s: x.status,
      t: { booked: x.bookedAt, verified: x.verifiedAt, washing: x.startedAt, ready: x.completedAt }[x.status] || x.bookedAt, late: isLate(x) })),
    today: { done: doneT.length, booked: todays.length, avgMin: at == null ? null : Math.round(at), damage: todays.filter(x => x.damage?.found).length,
      consent: todays.filter(x => x.consent).length, photos: doneT.filter(x => x.photos?.before && x.photos?.after).length,
      issues: list.filter(x => x.issue?.status === 'open').length },
  };
}
let pubTimer = null;
// At most one write every 1.5 s, even while tickets keep changing.
function publishSoon() { if (pubTimer) return; pubTimer = setTimeout(() => { pubTimer = null; publishBoards(); }, 1500); }
async function publishBoards(force) {
  if (!['owner', 'attendant', 'security'].includes(role())) return;
  const sites = role() === 'owner' ? SITES.map(x => x.id) : [mySite()];
  for (const id of sites) {
    const data = boardData(id); const key = JSON.stringify(data); const prev = lastPub.get(id);
    if (!force && prev && prev.key === key && Date.now() - prev.at < 5 * 60000) continue;
    try { await setDoc(doc(fs, 'public', id), { ...data, updatedAt: now() }); lastPub.set(id, { key, at: Date.now() }); } catch {}
  }
}
setInterval(() => publishBoards(), 5 * 60000);

// ---- new booking alert for attendants: sound, vibration and a banner
const seenBooked = new Set(); let seededBooked = false;
let actx = null;
function chime() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime;
    [880, 1175].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain(); const s0 = t0 + i * 0.18;
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, s0); g.gain.exponentialRampToValueAtTime(0.35, s0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s0 + 0.3);
      o.start(s0); o.stop(s0 + 0.32);
    });
  } catch {}
}
// Browsers only allow sound after the first tap on the page.
document.addEventListener('pointerdown', () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {} }, { once: true });
const seenIssues = new Set(); let seededIssues = false;
function checkNewIssues() {
  const open = tickets.filter(x => x.issue?.status === 'open');
  const fresh = open.filter(x => !seenIssues.has(x.id));
  open.forEach(x => seenIssues.add(x.id));
  if (!seededIssues) { seededIssues = true; return; }
  if (fresh.length && role() === 'owner') { if (soundOn) chime(); toast(`Customer complaint · ${fresh[0].plate}`, true); }
}
function checkNewBookings() {
  const booked = tickets.filter(x => x.status === 'booked' && !x.example);
  const fresh = booked.filter(x => !seenBooked.has(x.id) && x.createdBy !== user?.uid);
  booked.forEach(x => seenBooked.add(x.id));
  if (!seededBooked) { seededBooked = true; return; }
  if (!fresh.length || !['attendant', 'owner'].includes(role())) return;
  if (soundOn) chime();
  try { navigator.vibrate?.([180, 90, 180]); } catch {}
  toast(`New booking · ${fresh[0].plate}${fresh.length > 1 ? ` and ${fresh.length - 1} more` : ''}`, false, false, 'ok');
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
  } else if (action === 'issue') {
    if (tk.status !== 'closed' || tk.issue) return '';
    const text = String(extra?.text || '').trim().slice(0, 500);
    if (text.length < 5) return 'Describe the problem in a few words.';
    const type = ISSUE_TYPES.includes(extra?.type) ? extra.type : ISSUE_TYPES[ISSUE_TYPES.length - 1];
    Object.assign(patch, { issue: { status: 'open', type, text, at: now() }, alerts: addAlert(tk, `Problem reported: ${type}`) });
  } else if (action === 'resolve') {
    if (role() !== 'owner' || !tk.issue) return 'Only the owner can resolve complaints.';
    const note = String(extra || '').trim().slice(0, 300);
    if (!note) return 'Write what was done, for example “Refunded ₹249” or “Re-washed the car”.';
    Object.assign(patch, { issue: { ...tk.issue, status: 'resolved', resolution: note, resolvedAt: now(), resolvedBy: profile?.name || 'Owner' }, alerts: addAlert(tk, `Problem resolved: ${note}`) });
  } else if (action === 'accept' || action === 'decline') {
    const g = (tk.suggests || []).at(-1);
    if (!g || g.status !== 'open' || !['verified', 'washing'].includes(tk.status)) return 'This suggestion has already been answered.';
    const yes = action === 'accept';
    const sum = (g.items || []).reduce((a, i) => a + (Number(i.p) || 0), 0);
    Object.assign(patch, { suggests: [...tk.suggests.slice(0, -1), { ...g, status: yes ? 'accepted' : 'declined', answeredAt: now() }],
      alerts: addAlert(tk, yes ? `You added ${g.items.map(i => i.n).join(', ')} (+₹${sum})` : 'You said no thanks to the suggestion') });
  } else if (action === 'pay') {
    if (tk.status !== 'ready') return 'Payment opens when your car is ready.';
    Object.assign(patch, { status: 'closed', paidAt: now(), paidVia: 'Customer (demo)', alerts: addAlert(tk, 'Payment received. Ticket closed. Thank you!') });
  } else {
    if (!can('attendant')) return 'Only attendants can update jobs.';
    if (action === 'takeover') {
      if (!tk.attendantUid || tk.attendantUid === user.uid) return '';
      Object.assign(patch, { attendant: by, attendantUid: user.uid, alerts: addAlert(tk, `Job handed over from ${tk.attendant || 'another attendant'} to ${by}`) });
    } else if (tk.status !== 'booked' && tk.attendantUid && tk.attendantUid !== user.uid) {
      return `${tk.attendant || 'Another attendant'} is on this job. Tap “Take over this job” first.`;
    }
    if (action === 'verify') {
      if (norm(extra) !== tk.plateKey) return 'Car number doesn’t match the booking. Don’t start; check the bay with the customer.';
      Object.assign(patch, { status: 'verified', verifiedAt: now(), attendant: by, attendantUid: user.uid, alerts: addAlert(tk, `Car verified by ${by}`) });
      patch.prices = Object.fromEntries(items(tk.service).map(n => [n, itemPrice(n)]));
      const v = visits.get(tk.id); const L = business.loyalty || {};
      let best = null;
      if (v != null && L.every > 1 && (v + 1) % L.every === 0 && Number(L.discountPct) > 0) best = { pct: Number(L.discountPct), label: `Loyalty wash (${L.discountPct}% off)`, msg: `Loyalty wash: ${L.discountPct}% off. Thank you for coming back!` };
      if (offerOn() && Number(business.offer.pct) > (best?.pct || 0)) best = { pct: Number(business.offer.pct), label: `${business.offer.label || 'Offer'} (${business.offer.pct}% off)`, msg: `${business.offer.label || 'Offer'}: ${business.offer.pct}% off applied.` };
      if (best && !tk.discountPct) {
        Object.assign(patch, { discountPct: best.pct, discountLabel: best.label });
        patch.alerts = addAlert({ alerts: patch.alerts }, best.msg);
      }
    }
    if (action === 'suggest') {
      if (!['verified', 'washing'].includes(tk.status)) return 'Suggestions can be sent before the wash is complete.';
      if ((tk.suggests || []).some(g => g.status === 'open')) return 'Wait for the customer to answer the last suggestion.';
      const have = lineItems(tk).map(([n]) => n);
      const names = (extra?.names || []).filter(n => !have.includes(n) && activeCatalog().some(x => x.name === n));
      if (!names.length) return 'Choose at least one service to suggest.';
      const its = names.map(n => ({ n, p: itemPrice(n) }));
      const sum = its.reduce((a, i) => a + i.p, 0);
      const note = String(extra?.note || '').trim().slice(0, 160);
      Object.assign(patch, { suggests: [...(tk.suggests || []), { items: its, note, at: now(), by, status: 'open' }].slice(-5),
        alerts: addAlert(tk, `${by} suggests ${names.join(', ')} (+₹${sum})${note ? ': ' + note : ''}. Tap Add on your ticket if you’d like it`) });
    }
    if (action === 'check') {
      if (tk.status !== 'washing') return '';
      patch.checklist = { ...(tk.checklist || {}), [extra.item]: !!extra.on };
    }
    if (action === 'nodamage') Object.assign(patch, { damage: { found: false, at: now(), by } });
    if (action === 'damage') {
      const note = String(extra || '').trim();
      if (!note) return 'Describe the damage, for example “Scratch on rear bumper, left side”.';
      Object.assign(patch, { damage: { found: true, note: note.slice(0, 200), at: now(), by } });
    }
    if (action === 'redodamage') Object.assign(patch, { damage: null });
    if (action === 'noshow') {
      if (!['booked', 'verified'].includes(tk.status)) return 'Only jobs that haven’t started can be closed as not done.';
      const reason = String(extra || NOSHOW_REASONS[0]);
      Object.assign(patch, { status: 'noshow', noshowAt: now(), noshowReason: reason, noshowBy: by, alerts: addAlert(tk, `Not completed: ${reason}`) });
    }
    if (action === 'start') {
      if (!tk.damage) return 'Do the existing-damage check first.';
      if (!tk.photos?.before) return 'Take the before-photo first.';
      Object.assign(patch, { status: 'washing', startedAt: now(), alerts: addAlert(tk, tk.damage.found ? `Wash started. Existing damage noted before starting: ${tk.damage.note}` : 'Wash started. Before-photo taken, no existing damage found') });
    }
    if (action === 'done') {
      if (!checklistDone(tk)) return 'Tick every item on the checklist first.';
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
    const tk = findTicket(id);
    if (tk?.attendantUid && tk.attendantUid !== user?.uid) return `${tk.attendant || 'Another attendant'} is on this job. Tap “Take over this job” first.`;
    const data = await shrink(file);
    await setDoc(doc(fs, 'ticketPhotos', id), { [kind]: data }, { merge: true });
    photoData.set(id, { ...(photoData.get(id) || {}), [kind]: data });
    await updateDoc(doc(fs, 'tickets', id), { photos: { ...(tk.photos || {}), [kind]: true, [kind + 'At']: now(), [kind + 'By']: profile?.name || 'Staff' } });
    return '';
  } catch (err) { console.error(err); return 'Photo didn’t save. Check the internet connection and take it again.'; }
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
  if (tk.status === 'noshow') return `<p class="dmg found"><b>Not completed</b><span>${esc(tk.noshowReason || 'No reason given')}${tk.noshowBy ? ' · recorded by ' + esc(tk.noshowBy) : ''} · ${t(tk.noshowAt)}</span></p>`;
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
    out.push(src ? `<figure><img src="${src}" alt="${label}, ${esc(tk.plate)}">${label} · ${t(p[kind + 'At'])}${p[kind + 'By'] ? ` · ${esc(p[kind + 'By'])}` : ''}</figure>`
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
  const multi = SITES.length > 1 && role() === 'owner';
  return `<div class="tk-head"><div class="row"><span class="plate">${esc(tk.plate)}</span>
    <span class="chip st-${st}">${LABEL[st]}</span>${tk.example ? '<span class="ex">Example</span>' : ''}${tk.walkUp ? '<span class="ex">Walk-up</span>' : ''}${discChip(tk)}</div>
    <span class="mono">${esc(code(tk))}</span></div>
    <div class="tk-meta">${multi ? `<span>${esc(siteName(tk.site))}</span>` : ''}<span>Bay <b>${esc(bayText(tk))}</b></span><span>${esc(tk.service)}${price(tk) ? ` · <b>₹${price(tk)}</b>` : ''}</span>
    ${tk.attendant ? `<span>Attendant <b>${esc(tk.attendant)}</b></span>` : ''}
    ${showPhone && tk.phone ? `<span>WhatsApp <b>${esc(mask(tk.phone))}</b></span>` : ''}</div>`;
}
const alertsHTML = tk => `<div><h3>Updates</h3><ul class="alerts">${(tk.alerts || []).slice().reverse().map(a => `<li><time>${t(a.at)}</time><span>${esc(a.text)}</span></li>`).join('')}</ul></div>`;

const svgI = d => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  clock: svgI('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  check: svgI('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  drop: svgI('<path d="M12 3.5C10 6.2 6.5 10.6 6.5 14a5.5 5.5 0 0 0 11 0c0-3.4-3.5-7.8-5.5-10.5z"/>'),
  x: svgI('<path d="M7 7l10 10M17 7L7 17"/>'),
  bang: svgI('<path d="M12 6.5v7M12 17.5v.01"/>'),
  bell: svgI('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  belloff: svgI('<path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H7"/><path d="M10 20.5a2 2 0 0 0 4 0M4 4l16 16"/>'),
};
const HERO = {
  booked: ['clock', 'Waiting for an attendant', 'We’ve got your booking. An attendant will find your car and check the number plate.'],
  verified: ['check', 'Car found', 'The attendant has checked your car and will start shortly.'],
  washing: ['drop', 'Your car is being washed', 'This page updates the moment it’s ready.'],
  ready: ['check', 'Your car is ready', 'Pay below to close your ticket.'],
  closed: ['check', 'Paid. Thank you!', 'Your receipt is below.'],
  cancelled: ['x', 'Booking cancelled', 'Nothing was done to your car.'],
  noshow: ['bang', 'Wash not done', ''],
};
const DONE = ['closed', 'cancelled', 'noshow'];
function flash(box, list, seen, onChange) {
  list.forEach(tk => {
    const prev = seen.get(tk.id);
    if (prev && prev !== tk.status) {
      box.querySelector(`[data-id="${CSS.escape(tk.id)}"]`)?.classList.add('bump');
      onChange?.(tk);
    }
    seen.set(tk.id, tk.status);
  });
}

function renderCustomer() {
  const box = $('#myTickets');
  const list = mine.filter(id => myTickets.has(id)).map(id => ({ id, ...myTickets.get(id) }));
  // Open tickets, plus anything finished today. Older tickets drop off.
  const week = Date.now() - 7 * 86400000;
  const finishedAt = tk => tk.paidAt || tk.cancelledAt || tk.noshowAt || tk.bookedAt;
  const shown = list.filter(tk => !DONE.includes(tk.status) || today(finishedAt(tk)));
  const earlier = list.filter(tk => DONE.includes(tk.status) && !today(finishedAt(tk)) && new Date(finishedAt(tk)) > week);
  const active = shown.some(tk => !DONE.includes(tk.status));
  const card = $('#bookCard');
  card.classList.toggle('collapsed', active && !bookOpen);
  $('#bookAnother').hidden = !(active && !bookOpen);
  $('#bookTitle').textContent = active ? 'Need another car washed?' : 'Book a wash for your parked car';
  box.innerHTML = shown.map(ticketHTML).join('') + (earlier.length
    ? `<details class="sec"><summary>Earlier washes <span class="meta">${earlier.length}</span></summary><div class="secbody">${earlier.map(ticketHTML).join('')}</div></details>` : '');
  shown.forEach(tk => {
    const n = (tk.suggests || []).length, k = 'sg:' + tk.id;
    if (lastSeen.customer.has(k) && n > lastSeen.customer.get(k) && tk.suggests.at(-1).status === 'open') {
      try { navigator.vibrate?.([200, 100, 200]); } catch {}
      toast('Your attendant has a suggestion', false, false, 'ok');
    }
    lastSeen.customer.set(k, n);
  });
  flash(box, shown, lastSeen.customer, tk => { if (tk.status === 'ready') { try { navigator.vibrate?.([200, 100, 200]); } catch {} } });
}
function ticketHTML(tk) {
  const st = HERO[tk.status] ? tk.status : 'booked';
  const [ic, title, sub] = HERO[st];
  let subText = st === 'noshow' ? `${tk.noshowReason || 'The attendant couldn’t complete this wash'}. You haven’t been charged.` : sub;
  if (['booked', 'verified', 'washing'].includes(st) && tk.estReadyAt) subText += ` Expected ready around ${t(tk.estReadyAt)}.`;
  const al = (tk.alerts || []).slice().reverse();
  return `<article class="card ticket" data-id="${esc(tk.id)}">
    <div class="hero ${st}"><span class="ico">${ICON[ic]}</span><div><h2>${title}</h2><p>${esc(subText)}</p></div></div>
    <div class="tbody">
      <div class="tline"><span class="plate">${esc(tk.plate)}</span><span class="code">Ticket ${esc(code(tk))}</span>${discChip(tk)}</div>
      <div class="tk-meta"><span>Bay <b>${esc(bayText(tk))}</b></span><span>${esc(lineItems(tk).map(([n]) => n).join(' + '))}</span>${price(tk) ? `<span>Total <b>₹${price(tk)}</b></span>` : ''}${tk.attendant ? `<span>Attendant <b>${esc(tk.attendant)}</b></span>` : ''}</div>
      ${suggestCustomerHTML(tk)}
      ${['cancelled', 'noshow'].includes(st) ? '' : stepsHTML(tk)}
      ${tk.backBy && !DONE.includes(st) ? `<p class="hint">You said you’ll be back around <b>${t(tk.backBy)}</b>.</p>` : ''}
      ${damageHTML(tk, true)}${checklistView(tk)}${photosHTML(tk)}
      ${st === 'ready' ? payHTML(tk) : ''}
      ${st === 'closed' ? (tk.rating ? `<div class="pay"><h3>Thanks for your rating</h3>${ratingHTML(tk)}</div>` : rateHTML()) : ''}
      ${st === 'closed' ? receiptBlock(tk, 'customer') : ''}
      ${st === 'closed' ? issueCustomerHTML(tk) : ''}
      ${DONE.includes(st) ? `<button class="btn alt" data-again="${esc(tk.id)}">Book again for ${esc(tk.plate)}</button>` : ''}
      ${st === 'booked' ? '<div><button class="link danger" data-act="cancel">Cancel booking</button></div>' : ''}
      <details class="upd"><summary>All updates (${al.length})</summary><ul class="alerts">${al.map(a => `<li><time>${t(a.at)}</time><span>${esc(a.text)}</span></li>`).join('')}</ul></details>
      <p class="err" hidden></p>
    </div></article>`;
}
// What the attendant ticked off, shown to the customer and security.
function checklistView(tk) {
  const list = checklistFor(tk);
  if (!list.length || !['washing', 'ready', 'closed'].includes(tk.status)) return '';
  const n = list.filter(i => tk.checklist?.[i]).length;
  return `<div class="cklist view"><h3>What we did <span class="hint">${n} of ${list.length}</span></h3><ul>${list.map(i =>
    `<li class="${tk.checklist?.[i] ? 'on' : ''}">${esc(i)}</li>`).join('')}</ul></div>`;
}
function issueBadge(tk) {
  if (!tk.issue) return '';
  return tk.issue.status === 'resolved' ? '<span class="chip st-closed">Complaint resolved</span>' : '<span class="chip st-noshow">Complaint open</span>';
}
function issueCustomerHTML(tk) {
  if (tk.issue) {
    const i = tk.issue;
    return `<div class="issuebox ${i.status}"><b>${i.status === 'resolved' ? 'Problem resolved' : 'Problem reported'}</b>
      <span>${esc(i.type)}: “${esc(i.text)}” · ${t(i.at)}</span>
      ${i.status === 'resolved' ? `<span>${esc(i.resolution || '')}</span>` : '<span>We’ll look into it and contact you on WhatsApp.</span>'}</div>`;
  }
  return `<details class="issue"><summary class="link">Report a problem</summary><div class="issueform">
    <label>What went wrong?<select class="itype">${ISSUE_TYPES.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
    <label>Tell us more<textarea class="itext" maxlength="500" rows="3" placeholder="For example: small scratch on the left door that wasn’t there before"></textarea></label>
    <p class="hint">The before and after photos are attached automatically.</p>
    <button class="btn alt" data-act="issue">Send</button></div></details>`;
}
function rateHTML() {
  return `<div class="pay rate"><h3>How was your wash?</h3>
    <div class="starpick" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star" data-rate="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" aria-pressed="false">★</button>`).join('')}</div>
    <label>Comment (optional)<input class="rcomment" maxlength="300" placeholder="Anything we should know?"></label>
    <button class="btn go big" data-act="rate">Send rating</button></div>`;
}
// ---- receipts
function receiptLines(tk) {
  return lineItems(tk);
}
function receiptText(tk) {
  const L = [
    `${brand} – Receipt`,
    `Ticket ${code(tk)} · ${new Date(tk.paidAt || tk.bookedAt).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    `${siteName(tk.site)} · Bay ${bayText(tk)}`,
    `Car ${tk.plate}`,
    ...receiptLines(tk).map(([n, p]) => `${n}: ₹${p}`),
  ];
  if (discount(tk)) L.push(`${discountName(tk)}: −₹${discount(tk)}`);
  L.push(`Total paid: ₹${price(tk)}${tk.paidVia ? ' (' + tk.paidVia + ')' : ''}`);
  if (tk.attendant) L.push(`Attendant: ${tk.attendant}`);
  L.push('Thank you!');
  return L.join('\n');
}
function receiptHTML(tk) {
  return `<div class="receipt">
    <p class="rc-brand">${esc(brand)}</p>
    <p class="hint">Ticket ${esc(code(tk))} · ${new Date(tk.paidAt || tk.bookedAt).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}<br>${esc(siteName(tk.site))} · Bay ${esc(bayText(tk))} · ${esc(tk.plate)}</p>
    <table class="rc">${receiptLines(tk).map(([n, p]) => `<tr><td>${esc(n)}</td><td class="num">₹${p}</td></tr>`).join('')}
    ${discount(tk) ? `<tr><td>${esc(discountName(tk))}</td><td class="num">−₹${discount(tk)}</td></tr>` : ''}
    <tr class="rc-total"><td>Total paid</td><td class="num">₹${price(tk)}</td></tr></table>
    <p class="hint">${tk.paidVia ? 'Paid via ' + esc(tk.paidVia) + ' · ' : ''}${tk.attendant ? 'Attendant ' + esc(tk.attendant) : ''}</p></div>`;
}
const receiptWa = tk => { const n = waNumber(tk.phone); return n ? `https://wa.me/${n}?text=${encodeURIComponent(receiptText(tk))}` : ''; };
function receiptBlock(tk, who) {
  const share = who === 'customer'
    ? `<a class="btn alt sm" href="https://wa.me/?text=${encodeURIComponent(receiptText(tk))}" target="_blank" rel="noopener">Share on WhatsApp</a>`
    : (receiptWa(tk) ? `<a class="btn alt sm" href="${esc(receiptWa(tk))}" target="_blank" rel="noopener">Send receipt to customer</a>` : '');
  return `<details class="rcwrap"><summary class="btn alt sm">View receipt</summary>${receiptHTML(tk)}<div class="row">${share}<button class="btn alt sm" data-copy="${esc(tk.id)}">Copy receipt</button></div></details>`;
}

function payHTML(tk) {
  const amt = price(tk) ? `₹${price(tk)}` : '';
  return `<div class="pay">${amt ? `<div class="row between"><span class="hint">Amount due</span><span class="amount">${amt}</span></div>` : ''}
    <button class="btn go big" data-act="pay">Pay ${amt} now</button>
    <p class="hint">Demo payment: tapping marks the ticket as paid. No money is taken.</p></div>`;
}

function photoBtn(kind, has, big = true) {
  return has ? `<button class="link" data-photo="${kind}">Retake ${kind}-photo</button>`
    : `<button class="btn go${big ? ' big' : ''}" data-photo="${kind}">Take ${kind}-photo</button>`;
}
function noshowHTML(id) {
  return `<details class="noshow" data-keepopen="${esc(id)}:ns"><summary class="link">Car not found or customer left?</summary>
    <div class="noshowbox"><label>Reason<select class="nsreason" data-keep="${esc(id)}:nr">${NOSHOW_REASONS.map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
    <button class="btn warn" data-act="noshow">Close as not done</button></div></details>`;
}
function loyaltyHTML(tk) {
  const v = visits.get(tk.id);
  if (v == null) return '';
  const L = business.loyalty || {};
  const due = L.every > 1 && (v + 1) % L.every === 0;
  if (!v) return '<p class="hint">First visit for this car.</p>';
  return `<p class="loyal">Returning customer · ${v} earlier wash${v === 1 ? '' : 'es'}${due ? ` · <b>Loyalty wash: ${L.discountPct}% off</b> (applied when you verify)` : ''}</p>`;
}
async function loadVisits(tk) {
  const key = tk.id;
  if (visits.has(key) || !tk.plateKey) return;
  visits.set(key, null);
  try {
    const q = role() === 'owner'
      ? query(collection(fs, 'tickets'), where('plateKey', '==', tk.plateKey))
      : query(collection(fs, 'tickets'), where('site', '==', tk.site || mySite()), where('plateKey', '==', tk.plateKey));
    const snap = await getDocs(q);
    visits.set(key, snap.docs.filter(d => d.id !== tk.id && d.data().status === 'closed').length);
  } catch { visits.delete(key); }
  rerender();
}
const ago = iso => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
function stage(tk) {
  const p = tk.photos || {};
  if (tk.status === 'booked') return [1, 'Find and verify the car'];
  if (tk.status === 'verified') return !tk.damage ? [2, 'Check for existing damage'] : !p.before ? [3, 'Take the before-photo'] : [4, 'Start the wash'];
  if (tk.status === 'washing') return !(p.after && checklistDone(tk)) ? [5, 'Wash the car'] : [6, 'Mark the wash complete'];
  if (tk.status === 'ready') return [0, 'Waiting for payment'];
  return [0, ''];
}
function suggestStaffHTML(tk) {
  if (!['verified', 'washing'].includes(tk.status)) return '';
  const last = (tk.suggests || []).at(-1);
  const sum = g => (g.items || []).reduce((a, i) => a + (Number(i.p) || 0), 0);
  const names = g => (g.items || []).map(i => i.n).join(', ');
  const status = last ? (last.status === 'open' ? `<p class="sugstate wait">Waiting for the customer: ${esc(names(last))} +₹${sum(last)}</p>`
    : last.status === 'accepted' ? `<p class="sugstate yes">Customer added ${esc(names(last))} +₹${sum(last)}</p>` : `<p class="sugstate no">Customer said no to ${esc(names(last))}</p>`) : '';
  if (last?.status === 'open') return status;
  const have = lineItems(tk).map(([n]) => n);
  const opts = activeCatalog().filter(x => !have.includes(x.name));
  if (!opts.length) return status;
  return `${status}<details class="sugbox" data-keepopen="${esc(tk.id)}:sg"><summary class="link">Suggest an add-on to the customer</summary><div class="sugform">
    ${opts.map(x => `<label class="ck"><input type="checkbox" data-sug data-keep="${esc(tk.id)}:s:${esc(x.name)}" value="${esc(x.name)}"><span>${esc(x.name)}</span><b>₹${x.price}</b></label>`).join('')}
    <label>Why? (shown to the customer)<input class="sugnote" data-keep="${esc(tk.id)}:sn" maxlength="160" placeholder="Front left tyre looks low"></label>
    <button class="btn alt" data-act="suggest">Send suggestion</button>
    <p class="hint">The customer gets it on their ticket. Nothing is added unless they tap Add.</p></div></details>`;
}
function suggestCustomerHTML(tk) {
  const g = (tk.suggests || []).at(-1);
  if (!g || g.status !== 'open' || !['verified', 'washing'].includes(tk.status)) return '';
  const sum = (g.items || []).reduce((a, i) => a + (Number(i.p) || 0), 0);
  return `<div class="sugcard"><p class="stepno">Suggestion from ${esc(g.by || 'your attendant')}</p>
    ${(g.items || []).map(i => `<div class="row between"><b>${esc(i.n)}</b><b>+₹${i.p}</b></div>`).join('')}
    ${g.note ? `<p>“${esc(g.note)}”</p>` : ''}
    <button class="btn go big" data-act="accept">Add for ₹${sum}</button><button class="link" data-act="decline">No thanks</button></div>`;
}
function nowHTML(tk) {
  const p = tk.photos || {}; const id = esc(tk.id);
  const [n, title] = stage(tk);
  let help = '', main = '', more = '';
  if (tk.status === 'booked') {
    help = 'Type the number plate exactly as you see it on the car.';
    main = `${loyaltyHTML(tk)}<label>Number plate on the car<input class="vplate" data-keep="${id}:v" autocomplete="off" autocapitalize="characters" placeholder="Type what you see"></label>
      <button class="btn go big" data-act="verify">Verify car</button>`;
  } else if (tk.status === 'verified' && !tk.damage) {
    help = 'Walk around the car before touching it. Look for scratches, dents and cracks that are already there.';
    main = dmgOpen.has(tk.id)
      ? `<label>Describe the damage<input class="dmgnote" data-keep="${id}:d" maxlength="200" placeholder="Scratch on rear bumper, left side"></label>
         ${p.damage ? '<p class="ok">Damage photo added</p>' : ''}
         <button class="btn alt" data-photo="damage">${p.damage ? 'Retake' : 'Add'} damage photo</button>
         <button class="btn go big" data-act="damage">Save damage note</button>`
      : `<button class="btn go big" data-act="nodamage">No existing damage</button><button class="btn alt big" data-dmg="1">Found damage</button>`;
    if (dmgOpen.has(tk.id)) more = '<button class="link" data-dmg="0">Back</button>';
  } else if (tk.status === 'verified' && !p.before) {
    help = 'Photograph the whole car before you start.';
    main = photoBtn('before', false);
    more = '<button class="link" data-act="redodamage">Change damage check</button>';
  } else if (tk.status === 'verified') {
    main = '<button class="btn go big" data-act="start">Start wash</button>';
    more = `${photoBtn('before', true)}<button class="link" data-act="redodamage">Change damage check</button>`;
  } else if (tk.status === 'washing' && !(p.after && checklistDone(tk))) {
    const list = checklistFor(tk);
    help = list.length ? 'Tick each item as you finish it, then photograph the clean car from the same angle as the before-photo.' : 'When you finish, photograph the clean car from the same angle as the before-photo.';
    main = (list.length ? `<ul class="cklist">${list.map(i => `<li><label class="ck"><input type="checkbox" data-check="${esc(i)}" ${tk.checklist?.[i] ? 'checked' : ''}><span>${esc(i)}</span></label></li>`).join('')}</ul>` : '')
      + (p.after ? `<p class="ok">After-photo taken</p>` : `<button class="btn ${checklistDone(tk) ? 'go big' : 'alt'}" data-photo="after">Take after-photo</button>`);
    more = p.after ? photoBtn('after', true) : '';
  } else if (tk.status === 'washing') {
    main = '<button class="btn go big" data-act="done">Wash complete</button>';
    more = photoBtn('after', true);
  } else if (tk.status === 'ready') {
    main = '<p class="waitpay">The customer pays on their phone. This job closes by itself once they pay.</p>';
    more = '<button class="link" data-act="paid">Customer paid in cash instead</button>';
  }
  return `<div class="nowbox">${n ? `<p class="stepno">Step ${n} of 6</p>` : ''}<h3>${title}</h3>${help ? `<p class="hint">${help}</p>` : ''}${main}${more ? `<div class="row between">${more}</div>` : ''}</div>`;
}
function jobHTML(tk, group) {
  const st = LABEL[tk.status] ? tk.status : 'booked';
  const open = openJob === tk.id;
  const locked = tk.status !== 'booked' && tk.attendantUid && tk.attendantUid !== user?.uid;
  const since = { booked: tk.bookedAt, verified: tk.verifiedAt, washing: tk.startedAt, ready: tk.completedAt }[tk.status] || tk.bookedAt;
  const age = tk.status === 'booked' ? `waiting ${ago(since)}` : tk.status === 'ready' ? `ready ${ago(since)}` : ago(since);
  const head = `<button class="jobhead" data-toggle="${esc(tk.id)}" aria-expanded="${open}">
      <span class="plate">${esc(tk.plate)}</span><span class="where">Bay ${esc(bayText(tk))}${tk.backBy && !['ready'].includes(tk.status) ? ` <span class="${isLate(tk) ? 'late' : 'backby'}">${isLate(tk) ? 'Late · ' : ''}back ${t(tk.backBy)}</span>` : ''}</span>
      <span class="svcl">${esc(tk.service)}${price(tk) ? ` · ₹${price(tk)}` : ''}${group === 'other' ? ` · ${esc(tk.attendant || '')}` : ''}</span>
      <span class="chip st-${st}">${LABEL[st]}</span><span class="age">${age}</span></button>`;
  if (!open) return `<article class="job s-${st}${group === 'other' ? ' other' : ''}" data-id="${esc(tk.id)}">${head}</article>`;
  const wa = waLink(tk);
  const meta = [`<span>${esc(code(tk))}</span>`, tk.walkUp ? '<span class="ex">Walk-up</span>' : '', discChip(tk),
    tk.phone ? `<span>WhatsApp <b>${esc(mask(tk.phone))}</b></span>` : '', tk.attendant ? `<span>Attendant <b>${esc(tk.attendant)}</b></span>` : ''].join('');
  const action = locked
    ? `<div class="nowbox"><p class="lockmsg"><b>${esc(tk.attendant || 'Another attendant')}</b> is on this job. Only they can update it.</p><button class="link" data-act="takeover">Take over this job</button></div>`
    : nowHTML(tk) + suggestStaffHTML(tk);
  const foot = [wa ? `<a class="btn wa sm" href="${esc(wa)}" target="_blank" rel="noopener">Send WhatsApp update</a>` : '',
    !locked && ['booked', 'verified'].includes(tk.status) ? noshowHTML(tk.id) : ''].join('');
  return `<article class="job open s-${st}${group === 'other' ? ' other' : ''}" data-id="${esc(tk.id)}">${head}
    <div class="jobbody"><div class="tk-meta">${meta}</div>${stepsHTML(tk)}${tk.damage ? damageHTML(tk, false) : ''}${photosHTML(tk)}
    ${action}${foot ? `<div class="jobfoot">${foot}</div>` : ''}<p class="err" hidden></p></div></article>`;
}
// Typed text and open drop-downs survive the live redraws.
function saveDrafts(box) {
  const d = {}, o = {};
  box.querySelectorAll('[data-keep]').forEach(i => { d[i.dataset.keep] = i.type === 'checkbox' ? i.checked : i.value; });
  box.querySelectorAll('[data-keepopen]').forEach(i => { o[i.dataset.keepopen] = i.open; });
  const a = document.activeElement; const f = box.contains(a) ? a?.dataset?.keep : null;
  return { d, o, f, sel: f && a.setSelectionRange ? [a.selectionStart, a.selectionEnd] : null };
}
function restoreDrafts(box, k) {
  box.querySelectorAll('[data-keep]').forEach(i => { const v = k.d[i.dataset.keep]; if (v == null) return; if (i.type === 'checkbox') i.checked = v; else i.value = v; });
  box.querySelectorAll('[data-keepopen]').forEach(i => { if (k.o[i.dataset.keepopen]) i.open = true; });
  if (k.f) {
    const el = box.querySelector(`[data-keep="${CSS.escape(k.f)}"]`);
    if (el) { el.focus({ preventScroll: true }); try { if (k.sel) el.setSelectionRange(...k.sel); } catch {} }
  }
}
function renderQueue() {
  const box = $('#queue');
  const keep = saveDrafts(box);
  const uid = user?.uid;
  // Earliest deadline first: the customer's return time, or 3 hours after booking if they didn't say.
  const due = x => x.backBy ? new Date(x.backBy).getTime() : new Date(x.bookedAt || 0).getTime() + 3 * 3600000;
  const asc = (a, b) => due(a) - due(b);
  const open = tickets.filter(x => !DONE.includes(x.status));
  const mineJ = open.filter(x => x.status !== 'booked' && (!x.attendantUid || x.attendantUid === uid)).sort(asc);
  const newJ = open.filter(x => x.status === 'booked').sort(asc);
  const otherJ = open.filter(x => x.status !== 'booked' && x.attendantUid && x.attendantUid !== uid).sort(asc);
  newJ.forEach(loadVisits);
  if (openJob && !open.some(x => x.id === openJob)) openJob = undefined;
  if (openJob === undefined) openJob = mineJ[0]?.id || newJ[0]?.id;
  const doneToday = tickets.filter(x => x.status === 'closed' && today(x.paidAt));
  const done = doneToday.length ? `<details class="card donelist" data-keepopen="done"><summary>Completed today (${doneToday.length})</summary>${doneToday.map(tk =>
    `<div class="donerow" data-id="${esc(tk.id)}"><span class="plate sm">${esc(tk.plate)}</span><span>₹${price(tk)} · ${t(tk.paidAt)}</span>${receiptWa(tk) ? `<a class="btn alt sm" href="${esc(receiptWa(tk))}" target="_blank" rel="noopener">Send receipt</a>` : ''}</div>`).join('')}</details>` : '';
  const sec = (title, list, group) => list.length
    ? `<div class="qhead"><h3>${title}</h3><span>${list.length}</span></div><div class="joblist">${list.map(tk => jobHTML(tk, group)).join('')}</div>` : '';
  box.innerHTML = (open.length
    ? sec('My jobs', mineJ, 'mine') + sec('New bookings', newJ, 'new') + sec('Other attendants', otherJ, 'other')
    : `<div class="empty"><b>No open bookings</b><br>New bookings appear here the moment a customer books${soundOn ? ', with a sound' : ''}.</div>`) + done;
  restoreDrafts(box, keep);
  flash(box, open, lastSeen.queue);
  document.title = newJ.length && can('attendant') ? `(${newJ.length}) ${brand}` : brand;
}

function renderSecurity() {
  const todays = tickets.filter(x => today(x.bookedAt));
  const n = s => todays.filter(x => s.includes(x.status)).length;
  $('#stats').innerHTML = [
    ['Waiting', n(['booked'])], ['In progress', n(['verified', 'washing'])], ['Ready for owner', n(['ready'])], ['Closed today', n(['closed'])],
  ].map(([l, v]) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`).join('');
  $('#logBody').innerHTML = todays.length ? todays.map(tk => {
    const st = LABEL[tk.status] ? tk.status : 'booked';
    const ph = (tk.photos?.before ? 'Before' : '') + (tk.photos?.before && tk.photos?.after ? ' + ' : '') + (tk.photos?.after ? 'After' : '');
    return `<tr>
    <td class="t"><button class="link mono" data-detail="${esc(tk.id)}">${esc(code(tk))}</button>${tk.example ? ' <span class="ex">Ex</span>' : ''}</td><td class="t">${esc(tk.plate)}</td><td>${esc(bayText(tk))}</td><td>${esc(tk.service)}</td>
    <td><span class="chip st-${st}">${LABEL[st]}</span></td><td>${esc(tk.attendant || '–')}</td><td>${ph || '–'}</td><td>${tk.damage ? (tk.damage.found ? '<b class="dmgflag">Noted</b>' : 'None') : '–'}</td><td>${tk.rating ? `<span class="stars" aria-label="${tk.rating} out of 5">${stars(tk.rating)}</span>` : '–'}</td>
    <td class="t">${t(tk.bookedAt)}</td><td class="t">${t(tk.verifiedAt)}</td><td class="t">${t(tk.startedAt)}</td><td class="t">${t(tk.completedAt)}</td><td class="t">${t(tk.paidAt)}</td></tr>`;
  }).join('')
    : '<tr><td colspan="14"><div class="empty">No jobs logged today. Each booking appears here with every step timed.</div></td></tr>';
  $('#logCards').innerHTML = todays.length ? todays.map(tk => {
    const st = LABEL[tk.status] ? tk.status : 'booked';
    const times = [['Booked', tk.bookedAt], ['Started', tk.startedAt], ['Done', tk.completedAt], ['Paid', tk.paidAt]]
      .filter(([, v]) => v).map(([l, v]) => `${l} <b>${t(v)}</b>`).join(' · ');
    return `<article class="logcard">
      <div class="tk-head"><div class="row"><span class="plate">${esc(tk.plate)}</span><span class="chip st-${st}">${LABEL[st]}</span>${issueBadge(tk)}${tk.example ? '<span class="ex">Example</span>' : ''}</div>
        <button class="link mono" data-detail="${esc(tk.id)}">${esc(code(tk))}</button></div>
      <div class="tk-meta"><span>Bay <b>${esc(bayText(tk))}</b></span><span>${esc(tk.service)}</span>${tk.attendant ? `<span>Attendant <b>${esc(tk.attendant)}</b></span>` : ''}</div>
      <div class="tk-meta"><span>Photos <b>${tk.photos?.before ? (tk.photos?.after ? 'Before + after' : 'Before') : 'None yet'}</b></span>
        <span>Damage <b class="${tk.damage?.found ? 'dmgflag' : ''}">${tk.damage ? (tk.damage.found ? 'Noted' : 'None') : '–'}</b></span>
        ${tk.rating ? `<span class="stars" aria-label="${tk.rating} out of 5">${stars(tk.rating)}</span>` : ''}</div>
      <p class="times">${times}</p></article>`;
  }).join('') : '<div class="empty">No jobs logged today. Each booking appears here with every step timed.</div>';
  const d = detailId && tickets.find(x => x.id === detailId);
  $('#detail').innerHTML = d ? `<article class="card"><div class="row" style="justify-content:space-between"><h3>Ticket ${esc(code(d))}</h3><button class="link" data-detail="">Close</button></div>
    ${headHTML(d, true)}${stepsHTML(d)}${damageHTML(d, false)}${checklistView(d)}${photosHTML(d) || '<p class="hint">No photos yet.</p>'}${d.issue ? issueCustomerHTML(d) : ''}${ratingHTML(d)}${d.status === 'closed' ? receiptBlock(d, 'staff') : ''}${alertsHTML(d)}</article>` : '';
}

function renderStaff() {
  const body = $('#staffBody');
  if (!staff.length) { body.innerHTML = '<div class="empty">No staff accounts yet.</div>'; return; }
  const rank = { pending: 0, attendant: 1, security: 2, owner: 3, none: 4 };
  body.innerHTML = staff.slice().sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9)).map(s => {
    const self = s.uid === user?.uid;
    const btns = self || s.role === 'owner' ? '' : ['attendant', 'security', 'none']
      .filter(r => r !== s.role)
      .map(r => `<button class="btn ${r === 'none' ? 'warn' : s.role === 'pending' ? 'go' : 'alt'} sm" data-role="${r}" data-uid="${esc(s.uid)}">${r === 'none' ? 'Remove access' : 'Make ' + ROLE_LABEL[r].toLowerCase()}</button>`).join('');
    const siteCell = s.role === 'owner' ? '<span class="hint">All sites</span>'
      : SITES.length > 1 && !self
        ? `<select class="sitesel" data-site-uid="${esc(s.uid)}" aria-label="Site for ${esc(s.name || s.email)}">${SITES.map(x => `<option value="${esc(x.id)}" ${(s.site || DEFAULT_SITE) === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`
        : `<span class="hint">${esc(siteName(s.site))}</span>`;
    return `<div class="card staffcard"><div class="nm"><b>${esc(s.name || '–')}${self ? ' (you)' : ''}</b><small>${esc(s.email || '')}</small></div>
      <span class="chip ${s.role === 'pending' ? 'st-booked' : s.role === 'none' ? 'st-noshow' : 'st-ready'}">${esc(ROLE_LABEL[s.role] || s.role)}</span>
      <div class="row" style="flex:1 1 100%">${siteCell}${btns}</div></div>`;
  }).join('');
}

// ---- attendant shifts
function renderShift() {
  const box = $('#shiftCard'); if (!box) return;
  const sh = shifts.find(x => x.uid === user?.uid); const sessions = sh?.sessions || [];
  const on = sessions.length && !sessions[sessions.length - 1].out;
  const mins = sessions.reduce((m, x) => m + ((x.out ? new Date(x.out) : new Date()) - new Date(x.in)) / 60000, 0);
  box.className = 'shiftbar' + (on ? ' on' : '');
  box.innerHTML = `<div class="st"><span class="sdot"></span><div><b>${on ? 'On shift' : 'Off shift'}</b>
    <small>${sessions.length ? `Since ${t(sessions[0].in)} · ${fmtMin(mins)} today` : 'Tap Start when you arrive'}</small></div></div>
    <div class="acts"><button class="iconbtn" data-sound aria-pressed="${soundOn}" aria-label="Sound for new bookings" title="Sound for new bookings">${soundOn ? ICON.bell : ICON.belloff}</button>
    <button class="btn ${on ? 'alt' : 'go'} sm" data-shift="${on ? 'out' : 'in'}">${on ? 'End shift' : 'Start shift'}</button></div>`;
}
async function shiftAction(kind) {
  const id = `${user.uid}_${dayKey()}`;
  const sessions = [...(shifts.find(x => x.uid === user.uid)?.sessions || [])];
  if (kind === 'in') sessions.push({ in: now() });
  else if (sessions.length && !sessions[sessions.length - 1].out) sessions[sessions.length - 1] = { ...sessions[sessions.length - 1], out: now() };
  try {
    await setDoc(doc(fs, 'shifts', id), { uid: user.uid, name: profile?.name || user.email, site: mySite(), day: dayKey(), sessions });
  } catch { $('#shiftCard').insertAdjacentHTML('beforeend', '<p class="err">Shift didn’t save. Try again.</p>'); }
}

// ---- walk-up booking by an attendant
function walkServices() {
  const box = $('#w-services'); if (!box || box.dataset.done) return;
  box.dataset.done = '1';
  box.innerHTML = `<legend>Services</legend><div class="svcgrid addons">${activeCatalog().map(x => x.name).map(n =>
    `<label class="svc"><input type="checkbox" value="${esc(n)}"><span>${esc(n)}</span><b>${itemPrice(n) ? '₹' + itemPrice(n) : ''}</b></label>`).join('')}</div>
    <p class="total">Total <b id="w-total">₹0</b></p>`;
  if (box.dataset.bound) return; box.dataset.bound = '1';
  box.addEventListener('change', () => {
    const sum = [...box.querySelectorAll('input:checked')].reduce((s, i) => s + itemPrice(i.value), 0);
    $('#w-total').textContent = '₹' + sum.toLocaleString('en-IN');
  });
  const zs = $('#w-zone');
  const zones = siteOf(mySite()).zones || [];
  zs.innerHTML = `<option value="">No zone</option>${zones.map(z => `<option>${esc(z)}</option>`).join('')}`;
  zs.closest('label').hidden = !zones.length;
}
$('#walkForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#walkErr'); err.hidden = true;
  const plate = $('#w-plate').value.trim(), bay = $('#w-bay').value.trim(), phone = $('#w-phone').value.trim();
  const svcs = [...document.querySelectorAll('#w-services input:checked')].map(i => i.value);
  const problems = [];
  if (norm(plate).length < 6) problems.push('Enter the full car number.');
  if (!bay) problems.push('Enter the bay.');
  if (phone && phone.replace(/\D/g, '').length < 10) problems.push('Enter a 10-digit WhatsApp number, or leave it empty.');
  if (!svcs.length) problems.push('Choose at least one service.');
  if (!$('#w-consent').checked) problems.push('The customer needs to tick the authorisation box.');
  if (problems.length) { err.textContent = problems.join(' '); err.hidden = false; return; }
  const c = newCode(); const at = now();
  const by = profile?.name || 'Staff';
  const tk = { code: c, plate: prettyPlate(plate), plateKey: norm(plate), bay, phone, service: svcs.join(SEP),
    site: mySite(), zone: $('#w-zone').value || '', day: dayKey(), status: 'booked', consent: true, bookedAt: at,
    ...(Number($('#w-back').value) ? { backBy: new Date(Date.now() + Number($('#w-back').value) * 60000).toISOString() } : {}),
    walkUp: true, createdBy: user.uid, alerts: [{ at, text: `Walk-up booking by ${by}. Customer gave consent on the attendant's phone. Ticket ${c}` }] };
  try {
    await setDoc(doc(collection(fs, 'tickets')), tk);
    $('#walkForm').reset(); $('#w-total').textContent = '₹0';
    $('#walkDlg').close();
    toast(`Walk-up booking created · ${tk.plate}`, false, false, 'ok');
  } catch { err.textContent = 'Booking didn’t save. Check your connection and try again.'; err.hidden = false; }
});

function renderStaffViews() { renderQueue(); renderSecurity(); renderStaff(); renderDash(); renderShift(); if (can('attendant')) walkServices(); if (role() === 'owner' && clearStep === 0) renderClear(); }

// ---- owner dashboard
const mins = (a, b) => (a && b) ? (new Date(b) - new Date(a)) / 60000 : null;
const avg = xs => { const v = xs.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
const fmtMin = m => m == null ? '–' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');

function renderDash() {
  const box = $('#v-dash'); if (!box || role() !== 'owner') return;
  document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === dashRange)));
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (dashRange - 1));
  const inSite = x => dashSite === 'all' || (x.site || DEFAULT_SITE) === dashSite;
  const list = tickets.filter(x => !x.example && x.bookedAt && new Date(x.bookedAt) >= from && inSite(x));
  const closed = list.filter(x => x.status === 'closed');
  const priced = Object.values(business.prices || {}).some(v => Number(v) > 0);
  const revenue = closed.reduce((s, x) => s + price(x), 0);
  const rated = closed.filter(x => x.rating);
  const avgRating = avg(rated.map(x => x.rating));
  const tiles = [
    ['Washes', String(closed.length), `${list.length} booked`],
    ['Revenue', priced ? inr(revenue) : '–', priced ? 'From paid tickets' : 'Add prices in settings.js'],
    ['Rating', avgRating == null ? '–' : avgRating.toFixed(1) + ' ★', `${rated.length} rating${rated.length === 1 ? '' : 's'}`],
    ['Wash time', fmtMin(avg(closed.map(x => mins(x.startedAt, x.completedAt)))), 'Average, start to finish'],
  ];
  const tile = ([l, v, s]) => `<div class="stat"><span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`;
  $('#dashStats').innerHTML = tiles.map(tile).join('');
  $('#dashMore').innerHTML = [
    ['Bookings', String(list.length), `${list.filter(x => x.walkUp).length} walk-up`],
    ['Average wait', fmtMin(avg(closed.map(x => mins(x.bookedAt, x.startedAt)))), 'Booking to start'],
    ['Damage found', String(list.filter(x => x.damage?.found).length), 'Before washing'],
    ['Cancelled', String(list.filter(x => x.status === 'cancelled').length), 'By the customer'],
    ['Not done', String(list.filter(x => x.status === 'noshow').length), 'Car not found or left'],
    ['Discounted washes', String(list.filter(x => x.discountPct).length), 'Loyalty or offer'],
    ['Add-ons accepted', String(list.filter(x => (x.suggests || []).some(g => g.status === 'accepted')).length), `of ${list.filter(x => (x.suggests || []).length).length} suggested`],
  ].map(tile).join('');
  $('#revMeta').textContent = priced ? inr(revenue) : '';
  $('#bookMeta').textContent = `${list.length} booking${list.length === 1 ? '' : 's'}`;
  $('#cmMeta').textContent = rated.filter(x => x.ratingComment).length ? String(rated.filter(x => x.ratingComment).length) : '';

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
  const svcRev = new Map();
  closed.forEach(x => lineItems(x).forEach(([n, p]) => { bySvc.set(n, (bySvc.get(n) || 0) + 1); svcRev.set(n, (svcRev.get(n) || 0) + p); }));
  $('#svcBody').innerHTML = bySvc.size ? [...bySvc].sort((a, b) => b[1] - a[1]).map(([sv, c]) =>
    `<tr><td>${esc(sv)}</td><td class="num">${c}</td><td class="num">${priced ? inr(svcRev.get(sv) || 0) : '–'}</td></tr>`).join('')
    : '<tr><td colspan="3" class="hint">No completed washes yet.</td></tr>';

  // Comments
  const cm = rated.filter(x => x.ratingComment).sort((a, b) => (b.ratedAt || '').localeCompare(a.ratedAt || '')).slice(0, 8);
  $('#comments').innerHTML = cm.length ? cm.map(x => `<li><span class="stars" aria-label="${x.rating} out of 5">${stars(x.rating)}</span> “${esc(x.ratingComment)}” <span class="hint">${esc(x.plate)} · ${new Date(x.ratedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></li>`).join('')
    : '<li class="hint">Customer comments appear here after they rate a wash.</li>';

  renderRevenue(inSite); renderTeam(); renderQR(); renderIssues(inSite);
  if (!catDirty && !$('#catEditor')?.contains(document.activeElement)) renderCatalogEditor();
}

// ---- dashboard extras: revenue trend, team status, QR codes, monthly report
function barChart(values, labels, fmt, aria, everyNth = 1) {
  const W = 640, H = 260, L = 64, R = 8, T = 14, B = 36;
  const max = Math.max(1, ...values);
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw) || raw;
  const top = Math.ceil(max / step) * step;
  const bw = (W - L - R) / values.length;
  const y = v => T + (H - T - B) * (1 - v / top);
  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 7}" text-anchor="end" class="ax">${fmt(v)}</text>`;
  values.forEach((c, i) => {
    const x = L + i * bw + 2, w = Math.max(2, bw - 4), label = `${labels[i]} · ${fmt(c)}`;
    if (c) {
      const yy = y(c), hh = H - B - yy, r = Math.min(4, w / 2, hh);
      svg += `<path class="bar" d="M${x},${H - B} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${H - B} Z"><title>${esc(label)}</title></path>`;
    }
    svg += `<rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" class="hit"><title>${esc(label)}</title></rect>`;
    if (i % everyNth === 0) svg += `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle" class="ax">${esc(labels[i])}</text>`;
  });
  svg += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="base"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${svg}</svg>`;
}
function renderRevenue(inSite) {
  const n = Math.max(7, dashRange), days = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const keys = days.map(d => dayKey(d));
  const rev = keys.map(() => 0);
  tickets.filter(x => !x.example && x.status === 'closed' && x.paidAt && inSite(x)).forEach(x => {
    const i = keys.indexOf(dayKey(new Date(x.paidAt))); if (i >= 0) rev[i] += price(x);
  });
  const labels = days.map(d => d.toLocaleDateString([], { day: 'numeric', month: 'short' }));
  $('#revChart').innerHTML = rev.some(Boolean)
    ? barChart(rev, labels, v => '₹' + Math.round(v).toLocaleString('en-IN'), 'Revenue per day', n > 10 ? 5 : 1) + `<p class="hint">Revenue from paid washes, by the day they were paid. Total ${inr(rev.reduce((a, b) => a + b, 0))}.</p>`
    : '<div class="empty">No paid washes in this period yet.</div>';
}
function renderIssues(inSite) {
  const box = $('#issues'); if (!box) return;
  const keep = saveDrafts(box);
  const all = tickets.filter(x => x.issue && inSite(x)).sort((a, b) => (b.issue.at || '').localeCompare(a.issue.at || ''));
  const open = all.filter(x => x.issue.status === 'open');
  $('#issueMeta').textContent = open.length ? `${open.length} open` : all.length ? 'All resolved' : '';
  if (open.length) $('#issueCard').open = true;
  box.innerHTML = all.length ? all.slice(0, 20).map(tk => `<div class="issuecard ${tk.issue.status}" data-id="${esc(tk.id)}">
      <div class="row between"><span class="row"><span class="plate sm">${esc(tk.plate)}</span><span class="hint">${esc(code(tk))} · ${esc(tk.attendant || '–')}</span></span>${issueBadge(tk)}</div>
      <p><b>${esc(tk.issue.type)}</b> · ${new Date(tk.issue.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
      <p>“${esc(tk.issue.text)}”</p>
      ${damageHTML(tk, false)}${photosHTML(tk)}
      ${tk.issue.status === 'open'
        ? `<label>What did you do?<input class="resnote" data-keep="${esc(tk.id)}:r" maxlength="300" placeholder="Refunded ₹249 / re-washed the car / repaired"></label>
           <div class="row">${tk.phone && waNumber(tk.phone) ? `<a class="btn wa sm" href="https://wa.me/${waNumber(tk.phone)}?text=${encodeURIComponent(`Hi, this is about your car wash ticket ${code(tk)}. We're sorry about the problem you reported and are looking into it.`)}" target="_blank" rel="noopener">Message customer</a>` : ''}<button class="btn go sm" data-act="resolve">Mark resolved</button></div>`
        : `<p class="ok">Resolved by ${esc(tk.issue.resolvedBy || '')}: ${esc(tk.issue.resolution || '')}</p>`}
      <p class="err" hidden></p></div>`).join('')
    : '<p class="hint">No complaints. When a customer reports a problem on their ticket it appears here with the photos.</p>';
  restoreDrafts(box, keep);
}
let cfgDoc = null, catDraft = [], catDirty = false, offDraft = {}, loyDraft = {};
function loadDraft() {
  catDraft = catalog.map(x => ({ ...x, checklist: [...x.checklist] }));
  offDraft = { active: !!business.offer?.active, label: business.offer?.label || '', pct: Number(business.offer?.pct) || 0 };
  loyDraft = { every: Number(business.loyalty?.every) || 0, discountPct: Number(business.loyalty?.discountPct) || 0 };
}
function renderCatalogEditor() {
  const box = $('#catEditor'); if (!box || role() !== 'owner') return;
  if (!catDraft.length && !catDirty) loadDraft();
  $('#catMeta').textContent = `${activeCatalog().length} offered${offerOn() ? ' · offer on' : ''}`;
  box.innerHTML = catDraft.map((x, i) => `<div class="svcedit${x.active ? '' : ' off'}" data-ci="${i}">
      <label>Service name<input data-f="name" value="${esc(x.name)}" maxlength="60"></label>
      <div class="two"><label>Price (₹)<input data-f="price" type="number" inputmode="numeric" min="0" step="1" value="${x.price}"></label>
        <label>Type<select data-f="kind"><option value="wash" ${x.kind === 'wash' ? 'selected' : ''}>Wash</option><option value="addon" ${x.kind === 'addon' ? 'selected' : ''}>Add-on</option></select></label></div>
      <label class="check"><input type="checkbox" data-f="active" ${x.active ? 'checked' : ''}><span>Offered to customers</span></label>
      <label>Short description<input data-f="desc" value="${esc(x.desc)}" maxlength="80" placeholder="Outside only · no keys needed"></label>
      <label>Checklist for the attendant (one item per line)<textarea data-f="checklist" rows="3">${esc(x.checklist.join('\n'))}</textarea></label>
      <div class="row between">${i ? `<button class="link" data-catmove="${i}">Move up</button>` : '<span></span>'}<button class="link danger" data-catdel="${i}">Remove</button></div></div>`).join('')
    + `<button class="btn alt" id="catAdd" type="button">+ Add a service</button>
    <div class="svcedit"><h3>Offer</h3>
      <label class="check"><input type="checkbox" data-o="active" ${offDraft.active ? 'checked' : ''}><span>Offer is on</span></label>
      <div class="two"><label>Name<input data-o="label" value="${esc(offDraft.label)}" maxlength="40" placeholder="Diwali offer"></label><label>Discount (%)<input data-o="pct" type="number" min="0" max="90" value="${offDraft.pct}"></label></div>
      <p class="hint">Shown on the booking page and applied when the attendant verifies the car. A loyalty discount is used instead if it is bigger.</p></div>
    <div class="svcedit"><h3>Loyalty</h3>
      <div class="two"><label>Every Nth wash<input data-l="every" type="number" min="0" max="50" value="${loyDraft.every}"></label><label>Discount (%)<input data-l="discountPct" type="number" min="0" max="100" value="${loyDraft.discountPct}"></label></div>
      <p class="hint">Set “every” to 0 to switch loyalty off.</p></div>
    <p class="err" id="catErr" hidden></p>
    <div class="row"><button class="btn go" id="catSave" type="button">Save changes</button><button class="link" id="catUndo" type="button">Undo changes</button><span class="hint" id="catState">${catDirty ? 'Unsaved changes' : cfgDoc?.updatedAt ? `Last saved ${new Date(cfgDoc.updatedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${cfgDoc.updatedBy ? ' by ' + esc(cfgDoc.updatedBy) : ''}` : 'Using the starting prices from settings.js'}</span></div>
    <p class="hint">Changes reach every phone within seconds. Tickets already verified keep their old prices.</p>`;
}
function onCatInput(e) {
  const el = e.target;
  if (el.dataset.o) { offDraft[el.dataset.o] = el.type === 'checkbox' ? el.checked : el.dataset.o === 'pct' ? Number(el.value) : el.value; }
  else if (el.dataset.l) { loyDraft[el.dataset.l] = Number(el.value); }
  else if (el.dataset.f) {
    const x = catDraft[Number(el.closest('[data-ci]').dataset.ci)]; const f = el.dataset.f;
    x[f] = f === 'active' ? el.checked : f === 'price' ? Number(el.value) : f === 'checklist' ? el.value.split('\n').map(v => v.trim()).filter(Boolean) : el.value;
    if (f === 'active') el.closest('.svcedit').classList.toggle('off', !el.checked);
  } else return;
  catDirty = true; const st = $('#catState'); if (st) st.textContent = 'Unsaved changes';
}
async function saveCatalog() {
  const err = $('#catErr'); err.hidden = true;
  const list = catDraft.map(x => ({ name: String(x.name || '').trim(), kind: x.kind === 'addon' ? 'addon' : 'wash', desc: String(x.desc || '').trim().slice(0, 80),
    price: Math.round(Number(x.price)), checklist: (x.checklist || []).slice(0, 12).map(v => String(v).slice(0, 60)), active: !!x.active }));
  const problems = [];
  if (list.some(x => !x.name)) problems.push('Every service needs a name.');
  if (new Set(list.map(x => x.name.toLowerCase())).size !== list.length) problems.push('Two services have the same name.');
  if (list.some(x => !(x.price >= 0) || x.price > 100000)) problems.push('Prices must be whole rupees.');
  if (!list.some(x => x.active && x.kind === 'wash')) problems.push('Offer at least one wash.');
  if (list.some(x => x.name.includes(SEP.trim()))) problems.push('Service names can’t contain “+”.');
  const pct = Math.round(Number(offDraft.pct) || 0);
  if (offDraft.active && !(pct > 0 && pct <= 90)) problems.push('Set the offer discount between 1 and 90%.');
  if (problems.length) { err.textContent = problems.join(' '); err.hidden = false; return; }
  $('#catSave').disabled = true;
  try {
    await setDoc(doc(fs, 'config', 'main'), { services: list, offer: { active: !!offDraft.active, label: String(offDraft.label || '').trim().slice(0, 40), pct },
      loyalty: { every: Math.max(0, Math.round(loyDraft.every || 0)), discountPct: Math.min(100, Math.max(0, Math.round(loyDraft.discountPct || 0))) },
      updatedAt: now(), updatedBy: profile?.name || 'Owner' });
    catDirty = false; toast('Prices and services saved', false, false, 'ok');
  } catch { err.textContent = 'Didn’t save. Check your connection and that the new database rules are published.'; err.hidden = false; }
  const b = $('#catSave'); if (b) b.disabled = false;
}
function renderTeam() {
  const box = $('#teamBody'); if (!box) return;
  const people = staff.filter(p => ['attendant', 'owner'].includes(p.role) && (dashSite === 'all' || (p.site || DEFAULT_SITE) === dashSite || p.role === 'owner'));
  if (!people.length) { box.innerHTML = '<tr><td colspan="5" class="hint">No attendants yet. Approve staff on the Staff tab.</td></tr>'; $('#teamMeta').textContent = ''; return; }
  const onNow = people.filter(p => { const ss = shifts.find(x => x.uid === p.uid)?.sessions || []; return ss.length && !ss[ss.length - 1].out; }).length;
  $('#teamMeta').textContent = `${onNow} on shift`;
  box.innerHTML = people.map(p => {
    const sh = shifts.find(x => x.uid === p.uid);
    const sessions = sh?.sessions || [];
    const on = sessions.length && !sessions[sessions.length - 1].out;
    const mins = sessions.reduce((m, x) => m + ((x.out ? new Date(x.out) : new Date()) - new Date(x.in)) / 60000, 0);
    const job = tickets.find(x => x.attendantUid === p.uid && ['verified', 'washing'].includes(x.status));
    const jobs = tickets.filter(x => x.attendantUid === p.uid && x.status === 'closed' && today(x.paidAt)).length;
    const status = !on ? '<span class="chip st-closed">Off shift</span>'
      : job ? `<span class="chip st-washing">Busy · ${esc(job.plate)}</span>` : '<span class="chip st-ready">Free</span>';
    return `<tr><td>${esc(p.name || p.email)}</td><td>${status}</td><td class="num">${sessions.length ? t(sessions[0].in) : '–'}</td><td class="num">${sessions.length ? fmtMin(mins) : '–'}</td><td class="num">${jobs}</td></tr>`;
  }).join('');
}
function bookingUrl(site, zone) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('site', site); if (zone) u.searchParams.set('zone', zone);
  return u.toString() + '#customer';
}
function boardUrl(site) {
  const u = new URL(location.origin + location.pathname); u.searchParams.set('board', site); return u.toString();
}
function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
function renderQR() {
  const box = $('#qrSheet'); if (!box || box.dataset.done) return;
  box.dataset.done = '1';
  $('#boardLinks').innerHTML = SITES.map(st => `<a class="btn alt sm" href="${esc(boardUrl(st.id))}" target="_blank" rel="noopener">Open live board${SITES.length > 1 ? ' · ' + esc(st.name) : ''}</a>`).join('');
  box.innerHTML = SITES.map(st => `<h4>${esc(st.name)}</h4><div class="qrgrid">${[...(st.zones || []), ''].map(z => {
    const url = bookingUrl(st.id, z);
    return `<figure class="qrcard">${qrSvg(url)}<figcaption><b>${z ? esc(z) : 'Any zone'}</b><span>Scan to book a wash</span><a href="${esc(url)}" target="_blank" rel="noopener">Open link</a></figcaption></figure>`;
  }).join('')}</div>`).join('');
}
function printPart(id) {
  document.body.dataset.print = id;
  document.body.classList.add('printing');
  setTimeout(() => { window.print(); setTimeout(() => { document.body.classList.remove('printing'); delete document.body.dataset.print; }, 500); }, 50);
}

// Monthly report for a venue
let reportData = null;
function buildReport() {
  const [y, m] = $('#rMonth').value.split('-').map(Number);
  const site = $('#rSite').value;
  const start = new Date(y, m - 1, 1), end = new Date(y, m, 1);
  const st = siteOf(site);
  const list = tickets.filter(x => !x.example && x.bookedAt && new Date(x.bookedAt) >= start && new Date(x.bookedAt) < end && (x.site || DEFAULT_SITE) === site);
  const closed = list.filter(x => x.status === 'closed');
  const revenue = closed.reduce((s, x) => s + price(x), 0);
  const share = Math.round(revenue * (Number(st.sharePct || 0) / 100));
  const rated = closed.filter(x => x.rating);
  const ar = avg(rated.map(x => x.rating));
  const hours = Array(24).fill(0); list.forEach(x => hours[new Date(x.bookedAt).getHours()]++);
  const peak = hours.indexOf(Math.max(...hours));
  const svc = new Map(); closed.forEach(x => lineItems(x).forEach(([n]) => svc.set(n, (svc.get(n) || 0) + 1)));
  const daysIn = new Date(y, m, 0).getDate(), daily = [];
  for (let d = 1; d <= daysIn; d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`;
    const dc = closed.filter(x => dayKey(new Date(x.paidAt || x.bookedAt)) === k);
    daily.push([k, dc.length, dc.reduce((s, x) => s + price(x), 0)]);
  }
  const monthName = start.toLocaleDateString([], { month: 'long', year: 'numeric' });
  reportData = { site: st.name, monthName, daily };
  const rows = [
    ['Washes completed', String(closed.length)],
    ['Bookings received', String(list.length)],
    ['Revenue', inr(revenue)],
    [`Venue share (${st.sharePct || 0}%)`, inr(share)],
    ['Average customer rating', ar == null ? 'No ratings yet' : `${ar.toFixed(1)} / 5 from ${rated.length} rating${rated.length === 1 ? '' : 's'}`],
    ['Average wash time', fmtMin(avg(closed.map(x => mins(x.startedAt, x.completedAt))))],
    ['Existing damage recorded before washing', String(list.filter(x => x.damage?.found).length)],
    ['Before and after photos on completed washes', `${closed.filter(x => x.photos?.before && x.photos?.after).length} of ${closed.length}`],
    ['Customer consent recorded', `${list.filter(x => x.consent).length} of ${list.length}`],
    ['Cancelled by customer', String(list.filter(x => x.status === 'cancelled').length)],
    ['Not done (car not found or customer left)', String(list.filter(x => x.status === 'noshow').length)],
    ['Busiest hour', list.length ? `${pad(peak)}:00–${pad(peak + 1)}:00` : '–'],
    ['Ready before the customer’s return time', (() => { const w = closed.filter(x => x.backBy && x.completedAt); return w.length ? `${w.filter(x => x.completedAt <= x.backBy).length} of ${w.length}` : '–'; })()],
    ['Service checklist completed', `${closed.filter(x => checklistFor(x).length && checklistDone(x)).length} of ${closed.filter(x => checklistFor(x).length).length}`],
    ['Customer complaints', `${list.filter(x => x.issue).length} (${list.filter(x => x.issue?.status === 'resolved').length} resolved)`],
  ];
  reportData.rows = rows;
  $('#report').hidden = false;
  $('#report').innerHTML = `<div class="rep">
    <p class="rc-brand">${esc(brand)}</p>
    <h3>Monthly report · ${esc(st.name)}</h3><p class="hint">${esc(monthName)} · created ${new Date().toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</p>
    <table class="rc">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`).join('')}</table>
    <h4>Services</h4>
    <table class="rc">${svc.size ? [...svc].sort((a, b) => b[1] - a[1]).map(([n, c]) => `<tr><td>${esc(n)}</td><td class="num">${c}</td></tr>`).join('') : '<tr><td class="hint">No completed washes this month.</td></tr>'}</table>
    ${rated.some(x => x.ratingComment) ? `<h4>Customer comments</h4><ul class="comments">${rated.filter(x => x.ratingComment).slice(0, 10).map(x => `<li><span class="stars">${stars(x.rating)}</span> “${esc(x.ratingComment)}”</li>`).join('')}</ul>` : ''}
  </div>
  <div class="row noprint"><button class="btn go sm" data-report="print">Print or save as PDF</button><button class="btn alt sm" data-report="csv">Download daily figures (CSV)</button><button class="btn alt sm" data-report="copy">Copy summary</button></div>`;
}
function reportAction(a, btn) {
  if (!reportData) return;
  if (a === 'print') return printPart('report');
  if (a === 'csv') {
    const csv = [['Date', 'Washes', 'Revenue (₹)'], ...reportData.daily].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const el = document.createElement('a');
    el.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    el.download = `report-${reportData.site.replace(/\W+/g, '-')}-${reportData.daily[0][0].slice(0, 7)}.csv`;
    document.body.appendChild(el); el.click(); el.remove();
    return;
  }
  if (a === 'copy') {
    const txt = [`${brand} – ${reportData.site} – ${reportData.monthName}`, ...reportData.rows.map(([k, v]) => `${k}: ${v}`)].join('\n');
    navigator.clipboard.writeText(txt).then(() => { btn.textContent = 'Copied'; }, () => { btn.textContent = 'Copy failed'; });
    setTimeout(() => { btn.textContent = 'Copy summary'; }, 1500);
  }
}

// ---- delegated events
document.addEventListener('click', async e => {
  const tg = e.target.closest('[data-toggle]');
  if (tg) { openJob = openJob === tg.dataset.toggle ? null : tg.dataset.toggle; renderQueue(); return; }
  const dm = e.target.closest('[data-dmg]');
  if (dm) { const id = dm.closest('[data-id]').dataset.id; dm.dataset.dmg === '1' ? dmgOpen.add(id) : dmgOpen.delete(id); renderQueue(); return; }
  if (e.target.closest('[data-sound]')) { soundOn = !soundOn; store.set('pwt-sound', soundOn); renderShift(); if (soundOn) chime(); return; }
  if (e.target.closest('#walkFab')) { walkServices(); $('#walkErr').hidden = true; $('#walkDlg').showModal(); return; }
  if (e.target.closest('#walkClose')) { $('#walkDlg').close(); return; }
  if (e.target.closest('#bookAnother')) { bookOpen = true; renderCustomer(); if (!$('#f-plate').value) fillCar(cars()[0]); renderCars(); $('#f-bay').focus(); return; }
  const ag = e.target.closest('[data-again]');
  if (ag) {
    const tk = findTicket(ag.dataset.again); if (!tk) return;
    bookOpen = true; renderCustomer();
    fillCar({ plate: tk.plate, phone: tk.phone, services: lineItems(tk).map(([n]) => n) });
    renderCars(); $('#bookCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('#f-bay').focus(), 350); toast('Enter today’s parking bay', false, false, 'ok'); return;
  }
  const cc = e.target.closest('[data-car]');
  if (cc) {
    if (cc.dataset.car === 'forget') { store.set('pwt-cars', []); $('#bookForm').reset(); renderCars(); return; }
    fillCar(cars()[Number(cc.dataset.car)], true); renderCars(); return;
  }
  if (e.target.closest('#catAdd')) { catDraft.push({ name: '', kind: 'addon', desc: '', price: 0, checklist: [], active: true }); renderCatalogEditor(); return; }
  const cd = e.target.closest('[data-catdel]');
  if (cd) { catDraft.splice(Number(cd.dataset.catdel), 1); catDirty = true; renderCatalogEditor(); return; }
  const cm = e.target.closest('[data-catmove]');
  if (cm) { const i = Number(cm.dataset.catmove); if (i > 0) { [catDraft[i - 1], catDraft[i]] = [catDraft[i], catDraft[i - 1]]; catDirty = true; renderCatalogEditor(); } return; }
  if (e.target.closest('#catSave')) { saveCatalog(); return; }
  if (e.target.closest('#catUndo')) { catDirty = false; loadDraft(); renderCatalogEditor(); return; }
  const det = e.target.closest('[data-detail]');
  if (det) { detailId = det.dataset.detail || null; renderSecurity(); if (detailId) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const rb = e.target.closest('[data-role]');
  if (rb) {
    rb.disabled = true;
    const who = staff.find(x => x.uid === rb.dataset.uid);
    try { await updateDoc(doc(fs, 'roles', rb.dataset.uid), { role: rb.dataset.role, site: who?.site || DEFAULT_SITE, changedAt: now() }); } catch {}
    rb.disabled = false; return;
  }
  const star = e.target.closest('[data-rate]');
  if (star) {
    const card = star.closest('[data-id]'); card.dataset.rating = star.dataset.rate;
    card.querySelectorAll('[data-rate]').forEach(s => s.setAttribute('aria-pressed', String(Number(s.dataset.rate) <= Number(star.dataset.rate))));
    return;
  }
  const rp = e.target.closest('[data-report]');
  if (rp) { reportAction(rp.dataset.report, rp); return; }
  if (e.target.closest('#rBuild')) { buildReport(); return; }
  if (e.target.closest('#qrPrint')) { renderQR(); printPart('qrSheet'); return; }
  const sb = e.target.closest('[data-shift]');
  if (sb) { sb.disabled = true; await shiftAction(sb.dataset.shift); sb.disabled = false; return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    const tk = findTicket(cp.dataset.copy); if (!tk) return;
    try { await navigator.clipboard.writeText(receiptText(tk)); cp.textContent = 'Copied'; } catch { cp.textContent = 'Copy failed'; }
    setTimeout(() => { cp.textContent = 'Copy receipt'; }, 1500);
    return;
  }
  const cl = e.target.closest('[data-clear]');
  if (cl) {
    if (cl.dataset.clear === 'ask') { clearStep = 1; renderClear(); }
    else if (cl.dataset.clear === 'no') { clearStep = 0; renderClear(); }
    else clearTickets();
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
    : a === 'noshow' ? card.querySelector('.nsreason')?.value
    : a === 'damage' ? card.querySelector('.dmgnote').value
    : a === 'rate' ? { rating: card.dataset.rating, comment: card.querySelector('.rcomment')?.value }
    : a === 'issue' ? { type: card.querySelector('.itype')?.value, text: card.querySelector('.itext')?.value }
    : a === 'resolve' ? card.querySelector('.resnote')?.value
    : a === 'suggest' ? { names: [...card.querySelectorAll('[data-sug]:checked')].map(i => i.value), note: card.querySelector('.sugnote')?.value } : undefined;
  const msg = await act(id, b.dataset.act, extra);
  b.disabled = false;
  if (msg && errEl) { errEl.textContent = msg; errEl.hidden = false; errEl.scrollIntoView({ block: 'nearest' }); }
  else if (!msg) {
    if (a === 'damage' || a === 'nodamage') dmgOpen.delete(id);
    const said = { suggest: 'Suggestion sent to the customer', accept: 'Added to your wash', decline: 'No problem', issue: 'Sent. We’ll contact you on WhatsApp', resolve: 'Complaint resolved', verify: 'Car verified', nodamage: 'No damage recorded', damage: 'Damage recorded', start: 'Wash started', done: 'Wash complete. Customer notified', paid: 'Cash payment recorded', noshow: 'Closed as not done', takeover: 'Job is yours now', pay: 'Payment done. Thank you!', rate: 'Thanks for your rating' }[a];
    if (said) toast(said, false, false, 'ok');
  }
});
document.addEventListener('change', async e => {
  const ss = e.target.closest('[data-site-uid]');
  if (ss) { try { await updateDoc(doc(fs, 'roles', ss.dataset.siteUid), { site: ss.value, changedAt: now() }); } catch {} return; }
  if (e.target.id === 'dashSite') { dashSite = e.target.value; renderDash(); return; }
  if (e.target.id === 'f-back') { renderEta(); return; }
  if (e.target.closest('#catEditor')) { onCatInput(e); return; }
  const ck = e.target.closest('[data-check]');
  if (ck) {
    const card = ck.closest('[data-id]');
    const msg = await act(card.dataset.id, 'check', { item: ck.dataset.check, on: ck.checked });
    if (msg) { ck.checked = !ck.checked; toast(msg, true); }
  }
});

// One camera input that lives outside the job cards. The cards redraw whenever anything changes,
// and on some phones that used to throw away the photo while the camera app was open.
const cam = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
cam.setAttribute('capture', 'environment');
document.body.append(cam);
let camFor = null;
const note = Object.assign(document.createElement('div'), { className: 'toast', hidden: true });
document.body.append(note);
let noteTimer;
function toast(text, bad, keep, cls) {
  note.textContent = text; note.className = 'toast' + (bad ? ' bad' : cls ? ' ' + cls : ''); note.hidden = false;
  clearTimeout(noteTimer); if (!keep) noteTimer = setTimeout(() => { note.hidden = true; }, bad ? 6000 : 2500);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-photo]'); if (!b) return;
  const card = b.closest('[data-id]'); if (!card) return;
  camFor = { id: card.dataset.id, kind: b.dataset.photo };
  cam.value = ''; cam.click();
});
cam.addEventListener('change', async () => {
  const f = cam.files[0]; const job = camFor; camFor = null;
  if (!f || !job) return;
  toast('Saving photo…', false, true);
  const msg = await addPhoto(job.id, job.kind, f);
  toast(msg || 'Photo saved', !!msg, false, 'ok');
});

// ---- download today's log
$('#dlBtn').addEventListener('click', () => {
  const rows = [['Ticket', 'Site', 'Car', 'Bay', 'Service', 'Status', 'Attendant', 'Before photo', 'After photo', 'Booked', 'Verified', 'Started', 'Completed', 'Paid', 'Paid via', 'Existing damage', 'Damage note', 'Rating', 'Comment', 'Total (₹)', 'Discount (₹)', 'Not done reason', 'Walk-up', 'Consent', 'Back by', 'Checklist done', 'Complaint', 'Complaint status']];
  tickets.filter(x => today(x.bookedAt)).forEach(tk => rows.push([code(tk), siteName(tk.site), tk.plate, bayText(tk), tk.service, LABEL[tk.status] || tk.status, tk.attendant || '',
    tk.photos?.before ? 'Yes' : 'No', tk.photos?.after ? 'Yes' : 'No',
    tk.bookedAt || '', tk.verifiedAt || '', tk.startedAt || '', tk.completedAt || '', tk.paidAt || '', tk.paidVia || '', tk.damage ? (tk.damage.found ? 'Yes' : 'No') : '', tk.damage?.note || '', tk.rating || '', tk.ratingComment || '', price(tk), discount(tk), tk.noshowReason || '', tk.walkUp ? 'Yes' : 'No', tk.consent ? 'Yes' : 'No',
    tk.backBy || '', checklistFor(tk).length ? (checklistDone(tk) ? 'Yes' : 'No') : '', tk.issue ? `${tk.issue.type}: ${tk.issue.text}` : '', tk.issue?.status || '']));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `wash-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---- clear test tickets (owner only, with an in-page confirmation)
let clearStep = 0;
function renderClear(msg) {
  const n = tickets.length;
  $('#clearBox').innerHTML = clearStep === 0
    ? `<button class="btn warn sm" data-clear="ask" ${n ? '' : 'disabled'}>Clear test tickets</button>${msg ? `<span class="hint">${msg}</span>` : ''}`
    : `<span class="clearq">Delete all ${n} ticket${n === 1 ? '' : 's'} from the last 31 days, with their photos? This can’t be undone.</span>
       <button class="btn warn sm" data-clear="yes">Yes, delete ${n}</button><button class="btn alt sm" data-clear="no">Cancel</button>`;
}
async function clearTickets() {
  const ids = tickets.map(x => x.id);
  $('#clearBox').innerHTML = `<span class="hint">Deleting ${ids.length} tickets…</span>`;
  let failed = 0;
  for (const id of ids) {
    try { await deleteDoc(doc(fs, 'tickets', id)); } catch { failed++; continue; }
    try { await deleteDoc(doc(fs, 'ticketPhotos', id)); } catch {}
  }
  clearStep = 0;
  renderClear(failed ? `${failed} ticket${failed === 1 ? '' : 's'} couldn’t be deleted. Try again.` : 'Test tickets cleared.');
}

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

// ---- home-screen install
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch {}
  installEvt = null; $('#installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });

// ---- start
// Services come from config/main (owner edits on the dashboard), falling back to settings.js.
renderBookServices();
fillCar(cars()[0], true); renderCars();
$('#f-services').addEventListener('change', updateTotal);
$('#bookForm').addEventListener('reset', () => setTimeout(() => { renderBookServices(); renderCars(); }, 0));
$('#f-plate').addEventListener('input', renderCars);
document.addEventListener('input', e => { if (e.target.closest('#catEditor')) onCatInput(e); });
onSnapshot(doc(fs, 'config', 'main'), snap => {
  cfgDoc = snap.exists() ? snap.data() : null;
  applyCatalog(cfgDoc);
  renderBookServices();
  const ws = $('#w-services'); if (ws) delete ws.dataset.done;
  if (!catDirty) { catDraft = []; }
  renderCustomer(); renderStaffViews();
}, () => {});
(function initDashControls() {
  const ds = $('#dashSite');
  if (ds) { ds.innerHTML = `<option value="all">All sites</option>${SITES.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}`; ds.closest('label').hidden = SITES.length < 2; }
  const rs = $('#rSite'); if (rs) rs.innerHTML = SITES.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  const rm = $('#rMonth');
  if (rm) {
    const opts = [];
    for (let i = 0; i < 2; i++) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); opts.push(`<option value="${d.getFullYear()}-${pad(d.getMonth() + 1)}">${d.toLocaleDateString([], { month: 'long', year: 'numeric' })}${i === 0 ? ' (so far)' : ''}</option>`); }
    rm.innerHTML = opts.join('');
  }
  const zi = $('#zoneInfo');
  if (zi) { zi.hidden = !urlZone; zi.textContent = `You’re parked at ${urlZone}`; }
})();
const boardSite = SITES.some(x => x.id === params.get('board')) ? params.get('board') : '';
if (boardSite) startBoard(boardSite);
function startBoard(site) {
  document.body.classList.add('boardmode');
  document.title = `Live board · ${siteName(site)}`;
  $('#v-board').hidden = false;
  let data = null;
  const draw = () => {
    const el = $('#v-board'); const nowD = new Date();
    const fresh = data?.updatedAt && Date.now() - new Date(data.updatedAt) < 15 * 60000;
    const jobs = data?.jobs || [];
    const col = (title, sts, cls) => { const xs = jobs.filter(j => sts.includes(j.s));
      return `<section class="bcol ${cls}"><h2>${title}<span>${xs.length}</span></h2>${xs.length ? xs.map(j => `<div class="brow${j.late ? ' late' : ''}"><span class="plate">${esc(j.p)}</span><span class="bwhere">${esc([j.z, j.b].filter(Boolean).join(' · '))}</span><span class="bage">${ago(j.t)}</span></div>`).join('') : '<p class="bempty">None</p>'}</section>`; };
    const td = data?.today || {};
    el.innerHTML = `<header class="bhead"><div><b>${esc(brand)}</b><span>${esc(siteName(site))} · live job board</span></div>
      <div class="bclock"><b>${nowD.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b><span class="${fresh ? 'on' : ''}">${fresh ? 'Live' : data?.updatedAt ? 'Last update ' + t(data.updatedAt) : 'Waiting for staff to sign in'}</span></div></header>
      <div class="bcols">${col('Waiting', ['booked'], 'w')}${col('Being washed', ['verified', 'washing'], 'p')}${col('Ready for pickup', ['ready'], 'r')}</div>
      <footer class="bstats">${[['Washes today', td.done ?? 0], ['Bookings today', td.booked ?? 0], ['Average wash', td.avgMin == null ? '–' : td.avgMin + ' min'],
        ['Consent recorded', `${td.consent ?? 0} of ${td.booked ?? 0}`], ['Before + after photos', `${td.photos ?? 0} of ${td.done ?? 0}`], ['Damage noted before wash', td.damage ?? 0], ['Open complaints', td.issues ?? 0]]
        .map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</footer>`;
  };
  watchPublic(site, d => { data = d; draw(); });
  setInterval(draw, 30000); draw();
}
setMode(false);
soundOn = store.get('pwt-sound', true);
$('#brandName').textContent = brand;
if (!store.get('pwt-howto-seen', false)) { $('#howto').open = true; store.set('pwt-howto-seen', true); }
// Keep "waiting 5 min" labels fresh without redrawing while someone types.
setInterval(() => { if (current === 'attendant' && !$('#queue').contains(document.activeElement)) renderQueue(); }, 60000);
const hashTab = location.hash.replace('#', '');
show(TABS.includes(hashTab) ? hashTab : store.get('pwt-tab', 'customer'));
watchMine();
renderCustomer(); renderStaffViews();
if (!boardSite) watchPublic(urlSite, d => { pub = d; renderEta(); });
$('#liveDot').classList.add('on');
$('#liveText').textContent = 'Live updates on';
window.addEventListener('offline', () => { $('#liveDot').classList.remove('on'); $('#liveText').textContent = 'Offline'; });
window.addEventListener('online', () => { $('#liveDot').classList.add('on'); $('#liveText').textContent = 'Live updates on'; });
