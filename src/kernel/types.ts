// Plain-data types shared by the kernel and everything that feeds it. The
// kernel imports nothing else, so these live here and are re-exported by the
// layers that produce them.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------------------------------------------------------------------------
// Evidence

export interface EvidenceRecord {
  source: string;
  seq: number;
  recorded_at: string | null;
  fixture_time: string | null;
  trace_id: string | null;
  ids: JsonObject;
  kind: string;
  data: JsonObject;
}

export interface SourceMarks {
  high_water_mark: number;
  complete_through: number;
}

export type SampleReading = SourceMarks | { error: string };

export interface MarkSample {
  label: string;
  marks: Record<string, SampleReading>;
}

export interface SourceEvidence {
  start_mark: number;
  records: EvidenceRecord[];
  horizon: SourceMarks | null;
  read_error: string | null;
}

export interface Horizon {
  reached: boolean;
  reason: string | null;
  fixture_time: string | null;
}

export interface RunError {
  reason: 'step_failed';
  step: string;
  detail: string;
}

export interface EvidenceSet {
  sources: Record<string, SourceEvidence>;
  // In the sequence they were taken; the horizon read is an implicit last sample.
  samples: MarkSample[];
  horizon: Horizon;
  run_error: RunError | null;
}

// ---------------------------------------------------------------------------
// Definitions (already validated and normalized by the language layer)

export type Scope = 'self' | 'trigger' | 'left' | 'right';

export type ValueExpr =
  | { kind: 'literal'; value: Json }
  | { kind: 'ref'; scope: Scope; path: string };

export type CompareOp = 'equals' | 'not_equals' | 'lt' | 'lte' | 'gt' | 'gte';

export type Condition =
  | { op: CompareOp; path: string; value: ValueExpr }
  | { op: 'in' | 'not_in'; path: string; values: ValueExpr[] }
  | { op: 'exists'; path: string; value: boolean }
  | { op: 'all_of' | 'any_of'; items: Condition[] }
  | { op: 'not'; item: Condition }
  | { op: 'any' | 'all'; path: string; item: Condition };

export type ProjectionInput = { kind: 'source'; source: string } | { kind: 'event'; event: string };

export type MapExpr = { kind: 'path'; path: string } | { kind: 'literal'; value: Json };

export type Aggregate =
  | { op: 'key' }
  | { op: 'first' | 'last'; path: string; where: Condition[] }
  | { op: 'count'; where: Condition[] }
  | { op: 'count_distinct'; path: string; where: Condition[] }
  | { op: 'sum' | 'min' | 'max'; path: string; where: Condition[] }
  | { op: 'sum_product'; paths: [string, string]; where: Condition[] }
  | { op: 'any'; where: Condition[] };

export type JoinExpr = { kind: 'ref'; side: 'left' | 'right'; path: string } | { kind: 'exists'; side: 'right' };

export interface ProjectionExample {
  name: string;
  input: JsonObject[] | Record<string, JsonObject[]>;
  output: JsonObject[];
}

interface ProjectionHeader {
  id: string;
  version: number;
  emits: string;
  examples: ProjectionExample[];
}

export interface MapProjection extends ProjectionHeader {
  shape: 'map';
  input: ProjectionInput;
  where: Condition[];
  map: [string, MapExpr][];
  keep: Condition[];
}

export interface GroupProjection extends ProjectionHeader {
  shape: 'group';
  input: ProjectionInput;
  where: Condition[];
  by: string;
  map: [string, Aggregate][];
}

export interface JoinProjection extends ProjectionHeader {
  shape: 'join';
  left: { event: string; key: string };
  right: { event: string; key: string };
  type: 'inner' | 'left';
  map: [string, JoinExpr][];
}

export type ProjectionDef = MapProjection | GroupProjection | JoinProjection;

export interface EvidenceContract {
  required: string[];
  completeness: 'required' | 'best_effort';
}

interface ExpectationHeader {
  id: string;
  version: number;
  status: 'candidate' | 'confirmed' | 'rejected' | 'deprecated';
  evidence: EvidenceContract;
}

export interface TransitionDef extends ExpectationHeader {
  kind: 'transition';
  over: string;
  entity: string;
  allowed: { from: Json; to: Json }[];
}

export interface InvariantDef extends ExpectationHeader {
  kind: 'invariant';
  over: string;
  entity: string | null;
  where: Condition[];
  assert: Condition;
}

export type ObligationWindow =
  | { kind: 'within'; ms: number; raw: string }
  | { kind: 'until'; event: string; where: Condition[] }
  | { kind: 'horizon' };

export interface ObligationClause {
  mode: 'require' | 'forbid';
  event: string;
  where: Condition[];
  count_distinct: string | null;
  comparator: { op: 'equals' | 'gte' | 'lte'; value: number } | null;
}

export interface ObligationDef extends ExpectationHeader {
  kind: 'obligation';
  when: { event: string; where: Condition[] };
  correlate_by: [string, ValueExpr][];
  clause: ObligationClause;
  window: ObligationWindow;
}

export type ExpectationDef = TransitionDef | InvariantDef | ObligationDef;

export interface Definitions {
  sources: string[];
  projections: ProjectionDef[];
  expectations: ExpectationDef[];
}

// ---------------------------------------------------------------------------
// Results

export type Verdict = 'satisfied' | 'violated' | 'pending' | 'inconclusive' | 'not_applicable';

export interface SeqRange {
  from: number;
  to: number;
}

export interface InstanceVerdict {
  locator: {
    event: string;
    seq: number;
    source: string;
    entity: { field: string; value: Json } | null;
  };
  verdict: Verdict;
  reason: string | null;
  detail: string;
  evidence_range: Record<string, SeqRange>;
}

export interface SourceStatus {
  source: string;
  reliable: boolean;
  complete: boolean;
  reason: 'stream_reset' | 'incomplete' | 'read_failed' | 'sample_failed' | null;
  high_water_mark: number | null;
  complete_through: number | null;
  // For stream_reset: the two consecutive samples where the mark went down.
  regression: { before: { label: string; high_water_mark: number }; after: { label: string; high_water_mark: number } } | null;
  detail: string;
}

export interface ExpectationVerdict {
  expectation: string;
  version: number;
  kind: ExpectationDef['kind'];
  verdict: Verdict;
  best_effort: boolean;
  reason: string | null;
  detail: string;
  instances: InstanceVerdict[];
  projections: { id: string; version: number }[];
  sources: Record<string, { high_water_mark: number | null; complete_through: number | null; reliable: boolean }>;
}

export interface CoverageClass {
  kind: 'event' | 'http';
  class: string;
  total: number;
  unexplained: number;
  example_seqs: number[];
}

export interface Evaluation {
  sources: SourceStatus[];
  verdicts: ExpectationVerdict[];
  coverage: CoverageClass[];
}
