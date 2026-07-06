// Closed-loop agent controller.
//
// Implements the self-referential recursion of docs/7_AGI/17_AgentLoop.md (Layer F)
// as a concrete control layer over the model/action loop:
//
//   - F.4  self-critique C: c_{t+1} = c_pred + c_cons + c_nov, scalarised to cBar.
//   - F.-1.3 closure condition D_c R != 0: the critique is injected into the NEXT
//            input condition (the directive), so it is a control term, not a readout.
//   - F.-1.4 contraction metric rhoHat_t = cBar_t / cBar_{t-1}: detects whether the
//            loop is converging or thrashing (repeating a failing action).
//   - F.3  dual-process n_iter: the step budget stretches while the loop makes
//            progress and halts early once the critique reaches zero (converged).
//
// This module is pure (no vscode / no I/O) so it can be unit-tested directly.

export interface StepObservation {
  /** The model returned an executable clarus-actions plan this step. */
  hasActions: boolean;
  /** Canonical signature of the plan's operations (order-independent per op). */
  planSignature: string;
  /** applyFileActionPlan output text, or the thrown error text. */
  resultText: string;
  /** applyFileActionPlan threw (hard failure, not just a non-zero command exit). */
  applyError: boolean;
  /** The plan contained at least one mutating (non-read-only) operation. */
  mutated?: boolean;
}

export interface Critique {
  /** Prediction error: an action failed vs. its intended effect (F.4 c_pred). */
  cPred: number;
  /** Consistency error: this plan repeats an earlier failed plan (F.4 c_cons). */
  cCons: number;
  /** Novelty: the plan differs from everything tried so far (F.4 c_nov). */
  cNov: number;
  /** Weighted scalar critique (F.4 cBar), in [0, 1]. */
  cBar: number;
}

export interface LoopDecision {
  action: "continue" | "halt";
  /** Text injected into the next user turn — carries the critique (F.-1.3 closure). */
  directive: string;
  /** Observable recursion-quality metrics (F.-1.4). */
  metrics: { cBar: number; rhoHat: number; step: number; converged: boolean };
  reason: string;
}

// F.4 critique weights, w_p + w_c + w_n = 1. Prediction error dominates.
const W_PRED = 0.6;
const W_CONS = 0.3;
const W_NOV = 0.1;

const SOFT_STEP_BUDGET = 4; // base "WAKE shallow" budget (F.3 small n_iter)
const HARD_STEP_BUDGET = 8; // deliberation cap (F.3 large n_iter)
const MAX_FAILED_REPEATS = 2; // non-contraction tolerance before forced halt

export interface ControllerOptions {
  softBudget?: number;
  hardBudget?: number;
  maxFailedRepeats?: number;
}

export class ClosedLoopController {
  private readonly softBudget: number;
  private readonly hardBudget: number;
  private readonly maxFailedRepeats: number;

  private prevCBar = 0;
  /** Signatures of plans that failed, and how many times each has failed. */
  private readonly failedSignatures = new Map<string, number>();
  /** Every signature seen, for novelty. */
  private readonly seenSignatures = new Set<string>();

  constructor(options: ControllerOptions = {}) {
    this.softBudget = options.softBudget ?? SOFT_STEP_BUDGET;
    this.hardBudget = options.hardBudget ?? HARD_STEP_BUDGET;
    this.maxFailedRepeats = options.maxFailedRepeats ?? MAX_FAILED_REPEATS;
  }

  /** F.4: derive the critique vector and scalar from one step's observation. */
  critique(obs: StepObservation): Critique {
    const failed = obs.applyError || detectFailure(obs.resultText);
    const cPred = obs.hasActions && failed ? 1 : 0;

    const priorFailures = this.failedSignatures.get(obs.planSignature) ?? 0;
    // Consistency error: retrying a plan that already failed is self-inconsistent.
    const cCons = obs.hasActions && failed && priorFailures > 0 ? 1 : 0;

    const cNov = obs.hasActions && !this.seenSignatures.has(obs.planSignature) ? 1 : 0;

    const cBar = clamp01(W_PRED * cPred + W_CONS * cCons + W_NOV * cNov);
    return { cPred, cCons, cNov, cBar };
  }

