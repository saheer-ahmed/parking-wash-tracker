# Parking Wash Tracker – setup

A live booking and job-tracking demo. Customers book, attendants verify and update the job, and mall security sees every ticket. All screens that open the link update together.

It runs on two free services:
- **Firebase Firestore** stores the tickets and pushes live updates.
- **GitHub Pages** hosts the page and gives you a link to share.

Time needed: about 15 minutes.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page |
| `app.js` | The app logic |
| `firebase-config.js` | Your Firebase settings (you fill this in) |
| `firestore.rules` | Database access rules |
| `firebase.json` | Only needed if you host on Firebase instead of GitHub |

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com and sign in with your Google account.
2. Create a new project, for example `parking-wash-tracker`. Google Analytics is not needed.

## 2. Create the database

1. In the project, open **Firestore Database** and create a database.
2. Choose a location close to Mangalore, for example `asia-south1 (Mumbai)`. This can't be changed later.
3. Start in **production mode**.

## 3. Set the access rules

1. In Firestore, open the **Rules** tab.
2. Replace everything there with the contents of `firestore.rules`.
3. Publish.

## 4. Connect the page to your project

1. Open **Project settings** (the gear icon) and find **Your apps**.
2. Add a **Web** app (the `</>` icon). Any nickname works. Firebase Hosting is not needed if you use GitHub Pages.
3. Firebase shows a `firebaseConfig` block. Copy each value into the matching line of `firebase-config.js`.

## 5. Put it online with GitHub Pages

1. On GitHub, create a new public repository, for example `parking-wash-tracker`.
2. Upload `index.html`, `app.js` and `firebase-config.js` (the other files are optional).
3. In the repository, open **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute or two the link appears there, for example `https://saheer-ahmed.github.io/parking-wash-tracker/`.

## 6. Test it

1. Open the link on two phones.
2. On phone 1, go to **Customer** and book a wash.
3. On phone 2, go to **Mall security**. The booking should appear within a second or two.
4. Switch phone 2 to **Attendant** (sign in as staff), re-type the car number, take the photos and walk the ticket through to "Paid".
5. For a quick demo, use **Add example tickets** on the Mall security tab. They are marked "Example".

If the top right says "Can't reach the database", check that the rules were published (step 3) and the values in `firebase-config.js` are correct (step 4).

You can also open the tabs directly: add `#customer`, `#attendant` or `#security` to the end of the link. A QR code for the customer link can go on the poster.

## Staff logins (version 2)

Customers still book without an account and only ever see their own ticket. Staff sign in, and the owner gives each account a role.

1. In Firebase, open **Authentication**, tap **Get started**, choose **Email/Password**, switch it on and save.
2. In **Firestore → Rules**, replace the rules with the new `firestore.rules` and publish.
3. Upload the new `index.html` and `app.js` to GitHub (replace the old ones). `firebase-config.js` stays the same.
4. Open the site, go to the **Attendant** tab and tap **New staff member? Create an account**. Create your own account first.
5. Make yourself the owner (one time only): in Firebase, open **Firestore → Data → roles**, tap your document, change the `role` field from `pending` to `owner`, and save. Reload the site; a **Staff** tab appears.
6. Each attendant or security guard creates their own account. On the **Staff** tab, tap **Make attendant** or **Make mall security** next to their name.

| Role | Can do |
| --- | --- |
| Customer (no account) | Book, follow their own ticket, cancel before work starts |
| Attendant | See open jobs, verify the plate, take photos, move jobs forward |
| Mall security | See every ticket, photos and the daily log; change nothing |
| Owner | Everything, plus give or remove staff access and add example tickets |

Photos are required: **Start wash** stays locked until a before-photo is taken, and **Wash complete** until an after-photo is taken. The database rules enforce this too.

## Version 4: locations, walk-ups, receipts, loyalty, shifts, reports

After uploading, publish the new `firestore.rules` once (Firestore → Rules → paste → Publish).

**Locations and zones** live in `settings.js` (`sites`). Each site has an id, a name, the venue's revenue share and its parking zones. Existing attendants and security guards are placed at `forum`; change it on the **Staff** tab. Attendants and security only see tickets for their own site. Old test tickets made before version 4 have no site, so clear them from the dashboard.

