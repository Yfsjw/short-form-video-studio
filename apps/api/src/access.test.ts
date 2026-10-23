import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCESS_COOKIE_NAME, FailedAttemptLimiter, createAccessGate, readCookie, safeNextPath } from './access.js';
import { loadConfig } from './config.js';

const CODE = 'blue-river-7421';

test('without a code nothing is required, and nothing counts as the right code', () => {
  const gate = createAccessGate(undefined);
  assert.equal(gate.enabled, false);
  assert.equal(gate.allows({}), true);
  assert.equal(gate.codeIsRight(CODE), false);
  assert.equal(gate.cookieValue, '');
});

test('a code that is too short is refused, and the refusal does not repeat it', () => {
  assert.throws(() => createAccessGate('abc1234'), (error: Error) => /at least 8 characters/.test(error.message) && !error.message.includes('abc1234'));
  assert.doesNotThrow(() => createAccessGate('abcd1234'));
  // The same rule at start-up, where the setting is read: blank means "no code", spaces around a code are not part of it.
  assert.throws(() => loadConfig({ ACCESS_CODE: 'abc1234' }), (error: Error) => /ACCESS_CODE/.test(error.message) && !error.message.includes('abc1234'));
  assert.equal(loadConfig({ ACCESS_CODE: '' }).ACCESS_CODE, undefined);
  assert.equal(loadConfig({ ACCESS_CODE: '   ' }).ACCESS_CODE, undefined);
  assert.equal(loadConfig({}).ACCESS_CODE, undefined);
  assert.equal(loadConfig({ ACCESS_CODE: ` ${CODE} ` }).ACCESS_CODE, CODE);
});

test('the right code is recognised and nothing else is, however close it looks', () => {
  const gate = createAccessGate(CODE);
  assert.equal(gate.enabled, true);
  assert.equal(gate.codeIsRight(CODE), true);
  for (const wrong of ['', ' ', CODE.toUpperCase(), `${CODE} `, ` ${CODE}`, CODE.slice(0, -1), `${CODE}x`, 'blue-river-7422', 'x'.repeat(5000), `${CODE}${'x'.repeat(2000)}`]) assert.equal(gate.codeIsRight(wrong), false, JSON.stringify(wrong).slice(0, 40));
  for (const notText of [undefined, null, 42, true, {}, [CODE], ['x'], Buffer.from(CODE)]) assert.equal(gate.codeIsRight(notText), false);
});

test('the cookie proves the code, holds no copy of it, changes with it, and is the same after a restart', () => {
  const first = createAccessGate(CODE); const again = createAccessGate(CODE); const other = createAccessGate('green-lake-9035');
  assert.match(first.cookieValue, /^v1\.[A-Za-z0-9_-]{43}$/, 'a plain token that is safe in a cookie');
  assert.equal(first.cookieValue, again.cookieValue, 'a free instance restarts often, and nobody should have to log in again each time');
  assert.notEqual(first.cookieValue, other.cookieValue, 'changing the code logs everybody out');
  assert.ok(!first.cookieValue.includes(CODE) && !first.cookieValue.includes(Buffer.from(CODE).toString('base64').replace(/=+$/, '')));
});

test('a request is let through by the cookie (among others), by the code in a header, and by nothing wrong or half right', () => {
  const gate = createAccessGate(CODE); const cookie = `${ACCESS_COOKIE_NAME}=${gate.cookieValue}`;
  assert.equal(gate.allows({}), false);
  assert.equal(gate.allows({ cookie }), true);
  assert.equal(gate.allows({ cookie: `a=1; ${cookie}; b=2` }), true);
  assert.equal(gate.allows({ cookie: `${ACCESS_COOKIE_NAME}=${gate.cookieValue}x` }), false);
  assert.equal(gate.allows({ cookie: `${ACCESS_COOKIE_NAME}=${gate.cookieValue.slice(0, -1)}` }), false);
  assert.equal(gate.allows({ cookie: `${ACCESS_COOKIE_NAME}=${createAccessGate('green-lake-9035').cookieValue}` }), false, 'a cookie made with another code');
  assert.equal(gate.allows({ cookie: `x${ACCESS_COOKIE_NAME}=${gate.cookieValue}` }), false, 'a cookie with a similar name');
  assert.equal(gate.allows({ cookie: `${ACCESS_COOKIE_NAME}=${CODE}` }), false, 'the code itself is not what the cookie holds');

  assert.equal(gate.allows({ authorization: `Bearer ${CODE}` }), true);
  assert.equal(gate.allows({ authorization: `bearer ${CODE}` }), true);
  assert.equal(gate.allows({ authorization: `  Bearer    ${CODE}  ` }), true);
  for (const wrong of [`Basic ${CODE}`, 'Bearer wrong-code-123', 'Bearer', 'Bearer ', CODE, `Bearer${CODE}`, `Bearer ${CODE}x`]) assert.equal(gate.allows({ authorization: wrong }), false, wrong);

  assert.equal(gate.allows({ 'x-access-code': CODE }), true);
  assert.equal(gate.allows({ 'x-access-code': [CODE, 'other'] }), true);
  assert.equal(gate.allows({ 'x-access-code': ['other', CODE] }), false, 'only the first one is looked at');
  assert.equal(gate.allows({ 'x-access-code': 'wrong-code-123' }), false);
});