  /**
   * Advance the loop by one observed step: update memory, compute the critique,
   * and decide whether to continue (and with what directive) or halt.
   */
  step(stepIndex: number, obs: StepObservation): LoopDecision {
    const c = this.critique(obs);
    const failed = obs.applyError || detectFailure(obs.resultText);

    // F.-1.4 contraction ratio on the critique sequence. rhoHat < 1 => converging.
    const rhoHat = c.cBar / (this.prevCBar + 1e-6);

    // Converged: the model produced a final answer with no further actions.
    if (!obs.hasActions) {
      this.prevCBar = c.cBar;
      return {
        action: "halt",
        directive: "",
        metrics: { cBar: c.cBar, rhoHat, step: stepIndex, converged: true },
        reason: "converged: no further actions"
      };
    }

    // Record memory for consistency/novelty on later steps.
    this.seenSignatures.add(obs.planSignature);
    const priorFailures = this.failedSignatures.get(obs.planSignature) ?? 0;

    if (failed) {
      const repeats = priorFailures + 1;
      this.failedSignatures.set(obs.planSignature, repeats);
      this.prevCBar = c.cBar;

      // Non-contraction: the same failing action keeps coming back. Halting here
      // is what stops the "accumulate errors, never fix" failure mode (F.-1).
      if (repeats > this.maxFailedRepeats) {
        return {
          action: "halt",
          directive: "",
          metrics: { cBar: c.cBar, rhoHat, step: stepIndex, converged: false },
          reason: `non-contraction: plan failed ${repeats}x without change`
        };
      }

      const excerpt = failureExcerpt(obs.resultText);
      const directive = repeats > 1
        ? [
            "자기비평(반복 실패 감지): 방금 시도한 것과 **동일한 작업**이 다시 실패했습니다.",
            excerpt ? `실패 근거:\n${excerpt}` : "",
            "같은 작업을 반복하지 마세요. 실패의 근본 원인을 먼저 진단하고, 구조적으로 다른 접근을 시도하세요.",
            "필요하면 파일을 먼저 읽어 현재 상태를 확인한 뒤 수정하세요."
          ].filter(Boolean).join("\n")
        : [
            "자기비평(예측오차): 방금 작업의 결과가 의도와 달랐습니다.",
            excerpt ? `실패 근거:\n${excerpt}` : "",
            "결과를 근거로 원인을 진단하고, 이번엔 다른 방식으로 수정하세요. 성공하면 clarus-actions 없이 최종 요약만 답하세요."
          ].filter(Boolean).join("\n");

      // Budget check even on failure path — do not exceed the hard cap.
      if (stepIndex + 1 >= this.hardBudget) {
        return {
          action: "halt",
          directive: "",
          metrics: { cBar: c.cBar, rhoHat, step: stepIndex, converged: false },
          reason: "hard step budget reached"
        };
      }

      return {
        action: "continue",
        directive,
        metrics: { cBar: c.cBar, rhoHat, step: stepIndex, converged: false },
        reason: repeats > 1 ? "repeated failure — escalated directive" : "prediction error — corrective directive"
      };
    }

    // Success this step. F.3: only spend "system-2" depth (beyond the soft budget)
    // while the loop keeps producing new, successful actions (making progress).
    this.prevCBar = c.cBar;
    const dynamicBudget = Math.min(this.hardBudget, this.softBudget + this.seenSignatures.size);
    if (stepIndex + 1 >= dynamicBudget) {
      return {
        action: "halt",
        directive: "",
        metrics: { cBar: c.cBar, rhoHat, step: stepIndex, converged: false },
        reason: "step budget reached (progressing)"
      };
    }

    return {
      action: "continue",
      directive: [
        "작업 결과가 반영되었습니다.",
        "추가 작업이 필요하면 이어가고, 완료되었으면 clarus-actions 없이 간결한 최종 요약만 답하세요."
      ].join("\n"),
      metrics: { cBar: c.cBar, rhoHat, step: stepIndex, converged: false },
      reason: "action applied — continuing"
    };
  }
}

/** Order-independent canonical signature of a plan's operations. */
export function planSignature(operations: Array<Record<string, unknown>>): string {
  const parts = operations.map((op) => {
    const type = String(op.type ?? "");
    if (type === "runCommand") {
      const args = Array.isArray(op.args) ? op.args.join(" ") : "";
      return `runCommand:${String(op.command ?? "")} ${args}`.trim();
    }
    if (type === "mcpTool") {
      return `mcpTool:${String(op.server ?? "")}/${String(op.tool ?? "")}`;
    }
    if (type === "subagent") {
      return `subagent:${String(op.task ?? "").slice(0, 80)}`;
    }
    if (type === "searchText") {
      return `searchText:${String(op.pattern ?? "")}`;
    }
    return `${type}:${String(op.path ?? "")}`;
  });
  parts.sort();
  return parts.join("|");
}

const FAILURE_PATTERNS: RegExp[] = [
  /\bexit\s+(?!0\b)(?:-?\d+|error|SIG[A-Z]+)\b/i, // non-zero / signal command exit
  /^error:/im,
  /(?:거부|실패|차단)되었습니다/,
  /(?:적용|실행) 실패:/,
  /\bError\b.*\b(?:ENOENT|EACCES|EEXIST)\b/,
  /npm ERR!/i,
  /\berror TS\d+/, // tsc
  /Traceback \(most recent call last\)/
];

export function detectFailure(resultText: string): boolean {
  if (!resultText) {
    return false;
  }
  return FAILURE_PATTERNS.some((pattern) => pattern.test(resultText));
}

function failureExcerpt(resultText: string, maxChars = 1200): string {
  const trimmed = resultText.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  // Keep the tail — errors usually surface at the end of command output.
  return `...\n${trimmed.slice(trimmed.length - maxChars)}`;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
