// Business settings for the Parking Wash Tracker.
// Edit these and the app updates; nothing else needs changing.
export const business = {
  // Brand name shown on receipts and the monthly report. Change once you've chosen one.
  name: "Parking Wash",
  // Your UPI ID, for example "yourname@okhdfcbank". Leave empty to hide the "Pay by UPI" button.
  upiId: "",
  // Name shown in the customer's UPI app.
  payeeName: "Parking Wash",
  // Price per service in rupees (sample prices for the demo; change before launch).
  prices: {
    "Exterior eco wash": 249,
    "Interior cleaning": 299,
    "Full wash, inside and out": 499,
    "Steam interior cleaning": 699,
    "Tyre pressure check": 50,
    "Battery check": 100,
  },
  // Locations. Each has a short id (letters only, used in QR links), a name, the venue's
  // revenue share in percent, and its parking zones (one QR code per zone).
  defaultSite: "forum",
  sites: [
    { id: "forum", name: "Forum Mall, Mangalore", sharePct: 15, zones: ["Level B1", "Level B2", "Ground"] },
  ],
  // What the attendant ticks off for each service before "Wash complete" unlocks.
  // The customer sees the ticked list on their ticket.
  checklists: {
    "Exterior eco wash": ["Body panels", "Windows and mirrors", "Wheels and tyres", "Door edges and handles"],
    "Interior cleaning": ["Seats vacuumed", "Floor mats", "Dashboard and console", "Inside of windows"],
    "Full wash, inside and out": ["Body panels", "Windows and mirrors", "Wheels and tyres", "Door edges and handles", "Seats vacuumed", "Floor mats", "Dashboard and console", "Inside of windows"],
    "Steam interior cleaning": ["Seats steamed", "Floor mats steamed", "Dashboard and vents", "Door panels"],
    "Tyre pressure check": ["Tyre pressure checked and set"],
    "Battery check": ["Battery terminals and charge checked"],
  },
  // Loyalty: every Nth paid wash for the same car gets this discount.
  loyalty: { every: 5, discountPct: 50 },
};
