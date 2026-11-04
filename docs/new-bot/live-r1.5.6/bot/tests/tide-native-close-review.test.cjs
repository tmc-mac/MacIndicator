#!/usr/bin/env node
'use strict';
// Offline adversarial hypothesis ONLY: a native full/partial position close
// executes but leaves pre-existing, independently linked OCO exit pairs unchanged.
// This is a deliberately conservative fake model, not a statement about actual
// Gateway semantics or evidence that these exact bracket groups are supported.
// A fill cancels its own OCO sibling, but does not cancel other exit pairs.
// Run: node tests/tide-native-close-review.test.cjs
// Exit is intentionally nonzero when the modeled orphan-order risks are observed.
const assert = require('assert');

function fakeBroker() {
  let position = -3; // signed inventory: negative is short, positive is long
  const orders = [
    { group: 'A', role: 'stop', side: 1, quantity: 2, working: true },
    { group: 'A', role: 'target', side: 1, quantity: 2, working: true },
    { group: 'B', role: 'stop', side: 1, quantity: 1, working: true },
    { group: 'B', role: 'target', side: 1, quantity: 1, working: true },
  ];
  return {
    get position() { return position; },
    get orders() { return orders; },
    // Hypothesis: this succeeds without modifying any existing OCO children.
    nativeClose(quantity) {
      assert(Number.isInteger(quantity) && quantity > 0 && quantity <= Math.abs(position));
      position -= Math.sign(position) * quantity;
    },
    // A later, independent long position starts after the previous trade is flat.
    setLaterLong(quantity) { assert.strictEqual(position, 0); position = quantity; },
    trigger(group) {
      const stop = orders.find(o => o.group === group && o.role === 'stop' && o.working);
      assert(stop, 'missing working stop in fake OCO pair');
      position += stop.side * stop.quantity;
      stop.working = false;
      for (const order of orders) if (order.group === group && order !== stop) order.working = false;
    },
  };
}

let risks = 0;
function scenario(name, arrange, expected) {
  const broker = fakeBroker(); arrange(broker);
  broker.trigger('A'); broker.trigger('B');
  assert.strictEqual(broker.position, expected, name + ': unexpected fake-model result');
  assert(broker.orders.every(order => !order.working), 'fake OCO siblings did not cancel');
  risks++;
  console.log(`RISK ${name}: signed inventory ${broker.position > 0 ? '+' : ''}${broker.position}`);
}

scenario('partial close leaves oversized children', b => { b.nativeClose(2); assert.strictEqual(b.position, -1); }, 2);
scenario('full close leaves children while flat', b => { b.nativeClose(3); assert.strictEqual(b.position, 0); }, 3);
scenario('old children add to a later opposite position', b => { b.nativeClose(3); b.setLaterLong(1); }, 4);
console.log(`Fake-model hypothesis: ${risks} orphan-order risks reproduced; real provider behavior remains unverified.`);
process.exitCode = risks ? 1 : 0;
