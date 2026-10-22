import { readFile } from 'node:fs/promises';

/**
 * A Viola-Jones object detector that reads the cascades OpenCV ships (the .xml files of "Haar cascades"), written in plain TypeScript so
 * that finding a face needs no native library and no model download: the cascade is a file in this repository (assets/cascades). It is
 * what finds the face a framing follows (see framing.ts). It finds faces that look at the camera and stand upright, and claims nothing
 * beyond that.
 *
 * It follows OpenCV's own `detectMultiScale` step by step, so the same picture gives the same faces:
 *  - the picture is shrunk again and again (so that a window of the cascade's size, 20x20, covers bigger and bigger faces);
 *  - a window is dropped at once when it is too flat to hold a face (a standard deviation of its pixels of 10 or less);
 *  - the stages of the cascade are tried one after another, and most windows fail in the first;
 *  - the windows that pass are grouped: many overlapping hits make one face, and a group with too few hits is noise.
 */
export interface Rect { x: number; y: number; width: number; height: number; }
/** A face found: where it is, in pixels of the picture searched, and how many overlapping hits support it (more is surer). */
export interface Detection extends Rect { neighbors: number; }

/**
 * A cascade in the flat form the detector runs on. OpenCV keeps thresholds, leaves and weights as 32-bit floats, so they are rounded to
 * that precision here too (and held as doubles, which are quicker to read), and the comparisons come out as OpenCV's do.
 */
export interface HaarCascade {
  windowWidth: number; windowHeight: number;
  stageCount: number; stageThreshold: Float64Array; stageTreeStart: Int32Array; stageTreeCount: Int32Array;
  /** Where the nodes and the leaves of every tree start in `nodeLeft` ... and `leafValue`. */
  treeNodeStart: Int32Array; treeLeafStart: Int32Array;
  nodeLeft: Int32Array; nodeRight: Int32Array; nodeFeature: Int32Array; nodeThreshold: Float64Array; leafValue: Float64Array;
  /** The rectangles of the feature of every node (numbers into `rectBox` and `rectWeight`). */
  nodeRectStart: Int32Array; nodeRectCount: Int32Array;
  /** x, y, width, height of every rectangle of every feature, in the window; and the weight of each. */
  rectBox: Int32Array; rectWeight: Float64Array;
}

// ---- reading the XML ------------------------------------------------------------------------------------------------------------

interface XmlNode { name: string; children: XmlNode[]; text: string; }

/** The little of XML that OpenCV's cascade files use: nested elements and their text (the items of a list are called "_"). */
function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#root', children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const [token, closing, name, selfClosing, text] = match;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    const top = stack[stack.length - 1];
    if (text !== undefined) { top.text += text; continue; }
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const node: XmlNode = { name, children: [], text: '' };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}
const child = (node: XmlNode, name: string): XmlNode => {
  const found = node.children.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`The cascade has no <${name}>.`);
  return found;
};
const numbers = (text: string): number[] => text.trim().split(/\s+/).filter(Boolean).map(Number);
const integerOf = (node: XmlNode): number => Number(node.text.trim());

/** OpenCV lowers every stage threshold by this much when it reads a cascade. */
const STAGE_THRESHOLD_EPS = Math.fround(1e-5);

