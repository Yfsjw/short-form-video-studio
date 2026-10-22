/**
 * Where the picture of a clip is cut from, when the video is wider than the clip (a 16:9 video becomes a 9:16 clip, so only about a third
 * of the width fits). Cutting from the middle loses the speaker whenever they stand off to one side; this follows a face instead.
 *
 * It works on what the face detector saw in pictures taken every half second (see face-track.ts) and makes no use of the sound: it follows
 * the most visible face, not the person who is talking. These are plain rules, not a model:
 *  - faces seen in nearby pictures are chained into tracks (one track is one person staying more or less in one place);
 *  - the camera follows one track at a time, the one with the biggest, surest faces; it moves to another one only when the followed
 *    face has been out of sight for `holdSeconds` (or the video itself cuts to another shot), and then it cuts: a pan across the empty
 *    space between two people looks wrong;
 *  - a camera that follows every twitch looks nervous, so it only moves once the face is off the middle by more than a dead zone,
 *    moves at a limited speed, and stays put while the face cannot be seen;
 *  - the path is reduced to a few key moments, which the renderer turns into an expression FFmpeg evaluates for every frame.
 */

/** A face seen in one picture. */
export interface FaceSighting {
  /** The middle of the face across the picture: 0 at the left edge, 1 at the right edge. */
  x: number;
  /** The width of the face as a share of the width of the picture. */
  width: number;
  /** How many overlapping hits of the detector support the face (more is surer). */
  neighbors: number;
}
/** What was seen in the picture taken `seconds` after the start of the clip. */
export interface FramingObservation {
  seconds: number; faces: FaceSighting[];
  /** The picture looks nothing like the one before it: the video cuts to another shot here, so no face carries over and the camera need not wait. */
  sceneCut?: boolean;
}
/** Where the window cut out of the picture is at a moment: 0 at the far left of the picture, 1 at the far right. */
export interface FramingKeyframe { seconds: number; position: number; }
/** The path of the window over the clip; between two key moments it moves in a straight line. One key moment means it does not move. */
export interface FramingPlan { keyframes: FramingKeyframe[]; }

export type FramingResult =
  | { followed: true; plan: FramingPlan; /** The share of the pictures in which the followed face was seen, 0 to 1. */ seenShare: number; /** Faces that were followed one after the other. */ tracksFollowed: number; /** A line for the person: what happened. */ note: string }
  | { followed: false; note: string };

export interface FramingSettings {
  /** The followed face has to be out of sight this long (seconds) before the camera looks at another face. */
  holdSeconds: number;
  /** The camera moves once the face is off the middle by more than this share of the window's width... */
  deadZone: number;
  /** ... and stops once it is back within this share of it. */
  settle: number;
  /** The fastest the camera moves, in window widths per second. */
  maxSpeed: number;
  /** Fewer than this share of the pictures with the followed face in them is too little to follow (the clip stays centred). */
  minSeenShare: number;
  /** A face seen in fewer pictures than this is taken for a mistake of the detector. */
  minSightings: number;
  /** Faces in two pictures belong to one track when they are at most `gateBase + gateSpeed * seconds apart` apart (shares of the picture's width, at most `gateMax`). */
  gateBase: number; gateSpeed: number; gateMax: number;
  /** The path may be simplified until it is this far (share of the window's travel) from the original. */
  simplifyTolerance: number;
  /** A cut takes this long (seconds): a frame or two. */
  cutSeconds: number;
}
export const defaultFramingSettings: FramingSettings = {
  holdSeconds: 1.5, deadZone: 0.12, settle: 0.03, maxSpeed: 0.7, minSeenShare: 0.15, minSightings: 2,
  gateBase: 0.08, gateSpeed: 0.15, gateMax: 0.35, simplifyTolerance: 0.002, cutSeconds: 0.04,
};

interface Sighting extends FaceSighting { index: number; seconds: number; }
interface Track { sightings: Sighting[]; byIndex: Map<number, Sighting>; last: Sighting; score: number; }

/** How much a detection is trusted, 0 to 1. */
const confidence = (face: FaceSighting) => Math.min(1, Math.max(0, face.neighbors) / 30);
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** Chains the faces of the pictures, in order, into tracks. */
function buildTracks(observations: readonly FramingObservation[], settings: FramingSettings): Track[] {
  const tracks: Track[] = [];
  let open: Track[] = []; // the tracks a face may still join: a cut in the video closes them all
  observations.forEach((observation, index) => {
    if (observation.sceneCut) open = [];
    const taken = new Set<Track>();
    // The biggest, surest faces choose first, so that a small mistake of the detector cannot take a track away from a real face.
    const faces = [...observation.faces].sort((a, b) => b.width * confidence(b) - a.width * confidence(a));
    for (const face of faces) {
      const sighting: Sighting = { ...face, index, seconds: observation.seconds };
      let best: Track | undefined; let bestDistance = Number.POSITIVE_INFINITY;
      for (const track of open) {
        if (taken.has(track)) continue;
        const gate = Math.min(settings.gateMax, settings.gateBase + settings.gateSpeed * Math.max(0, observation.seconds - track.last.seconds));
        const distance = Math.abs(face.x - track.last.x); const ratio = face.width / track.last.width;
        if (distance <= gate && ratio >= 0.5 && ratio <= 2 && distance < bestDistance) { best = track; bestDistance = distance; }
      }
      if (best) { best.sightings.push(sighting); best.byIndex.set(index, sighting); best.last = sighting; taken.add(best); }
      else { const track: Track = { sightings: [sighting], byIndex: new Map([[index, sighting]]), last: sighting, score: 0 }; tracks.push(track); open.push(track); taken.add(track); }
    }
  });
  for (const track of tracks) track.score = track.sightings.reduce((total, sighting) => total + sighting.width * confidence(sighting), 0);
  return tracks;
}

