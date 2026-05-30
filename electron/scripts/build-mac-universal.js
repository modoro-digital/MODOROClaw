#!/usr/bin/env node
if (process.env.ALLOW_UNSAFE_UNIVERSAL === '1') {
  process.exit(0);
}

console.error('[build:mac:universal] Blocked by default. Universal build can bundle the wrong vendor arch and has not been validated as a safe release path.');
console.error('[build:mac:universal] Use npm run build:mac, build:mac:arm, or build:mac:intel instead.');
console.error('[build:mac:universal] If you intentionally want to bypass this guard, rerun with ALLOW_UNSAFE_UNIVERSAL=1.');
process.exit(1);
