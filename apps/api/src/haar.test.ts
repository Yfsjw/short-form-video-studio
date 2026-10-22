import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { detectFaces, loadFaceCascade, parseHaarCascade, type Detection } from './haar.js';

/** Reads the little grey picture the tests search (test-assets/README.md says where it comes from). */
function readPgm(name: string): { pixels: Uint8Array; width: number; height: number } {
  const file = readFileSync(new URL(`../test-assets/${name}`, import.meta.url));
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(file.subarray(0, 40).toString('latin1'));
  assert.ok(header, 'the picture is a binary PGM');
  const width = Number(header[1]); const height = Number(header[2]);
  const pixels = new Uint8Array(file.subarray(header[0].length));
  assert.equal(pixels.length, width * height);
  return { pixels, width, height };
}

/** Puts a picture on a bigger flat one. */
function embed(picture: { pixels: Uint8Array; width: number; height: number }, width: number, height: number, left: number, top: number, fill = 128) {
  const pixels = new Uint8Array(width * height).fill(fill);
  for (let y = 0; y < picture.height; y += 1) pixels.set(picture.pixels.subarray(y * picture.width, (y + 1) * picture.width), (y + top) * width + left);
  return { pixels, width, height };
}

/**
 * Every hit OpenCV.js 4.11 (`CascadeClassifier.detectMultiScale(gray, faces, 1.1, 0, 0, Size(24, 24))`, which leaves the hits ungrouped)
 * finds in test-assets/astronaut-320.pgm with the same haarcascade_frontalface_alt2.xml: x, y, width, height.
 */
const OPENCV_HITS: Array<[number, number, number, number]> = [
  [120, 49, 43, 43], [120, 47, 47, 47], [114, 41, 52, 52], [112, 44, 52, 52], [117, 44, 52, 52], [114, 47, 52, 52], [117, 47, 52, 52], [119, 47, 52, 52],
  [108, 40, 57, 57], [111, 40, 57, 57], [106, 43, 57, 57], [108, 43, 57, 57], [111, 43, 57, 57], [114, 43, 57, 57], [108, 46, 57, 57], [111, 46, 57, 57],
  [114, 46, 57, 57], [107, 38, 63, 63], [110, 38, 63, 63], [113, 38, 63, 63], [107, 41, 63, 63], [110, 41, 63, 63], [113, 41, 63, 63], [107, 44, 63, 63],
  [110, 44, 63, 63], [104, 35, 69, 69], [107, 35, 69, 69], [107, 38, 69, 69], [110, 38, 69, 69], [107, 41, 69, 69], [110, 41, 69, 69], [99, 30, 76, 76],
  [103, 30, 76, 76], [106, 30, 76, 76], [99, 34, 76, 76], [103, 34, 76, 76], [106, 34, 76, 76], [103, 38, 76, 76], [178, 80, 76, 76], [100, 29, 84, 84],
  [175, 75, 84, 84], [175, 69, 92, 92],
];
/** What OpenCV.js groups those hits into (minNeighbors 4): one face. */
const OPENCV_FACE = { x: 109, y: 40, width: 63, height: 63 };

const near = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) <= tolerance;
const centre = (face: Detection) => ({ x: face.x + face.width / 2, y: face.y + face.height / 2 });

test('the cascade that ships with the program reads as a 20x20 frontal-face cascade, once', async () => {
  const cascade = await loadFaceCascade();
  assert.equal(cascade.windowWidth, 20); assert.equal(cascade.windowHeight, 20);
  assert.equal(cascade.stageCount, 20);
  assert.equal(cascade.treeNodeStart.length, 1047);
  assert.equal(cascade.nodeLeft.length, 2094);
  assert.equal(await loadFaceCascade(), cascade, 'the file is read once');
});

test('on a picture OpenCV has searched, every hit OpenCV found is found here too, and next to nothing else', async () => {
  const cascade = await loadFaceCascade(); const { pixels, width, height } = readPgm('astronaut-320.pgm');
  const mine = detectFaces(cascade, pixels, width, height, { minNeighbors: 0, minSize: 24 });
  const mineKeys = new Set(mine.map((hit) => `${hit.x},${hit.y},${hit.width},${hit.height}`));
  const missing = OPENCV_HITS.filter((hit) => !mineKeys.has(hit.join(',')));
  assert.deepEqual(missing, [], 'hits that OpenCV finds and this does not');
  // (Pictures are shrunk with a slightly different rounding, so a window right at a threshold can go either way.)
  assert.ok(mine.length <= OPENCV_HITS.length + 3, `${mine.length} hits against OpenCV's ${OPENCV_HITS.length}`);
});