test('one cookie is found among several, and look-alikes are not mistaken for it', () => {
  assert.equal(readCookie('a=1; studio_access=abc; b=2', 'studio_access'), 'abc');
  assert.equal(readCookie('studio_access=abc', 'studio_access'), 'abc');
  assert.equal(readCookie('  studio_access = abc ', 'studio_access'), 'abc');
  assert.equal(readCookie('my_studio_access=abc; studio_access_2=def', 'studio_access'), undefined);
  assert.equal(readCookie('studio_access', 'studio_access'), undefined, 'no value');
  assert.equal(readCookie('', 'studio_access'), undefined);
  assert.equal(readCookie(undefined, 'studio_access'), undefined);
  assert.equal(readCookie('studio_access=a=b', 'studio_access'), 'a=b', 'only the first equals sign separates the name');
});

test('after the code is given a person goes on to a place on this server, and never to another site or back to the login page', () => {
  for (const place of ['/jobs/0b7a1a8e-1a2b-4c3d-8e9f-0123456789ab', '/test-upload', '/test-upload?x=1#top', '/api/jobs/abc', '/loginx', '/']) assert.equal(safeNextPath(place), place, place);
  const fallback = '/test-upload';
  for (const bad of ['https://evil.example', 'http://evil.example/x', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/a\u0000b', 'javascript:alert(1)', 'evil.example', '', ' /x', '/login', '/login?next=/x', '/login/', '/logout', '/logout#x', `/${'a'.repeat(300)}`, undefined, null, 7, ['/a', '/b'], { 0: '/a' }]) assert.equal(safeNextPath(bad), fallback, JSON.stringify(bad)?.slice(0, 40));
  assert.equal(safeNextPath('', '/elsewhere'), '/elsewhere', 'the fallback can be chosen');
  assert.equal(safeNextPath(`/${'a'.repeat(299)}`).length, 300, 'the longest allowed');
});

test('guessing is slowed: ten wrong codes from one address make it wait, a right code clears the count, and others are not affected', () => {
  let now = 1_000_000;
  const limiter = new FailedAttemptLimiter({ maxFailures: 10, windowMs: 15 * 60_000 }, () => now);
  for (let attempt = 1; attempt <= 9; attempt += 1) { assert.equal(limiter.waitSeconds('1.1.1.1'), 0, `attempt ${attempt} may be made`); limiter.recordFailure('1.1.1.1'); }
  assert.equal(limiter.waitSeconds('1.1.1.1'), 0, 'the tenth attempt may still be made');
  limiter.recordFailure('1.1.1.1');
  assert.equal(limiter.waitSeconds('1.1.1.1'), 15 * 60, 'now it must wait for the whole window');
  assert.equal(limiter.waitSeconds('2.2.2.2'), 0, 'somebody else is not affected');
  now += 5 * 60_000;
  assert.equal(limiter.waitSeconds('1.1.1.1'), 10 * 60, 'the wait counts down');
  now += 10 * 60_000 - 1;
  assert.equal(limiter.waitSeconds('1.1.1.1'), 1, 'rounded up, never zero while it still has to wait');
  now += 1;
  assert.equal(limiter.waitSeconds('1.1.1.1'), 0, 'the window is over');
  limiter.recordFailure('1.1.1.1');
  assert.equal(limiter.waitSeconds('1.1.1.1'), 0, 'and the count starts again from one');

  for (let attempt = 0; attempt < 9; attempt += 1) limiter.recordFailure('3.3.3.3');
  limiter.recordSuccess('3.3.3.3');
  for (let attempt = 0; attempt < 9; attempt += 1) limiter.recordFailure('3.3.3.3');
  assert.equal(limiter.waitSeconds('3.3.3.3'), 0, 'a right code wipes the count: the owner is not locked out by earlier typing mistakes');
});

test('the window does not slide: failures spread over time still run out at the end of the first one\'s window', () => {
  let now = 0;
  const limiter = new FailedAttemptLimiter({ maxFailures: 3, windowMs: 60_000 }, () => now);
  limiter.recordFailure('a'); now += 30_000; limiter.recordFailure('a'); now += 29_000; limiter.recordFailure('a');
  assert.equal(limiter.waitSeconds('a'), 1, 'three failures within the first minute: wait for the rest of it');
  now += 1000;
  assert.equal(limiter.waitSeconds('a'), 0);
});

test('the limiter never remembers more addresses than allowed, whatever is sent', () => {
  let now = 0;
  const limiter = new FailedAttemptLimiter({ maxFailures: 2, windowMs: 60_000, maxClients: 5 }, () => now);
  limiter.recordFailure('first'); limiter.recordFailure('first');
  assert.ok(limiter.waitSeconds('first') > 0);
  for (let index = 0; index < 50; index += 1) { limiter.recordFailure(`flood-${index}`); assert.ok(limiter.trackedClients <= 5); }
  assert.equal(limiter.trackedClients, 5);
  assert.equal(limiter.waitSeconds('first'), 0, 'the oldest is forgotten first');
  now += 61_000;
  limiter.recordFailure('late');
  assert.equal(limiter.trackedClients <= 5, true);
});
