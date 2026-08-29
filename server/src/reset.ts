export const phases = ["none", "possible", "scheduled", "announced"] as const;

export type Phase = (typeof phases)[number];

export interface Classification {
  relevant: boolean;
  phase: Phase;
  expectedAt: string | null;
  summary: string;
  resetLikelihood: number;
  confidence: number;
}

export interface XPostReference {
  type: string;
  id: string;
}

export interface XPost {
  id: string;
  text: string;
  created_at?: string;
  note_tweet?: { text?: string };
  referenced_tweets?: XPostReference[];
}

export interface ResetEvent {
  phase: Exclude<Phase, "none">;
  expectedAt: Date | null;
  summary: string;
  resetLikelihood: number;
  confidence: number;
  post: XPost;
  createdAt: Date;
}

export interface PublicStatus {
  status: Phase;
  summary: string;
  expectedAt: string | null;
  tweetId: string | null;
  tweetText: string | null;
  tweetUrl: string | null;
  resetLikelihood: number;
  confidence: number | null;
  checkedAt: string | null;
}

const classificationKeys = new Set([
  "relevant",
  "phase",
  "expectedAt",
  "summary",
  "resetLikelihood",
  "confidence",
]);
const utcIsoDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && phases.includes(value as Phase);
}

function isValidUtcDate(value: string): boolean {
  const match = utcIsoDate.exec(value);
  const timestamp = Date.parse(value);
  if (!match || !Number.isFinite(timestamp)) {
    return false;
  }
  const date = new Date(timestamp);
  return Number(match[1]) === date.getUTCFullYear()
    && Number(match[2]) === date.getUTCMonth() + 1
    && Number(match[3]) === date.getUTCDate()
    && Number(match[4]) === date.getUTCHours()
    && Number(match[5]) === date.getUTCMinutes()
    && Number(match[6]) === date.getUTCSeconds();
}

export function parseClassification(value: unknown): Classification {
  if (!isRecord(value)) {
    throw new Error("Classification must be an object");
  }

  const keys = Object.keys(value);
  if (keys.length !== classificationKeys.size || keys.some((key) => !classificationKeys.has(key))) {
    throw new Error("Classification has unexpected fields");
  }

  const { relevant, phase, expectedAt, summary, resetLikelihood, confidence } = value;
  if (typeof relevant !== "boolean" || !isPhase(phase)) {
    throw new Error("Classification relevance or phase is invalid");
  }
  if (expectedAt !== null && typeof expectedAt !== "string") {
    throw new Error("Classification expectedAt is invalid");
  }
  if (typeof summary !== "string" || summary.trim().length === 0 || summary.trim().length > 160) {
    throw new Error("Classification summary is invalid");
  }
  if (!Number.isInteger(resetLikelihood) || (resetLikelihood as number) < 0 || (resetLikelihood as number) > 100) {
    throw new Error("Classification resetLikelihood is invalid");
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Classification confidence is invalid");
  }
  if (!relevant && phase !== "none") {
    throw new Error("An irrelevant classification must use phase none");
  }
  if (phase === "scheduled") {
    if (typeof expectedAt !== "string" || !isValidUtcDate(expectedAt)) {
      throw new Error("A scheduled classification needs a UTC expectedAt");
    }
  } else if (expectedAt !== null) {
    throw new Error("Only a scheduled classification can have expectedAt");
  }

  return {
    relevant,
    phase,
    expectedAt,
    summary: summary.trim(),
    resetLikelihood: resetLikelihood as number,
    confidence,
  };
}

export function postText(post: XPost): string {
  const noteText = post.note_tweet?.text?.trim();
  return noteText || post.text;
}

export function passesKeywordGate(post: XPost, references: XPost[]): boolean {
  const text = [postText(post), ...references.map(postText)].join("\n").toLowerCase();
  const signal = /\b(resets?|codex|usage|rate[ -]?limits?|quota|message caps?|celebrat(?:e|es|ed|ing|ion)|milestones?|timelines?|press(?:ed|ing)?|buttons?|gifts?|upcoming|events?|launch(?:es|ed|ing)?|bank(?:ed|ing)?|credits?|active users?|conditions?|terms?)\b/i;
  return signal.test(text);
}

export function isExpired(event: ResetEvent, now: Date): boolean {
  const start = event.phase === "scheduled" ? event.expectedAt : event.createdAt;
  if (!start) {
    return true;
  }

  const lifetimeMs = event.phase === "possible" ? 6 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  return now.getTime() >= start.getTime() + lifetimeMs;
}

function isSnowflake(value: string): boolean {
  return /^[0-9]{1,19}$/.test(value);
}

function postDate(post: XPost, fallback: Date): Date {
  if (post.created_at) {
    const timestamp = Date.parse(post.created_at);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp);
    }
  }
  return fallback;
}

export class ResetState {
  private current: ResetEvent | null = null;
  private latestProcessedId: string | null = null;
  private latestDecisionId: string | null = null;
  private lastCheckedAt: Date | null = null;
  private readonly username: string;

  constructor(username: string) {
    this.username = username.replace(/^@/, "");
  }

  get sinceId(): string | null {
    return this.latestProcessedId;
  }

  shouldProcess(postId: string): boolean {
    if (!isSnowflake(postId)) {
      return false;
    }
    return this.latestProcessedId === null || BigInt(postId) > BigInt(this.latestProcessedId);
  }

  markProcessed(postId: string): boolean {
    if (!this.shouldProcess(postId)) {
      return false;
    }
    this.latestProcessedId = postId;
    return true;
  }

  apply(post: XPost, classification: Classification, now = new Date()): boolean {
    if (!this.markProcessed(post.id)) {
      return false;
    }
    this.applyDecision(post, classification, now);
    return true;
  }

  private applyDecision(post: XPost, classification: Classification, now: Date): boolean {
    if (!classification.relevant) {
      return false;
    }
    if (this.latestDecisionId !== null && BigInt(post.id) <= BigInt(this.latestDecisionId)) {
      return false;
    }
    this.latestDecisionId = post.id;
    if (classification.phase === "none") {
      this.current = null;
      return true;
    }

    this.current = {
      phase: classification.phase,
      expectedAt: classification.expectedAt ? new Date(classification.expectedAt) : null,
      summary: classification.summary,
      resetLikelihood: classification.resetLikelihood,
      confidence: classification.confidence,
      post,
      createdAt: postDate(post, now),
    };
    return true;
  }

  markChecked(at = new Date()): void {
    this.lastCheckedAt = new Date(at);
  }

  status(now = new Date()): PublicStatus {
    if (this.current && isExpired(this.current, now)) {
      this.current = null;
    }

    if (!this.current) {
      return {
        status: "none",
        summary: "No reset expected",
        expectedAt: null,
        tweetId: null,
        tweetText: null,
        tweetUrl: null,
        resetLikelihood: 0,
        confidence: null,
        checkedAt: this.lastCheckedAt?.toISOString() ?? null,
      };
    }

    return {
      status: this.current.phase,
      summary: this.current.summary,
      expectedAt: this.current.expectedAt?.toISOString() ?? null,
      tweetId: this.current.post.id,
      tweetText: postText(this.current.post),
      tweetUrl: `https://x.com/${encodeURIComponent(this.username)}/status/${this.current.post.id}`,
      resetLikelihood: this.current.resetLikelihood,
      confidence: this.current.confidence,
      checkedAt: this.lastCheckedAt?.toISOString() ?? null,
    };
  }
}
