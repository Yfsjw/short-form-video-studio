import assert from 'node:assert/strict';
import { availableParallelism, totalmem } from 'node:os';
import test from 'node:test';
import { automaticThreads, cpuLimitFrom, describeMachine, describeThreads, memoryLimitFrom, readMachineLimits } from './machine.js';

const GIB = 1024 ** 3;

test('the processor share of a container is read from its control group files, in both versions, and no limit is no number', () => {
  assert.equal(cpuLimitFrom('max 100000\n'), null);
  assert.equal(cpuLimitFrom('15000 100000\n'), 0.15);
  assert.equal(cpuLimitFrom('200000 100000'), 2);
  assert.equal(cpuLimitFrom('10000'), 0.1, 'a missing period is the usual 100 ms');
  assert.equal(cpuLimitFrom(undefined, '50000\n', '100000\n'), 0.5, 'version 1 keeps the two numbers in two files');
  assert.equal(cpuLimitFrom(undefined, '-1', '100000'), null, 'and says -1 for no limit');
  for (const unreadable of [undefined, '', '  ', 'garbage', '0 100000', '-5 100000']) assert.equal(cpuLimitFrom(unreadable), null, String(unreadable));
  assert.equal(cpuLimitFrom(undefined, 'x', '100000'), null);
  assert.equal(cpuLimitFrom('max 100000', '50000', '100000'), null, 'version 2, when it is there, is the one believed');
});

test('the memory limit of a container is read the same way, and a machine is described in plain words', () => {
  assert.equal(memoryLimitFrom('536870912\n'), 536_870_912);
  assert.equal(memoryLimitFrom('max'), null);
  assert.equal(memoryLimitFrom(undefined, '9223372036854771712'), null, 'version 1 says "no limit" with a number close to 2^63');
  assert.equal(memoryLimitFrom('max', '268435456'), 268_435_456, 'version 1 is read when version 2 says nothing useful');
  for (const unreadable of [undefined, '', '0', 'garbage', '-1']) assert.equal(memoryLimitFrom(unreadable), null, String(unreadable));
  assert.equal(describeMachine({ cpuLimit: 0.15, memoryLimitBytes: 512 * 1024 * 1024, cores: 16, totalMemoryBytes: 64 * GIB }), 'the processor share is limited to 0.15 of one core (16 cores visible); memory limited to 512 MiB');
  assert.equal(describeMachine({ cpuLimit: null, memoryLimitBytes: null, cores: 4, totalMemoryBytes: 8 * GIB }), 'no limit on the processor share (4 cores visible); memory 8192 MiB, with no limit of its own');
});

test('the machine is read from the real files of this machine, and what is read is plausible', async () => {
  const limits = await readMachineLimits();
  assert.equal(limits.cores, availableParallelism());
  assert.equal(limits.totalMemoryBytes, totalmem());
  assert.ok(limits.cpuLimit === null || limits.cpuLimit > 0, `a share of a processor is a positive number or nothing, not ${limits.cpuLimit}`);
  assert.ok(limits.memoryLimitBytes === null || limits.memoryLimitBytes > 0, `a memory limit is a positive number or nothing, not ${limits.memoryLimitBytes}`);
  assert.match(describeMachine(limits), new RegExp(`^(no limit on the processor share|the processor share is limited to \\d+\\.\\d\\d of one core) \\(${availableParallelism()} cores visible\\); memory (${Math.round(totalmem() / 1024 / 1024)} MiB, with no limit of its own|limited to \\d+ MiB)$`));
});

test('the number of threads follows the share of a processor the machine may use: at least one, no more than are visible or asked for, and none chosen when nothing is known', () => {
  const on = (cpuLimit: number | null, cores = 16) => ({ cpuLimit, cores });
  assert.equal(automaticThreads(on(null)), undefined, 'a machine that is not a container: the program chooses');
  assert.equal(automaticThreads(on(0.15, 1)), 1, 'Render\'s free instance, where one thread was measured to be better than whisper.cpp\'s own choice');
  assert.equal(automaticThreads(on(0.15)), 1, 'whatever number of processors the host shows');
  for (const [share, threads] of [[0.4, 1], [0.5, 1], [1, 1], [1.4, 1], [1.5, 2], [2, 2], [3.6, 4]] as const) assert.equal(automaticThreads(on(share)), threads, `a share of ${share}`);
  assert.equal(automaticThreads(on(0, 4)), 1, 'never none');
  assert.equal(automaticThreads(on(64)), 16, 'no more than 16 unless asked');
  assert.equal(automaticThreads(on(64), 4), 4, 'whisper.cpp is asked for no more than its own limit of 4');
  assert.equal(automaticThreads(on(8, 2)), 2, 'nor more than the processors that are visible');
});

test('threads are described in plain words', () => {
  assert.equal(describeThreads(undefined), "the program's own choice of threads");
  assert.equal(describeThreads(1), '1 thread');
  assert.equal(describeThreads(4), '4 threads');
});