test('the hits make one face, where OpenCV puts it', async () => {
  const cascade = await loadFaceCascade(); const { pixels, width, height } = readPgm('astronaut-320.pgm');
  const faces = detectFaces(cascade, pixels, width, height, { minNeighbors: 4, minSize: 24 });
  assert.equal(faces.length, 1, 'the other hits (lower right) are too few to be a face');
  const [face] = faces;
  for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(near(face[key], OPENCV_FACE[key], 1), `${key}: ${face[key]} against ${OPENCV_FACE[key]}`);
  assert.ok(face.neighbors >= 30, `${face.neighbors} overlapping hits support it`);
});

test('a bigger step between sizes (and no smallest size) finds the same face', async () => {
  const cascade = await loadFaceCascade(); const { pixels, width, height } = readPgm('astronaut-320.pgm');
  for (const options of [{ scaleFactor: 1.2, minSize: 24 }, { scaleFactor: 1.1 }, { scaleFactor: 1.15, minNeighbors: 5, minSize: 24 }]) {
    const faces = detectFaces(cascade, pixels, width, height, options);
    assert.equal(faces.length, 1, JSON.stringify(options));
    const here = centre(faces[0]); const there = centre({ ...OPENCV_FACE, neighbors: 0 });
    assert.ok(near(here.x, there.x, 3) && near(here.y, there.y, 3), `${JSON.stringify(options)}: centre ${here.x},${here.y}`);
    assert.ok(near(faces[0].width, OPENCV_FACE.width, 6), `${JSON.stringify(options)}: width ${faces[0].width}`);
  }
});

test('a group needs MORE hits than minNeighbors to be a face', async () => {
  const cascade = await loadFaceCascade(); const { pixels, width, height } = readPgm('astronaut-320.pgm');
  const [face] = detectFaces(cascade, pixels, width, height, { minNeighbors: 4, minSize: 24 });
  assert.equal(detectFaces(cascade, pixels, width, height, { minNeighbors: face.neighbors, minSize: 24 }).length, 0);
  assert.equal(detectFaces(cascade, pixels, width, height, { minNeighbors: face.neighbors - 1, minSize: 24 }).length, 1);
});

test('faces smaller or bigger than asked for are left out', async () => {
  const cascade = await loadFaceCascade(); const { pixels, width, height } = readPgm('astronaut-320.pgm');
  assert.equal(detectFaces(cascade, pixels, width, height, { maxSize: 40 }).length, 0, 'the face is 63 pixels wide');
  assert.equal(detectFaces(cascade, pixels, width, height, { minSize: 120 }).length, 0);
  assert.equal(detectFaces(cascade, pixels, width, height, { minSize: 50, maxSize: 90 }).length, 1);
});

test('the same face is found wherever it stands in a bigger picture', async () => {
  const cascade = await loadFaceCascade(); const picture = readPgm('astronaut-320.pgm');
  for (const [left, top] of [[200, 20], [0, 0], [310, 40]]) {
    const scene = embed(picture, 640, 360, left, top);
    const faces = detectFaces(cascade, scene.pixels, scene.width, scene.height, { minNeighbors: 5, minSize: 24 });
    assert.equal(faces.length, 1, `offset ${left},${top}`);
    assert.ok(near(faces[0].x, OPENCV_FACE.x + left, 4) && near(faces[0].y, OPENCV_FACE.y + top, 4), `offset ${left},${top}: found at ${faces[0].x},${faces[0].y}`);
    assert.ok(near(faces[0].width, OPENCV_FACE.width, 5));
  }
});

test('pictures without a face give no face', async () => {
  const cascade = await loadFaceCascade();
  const flat = new Uint8Array(320 * 240).fill(120);
  assert.deepEqual(detectFaces(cascade, flat, 320, 240), []);
  const gradient = new Uint8Array(320 * 240); for (let y = 0; y < 240; y += 1) gradient.fill(Math.round((y * 255) / 239), y * 320, (y + 1) * 320);
  assert.deepEqual(detectFaces(cascade, gradient, 320, 240), []);
  let seed = 12345; const noise = new Uint8Array(320 * 240).map(() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; });
  assert.deepEqual(detectFaces(cascade, noise, 320, 240, { minNeighbors: 5 }), []);
});

test('a picture smaller than its size says, or a step that does not shrink it, is refused', async () => {
  const cascade = await loadFaceCascade();
  assert.throws(() => detectFaces(cascade, new Uint8Array(10), 320, 240), /smaller than its size/);
  assert.throws(() => detectFaces(cascade, new Uint8Array(320 * 240), 320, 240, { scaleFactor: 1 }), /bigger than 1/);
  assert.deepEqual(detectFaces(cascade, new Uint8Array(10 * 10), 10, 10), [], 'a picture smaller than the window has nothing to look at');
});