/** Drops the key moments that lie within `tolerance` of the straight line between the ones next to them (Ramer-Douglas-Peucker on position over time). */
function simplify(points: readonly FramingKeyframe[], tolerance: number): FramingKeyframe[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false); keep[0] = true; keep[points.length - 1] = true;
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length) {
    const [from, to] = pending.pop() as [number, number];
    const a = points[from]; const b = points[to];
    let worst = -1; let worstDistance = tolerance;
    for (let index = from + 1; index < to; index += 1) {
      const along = b.seconds === a.seconds ? 0 : (points[index].seconds - a.seconds) / (b.seconds - a.seconds);
      const distance = Math.abs(points[index].position - (a.position + (b.position - a.position) * along));
      if (distance > worstDistance) { worst = index; worstDistance = distance; }
    }
    if (worst >= 0) { keep[worst] = true; pending.push([from, worst], [worst, to]); }
  }
  return points.filter((_, index) => keep[index]);
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const centred = (why: string): FramingResult => ({ followed: false, note: `Centred: ${why}.` });

/**
 * Plans the camera for one clip.
 * @param observations what the detector saw in each picture, in time order (seconds from the start of the clip)
 * @param clipSeconds how long the clip is
 * @param cropShare how wide the window is, as a share of the width of the picture (the clip's shape against the video's: about 0.32 for a 9:16 clip from 16:9)
 */
export function planFraming(observations: readonly FramingObservation[], clipSeconds: number, cropShare: number, settings: FramingSettings = defaultFramingSettings): FramingResult {
  if (!(cropShare > 0) || cropShare >= 0.999) return centred('the picture is already as narrow as the clip, so there is nothing to follow');
  if (!observations.length || !(clipSeconds > 0)) return centred('there were no pictures to look for faces in');

  const tracks = buildTracks(observations, settings);
  if (!tracks.length) return centred('no face was found in this stretch of the video');
  const solid = tracks.filter((track) => track.sightings.length >= settings.minSightings);
  if (!solid.length) return centred('a face turned up too briefly to be sure it was one');

  // Which face is followed at each picture, and where the camera wants to be.
  interface Target { x: number; cut: boolean; }
  const targets: Array<Target | undefined> = [];
  let active: Track | undefined; let lastSeenSeconds = Number.NEGATIVE_INFINITY; let hadTarget = false; let seen = 0; const followed = new Set<Track>();
  observations.forEach((observation, index) => {
    if (observation.sceneCut) { active = undefined; lastSeenSeconds = Number.NEGATIVE_INFINITY; } // another shot: choose again at once
    const own = active?.byIndex.get(index);
    if (own) { lastSeenSeconds = observation.seconds; seen += 1; targets.push({ x: own.x, cut: false }); hadTarget = true; return; }
    if (!active || observation.seconds - lastSeenSeconds >= settings.holdSeconds) {
      let best: Track | undefined; let bestSighting: Sighting | undefined;
      for (const track of solid) {
        const sighting = track.byIndex.get(index);
        if (track !== active && sighting && (!best || track.score > best.score)) { best = track; bestSighting = sighting; }
      }
      if (best && bestSighting) {
        targets.push({ x: bestSighting.x, cut: hadTarget }); hadTarget = true;
        active = best; lastSeenSeconds = observation.seconds; seen += 1; followed.add(best);
        return;
      }
    }
    targets.push(undefined); // out of sight: the camera stays where it is
  });
  if (active) followed.add(active);
  const seenShare = seen / observations.length;
  if (seenShare < settings.minSeenShare) return centred(`a face was seen in only ${percent(seenShare)} of the moments checked, too little to follow`);

  // The camera. `centre` is the middle of the window, as a share of the picture's width.
  const half = cropShare / 2;
  let centre: number | undefined; let moving = false;
  const centres: Array<{ seconds: number; centre: number; cut: boolean } | undefined> = [];
  observations.forEach((observation, index) => {
    const target = targets[index]; let cut = false;
    if (target) {
      const want = clamp(target.x, half, 1 - half);
      if (centre === undefined) centre = want;
      else if (target.cut) { centre = want; moving = false; cut = true; }
      else {
        const error = want - centre;
        if (!moving && Math.abs(error) > settings.deadZone * cropShare) moving = true;
        if (moving) {
          const seconds = Math.max(0, observation.seconds - (observations[index - 1]?.seconds ?? observation.seconds));
          const longestStep = settings.maxSpeed * cropShare * seconds;
          centre += clamp(error, -longestStep, longestStep);
          if (Math.abs(want - centre) <= settings.settle * cropShare) moving = false;
        }
      }
    }
    centres.push(centre === undefined ? undefined : { seconds: observation.seconds, centre, cut });
  });

  // Before the first face is seen the window already stands where it will be; after the last, it stays.
  const firstCentre = centres.find((entry) => entry !== undefined)?.centre ?? 0.5;
  const steps = centres.map((entry, index) => ({ seconds: observations[index].seconds, centre: entry?.centre ?? firstCentre, cut: entry?.cut ?? false }));
  // Moving in bursts with sharp corners looks mechanical, so each stretch between two cuts is smoothed a little (each moment is mixed with
  // the ones next to it: 1 : 2 : 1). A window that stands still is not changed by this at all.
  const smoothed = steps.map((step) => ({ ...step }));
  let from = 0;
  for (let index = 1; index <= steps.length; index += 1) {
    if (index < steps.length && !steps[index].cut) continue;
    for (let moment = from; moment < index; moment += 1) {
      const before = steps[Math.max(from, moment - 1)].centre; const after = steps[Math.min(index - 1, moment + 1)].centre;
      smoothed[moment].centre = (before + 2 * steps[moment].centre + after) / 4;
    }
    from = index;
  }
  const toPosition = (windowCentre: number) => clamp((windowCentre - half) / (1 - cropShare), 0, 1);
  const path: FramingKeyframe[] = [];
  const push = (seconds: number, position: number) => {
    const previous = path[path.length - 1];
    if (previous && seconds <= previous.seconds) { path[path.length - 1] = { seconds: previous.seconds, position }; return; }
    path.push({ seconds, position });
  };
  if (observations[0].seconds > 0) push(0, toPosition(smoothed[0].centre));
  let previousPosition = toPosition(smoothed[0].centre);
  smoothed.forEach((step) => {
    const position = toPosition(step.centre);
    if (step.cut) push(Math.max(path[path.length - 1]?.seconds ?? 0, step.seconds - settings.cutSeconds), previousPosition);
    push(step.seconds, position);
    previousPosition = position;
  });
  const end = path[path.length - 1];
  if (end.seconds < clipSeconds) push(clipSeconds, end.position);

  let keyframes = simplify(path, settings.simplifyTolerance);
  const positions = keyframes.map((keyframe) => keyframe.position);
  if (Math.max(...positions) - Math.min(...positions) <= 0.004) keyframes = [{ seconds: 0, position: (Math.max(...positions) + Math.min(...positions)) / 2 }];
  return { followed: true, plan: { keyframes }, seenShare, tracksFollowed: followed.size, note: `Followed a face, seen in ${percent(seenShare)} of the moments checked${keyframes.length === 1 ? ' (it hardly moved, so the picture was cut once, around it)' : ''}.` };
}

