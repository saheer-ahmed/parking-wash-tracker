// Business settings for the Parking Wash Tracker.
// Edit these and the app updates; nothing else needs changing.
export const business = {
  // Your UPI ID, for example "yourname@okhdfcbank". Leave empty to hide the "Pay by UPI" button.
  upiId: "",
  // Name shown in the customer's UPI app.
  payeeName: "Parking Wash",
  // Price per service in rupees. 0 means the customer types the amount in their UPI app.
  prices: {
    "Exterior eco wash": 0,
    "Interior cleaning": 0,
    "Full wash, inside and out": 0,
    "Steam interior cleaning": 0,
    "Tyre pressure check": 0,
    "Battery check": 0,
  },
};
