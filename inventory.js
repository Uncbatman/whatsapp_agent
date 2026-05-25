module.exports = {
  products: {
    bread: { price: 65, unit: "loaf" },
    milk: { price: 70, unit: "packet" },
    sugar: { price: 150, unit: "kg" },
    eggs: { price: 15, unit: "egg" },
    rice: { price: 180, unit: "kg" },
    "cooking oil": { price: 250, unit: "litre" },
    beans: { price: 120, unit: "kg" },
  },
  delivery_rates: {
    within_1km: 20,
    outside_2km: 50, // Backup default if further away
  },
};