test('it does not take long on a small picture', async () => {
  const cascade = await loadFaceCascade(); const { pixels, width, height } = readPgm('astronaut-320.pgm');
  const started = Date.now();
  detectFaces(cascade, pixels, width, height, { minNeighbors: 5, minSize: 24 });
  // About 0.2 s on a laptop; the limit only catches an accident (a search that never ends, grouping that explodes).
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

// ---- a cascade made by hand: one stage, one feature ("the right half of the window is brighter than the left half") ----------------

const HAND_MADE = `<?xml version="1.0"?>
<opencv_storage>
<cascade type_id="opencv-cascade-classifier"><stageType>BOOST</stageType>
  <featureType>HAAR</featureType>
  <height>8</height>
  <width>8</width>
  <stageNum>1</stageNum>
  <stages>
    <_>
      <maxWeakCount>1</maxWeakCount>
      <stageThreshold>5.0000000000000000e-01</stageThreshold>
      <weakClassifiers>
        <_>
          <internalNodes>
            0 -1 0 0.</internalNodes>
          <leafValues>
            0. 1.</leafValues></_></weakClassifiers></_></stages>
  <features>
    <_>
      <rects>
        <_>0 0 4 8 -1.</_>
        <_>4 0 4 8 1.</_></rects>
      <tilted>0</tilted></_></features></cascade>
</opencv_storage>`;

/** A 40x40 picture: the left half one grey, the right half another. */
const twoHalves = (left: number, right: number) => { const pixels = new Uint8Array(40 * 40); for (let y = 0; y < 40; y += 1) for (let x = 0; x < 40; x += 1) pixels[y * 40 + x] = x < 20 ? left : right; return pixels; };

test('a cascade made by hand shows which windows are looked at and how a feature is read', () => {
  const cascade = parseHaarCascade(HAND_MADE);
  assert.equal(cascade.windowWidth, 8); assert.equal(cascade.stageCount, 1);
  // Only windows of the cascade's own size (maxSize 8), every hit on its own (minNeighbors 0).
  const hits = detectFaces(cascade, twoHalves(50, 200), 40, 40, { minNeighbors: 0, maxSize: 8 });
  // The window is moved two pixels at a time; one that is flat inside (all one grey) is skipped, and one has to hold the edge at column 20
  // with the bright side on the right to pass: its inside (a pixel in from each side) holds the edge for x = 14, 16 and 18.
  assert.deepEqual([...new Set(hits.map((hit) => hit.x))].sort((a, b) => a - b), [14, 16, 18]);
  assert.deepEqual([...new Set(hits.map((hit) => hit.y))].sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index * 2), 'every second row from the top down to the last window that fits');
  assert.equal(hits.length, 48);
  assert.ok(hits.every((hit) => hit.width === 8 && hit.height === 8));
  assert.deepEqual(detectFaces(cascade, twoHalves(200, 50), 40, 40, { minNeighbors: 0, maxSize: 8 }), [], 'the other way round the feature is negative');
});

test('a window whose pixels differ by less than a standard deviation of 10 is too flat to be looked at', () => {
  const cascade = parseHaarCascade(HAND_MADE);
  assert.equal(detectFaces(cascade, twoHalves(100, 110), 40, 40, { minNeighbors: 0, maxSize: 8 }).length, 0, 'ten grey levels apart: a standard deviation of 5');
  assert.ok(detectFaces(cascade, twoHalves(100, 125), 40, 40, { minNeighbors: 0, maxSize: 8 }).length > 0, 'twenty-five apart: a standard deviation of 12');
});

test('a cascade that is not understood is refused, with a reason', () => {
  assert.throws(() => parseHaarCascade('<nothing/>'), /no <opencv_storage>|no <cascade>/);
  assert.throws(() => parseHaarCascade(HAND_MADE.replace('<featureType>HAAR', '<featureType>LBP')), /Only Haar/);
  assert.throws(() => parseHaarCascade(HAND_MADE.replace('<tilted>0', '<tilted>1')), /Tilted/);
  assert.throws(() => parseHaarCascade(HAND_MADE.replace('<width>8', '<width>4')), /window/);
  assert.throws(() => parseHaarCascade(HAND_MADE.replace('0 -1 0 0.', '0 7 0 0.')), /points nowhere/);
  assert.throws(() => parseHaarCascade(HAND_MADE.replace('0 -1 0 0.', '0 -1 9 0.')), /feature that does not exist/);
  assert.throws(() => parseHaarCascade(HAND_MADE.replace('0. 1.</leafValues>', '0.</leafValues>')), /malformed/);
  assert.throws(() => parseHaarCascade(HAND_MADE.replace('4 0 4 8 1.', '4 0 9 8 1.')), /malformed/);
});
