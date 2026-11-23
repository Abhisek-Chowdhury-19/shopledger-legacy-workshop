const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../lib/pricing');
const invoice = require('../lib/invoice');
const reports = require('../lib/reports');

// Mirrors the order line shape saved at checkout, with HSN and no gstRate.
const items = [
  { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 800, qty: 2 },
  { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 400, qty: 1 }
];

const billedOrder = {
  id: 1,
  date: '08/05/2026',
  status: 'completed',
  items,
  coupon: 'SAVE10',
  subtotal: 2000,
  discount: 150,
  tax: 118.40,
  total: 1968.40
};

test('checkout caps SAVE10 and applies each HSN rate after allocating the discount', function () {
  const { lines, ...totals } = pricing.computeTotals(items, billedOrder.coupon);

  assert.deepEqual(totals, {
    subtotal: 2000,
    discount: 150,
    taxable: 1850,
    tax: 118.40,
    cgst: 59.20,
    sgst: 59.20,
    total: 1968.40
  });
  assert.deepEqual(lines, [
    { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 1600,
      discount: 120, taxable: 1480, tax: 74, net: 1554 },
    { id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12, gross: 400,
      discount: 30, taxable: 370, tax: 44.40, net: 414.40 }
  ]);
});

test('invoice agrees with the billed order and shows the checkout GST for each line', function () {
  const figures = invoice.computeInvoiceFigures(billedOrder);

  assert.deepEqual(
    { subtotal: figures.subtotal, discount: figures.discount, tax: figures.tax, total: figures.total },
    { subtotal: 2000, discount: 150, tax: 118.40, total: 1968.40 }
  );
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => ({ gstPercent, lineTax })), [
    { gstPercent: 5, lineTax: 74 },
    { gstPercent: 12, lineTax: 44.40 }
  ]);
});

test('invoice uses checkout GST rules for fractional and zero rates', function () {
  const lines = [
    { name: 'Fractional rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ];

  assert.deepEqual(pricing.computeTotals(lines, '').lines.map(line => line.tax), [5, 0]);
  assert.deepEqual(invoice.computeInvoiceFigures({ items: lines }).rows.map(line => line.lineTax), [5, 0]);
});

test('invoice sums rounded line GST and uses the checkout CGST and SGST split', function () {
  const lines = [
    { name: 'First line', price: 0.50, qty: 1, gstRate: 5 },
    { name: 'Second line', price: 0.50, qty: 1, gstRate: 5 }
  ];
  const figures = invoice.computeInvoiceFigures({ items: lines });

  assert.deepEqual(figures.rows.map(line => line.lineTax), [0.03, 0.03]);
  assert.equal(figures.tax, 0.06);
  assert.equal(figures.cgst, 0.03);
  assert.equal(figures.sgst, 0.03);
  assert.equal(pricing.computeTotals(lines, '').tax, 0.06);
});

test('printable invoice displays checkout figures and warns only when its total differs from the stored total', function () {
  const html = invoice.render(billedOrder);

  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹118\.40<\/td>/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹1968\.40<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  const historicalHtml = invoice.render({ ...billedOrder, total: 1900 });
  assert.match(historicalHtml, /Order Ledger recorded total \(₹1900\.00\) by \+₹68\.40/);
});

test('reconciliation excludes cancelled orders and flags a tax difference even when totals agree', function () {
  const sameTotal = { ...billedOrder, id: 2, tax: 120 };
  const cancelledOrder = { ...billedOrder, id: 3, status: 'cancelled' };
  const result = reports.getGstReconciliation({ orders: [billedOrder, sameTotal, cancelledOrder] });

  assert.equal(result.totalChecked, 2);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 0);
  assert.deepEqual(result.rows.map(({ orderId, ledgerTax, invoiceTax, delta, matched }) => ({
    orderId, ledgerTax, invoiceTax, delta, matched
  })), [
    { orderId: 1, ledgerTax: 118.40, invoiceTax: 118.40, delta: 0, matched: true },
    { orderId: 2, ledgerTax: 120, invoiceTax: 118.40, delta: 0, matched: false }
  ]);
});
