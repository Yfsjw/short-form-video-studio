import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { SAYS_HLG, SAYS_PQ, SDR_COLOUR_TAGS, TONE_MAPPING_FILTERS, TONE_MAPPING_MIN_MEMORY_BYTES, TONE_MAP_TO_SDR, decideToneMapping, hdrKindOf, isColourConversionFailure, probeToneMapping, saysColours, type PictureProgram } from './hdr.js';
import { listsFilter } from './toolchain.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
// On a developer machine without ffmpeg these tests are skipped; in CI they must never be skipped silently.
if (!hasFfmpeg && process.env.CI) throw new Error('ffmpeg must be installed in CI so that the conversion of HDR colours is really tried.');
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg is not installed on this machine' };

test('the kind of HDR a picture is in comes from its transfer curve: HLG is what an iPhone records, PQ is HDR10, and anything else is an ordinary picture', () => {
  assert.equal(hdrKindOf('arib-std-b67'), 'hlg');
  assert.equal(hdrKindOf('smpte2084'), 'pq');
  for (const ordinary of ['bt709', 'smpte170m', 'bt470bg', 'iec61966-2-1', 'linear', 'unknown', 'unspecified', 'N/A', '', ' arib-std-b67', 'ARIB-STD-B67', undefined]) assert.equal(hdrKindOf(ordinary), undefined, String(ordinary));
});

