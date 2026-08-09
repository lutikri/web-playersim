export interface StartupTimingEntry {
  label: string;
  durationMs: number;
  startedAtMs: number;
}

export interface StartupTimingSnapshot {
  totalMs: number;
  stages: StartupTimingEntry[];
  resources: Array<{
    category: string;
    count: number;
    transferMb: number;
    totalDurationMs: number;
    slowestMs: number;
  }>;
  slowestResources: Array<{
    file: string;
    durationMs: number;
    transferKb: number;
  }>;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function resourceCategory(entry: PerformanceResourceTiming): string {
  const path = new URL(entry.name, window.location.href).pathname.toLowerCase();
  if (path.endsWith('.glb')) return '3D models';
  if (/\.(ktx2|png|jpe?g|webp)$/.test(path)) return 'Textures';
  if (/\.(ogg|mp3|wav|flac)$/.test(path)) return 'Audio';
  if (path.endsWith('.wasm')) return 'WASM';
  if (/\.(js|css)$/.test(path)) return 'Code';
  return 'Other';
}

export class StartupTimings {
  private readonly startedAt = 0;
  private readonly stages: StartupTimingEntry[] = [];
  private finishedAt: number | null = null;

  start(label: string): () => void {
    const startedAt = performance.now();
    return () => this.record(label, performance.now() - startedAt, startedAt - this.startedAt);
  }

  record(label: string, durationMs: number, startedAtMs = performance.now() - this.startedAt - durationMs): void {
    this.stages.push({ label, durationMs: round(durationMs), startedAtMs: round(startedAtMs) });
  }

  finish(): StartupTimingSnapshot {
    this.finishedAt ??= performance.now();
    const snapshot = this.snapshot();
    console.groupCollapsed(`[Loading timings] ready in ${snapshot.totalMs} ms`);
    console.table(snapshot.stages.map(({ label, durationMs, startedAtMs }) => ({
      stage: label,
      durationMs,
      startedAtMs,
    })));
    console.table(snapshot.resources);
    console.table(snapshot.slowestResources);
    console.info('[Loading timings] Run kernwerk.loading() to print this report again.');
    console.groupEnd();
    return snapshot;
  }

  report(): StartupTimingSnapshot {
    const snapshot = this.snapshot();
    console.group(`[Loading timings] ${snapshot.totalMs} ms`);
    console.table(snapshot.stages);
    console.table(snapshot.resources);
    console.table(snapshot.slowestResources);
    console.groupEnd();
    return snapshot;
  }

  snapshot(): StartupTimingSnapshot {
    const resourceEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const relevant = resourceEntries.filter((entry) => resourceCategory(entry) !== 'Other');
    const grouped = new Map<string, PerformanceResourceTiming[]>();
    relevant.forEach((entry) => {
      const category = resourceCategory(entry);
      grouped.set(category, [...(grouped.get(category) ?? []), entry]);
    });
    const resources = [...grouped].map(([category, entries]) => ({
      category,
      count: entries.length,
      transferMb: round(entries.reduce((sum, entry) => sum + entry.transferSize, 0) / 1_048_576, 2),
      totalDurationMs: round(entries.reduce((sum, entry) => sum + entry.duration, 0)),
      slowestMs: round(Math.max(...entries.map((entry) => entry.duration))),
    }));
    const slowestResources = [...relevant]
      .sort((left, right) => right.duration - left.duration)
      .slice(0, 12)
      .map((entry) => ({
        file: new URL(entry.name, window.location.href).pathname.split('/').pop() ?? entry.name,
        durationMs: round(entry.duration),
        transferKb: round(entry.transferSize / 1024),
      }));
    return {
      totalMs: round((this.finishedAt ?? performance.now()) - this.startedAt),
      stages: [...this.stages].sort((left, right) => left.startedAtMs - right.startedAtMs),
      resources,
      slowestResources,
    };
  }
}
