/**
 * INVENTORY.JS
 * Central product list for the FMCG WhatsApp Chatbot
 * Import this file and use getProductNames() to get all searchable products
 */

const products = [
  // Flours & Grains
  { name: "unga ugali", category: "flours" },
  { name: "ugali", category: "flours" },
  { name: "unga", category: "flours" },
  { name: "maize flour", category: "flours" },
  { name: "wheat flour", category: "flours" },
  { name: "flour", category: "flours" },
  
  // Rice & Beans
  { name: "rice", category: "grains" },
  { name: "beans", category: "grains" },
  { name: "lentils", category: "grains" },
  
  // Cooking Essentials
  { name: "oil", category: "cooking" },
  { name: "cooking oil", category: "cooking" },
  { name: "mafuta ya kupika", category: "cooking" },
  { name: "mafuta", category: "cooking" },
  { name: "sugar", category: "cooking" },
  { name: "salt", category: "cooking" },
  { name: "salad", category: "cooking" },
  
  // Dairy & Eggs
  { name: "milk", category: "dairy" },
  { name: "butter", category: "dairy" },
  { name: "cheese", category: "dairy" },
  { name: "yoghurt", category: "dairy" },
  { name: "eggs", category: "dairy" },
  
  // Beverages
  { name: "tea", category: "beverages" },
  { name: "coffee", category: "beverages" },
  { name: "water", category: "beverages" },
  { name: "soda", category: "beverages" },
  { name: "cola", category: "beverages" },
  
  // Household & Cleaning
  { name: "soap", category: "household" },
  { name: "detergent", category: "household" },
  { name: "shampoo", category: "household" },
  { name: "toothpaste", category: "household" },
  { name: "toilet paper", category: "household" },
  { name: "tissue", category: "household" },
  
  // Bread & Bakery
  { name: "bread", category: "bakery" },
  { name: "mandazi", category: "bakery" },
  { name: "chapati", category: "bakery" },
];

/**
 * Get all product names as a flat array
 * Used for extracting product names from customer messages
 */
function getProductNames() {
  return products.map((p) => p.name.toLowerCase());
}

/**
 * Get all products with details
 * Used for admin/inventory endpoints
 */
function getAllProducts() {
  return products;
}

/**
 * Get products by category
 */
function getProductsByCategory(category) {
  return products.filter((p) => p.category === category);
}

/**
 * Get product info by name
 */
function getProductInfo(name) {
  return products.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

module.exports = {
  products,
  getProductNames,
  getAllProducts,
  getProductsByCategory,
  getProductInfo,
};
