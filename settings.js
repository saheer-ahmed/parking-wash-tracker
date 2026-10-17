// Business settings for the Parking Wash Tracker.
// Edit these and the app updates; nothing else needs changing.
export const business = {
  // Brand name shown on receipts and the monthly report. Change once you've chosen one.
  name: "Parking Wash",
  // Your UPI ID, for example "yourname@okhdfcbank". Leave empty to hide the "Pay by UPI" button.
  upiId: "",
  // Name shown in the customer's UPI app.
  payeeName: "Parking Wash",
  // Starting list of services. After the owner saves "Services and prices" on the dashboard,
  // the dashboard version is used instead and this list is ignored.
  // kind: "wash" (big tiles) or "addon". checklist: what the attendant ticks before "Wash complete".
  services: [
    { name: "Exterior eco wash", kind: "wash", desc: "Outside only · no keys needed", price: 249,
      checklist: ["Body panels", "Windows and mirrors", "Wheels and tyres", "Door edges and handles"] },
    { name: "Interior cleaning", kind: "wash", desc: "Vacuum and wipe-down inside", price: 299,
      checklist: ["Seats vacuumed", "Floor mats", "Dashboard and console", "Inside of windows"] },
    { name: "Full wash, inside and out", kind: "wash", desc: "Exterior + interior", price: 499,
      checklist: ["Body panels", "Windows and mirrors", "Wheels and tyres", "Door edges and handles", "Seats vacuumed", "Floor mats", "Dashboard and console", "Inside of windows"] },
    { name: "Steam interior cleaning", kind: "wash", desc: "Deep clean of seats and mats", price: 699,
      checklist: ["Seats steamed", "Floor mats steamed", "Dashboard and vents", "Door panels"] },
    { name: "Tyre pressure check", kind: "addon", price: 50, checklist: ["Tyre pressure checked and set"] },
    { name: "Battery check", kind: "addon", price: 100, checklist: ["Battery terminals and charge checked"] },
  ],
  offer: { active: false, label: "", pct: 0 },
  // Locations. Each has a short id (letters only, used in QR links), a name, the venue's
  // revenue share in percent, and its parking zones (one QR code per zone).
  defaultSite: "forum",
  sites: [
    { id: "forum", name: "Forum Mall, Mangalore", sharePct: 15, zones: ["Level B1", "Level B2", "Ground"] },
  ],
  // Loyalty: every Nth paid wash for the same car gets this discount.
  loyalty: { every: 5, discountPct: 50 },
};