**Zone QR codes:** Dashboard → **Parking QR codes** → **Print**. Each code opens the booking page with the site and zone already filled in.

**Walk-up booking:** Jobs tab → **+ Walk-up**. Ask the customer's consent, fill the car number and services, and the ticket starts as a normal booking marked "Walk-up".

**Not done:** if a car isn't in the bay or the customer leaves, the attendant closes the ticket as **Not done** with a reason. It shows on the ticket, the log and the report.

**Receipts:** paid tickets show a receipt. Customers can share it on WhatsApp; staff can send it from **Completed today**.

**Loyalty:** every 5th paid wash for the same car gets 50% off, applied automatically when the plate is verified. Change it in `settings.js` (`loyalty`).

**Shifts:** attendants tap **Start shift** / **Break** / **End shift**. The dashboard's **Team today** shows who is on, hours and jobs done.

**Revenue and monthly report:** the dashboard shows revenue per day. **Monthly report** builds a summary for the mall (washes, revenue, venue share, ratings, damage, not done) that can be printed or saved as PDF, downloaded as CSV or copied.

**Install on the phone:** open the site in Chrome and tap **Install app** (or menu → Add to Home screen). It opens straight to the Attendant tab.

## Version 5: new design

No rules change. The app now looks and works like this:

- **Customers** see only the booking page. Staff tap **Staff sign in** at the bottom. After signing in, staff land on their own screen (Jobs for attendants, Security log for security).
- **Booking:** wash types are large tiles, and the total and **Book wash** stay at the bottom of the screen. After booking, the ticket shows a large status ("Waiting for an attendant", "Your car is being washed", "Your car is ready") with a big Pay button.
- **Jobs (attendant):** a short list grouped into My jobs, New bookings and Other attendants. Tap a car to open it. Each job shows only the next step with one big button. **+ Walk-up** sits at the bottom right. New bookings play a sound and vibrate; the bell button next to the shift turns the sound off.
- **Dashboard:** four headline numbers, then sections that open on tap (Team, Revenue, Bookings, Attendants, Comments, Monthly report, QR codes).
- **Security log:** Add example tickets and Clear test tickets are under **Testing tools** (owner only).
- Dark mode follows the phone's setting.

## Version 6: wait time, return time, checklist, live board, complaints

Publish the new `firestore.rules` once (Firestore → Rules → paste → Publish).

- **Wait time:** the booking page shows “Ready in about 40 min · 2 cars ahead”. It is worked out from open jobs, recent wash times and how many attendants are working, and only shows while a staff phone is signed in. The ticket shows the expected ready time.
- **Return time:** customers choose when they’ll be back. Attendants see “back 6:30 PM” on each job, late jobs turn red, and jobs are sorted by who is due back first. The monthly report shows how many were ready in time.
- **Service checklist:** during the wash the attendant ticks each item (set per service in `settings.js` under `checklists`). Wash complete stays locked until every item is ticked and the after-photo is taken. The customer and security see “What we did”.
- **Live board:** Dashboard → Parking QR codes → **Open live board**. A read-only screen for the mall’s security room or parking office: waiting, being washed, ready, and today’s figures. No login; plates are partly hidden. It updates while any staff phone at that site is signed in.
- **Complaints:** customers tap **Report a problem** on a paid ticket (once). The owner gets an alert, and the Dashboard’s **Complaints** section shows it with the photos, a button to message the customer and **Mark resolved** with a note. The customer sees the resolution on their ticket.

## Before real customers use it

- **Real WhatsApp alerts:** alerts are prepared in the app and opened in WhatsApp; sending them automatically needs the WhatsApp Business API through a provider.
- **Payments:** the Pay button is a demo. Before launch, add your UPI ID in `settings.js` or connect a payment gateway.
- **Prices:** the prices in `settings.js` are samples.

## Free limits

Firebase's free plan includes 50,000 reads and 20,000 writes a day, which is far more than a pilot needs. Photos are shrunk and stored inside each ticket, so paid file storage isn't needed.