// ---- for the renderer ---------------------------------------------------------------------------------------------------------------

const decimals = (value: number, places: number) => String(Number(value.toFixed(places)));

/**
 * The position of the window (0 far left ... 1 far right) as an FFmpeg expression of `t`, the time in seconds from the start of the clip:
 * the first position plus, for every stretch between two key moments, the change over it times a ramp that goes from 0 to 1 while the
 * stretch lasts. (Written as a sum rather than as nested `if`s because FFmpeg's expression parser gives up at about 100 levels.)
 */
export function positionExpression(keyframes: readonly FramingKeyframe[]): string {
  if (!keyframes.length) return '0.5';
  const first = clamp(keyframes[0].position, 0, 1);
  const terms: string[] = [];
  for (let index = 0; index + 1 < keyframes.length; index += 1) {
    const from = keyframes[index]; const to = keyframes[index + 1];
    const change = clamp(to.position, 0, 1) - clamp(from.position, 0, 1);
    if (Math.abs(change) < 0.00005) continue;
    const lasts = Math.max(to.seconds - from.seconds, 0.001);
    terms.push(`(${decimals(change, 4)})*clip((t-${decimals(from.seconds, 3)})/${decimals(lasts, 3)},0,1)`);
  }
  return [decimals(first, 4), ...terms].join('+');
}

/** The `x` of FFmpeg's `crop` filter, evaluated for every frame: how far from the left of the (already enlarged) picture the window starts. */
export function cropXExpression(keyframes: readonly FramingKeyframe[]): string {
  return `(in_w-out_w)*(${positionExpression(keyframes)})`;
}

/** The position of the window at a moment, the way the expression above works it out (for tests and for telling people where the camera was). */
export function positionAt(keyframes: readonly FramingKeyframe[], seconds: number): number {
  if (!keyframes.length) return 0.5;
  let position = clamp(keyframes[0].position, 0, 1);
  for (let index = 0; index + 1 < keyframes.length; index += 1) {
    const from = keyframes[index]; const to = keyframes[index + 1];
    const lasts = Math.max(to.seconds - from.seconds, 0.001);
    position += (clamp(to.position, 0, 1) - clamp(from.position, 0, 1)) * clamp((seconds - from.seconds) / lasts, 0, 1);
  }
  return position;
}
