import assert from 'node:assert/strict';
import test from 'node:test';
import { limitWords, refuseIfFull, refuseIfTooLong, type AdmissionRules } from './admission.js';

const live = { listen: 3.4 };   // what the live server was seen to do (see the README)
const rules: AdmissionRules = { queueLimit: 5, listeningLimitSeconds: 3600 };

test('a video that cannot be listened to in the time allowed is turned away, in words that say why, how long it would take, and what to do', () => {
  const refusal = refuseIfTooLong(4800, live, rules);
  assert.ok(refusal && refusal.code === 'VIDEO_TOO_LONG');
  assert.equal(refusal.status, 422);
  assert.equal(refusal.message, 'This video is 1 h 20 min long, which is too long for this server: listening to it would take about 4 h 30 min, and the server stops listening after 1 hour. Videos up to about 15 min work right now. Please upload a shorter part of it.');
});

test('the longest video that works is the one that is expected to take nine tenths of the time allowed, in whole windows of 30 s, said in whole minutes that are never too many', () => {
  // 3240 s of listening at 3.4 for each second of a window is 31 windows: 930 s of video, which is 15 whole minutes and a half.
  assert.equal(refuseIfTooLong(930, live, rules), undefined, 'a video that fits is not turned away');
  assert.equal(refuseIfTooLong(931, live, rules), undefined, 'a tail of a second is not listened to');
  const justOver = refuseIfTooLong(932, live, rules);
  assert.ok(justOver);
  assert.match(justOver.message, /Videos up to about 15 min work right now\./);
  // A server so slow that not even a minute works says so, instead of "0 min".
  const crawling = refuseIfTooLong(60, { listen: 100 }, rules);
  assert.ok(crawling);
  assert.match(crawling.message, /Right now only a very short video can be done\./);
  assert.doesNotMatch(crawling.message, /\b0 min/);
  assert.equal(refuseIfTooLong(30, { listen: 150 }, rules), undefined, 'a video of one window is always taken, however slow the server looks: it is how a server finds out that it got quicker');
  const slowest = refuseIfTooLong(60, { listen: 150 }, rules); assert.ok(slowest); assert.match(slowest.message, /Right now only a very short video can be done\./);
});

test('nothing is said against a video when its length, the speed of listening or the limit is not known', () => {
  assert.equal(refuseIfTooLong(undefined, live, rules), undefined, 'a video whose length could not be read is left to the pipeline, which tells what is wrong with it');
  assert.equal(refuseIfTooLong(99_999, {}, rules), undefined, 'no speed is known yet (the start-up check has not finished and no video has been done)');
  assert.equal(refuseIfTooLong(99_999, live, { ...rules, listeningLimitSeconds: undefined }), undefined, 'a hosted speech service is not stopped at a time limit');
  assert.equal(refuseIfTooLong(0, live, rules), undefined);
});

test('a limit is said as it is: whole hours as hours, anything else in minutes', () => {
  assert.equal(limitWords(3600), '1 hour'); assert.equal(limitWords(7200), '2 hours'); assert.equal(limitWords(5400), '90 minutes'); assert.equal(limitWords(1800), '30 minutes'); assert.equal(limitWords(600), '10 minutes'); assert.equal(limitWords(90), '90 seconds'); assert.equal(limitWords(20), '20 seconds');
});

test('a server that holds as many waiting videos as it takes on turns the next away, and says when to come back', () => {
  assert.equal(refuseIfFull(4, rules), undefined, 'one place is left');
  const full = refuseIfFull(5, rules, 1500);
  assert.ok(full && full.code === 'SERVER_BUSY');
  assert.equal(full.status, 503);
  assert.equal(full.message, 'The server is full right now: 5 videos are already waiting for their turn, and it does not take on more than 5. Please try again in about 25 min.');
  assert.equal(full.retryAfterSeconds, 1500);
  const over = refuseIfFull(9, rules); assert.ok(over); assert.match(over.message, /9 videos are already waiting/);
  const one = refuseIfFull(1, { ...rules, queueLimit: 1 }); assert.ok(one); assert.match(one.message, /1 video is already waiting/);
});

test('when it is not known when a place frees up, the answer says a few minutes, and the time to wait stays within what makes sense', () => {
  const unknown = refuseIfFull(5, rules); assert.ok(unknown);
  assert.match(unknown.message, /Please try again in a few minutes\.$/);
  assert.equal(unknown.retryAfterSeconds, 300);
  assert.equal(refuseIfFull(5, rules, 5)?.retryAfterSeconds, 60, 'not sooner than a minute');
  assert.equal(refuseIfFull(5, rules, 100_000)?.retryAfterSeconds, 3600, 'and not later than an hour');
  assert.equal(refuseIfFull(5, rules, 90.2)?.retryAfterSeconds, 91, 'rounded up');
  assert.equal(refuseIfFull(5, rules, Number.NaN)?.retryAfterSeconds, 300, 'a time that is not a number is a time that is not known');
});

test('with no limit on the line nobody is turned away for it', () => {
  assert.equal(refuseIfFull(1000, { ...rules, queueLimit: undefined }), undefined);
});