/** Reads an OpenCV Haar cascade (the "new" XML format, with trees of any depth) into the flat form the detector runs on. */
export function parseHaarCascade(xml: string): HaarCascade {
  const cascade = child(child(parseXml(xml), 'opencv_storage'), 'cascade');
  if (child(cascade, 'featureType').text.trim() !== 'HAAR') throw new Error('Only Haar cascades are supported.');
  const windowWidth = integerOf(child(cascade, 'width')); const windowHeight = integerOf(child(cascade, 'height'));
  if (!(windowWidth >= 8 && windowHeight >= 8)) throw new Error('The cascade does not say how big its window is.');

  const stages = child(cascade, 'stages').children;
  const features = child(cascade, 'features').children;
  if (stages.length === 0 || features.length === 0) throw new Error('The cascade has no stages or no features.');
  const trees = stages.flatMap((stage) => child(stage, 'weakClassifiers').children);
  const nodeCount = trees.reduce((total, tree) => total + numbers(child(tree, 'internalNodes').text).length / 4, 0);
  const leafCount = trees.reduce((total, tree) => total + numbers(child(tree, 'leafValues').text).length, 0);

  const result: HaarCascade = {
    windowWidth, windowHeight, stageCount: stages.length,
    stageThreshold: new Float64Array(stages.length), stageTreeStart: new Int32Array(stages.length), stageTreeCount: new Int32Array(stages.length),
    treeNodeStart: new Int32Array(trees.length), treeLeafStart: new Int32Array(trees.length),
    nodeLeft: new Int32Array(nodeCount), nodeRight: new Int32Array(nodeCount), nodeFeature: new Int32Array(nodeCount),
    nodeThreshold: new Float64Array(nodeCount), leafValue: new Float64Array(leafCount),
    nodeRectStart: new Int32Array(nodeCount), nodeRectCount: new Int32Array(nodeCount),
    rectBox: new Int32Array(0), rectWeight: new Float64Array(0),
  };

  let tree = 0; let node = 0; let leaf = 0;
  stages.forEach((stage, stageIndex) => {
    result.stageThreshold[stageIndex] = Math.fround(Number(child(stage, 'stageThreshold').text.trim()) - STAGE_THRESHOLD_EPS);
    const weak = child(stage, 'weakClassifiers').children;
    result.stageTreeStart[stageIndex] = tree; result.stageTreeCount[stageIndex] = weak.length;
    for (const classifier of weak) {
      const internal = numbers(child(classifier, 'internalNodes').text); const leaves = numbers(child(classifier, 'leafValues').text);
      const nodesInTree = internal.length / 4;
      if (!Number.isInteger(nodesInTree) || nodesInTree < 1 || leaves.length !== nodesInTree + 1) throw new Error('A weak classifier of the cascade is malformed.');
      result.treeNodeStart[tree] = node; result.treeLeafStart[tree] = leaf;
      for (let index = 0; index < internal.length; index += 4) {
        const left = internal[index]; const right = internal[index + 1]; const feature = internal[index + 2]; const threshold = internal[index + 3];
        // A child is either a node further down this tree (a positive number) or a leaf of it (zero or less: minus the leaf's number).
        const ownIndex = index / 4;
        for (const next of [left, right]) {
          const valid = Number.isInteger(next) && (next > 0 ? next > ownIndex && next < nodesInTree : -next < leaves.length);
          if (!valid) throw new Error('A node of the cascade points nowhere.');
        }
        if (!Number.isInteger(feature) || feature < 0 || feature >= features.length || !Number.isFinite(threshold)) throw new Error('A node of the cascade names a feature that does not exist.');
        result.nodeLeft[node] = left; result.nodeRight[node] = right; result.nodeFeature[node] = feature; result.nodeThreshold[node] = Math.fround(threshold);
        node += 1;
      }
      for (const value of leaves) {
        if (!Number.isFinite(value)) throw new Error('A leaf of the cascade is not a number.');
        result.leafValue[leaf] = Math.fround(value); leaf += 1;
      }
      tree += 1;
    }
  });

  const boxes: number[] = []; const weights: number[] = [];
  const featureRectStart = new Int32Array(features.length); const featureRectCount = new Int32Array(features.length);
  features.forEach((feature, index) => {
    if (feature.children.some((entry) => entry.name === 'tilted' && integerOf(entry) !== 0)) throw new Error('Tilted Haar features are not supported.');
    const rects = child(feature, 'rects').children;
    featureRectStart[index] = weights.length; featureRectCount[index] = rects.length;
    for (const rect of rects) {
      const [x, y, width, height, weight] = numbers(rect.text);
      const inside = x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= windowWidth && y + height <= windowHeight;
      if (!inside || !Number.isFinite(weight)) throw new Error('A feature of the cascade is malformed.');
      boxes.push(x, y, width, height); weights.push(weight);
    }
  });
  result.rectBox = Int32Array.from(boxes); result.rectWeight = Float64Array.from(weights, Math.fround);
  for (let index = 0; index < nodeCount; index += 1) {
    result.nodeRectStart[index] = featureRectStart[result.nodeFeature[index]]; result.nodeRectCount[index] = featureRectCount[result.nodeFeature[index]];
  }
  return result;
}

