// Business settings for the Parking Wash Tracker.
// Edit these and the app updates; nothing else needs changing.
export const business = {
  // Your UPI ID, for example "yourname@okhdfcbank". Leave empty to hide the "Pay by UPI" button.
  upiId: "",
  // Name shown in the customer's UPI app.
  payeeName: "Parking Wash",
  // Price per service in rupees (sample prices for the demo; change before launch). 0 means the customer types the amount in their UPI app.
  prices: {
    "Exterior eco wash": 249,
    "Interior cleaning": 299,
    "Full wash, inside and out": 499,
    "Steam interior cleaning": 699,
    "Tyre pressure check": 50,
    "Battery check": 100,
  },
};
