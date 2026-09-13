import { run as runAckTests } from './ack.test.mjs';
import { run as runSenderTests } from './keydrop-ack-sender.test.mjs';
import { run as runStripeProbeTests } from './stripe-probe.test.mjs';

const suites = [
  ['ack.test.mjs', runAckTests],
  ['keydrop-ack-sender.test.mjs', runSenderTests],
  ['stripe-probe.test.mjs', runStripeProbeTests],
];

let failures = 0;
for (const [name, run] of suites) {
  try {
    await run();
    console.log(`ok ${name}`);
  } catch (err) {
    failures += 1;
    const msg = err && err.stack ? err.stack : String(err);
    console.error(`not ok ${name}\n${msg}`);
  }
}

if (failures > 0) {
  console.error(`FAILED: ${failures} suite(s) failed`);
  process.exit(1);
}

console.log('all tests passed');