let bundled: Promise<HaarCascade> | undefined;
/** The frontal-face cascade that ships with the program (apps/api/assets/cascades). Read once; a failed read can be tried again. */
export function loadFaceCascade(): Promise<HaarCascade> {
  if (!bundled) {
    const loading = readFile(new URL('../assets/cascades/haarcascade_frontalface_alt2.xml', import.meta.url), 'utf8').then(parseHaarCascade);
    bundled = loading;
    loading.catch(() => { if (bundled === loading) bundled = undefined; });
  }
  return bundled;
}

// ---- looking for faces -------------------------------------------------------------------------------------------------------------

export interface DetectOptions {
  /** How much smaller the picture gets at every step (default 1.1; bigger is faster and misses more). */
  scaleFactor?: number;
  /** A face needs more than this many overlapping hits (default 4; 0 gives every hit, ungrouped). */
  minNeighbors?: number;
  /** The smallest face to look for, in pixels (default: the window of the cascade). */
  minSize?: number;
  /** The largest face to look for, in pixels (default: as big as the picture lets it be). */
  maxSize?: number;
}

/** More hits than this and the picture is noise (a chessboard, static): searching stops there, so grouping stays quick. */
const MAX_HITS = 4000;

/** Rounds to the nearest whole number and halves to the even one, as C's lrint does (and so OpenCV's cvRound). */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value); const difference = value - floor;
  if (difference < 0.5) return floor;
  if (difference > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The picture at another size, smoothly: each new pixel is mixed from the four around the spot it comes from. */
function resizeInto(source: Uint8Array, sourceWidth: number, sourceHeight: number, out: Uint8Array, width: number, height: number): void {
  const scaleX = sourceWidth / width; const scaleY = sourceHeight / height;
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(Math.max((y + 0.5) * scaleY - 0.5, 0), sourceHeight - 1); const y0 = Math.floor(fy); const y1 = Math.min(y0 + 1, sourceHeight - 1); const wy = fy - y0;
    const row0 = y0 * sourceWidth; const row1 = y1 * sourceWidth;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(Math.max((x + 0.5) * scaleX - 0.5, 0), sourceWidth - 1); const x0 = Math.floor(fx); const x1 = Math.min(x0 + 1, sourceWidth - 1); const wx = fx - x0;
      const top = source[row0 + x0] * (1 - wx) + source[row0 + x1] * wx;
      const bottom = source[row1 + x0] * (1 - wx) + source[row1 + x1] * wx;
      out[y * width + x] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
}

/** Sums of the pixels (and of their squares) over every rectangle that starts at the top left corner: one row and one column bigger than the picture. */
function integralsInto(image: Uint8Array, width: number, height: number, sum: Int32Array, squares: Float64Array): void {
  const stride = width + 1;
  sum.fill(0, 0, stride); squares.fill(0, 0, stride);
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0; let rowSquares = 0;
    const above = y * stride; const here = above + stride;
    sum[here] = 0; squares[here] = 0;
    for (let x = 0; x < width; x += 1) {
      const value = image[y * width + x];
      rowSum += value; rowSquares += value * value;
      sum[here + x + 1] = sum[above + x + 1] + rowSum;
      squares[here + x + 1] = squares[above + x + 1] + rowSquares;
    }
  }
}

/** Where the four corners of every rectangle of every feature are, relative to the top left of a window, in an integral image of this width. */
function cornerOffsets(cascade: HaarCascade, stride: number): Int32Array {
  const count = cascade.rectWeight.length; const offsets = new Int32Array(count * 4);
  for (let rect = 0; rect < count; rect += 1) {
    const x = cascade.rectBox[rect * 4]; const y = cascade.rectBox[rect * 4 + 1]; const w = cascade.rectBox[rect * 4 + 2]; const h = cascade.rectBox[rect * 4 + 3];
    offsets[rect * 4] = y * stride + x; offsets[rect * 4 + 1] = y * stride + x + w; offsets[rect * 4 + 2] = (y + h) * stride + x; offsets[rect * 4 + 3] = (y + h) * stride + x + w;
  }
  return offsets;
}

