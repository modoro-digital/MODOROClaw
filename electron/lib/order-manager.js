'use strict';
const fs = require('fs');
const path = require('path');

let _getWorkspace;
function init(deps) { _getWorkspace = deps.getWorkspace; }

function _ordersPath() {
  const ws = _getWorkspace();
  return ws ? path.join(ws, 'orders.json') : null;
}

function _readOrders() {
  const p = _ordersPath();
  if (!p || !fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function _writeOrders(orders) {
  const p = _ordersPath();
  if (!p) throw new Error('workspace not available');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(orders, null, 2) + '\n', 'utf-8');
}

function _nextId(orders) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).replace(/-/g, '');
  const todayOrders = orders.filter(o => o.id && o.id.startsWith('ORD-' + today));
  const seq = String(todayOrders.length + 1).padStart(3, '0');
  return 'ORD-' + today + '-' + seq;
}

function createOrder({ customer, items, note, total }) {
  if (!customer || !items || !items.length) throw new Error('customer and items required');
  const orders = _readOrders();
  const order = {
    id: _nextId(orders),
    customer,
    items: items.map(i => ({
      name: i.name || '',
      qty: Number(i.qty) || 1,
      price: Number(i.price) || 0,
    })),
    total: total != null ? Number(total) : items.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.price) || 0), 0),
    status: 'new',
    note: note || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  orders.push(order);
  _writeOrders(orders);
  return order;
}

function listOrders({ status, from, to, limit } = {}) {
  let orders = _readOrders();
  if (status) orders = orders.filter(o => o.status === status);
  if (from) orders = orders.filter(o => o.createdAt >= from);
  if (to) orders = orders.filter(o => o.createdAt <= to + 'T23:59:59Z');
  orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (limit) orders = orders.slice(0, Number(limit));
  return orders;
}

function updateOrder({ orderId, status, note, payment }) {
  if (!orderId) throw new Error('orderId required');
  const orders = _readOrders();
  const order = orders.find(o => o.id === orderId);
  if (!order) throw new Error('order not found: ' + orderId);
  if (status) order.status = status;
  if (note !== undefined) order.note = note;
  if (payment !== undefined) order.payment = payment;
  order.updatedAt = new Date().toISOString();
  _writeOrders(orders);
  return order;
}

function getOrderStatus({ orderId }) {
  if (!orderId) throw new Error('orderId required');
  const orders = _readOrders();
  const order = orders.find(o => o.id === orderId);
  if (!order) return { found: false };
  return { found: true, ...order };
}

function orderSummary({ from, to }) {
  const orders = listOrders({ from, to });
  const byStatus = {};
  let totalRevenue = 0;
  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (o.status === 'paid' || o.status === 'delivered' || o.status === 'completed') {
      totalRevenue += o.total || 0;
    }
  }
  return { total: orders.length, byStatus, totalRevenue, from, to };
}

module.exports = { init, createOrder, listOrders, updateOrder, getOrderStatus, orderSummary };
