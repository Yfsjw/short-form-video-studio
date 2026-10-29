import { readFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';

/**
 * What the machine a program runs on is allowed to use. A container sees all the processors of the host it runs on, but may use only a share
 * of them, and it is the share that decides how fast things go: on Render's free instance one processor is shared out as 0.15 of a core.
 */
export interface MachineLimits { cpuLimit: number | null; memoryLimitBytes: number | null; cores: number; totalMemoryBytes: number; }

/**
 * How much of a processor a container may use, from the files of its control group (version 2: "cpu.max" holds "<quota> <period>" or
 * "max <period>"; version 1: the quota and the period are in two files). null when there is no limit or nothing can be read.
 */
export function cpuLimitFrom(version2?: string, version1Quota?: string, version1Period?: string): number | null {
  const parts = version2?.trim().split(/\s+/) ?? [];
  if (parts[0]) {
    if (parts[0] === 'max') return null;
    const quota = Number(parts[0]); const period = Number(parts[1] ?? 100_000);
    return quota > 0 && period > 0 ? quota / period : null;
  }
  const quota = Number(version1Quota?.trim()); const period = Number(version1Period?.trim());
  return Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0 ? quota / period : null;
}

/** The memory a container may use, in bytes: version 2 says "max" for no limit, version 1 says a number close to 2^63. */
export function memoryLimitFrom(version2?: string, version1?: string): number | null {
  for (const text of [version2, version1]) {
    const value = text?.trim();
    if (!value || value === 'max') continue;
    const bytes = Number(value);
    if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 50) return bytes;
  }
  return null;
}

export function describeMachine(limits: MachineLimits): string {
  const mebibytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;
  const processor = limits.cpuLimit === null ? `no limit on the processor share (${limits.cores} cores visible)` : `the processor share is limited to ${limits.cpuLimit.toFixed(2)} of one core (${limits.cores} cores visible)`;
  const memory = limits.memoryLimitBytes === null ? `memory ${mebibytes(limits.totalMemoryBytes)}, with no limit of its own` : `memory limited to ${mebibytes(limits.memoryLimitBytes)}`;
  return `${processor}; ${memory}`;
}

export async function readMachineLimits(): Promise<MachineLimits> {
  const read = (path: string) => readFile(path, 'utf8').catch(() => undefined);
  const [version2Cpu, version1Quota, version1Period, version2Memory, version1Memory] = await Promise.all([
    read('/sys/fs/cgroup/cpu.max'), read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'), read('/sys/fs/cgroup/memory.max'), read('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
  ]);
  return { cpuLimit: cpuLimitFrom(version2Cpu, version1Quota, version1Period), memoryLimitBytes: memoryLimitFrom(version2Memory, version1Memory), cores: availableParallelism(), totalMemoryBytes: totalmem() };
}


/**
 * How many threads a program should use on a machine that may use `limits.cpuLimit` processors. `undefined` means: leave it to the program
 * (nothing is known about a limit, which is the case of a machine that is not a container).
 *
 * Why this is not left to the programs: whisper.cpp and FFmpeg count the processors of the host, not the share of them the container may
 * use, and threads beyond the share only wait for each other while using up the share (and each needs memory of its own). Measured on the free
 * instance on 27 October 2026 (0.15 of a core): whisper.cpp with its own choice of threads took 92.6 s to listen to 11 s of speech and used
 * about 250 MB; with one thread 39.6 s and about 110 MB. FFmpeg's encoder: 14.0 s for 3 s of clip with its own choice, 11.0 s with one thread.
 * So: as many threads as the share allows, rounded to the nearest whole number, at least one, never more than the processors that are
 * visible nor `most`.
 */
export function automaticThreads(limits: Pick<MachineLimits, 'cpuLimit' | 'cores'>, most = 16): number | undefined {
  if (limits.cpuLimit === null) return undefined;
  return Math.max(1, Math.min(most, limits.cores, Math.round(limits.cpuLimit)));
}

/** The number of threads in plain words, for the log: a chosen number, or the program's own choice. */
export function describeThreads(threads: number | undefined): string {
  return threads === undefined ? "the program's own choice of threads" : `${threads} thread${threads === 1 ? '' : 's'}`;
}