/** Does the window whose top left is `base` in the integral image pass every stage? `inverseNorm` evens out the window's contrast. */
function passesAllStages(cascade: HaarCascade, offsets: Int32Array, sum: Int32Array, base: number, inverseNorm: number): boolean {
  const { stageCount, stageThreshold, stageTreeStart, stageTreeCount, treeNodeStart, treeLeafStart, nodeLeft, nodeRight, nodeThreshold, leafValue, nodeRectStart, nodeRectCount, rectWeight } = cascade;
  for (let stage = 0; stage < stageCount; stage += 1) {
    let total = 0;
    const firstTree = stageTreeStart[stage]; const endTree = firstTree + stageTreeCount[stage];
    for (let tree = firstTree; tree < endTree; tree += 1) {
      const nodeBase = treeNodeStart[tree]; let index = 0;
      do {
        const node = nodeBase + index;
        let value = 0;
        const firstRect = nodeRectStart[node]; const endRect = firstRect + nodeRectCount[node];
        for (let rect = firstRect; rect < endRect; rect += 1) {
          const o = rect * 4;
          value += rectWeight[rect] * (sum[base + offsets[o + 3]] - sum[base + offsets[o + 1]] - sum[base + offsets[o + 2]] + sum[base + offsets[o]]);
        }
        index = value * inverseNorm < nodeThreshold[node] ? nodeLeft[node] : nodeRight[node];
      } while (index > 0);
      total += leafValue[treeLeafStart[tree] - index];
    }
    if (total < stageThreshold[stage]) return false;
  }
  return true;
}

/** Many overlapping hits are one face: hits of nearly the same place and size are joined, and a joined group needs more than `minNeighbors` hits. */
function groupHits(hits: Rect[], minNeighbors: number, eps = 0.2): Detection[] {
  if (minNeighbors <= 0 || hits.length === 0) return hits.map((hit) => ({ ...hit, neighbors: 1 }));
  const parent = hits.map((_, index) => index);
  const find = (start: number): number => {
    let root = start; while (parent[root] !== root) root = parent[root];
    for (let walk = start; parent[walk] !== root;) { const next = parent[walk]; parent[walk] = root; walk = next; }
    return root;
  };
  for (let i = 0; i < hits.length; i += 1) {
    const a = hits[i];
    for (let j = i + 1; j < hits.length; j += 1) {
      const b = hits[j];
      const delta = eps * (Math.min(a.width, b.width) + Math.min(a.height, b.height)) * 0.5;
      if (Math.abs(a.x - b.x) <= delta && Math.abs(a.y - b.y) <= delta && Math.abs(a.x + a.width - b.x - b.width) <= delta && Math.abs(a.y + a.height - b.y - b.height) <= delta) parent[find(i)] = find(j);
    }
  }
  const classes = new Map<number, { x: number; y: number; width: number; height: number; count: number }>();
  hits.forEach((hit, index) => {
    const root = find(index); const entry = classes.get(root) ?? { x: 0, y: 0, width: 0, height: 0, count: 0 };
    entry.x += hit.x; entry.y += hit.y; entry.width += hit.width; entry.height += hit.height; entry.count += 1; classes.set(root, entry);
  });
  // The average of a group, in float arithmetic like OpenCV's, rounded to the nearest whole pixel.
  const mean = (total: number, count: number) => roundHalfToEven(Math.fround(Math.fround(total) * Math.fround(1 / count)));
  const averaged: Detection[] = [...classes.values()].map((entry) => ({ x: mean(entry.x, entry.count), y: mean(entry.y, entry.count), width: mean(entry.width, entry.count), height: mean(entry.height, entry.count), neighbors: entry.count }));
  return averaged.filter((small, i) => {
    if (small.neighbors <= minNeighbors) return false;
    // A small group inside a bigger one that is better supported is only part of that face.
    return !averaged.some((big, j) => {
      if (i === j || big.neighbors <= minNeighbors) return false;
      const dx = roundHalfToEven(big.width * eps); const dy = roundHalfToEven(big.height * eps);
      return small.x >= big.x - dx && small.y >= big.y - dy && small.x + small.width <= big.x + big.width + dx && small.y + small.height <= big.y + big.height + dy
        && (big.neighbors > Math.max(3, small.neighbors) || small.neighbors < 3);
    });
  }).sort((a, b) => b.neighbors - a.neighbors || b.width - a.width || a.x - b.x || a.y - b.y);
}

