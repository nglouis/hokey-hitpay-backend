// A deliberately tiny, dependency-free "database": one JSON file on disk.
// This is fine to get a small storefront's HitPay + WhatsApp flow working
// and testable end-to-end, but a real store should not rely on a single
// file for its order records. Swap readAll/writeAll for calls to Postgres,
// SQLite, a managed DB, etc. — every other function in this file only
// depends on those two, so that's the one place you'd need to change.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'orders.json');

function readAll() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    console.error('Could not read orders.json, starting fresh:', err);
    return {};
  }
}

function writeAll(orders) {
  fs.writeFileSync(DB_PATH, JSON.stringify(orders, null, 2));
}

function saveOrder(order) {
  const orders = readAll();
  orders[order.reference] = order;
  writeAll(orders);
  return order;
}

function getOrder(reference) {
  const orders = readAll();
  return orders[reference] || null;
}

function updateOrderStatus(reference, status, extra = {}) {
  const orders = readAll();
  if (!orders[reference]) return null;
  orders[reference] = { ...orders[reference], status, ...extra, updatedAt: Date.now() };
  writeAll(orders);
  return orders[reference];
}

module.exports = { saveOrder, getOrder, updateOrderStatus };