test('the conversion is the recipe of the FFmpeg wiki, ends as an ordinary 4:2:0 picture, and needs exactly the two filters that are asked for at start-up', () => {
  assert.equal(TONE_MAP_TO_SDR, 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
  assert.deepEqual([...TONE_MAPPING_FILTERS], ['zscale', 'tonemap']);
  for (const filter of TONE_MAPPING_FILTERS) assert.ok(TONE_MAP_TO_SDR.split(',').some((step) => step.startsWith(`${filter}=`)), `the conversion uses ${filter}`);
  assert.ok(TONE_MAP_TO_SDR.endsWith(',format=yuv420p'), 'and it ends in the pixels every phone plays');
  assert.deepEqual([...SDR_COLOUR_TAGS], ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']);
});

test('what a made-up picture says about its colours is a setparams filter with exactly what was said, and a picture that says nothing needs none', () => {
  assert.equal(saysColours({ transfer: 'arib-std-b67' }), 'setparams=color_trc=arib-std-b67');
  assert.equal(saysColours({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' }), 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');
  assert.equal(saysColours({ matrix: 'bt2020nc', range: 'tv' }), 'setparams=colorspace=bt2020nc:range=tv');
  assert.equal(SAYS_HLG, 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv');
  assert.equal(SAYS_PQ, 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv');
  assert.throws(() => saysColours({}), /says nothing about its colours/);
});

test('by default the colours of HDR video are converted where the machine has the memory for it (a GiB), or where its memory is not known; yes and no are obeyed whatever the memory', () => {
  const MiB = 1024 * 1024; const GiB = 1024 * MiB;
  assert.equal(TONE_MAPPING_MIN_MEMORY_BYTES, GiB);
  const switchedOff = { convert: false, why: 'converting its colours is switched off (CLIP_TONE_MAP_HDR)' };
  assert.deepEqual(decideToneMapping(false, 64 * GiB), switchedOff, 'switched off on a machine with plenty of memory');
  assert.deepEqual(decideToneMapping(false, null), switchedOff);
  const asked = { convert: true, why: 'converting its colours is asked for (CLIP_TONE_MAP_HDR)' };
  assert.deepEqual(decideToneMapping(true, 512 * MiB), asked, 'asked for on a machine as small as the free instance');
  assert.deepEqual(decideToneMapping(true, null), asked);
  assert.deepEqual(decideToneMapping('auto', 512 * MiB), { convert: false, why: 'converting its colours is left off on this machine, which has 512 MiB of memory: it needs about 90 MiB more for every clip (CLIP_TONE_MAP_HDR=true converts them anyway)' });
  assert.equal(decideToneMapping('auto', GiB - 1).convert, false, 'a byte short of a GiB is too little');
  assert.equal(decideToneMapping('auto', 0).convert, false);
  assert.deepEqual(decideToneMapping('auto', GiB), { convert: true, why: 'this machine has 1024 MiB of memory, enough for converting its colours' }, 'a GiB is enough');
  assert.deepEqual(decideToneMapping('auto', 2 * GiB), { convert: true, why: 'this machine has 2048 MiB of memory, enough for converting its colours' });
  assert.deepEqual(decideToneMapping('auto', null), { convert: true, why: 'nothing says that this machine has too little memory for converting its colours' }, 'a machine whose memory is not known is not taken for a small one');
});

test('a failure of the conversion is told from other failures by what the program printed, never by the command line it was started with', () => {
  for (const printed of [
    '[Parsed_zscale_0 @ 0x55d] code 3074: no path between colorspaces', '[Parsed_tonemap_3 @ 0x55d] Unsupported input format', 'Error while filtering: Generic error in an external library — colorspace',
    'No such filter: \'zscale\'', 'the Colourspace is not known',
  ]) assert.equal(isColourConversionFailure(printed), true, printed);
  for (const printed of ['No space left on device', 'Conversion failed!', 'Invalid data found when processing input', 'Error opening output file', '']) assert.equal(isColourConversionFailure(printed), false, printed);
  // What is not text is no evidence: an error object carries the whole command line, which names the filters whatever went wrong.
  for (const notText of [undefined, null, 3, new Error('Command failed: ffmpeg -vf zscale=t=linear tonemap colorspace'), { stderr: 'zscale' }, Buffer.from('zscale')]) assert.equal(isColourConversionFailure(notText), false, String(notText));
});

test('trying the conversion on a made-up HLG picture says whether it works, and what is wrong when it does not, without ever throwing', async () => {
  const size = 64 * 36 * 3 / 2;
  const calls: Array<{ binary: string; args: string[]; timeout: number }> = [];
  const answering = (answer: () => Buffer): PictureProgram => async (binary, args, options) => { calls.push({ binary, args, timeout: options.timeout }); return answer(); };

  const works = await probeToneMapping('/the/ffmpeg', { run: answering(() => Buffer.alloc(size)) });
  assert.equal(works.works, true);
  assert.match(works.detail, /^a test HLG picture was converted in \d+ ms$/);
  assert.equal(calls[0].binary, '/the/ffmpeg');
  const args = calls[0].args;
  assert.ok(args.includes('-nostdin'));
  const source = args[args.indexOf('-i') + 1];
  assert.match(source, /^color=.*s=64x36/, 'a picture of its own, from no file');
  assert.match(source, /format=yuv420p10le/, 'of ten bits per colour');
  assert.doesNotMatch(source, /setparams|color_trc/, 'it does not say what colours it has where it is made: FFmpeg 5.1 loses that on its way to the conversion');
  assert.equal(args[args.indexOf('-vf') + 1], `${SAYS_HLG},${TONE_MAP_TO_SDR}`, 'it says what colours it has (what a phone says) in the graph that converts it, through the very conversion the clips use');
  assert.match(SAYS_HLG, /^setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc/, 'BT.2020 colours, the HLG curve');
  assert.deepEqual(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2), ['-frames:v', '1']);
  assert.deepEqual(args.slice(-5), ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], 'and is looked at as 8-bit pixels');
  assert.equal(calls[0].timeout, 60_000);
  await probeToneMapping('/the/ffmpeg', { run: answering(() => Buffer.alloc(size)), timeoutMs: 5_000 });
  assert.equal(calls[1].timeout, 5_000);

  const short = await probeToneMapping('ffmpeg', { run: answering(() => Buffer.alloc(size - 1)) });
  assert.deepEqual(short, { works: false, detail: `a test picture of ${size} bytes came out as ${size - 1} bytes` }, 'a picture of the wrong size is not a conversion that works');
  const nothing = await probeToneMapping('ffmpeg', { run: answering(() => Buffer.alloc(0)) });
  assert.equal(nothing.works, false);

  const failing = (failure: unknown): PictureProgram => async () => { throw failure; };
  const printed = await probeToneMapping('ffmpeg', { run: failing(Object.assign(new Error('Command failed: ffmpeg -vf zscale…'), { stderr: 'first line\nsecond line\n[Parsed_zscale_0 @ 0x1] code 3074: no path between colorspaces\nError while filtering\n' })) });
  assert.deepEqual(printed, { works: false, detail: '[Parsed_zscale_0 @ 0x1] code 3074: no path between colorspaces | Error while filtering' }, 'the last two lines it printed, which is where FFmpeg says what is wrong');
  const asBytes = await probeToneMapping('ffmpeg', { run: failing(Object.assign(new Error('x'), { stderr: Buffer.from('No such filter: \'zscale\'\n') })) });
  assert.deepEqual(asBytes, { works: false, detail: "No such filter: 'zscale'" });
  assert.deepEqual(await probeToneMapping('ffmpeg', { run: failing(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })) }), { works: false, detail: 'ffmpeg was not found' });
  assert.deepEqual(await probeToneMapping('ffmpeg', { run: failing(Object.assign(new Error('Command failed'), { killed: true })) }), { works: false, detail: 'it took too long and was stopped' });
  assert.deepEqual(await probeToneMapping('ffmpeg', { run: failing(new Error('Command failed: ffmpeg\nsomething else')) }), { works: false, detail: 'Command failed: ffmpeg' }, 'with nothing printed, the first line of the error');
  assert.deepEqual(await probeToneMapping('ffmpeg', { run: failing(Object.assign(new Error('x'), { stderr: '' })) }), { works: false, detail: 'x' });
  for (const odd of [null, undefined, 'a string was thrown', 42, {}]) {
    const verdict = await probeToneMapping('ffmpeg', { run: failing(odd) });
    assert.equal(verdict.works, false, String(odd));
    assert.equal(typeof verdict.detail, 'string');
  }
  const long = await probeToneMapping('ffmpeg', { run: failing(Object.assign(new Error('x'), { stderr: `${'a'.repeat(900)}\n${'b'.repeat(900)}` })) });
  assert.ok(long.detail.length <= 300, 'what is kept for the log is short');
});

test('on this machine\'s FFmpeg the conversion either works, and then both its filters are there, or is said not to', needsFfmpeg, async (t) => {
  const verdict = await probeToneMapping('ffmpeg');
  // What CI shows for each FFmpeg it runs with: the one of Debian 12 is the one Render has.
  t.diagnostic(`converting HDR colours with this FFmpeg: works=${verdict.works} (${verdict.detail})`);
  assert.equal(typeof verdict.works, 'boolean');
  if (verdict.works) {
    const listing = (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout;
    for (const filter of TONE_MAPPING_FILTERS) assert.ok(listsFilter(listing, filter), `a conversion that works needs ${filter}, which this FFmpeg lists`);
  }
  assert.deepEqual(await probeToneMapping('/there/is/no/ffmpeg/here'), { works: false, detail: 'ffmpeg was not found' });
  const brokenFilter = await probeToneMapping('ffmpeg', { run: async (binary, args, options) => { const bad = args.map((argument) => (argument.includes(TONE_MAP_TO_SDR) ? argument.replace(TONE_MAP_TO_SDR, 'zscale=t=no-such-curve') : argument)); return (await run(binary, bad, { ...options, encoding: 'buffer' })).stdout; } });
  assert.equal(brokenFilter.works, false, 'a conversion that FFmpeg refuses is not one that works');
  assert.ok(brokenFilter.detail.length > 0);
});