/** Finds the faces in a grey picture (one byte per pixel, row after row), the surest first. */
export function detectFaces(cascade: HaarCascade, gray: Uint8Array, width: number, height: number, options: DetectOptions = {}): Detection[] {
  if (!(width > 0 && height > 0) || gray.length < width * height) throw new Error('The picture is smaller than its size says.');
  const scaleFactor = options.scaleFactor ?? 1.1;
  if (!(scaleFactor > 1)) throw new Error('The scale factor has to be bigger than 1.');
  const minNeighbors = options.minNeighbors ?? 4; const minSize = options.minSize ?? 0; const maxSize = options.maxSize ?? Number.POSITIVE_INFINITY;
  const { windowWidth, windowHeight } = cascade;

  // One set of buffers for every size: the picture only gets smaller.
  const resized = new Uint8Array(width * height);
  const sum = new Int32Array((width + 1) * (height + 1)); const squares = new Float64Array((width + 1) * (height + 1));
  const hits: Rect[] = [];

  // The contrast of a window is measured a pixel inside its edge.
  const innerWidth = windowWidth - 2; const innerHeight = windowHeight - 2; const innerArea = innerWidth * innerHeight;

  for (let factor = 1; hits.length < MAX_HITS; factor *= scaleFactor) {
    const faceWidth = Math.round(windowWidth * factor); const faceHeight = Math.round(windowHeight * factor);
    const scaledWidth = Math.round(width / factor); const scaledHeight = Math.round(height / factor);
    // A window may start in every column and row but the last window's worth: OpenCV does not look at the very last ones either.
    const columns = scaledWidth - windowWidth; const rows = scaledHeight - windowHeight;
    if (columns <= 0 || rows <= 0 || faceWidth > maxSize || faceHeight > maxSize) break;
    if (faceWidth < minSize || faceHeight < minSize) continue;

    let scaled = gray;
    if (factor !== 1) { resizeInto(gray, width, height, resized, scaledWidth, scaledHeight); scaled = resized; }
    integralsInto(scaled, scaledWidth, scaledHeight, sum, squares);
    const stride = scaledWidth + 1;
    const offsets = cornerOffsets(cascade, stride);
    const step = factor > 2 ? 1 : 2;
    const topLeft = stride + 1; const topRight = topLeft + innerWidth; const bottomLeft = topLeft + innerHeight * stride; const bottomRight = bottomLeft + innerWidth;

    for (let y = 0; y < rows; y += step) {
      for (let x = 0; x < columns; x += step) {
        const base = y * stride + x;
        const windowSum = sum[base + bottomRight] - sum[base + topRight] - sum[base + bottomLeft] + sum[base + topLeft];
        const windowSquares = squares[base + bottomRight] - squares[base + topRight] - squares[base + bottomLeft] + squares[base + topLeft];
        const spread = innerArea * windowSquares - windowSum * windowSum;
        if (!(spread > 0)) continue;
        const norm = Math.sqrt(spread);
        if (norm <= 10 * innerArea) continue; // a standard deviation of 10 or less is too flat to hold a face
        if (passesAllStages(cascade, offsets, sum, base, Math.fround(1 / norm))) {
          hits.push({ x: Math.round(x * factor), y: Math.round(y * factor), width: faceWidth, height: faceHeight });
        }
      }
      if (hits.length >= MAX_HITS) break;
    }
  }
  return groupHits(hits, minNeighbors);
}
