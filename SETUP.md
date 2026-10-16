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

## Before real customers use it

This version is for demos and the trial. Before launch:

- **Phone numbers:** with version 2, only staff can list tickets; a customer can only open a ticket whose private link their own phone holds.
- **Real WhatsApp alerts:** alerts are shown in the app but not sent. Real alerts need the WhatsApp Business API through a provider.
- **Payments:** connect a UPI payment link or gateway instead of the "payment received" button.

## Free limits

Firebase's free plan includes 50,000 reads and 20,000 writes a day, which is far more than a pilot needs. Photos are shrunk and stored inside each ticket, so paid file storage isn't needed.
