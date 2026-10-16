/** Targets from the non-functional requirements (NFR2–NFR4). */
export const TARGETS = {
  loadMs: 5000,
  p95At300WordsMs: 1500,
  ramMb: 350,
  modelMb: 70,
} as const;

export interface TargetCheck {
  name: string;
  target: string;
  measured: string;
  /** null when the value has to be read outside the page (RAM). */
  pass: boolean | null;
}

export interface BenchFigures {
  loadMs: number;
  p95At300WordsMs: number;
  modelBytes: number;
  /** Memory of this page and its workers, when the browser reports it. */
  memoryBytes: number | null;
}

const mb = (bytes: number): number => bytes / (1024 * 1024);

export function checkTargets(figures: BenchFigures): TargetCheck[] {
  return [
    {
      name: 'Model load (cold)',
      target: `≤ ${TARGETS.loadMs.toString()} ms`,
      measured: `${Math.round(figures.loadMs).toString()} ms`,
      pass: figures.loadMs <= TARGETS.loadMs,
    },
    {
      name: 'p95, 300 words',
      target: `≤ ${TARGETS.p95At300WordsMs.toString()} ms`,
      measured: `${Math.round(figures.p95At300WordsMs).toString()} ms`,
      pass: figures.p95At300WordsMs <= TARGETS.p95At300WordsMs,
    },
    {
      name: 'Model size',
      target: `≤ ${TARGETS.modelMb.toString()} MB`,
      measured: `${mb(figures.modelBytes).toFixed(1)} MB`,
      pass: mb(figures.modelBytes) <= TARGETS.modelMb,
    },
    {
      name: 'Extra RAM',
      target: `≤ ${TARGETS.ramMb.toString()} MB`,
      measured:
        figures.memoryBytes === null
          ? 'read in Chrome Task Manager'
          : `${mb(figures.memoryBytes).toFixed(0)} MB (page + workers); confirm in Task Manager`,
      pass:
        figures.memoryBytes === null
          ? null
          : mb(figures.memoryBytes) <= TARGETS.ramMb,
    },
  ];
}
