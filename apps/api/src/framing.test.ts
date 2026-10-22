import assert from 'node:assert/strict';
import test from 'node:test';
import { cropXExpression, defaultFramingSettings, planFraming, positionAt, positionExpression, type FaceSighting, type FramingObservation, type FramingResult } from './framing.js';

const CROP = 0.316; // a 9:16 window out of a 16:9 picture
const half = CROP / 2;
/** Where the window sits (0..1) when its middle is at `x` across the picture. */
const positionFor = (x: number) => (Math.min(Math.max(x, half), 1 - half) - half) / (1 - CROP);
const face = (x: number, width = 0.1, neighbors = 30): FaceSighting => ({ x, width, neighbors });
/** One picture every half second for `seconds`, with the faces `at(t)` says are in it. */
const watch = (seconds: number, at: (t: number) => FaceSighting[]): FramingObservation[] => Array.from({ length: Math.round(seconds * 2) }, (_, index) => ({ seconds: index / 2, faces: at(index / 2) }));
const plan = (result: FramingResult) => { assert.ok(result.followed, result.note); return result.plan; };
const close = (actual: number, expected: number, tolerance: number, message?: string) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} ${actual} is not within ${tolerance} of ${expected}`);

test('a face that stays put gets one cut of the picture, around it', () => {
  const result = planFraming(watch(20, () => [face(0.3)]), 20, CROP);
  assert.ok(result.followed);
  assert.equal(result.plan.keyframes.length, 1, 'the window does not move');
  close(result.plan.keyframes[0].position, positionFor(0.3), 0.005);
  assert.equal(result.seenShare, 1);
  assert.match(result.note, /^Followed a face, seen in 100% of the moments checked/);
});

test('small movements of the face inside the dead zone do not move the camera', () => {
  const result = planFraming(watch(20, (t) => [face(0.3 + 0.012 * Math.sin(t * 3))]), 20, CROP);
  assert.equal(plan(result).keyframes.length, 1);
  close(plan(result).keyframes[0].position, positionFor(0.3), 0.03);
});

test('a face that walks across the picture is followed, closely and no faster than the speed limit', () => {
  const observations = watch(20, (t) => [face(0.2 + 0.03 * t)]); // from 0.2 to 0.8 at 0.03 of the width per second
  const { keyframes } = plan(planFraming(observations, 20, CROP));
  assert.ok(keyframes.length >= 2 && keyframes.length < 60, `${keyframes.length} key moments`);
  close(keyframes[0].position, positionFor(0.2), 0.02, 'it starts at the face');
  assert.ok(keyframes[keyframes.length - 1].position > 0.85, 'it ends near the right');
  for (let index = 1; index < keyframes.length; index += 1) assert.ok(keyframes[index].position >= keyframes[index - 1].position - 1e-9, 'it only goes right');
  // the fastest the window may travel, in positions per second: the speed limit (window widths per second) turned into the 0..1 scale
  const fastest = (defaultFramingSettings.maxSpeed * CROP) / (1 - CROP);
  for (let index = 1; index < keyframes.length; index += 1) {
    const slope = (keyframes[index].position - keyframes[index - 1].position) / (keyframes[index].seconds - keyframes[index - 1].seconds);
    assert.ok(slope <= fastest + 1e-6, `slope ${slope} against the limit ${fastest}`);
  }
  for (const observation of observations) close(half + positionAt(keyframes, observation.seconds) * (1 - CROP), observation.faces[0].x, 0.09, `at ${observation.seconds} s the face is off the middle of the window by`);
});

test('a face that moves to the other side of the picture is followed there', () => {
  const observations = watch(12, (t) => [face(t < 4 ? 0.25 : 0.7)]);
  // Whether the camera chases it or cuts to it, it ends up there.
  const { keyframes } = plan(planFraming(observations, 12, CROP));
  close(positionAt(keyframes, 0), positionFor(0.25), 0.01);
  close(positionAt(keyframes, 11.9), positionFor(0.7), 0.03);
});

test('a face that cannot be seen for a moment is waited for: the camera does not wander', () => {
  const observations = watch(20, (t) => (t >= 8 && t < 9 ? [] : [face(0.7)]));
  const result = planFraming(observations, 20, CROP);
  assert.equal(plan(result).keyframes.length, 1);
  close(plan(result).keyframes[0].position, positionFor(0.7), 0.005);
  close((result as { seenShare: number }).seenShare, 38 / 40, 1e-9);
});

test('when the followed face has gone for good, the camera cuts to the other face, after a moment', () => {
  // The first face is bigger and so is followed; the second one is there all along, but only becomes the one to follow when the first has gone.
  const observations = watch(30, (t) => [...(t < 20 ? [face(0.25, 0.14)] : []), face(0.75, 0.06)]);
  const result = planFraming(observations, 30, CROP);
  const { keyframes } = plan(result);
  close(positionAt(keyframes, 10), positionFor(0.25), 0.01, 'while the first face is there');
  close(positionAt(keyframes, 20.9), positionFor(0.25), 0.01, 'it waits (the face was last seen at 19.5 s and the wait is 1.5 s)');
  close(positionAt(keyframes, 21.2), positionFor(0.75), 0.01, 'then it cuts');
  close(positionAt(keyframes, 28), positionFor(0.75), 0.01);
  assert.equal((result as { tracksFollowed: number }).tracksFollowed, 2);
});

test('when the video cuts to another shot, the camera does not wait to find the face in it', () => {
  const observations = watch(30, (t) => [face(t < 10 ? 0.25 : 0.75)]).map((observation) => (observation.seconds === 10 ? { ...observation, sceneCut: true } : observation));
  const { keyframes } = plan(planFraming(observations, 30, CROP));
  close(positionAt(keyframes, 9.9), positionFor(0.25), 0.01);
  close(positionAt(keyframes, 10.1), positionFor(0.75), 0.01);
  // ...and without the mark the same change has to be waited out (the face in the second shot is "a face that jumped", out of the first's reach)
  const unmarked = plan(planFraming(watch(30, (t) => [face(t < 10 ? 0.25 : 0.75)]), 30, CROP)).keyframes;
  close(positionAt(unmarked, 10.1), positionFor(0.25), 0.05, 'still waiting at 10.1 s');
  close(positionAt(unmarked, 11.6), positionFor(0.75), 0.02, 'cut at 11.5 s');
});

test('faces on the two sides of a cut are never taken for one person', () => {
  // Same place, same size before and after the cut: one face as far as the camera is concerned, so one static shot.
  const observations = watch(20, () => [face(0.4)]).map((observation) => (observation.seconds === 10 ? { ...observation, sceneCut: true } : observation));
  const result = planFraming(observations, 20, CROP);
  assert.equal(plan(result).keyframes.length, 1);
  assert.equal((result as { tracksFollowed: number }).tracksFollowed, 2);
});

test('with two faces all the time it stays with the more visible one and does not hop', () => {
  const result = planFraming(watch(30, () => [face(0.7, 0.07, 20), face(0.3, 0.15, 40)]), 30, CROP);
  assert.equal(plan(result).keyframes.length, 1);
  close(plan(result).keyframes[0].position, positionFor(0.3), 0.005);
  assert.equal((result as { tracksFollowed: number }).tracksFollowed, 1);
});

test('one face that shows up on and off is not mistaken for a second one', () => {
  const result = planFraming(watch(30, (t) => (Math.floor(t) % 3 === 2 ? [] : [face(0.4 + 0.004 * Math.sin(t))])), 30, CROP);
  assert.equal(plan(result).keyframes.length, 1);
  assert.equal((result as { tracksFollowed: number }).tracksFollowed, 1);
});

test('before the first face is seen the window already stands where it will be', () => {
  const { keyframes } = plan(planFraming(watch(20, (t) => (t < 5 ? [] : [face(0.8)])), 20, CROP));
  assert.equal(keyframes.length, 1);
  close(keyframes[0].position, positionFor(0.8), 0.005);
});

test('a face at the very edge keeps the window inside the picture', () => {
  assert.equal(plan(planFraming(watch(10, () => [face(0.99)]), 10, CROP)).keyframes[0].position, 1);
  assert.equal(plan(planFraming(watch(10, () => [face(0.01)]), 10, CROP)).keyframes[0].position, 0);
});

test('without a face, or with one that is not believable, or with too little of one, the clip stays centred and says why', () => {
  const none = planFraming(watch(10, () => []), 10, CROP);
  assert.equal(none.followed, false); assert.match(none.note, /^Centred: no face was found/);
  const brief = planFraming(watch(20, (t) => (t === 5 ? [face(0.5)] : [])), 20, CROP);
  assert.equal(brief.followed, false); assert.match(brief.note, /too briefly/);
  const rare = planFraming(watch(20, (t) => (t >= 5 && t < 6.5 ? [face(0.5)] : [])), 20, CROP);
  assert.equal(rare.followed, false); assert.match(rare.note, /only 8% of the moments checked/);
  const narrow = planFraming(watch(10, () => [face(0.5)]), 10, 1);
  assert.equal(narrow.followed, false); assert.match(narrow.note, /already as narrow as the clip/);
  const empty = planFraming([], 10, CROP);
  assert.equal(empty.followed, false);
});

test('a face that jumps in an instant is cut to in an instant, not slid to', () => {
  const observations = watch(30, (t) => (t < 10 ? [face(0.25)] : t < 11.5 ? [] : [face(0.75)]));
  const { keyframes } = plan(planFraming(observations, 30, CROP));
  close(positionAt(keyframes, 11.4), positionFor(0.25), 0.01);
  close(positionAt(keyframes, 11.6), positionFor(0.75), 0.01);
});

test('the path is turned into an FFmpeg expression that works out the same positions', () => {
  const keyframes = [{ seconds: 0, position: 0.2 }, { seconds: 2, position: 0.2 }, { seconds: 2.5, position: 0.6 }, { seconds: 6, position: 0.35 }];
  const expression = positionExpression(keyframes);
  assert.equal(expression, '0.2+(0.4)*clip((t-2)/0.5,0,1)+(-0.25)*clip((t-2.5)/3.5,0,1)', 'the stretch where it stands still adds nothing');
  const evaluate = new Function('t', 'clip', `return ${expression};`) as (t: number, clip: (value: number, low: number, high: number) => number) => number;
  const clip = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
  for (const t of [0, 1, 2, 2.25, 2.5, 4, 6, 9]) close(evaluate(t, clip), positionAt(keyframes, t), 1e-9, `at ${t} s`);
  assert.equal(positionExpression([{ seconds: 0, position: 0.4321987 }]), '0.4322');
  assert.equal(positionExpression([]), '0.5');
  assert.equal(cropXExpression([{ seconds: 0, position: 0.5 }]), '(in_w-out_w)*(0.5)');
});

test('a long and busy path still gives a modest expression with no nesting', () => {
  const observations = watch(90, (t) => [face(0.5 + 0.4 * Math.sin(t / 3), 0.1, 30)]);
  const { keyframes } = plan(planFraming(observations, 90, CROP));
  const expression = cropXExpression(keyframes);
  assert.ok(expression.length < 6000, `${expression.length} characters, ${keyframes.length} key moments`);
  assert.ok(!expression.includes('if('), 'no nested ifs');
  assert.ok((expression.match(/\(/g) ?? []).length === (expression.match(/\)/g) ?? []).length, 'brackets balance');
  assert.ok(keyframes.every((keyframe, index) => index === 0 || keyframe.seconds > keyframes[index - 1].seconds), 'time only goes forward');
});
