'use strict';
const fs = require('fs');
const path = require('path');

let _getWorkspace;
function init(deps) { _getWorkspace = deps.getWorkspace; }

function _inventoryPath() {
  const ws = _getWorkspace();
  return ws ? path.join(ws, 'inventory.json') : null;
}

function _readInventory() {
  const p = _inventoryPath();
  if (!p || !fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function _writeInventory(items) {
  const p = _inventoryPath();
  if (!p) throw new Error('workspace not available');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(items, null, 2) + '\n', 'utf-8');
}

function _generateSku(items) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const todayItems = items.filter(i => i.sku && i.sku.startsWith('SP-' + today));
  const seq = String(todayItems.length + 1).padStart(3, '0');
  return 'SP-' + today + '-' + seq;
}

function adjustStock({ sku, name, qty, type, note }) {
  if (!type || (type !== 'in' && type !== 'out')) throw new Error('type must be "in" or "out"');
  const adjustQty = Number(qty);
  if (!adjustQty || adjustQty <= 0) throw new Error('qty must be a positive number');

  const items = _readInventory();

  let item = sku ? items.find(i => i.sku === sku) : null;

  if (!item && type === 'out') {
    throw new Error('SKU not found: ' + (sku || '(none)') + '. Cannot adjust out for non-existent item.');
  }

  if (!item) {
    // Create new item (type must be "in" at this point)
    const newSku = sku || _generateSku(items);
    item = {
      sku: newSku,
      name: name || '',
      currentQty: 0,
      minQty: 0,
      unit: '',
      lastAdjusted: new Date().toISOString(),
      adjustments: [],
    };
    items.push(item);
  }

  if (type === 'out' && item.currentQty < adjustQty) {
    throw new Error('Insufficient stock for ' + item.sku + ': current=' + item.currentQty + ', requested=' + adjustQty);
  }

  if (name) item.name = name;
  item.currentQty += (type === 'in' ? adjustQty : -adjustQty);
  item.lastAdjusted = new Date().toISOString();
  item.adjustments.push({
    type,
    qty: adjustQty,
    note: note || '',
    date: new Date().toISOString(),
  });

  _writeInventory(items);
  return item;
}

function checkStock({ sku } = {}) {
  const items = _readInventory();
  if (sku) {
    const item = items.find(i => i.sku === sku);
    if (!item) return { found: false };
    return { found: true, ...item };
  }
  const sorted = items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { items: sorted, count: sorted.length };
}

function getAlerts() {
  const items = _readInventory();
  const alerts = items.filter(i => i.minQty > 0 && i.currentQty < i.minQty);
  return { alerts, count: alerts.length };
}

function setMinQty({ sku, minQty }) {
  if (!sku) throw new Error('sku required');
  const min = Number(minQty);
  if (isNaN(min) || min < 0) throw new Error('minQty must be a non-negative number');

  const items = _readInventory();
  const item = items.find(i => i.sku === sku);
  if (!item) throw new Error('SKU not found: ' + sku);

  item.minQty = min;
  _writeInventory(items);
  return item;
}

module.exports = { init, adjustStock, checkStock, getAlerts, setMinQty };
