export const phases = ["none", "possible", "scheduled", "announced"] as const;
export const signalWindowMs = 72 * 60 * 60 * 1000;

export type Phase = (typeof phases)[number];

export interface Classification {
  relevant: boolean;
  phase: Phase;
  expectedAt: string | null;
  estimatedWindowStart: string | null;
  estimatedWindowEnd: string | null;
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
  estimatedWindowStart: Date | null;
  estimatedWindowEnd: Date | null;
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
  estimatedWindowStart: string | null;
  estimatedWindowEnd: string | null;
  tweetId: string | null;
  tweetText: string | null;
  tweetCreatedAt: string | null;
  tweetUrl: string | null;
  resetLikelihood: number;
  confidence: number | null;
  checkedAt: string | null;
}

const classificationKeys = new Set([
  "relevant",
  "phase",
  "expectedAt",
  "estimatedWindowStart",
  "estimatedWindowEnd",
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

  const {
    relevant,
    phase,
    expectedAt,
    estimatedWindowStart,
    estimatedWindowEnd,
    summary,
    resetLikelihood,
    confidence,
  } = value;
  if (typeof relevant !== "boolean" || !isPhase(phase)) {
    throw new Error("Classification relevance or phase is invalid");
  }
  if (expectedAt !== null && typeof expectedAt !== "string") {
    throw new Error("Classification expectedAt is invalid");
  }
  if (estimatedWindowStart !== null && typeof estimatedWindowStart !== "string"
    || estimatedWindowEnd !== null && typeof estimatedWindowEnd !== "string") {
    throw new Error("Classification estimated window is invalid");
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
  if ((estimatedWindowStart === null) !== (estimatedWindowEnd === null)) {
    throw new Error("An estimated window needs both start and end");
  }
  if (estimatedWindowStart !== null && estimatedWindowEnd !== null) {
    if (phase !== "possible") {
      throw new Error("Only a possible classification can have an estimated window");
    }
    if (!isValidUtcDate(estimatedWindowStart) || !isValidUtcDate(estimatedWindowEnd)
      || Date.parse(estimatedWindowEnd) <= Date.parse(estimatedWindowStart)) {
      throw new Error("Classification estimated window is invalid");
    }
  }

  return {
    relevant,
    phase,
    expectedAt,
    estimatedWindowStart,
    estimatedWindowEnd,
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

  const lifetimeMs = event.phase === "possible" ? signalWindowMs : 2 * 60 * 60 * 1000;
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

function parseStoredDate(value: unknown, name: string): Date | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !isValidUtcDate(value)) {
    throw new Error(`State snapshot ${name} is invalid`);
  }
  return new Date(value);
}

function parseStoredId(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !isSnowflake(value)) {
    throw new Error(`State snapshot ${name} is invalid`);
  }
  return value;
}

function parseStoredEvent(value: unknown): ResetEvent {
  if (!isRecord(value)) {
    throw new Error("State snapshot event is invalid");
  }
  const classification = parseClassification({
    relevant: true,
    phase: value.phase,
    expectedAt: value.expectedAt,
    estimatedWindowStart: value.estimatedWindowStart,
    estimatedWindowEnd: value.estimatedWindowEnd,
    summary: value.summary,
    resetLikelihood: value.resetLikelihood,
    confidence: value.confidence,
  });
  if (classification.phase === "none") {
    throw new Error("State snapshot event phase is invalid");
  }
  if (typeof value.postId !== "string" || !isSnowflake(value.postId)
    || typeof value.postText !== "string" || value.postText.trim().length === 0) {
    throw new Error("State snapshot post is invalid");
  }
  const createdAt = parseStoredDate(value.createdAt, "event createdAt");
  if (!createdAt) {
    throw new Error("State snapshot event createdAt is invalid");
  }
  return {
    phase: classification.phase,
    expectedAt: classification.expectedAt ? new Date(classification.expectedAt) : null,
    estimatedWindowStart: classification.estimatedWindowStart
      ? new Date(classification.estimatedWindowStart)
      : null,
    estimatedWindowEnd: classification.estimatedWindowEnd
      ? new Date(classification.estimatedWindowEnd)
      : null,
    summary: classification.summary,
    resetLikelihood: classification.resetLikelihood,
    confidence: classification.confidence,
    post: { id: value.postId, text: value.postText },
    createdAt,
  };
}

export class ResetState {
  private events: ResetEvent[] = [];
  private latestProcessedId: string | null = null;
  private latestDecisionId: string | null = null;
  private lastCheckedAt: Date | null = null;
  private readonly username: string;

  constructor(username: string) {
    this.username = username.replace(/^@/, "");
  }

  static fromSnapshot(username: string, value: unknown): ResetState {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events)
      || value.events.length > 1_000) {
      throw new Error("State snapshot is invalid");
    }
    const latestProcessedId = parseStoredId(value.latestProcessedId, "latestProcessedId");
    const latestDecisionId = parseStoredId(value.latestDecisionId, "latestDecisionId");
    if (latestDecisionId && (!latestProcessedId || BigInt(latestDecisionId) > BigInt(latestProcessedId))) {
      throw new Error("State snapshot IDs are invalid");
    }
    const events = value.events.map(parseStoredEvent);
    if (events.some((event) => !latestDecisionId || BigInt(event.post.id) > BigInt(latestDecisionId))) {
      throw new Error("State snapshot events are invalid");
    }

    const state = new ResetState(username);
    state.events = events;
    state.latestProcessedId = latestProcessedId;
    state.latestDecisionId = latestDecisionId;
    state.lastCheckedAt = parseStoredDate(value.lastCheckedAt, "lastCheckedAt");
    return state;
  }

  snapshot() {
    return {
      version: 1,
      events: this.events.map((event) => ({
        phase: event.phase,
        expectedAt: event.expectedAt?.toISOString() ?? null,
        estimatedWindowStart: event.estimatedWindowStart?.toISOString() ?? null,
        estimatedWindowEnd: event.estimatedWindowEnd?.toISOString() ?? null,
        summary: event.summary,
        resetLikelihood: event.resetLikelihood,
        confidence: event.confidence,
        postId: event.post.id,
        postText: postText(event.post),
        createdAt: event.createdAt.toISOString(),
      })),
      latestProcessedId: this.latestProcessedId,
      latestDecisionId: this.latestDecisionId,
      lastCheckedAt: this.lastCheckedAt?.toISOString() ?? null,
    };
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
      this.events = [];
      return true;
    }

    const event: ResetEvent = {
      phase: classification.phase,
      expectedAt: classification.expectedAt ? new Date(classification.expectedAt) : null,
      estimatedWindowStart: classification.estimatedWindowStart
        ? new Date(classification.estimatedWindowStart)
        : null,
      estimatedWindowEnd: classification.estimatedWindowEnd
        ? new Date(classification.estimatedWindowEnd)
        : null,
      summary: classification.summary,
      resetLikelihood: classification.resetLikelihood,
      confidence: classification.confidence,
      post,
      createdAt: postDate(post, now),
    };
    if (classification.phase === "scheduled" || classification.phase === "announced") {
      this.events = [event];
    } else {
      this.events.push(event);
    }
    return true;
  }

  markChecked(at = new Date()): void {
    this.lastCheckedAt = new Date(at);
  }

  status(now = new Date()): PublicStatus {
    this.events = this.events.filter((event) => !isExpired(event, now));
    const current = this.events.reduce<ResetEvent | null>(
      (strongest, event) => !strongest || event.resetLikelihood >= strongest.resetLikelihood ? event : strongest,
      null,
    );

    if (!current) {
      return {
        status: "none",
        summary: "No reset expected",
        expectedAt: null,
        estimatedWindowStart: null,
        estimatedWindowEnd: null,
        tweetId: null,
        tweetText: null,
        tweetCreatedAt: null,
        tweetUrl: null,
        resetLikelihood: 0,
        confidence: null,
        checkedAt: this.lastCheckedAt?.toISOString() ?? null,
      };
    }

    return {
      status: current.phase,
      summary: current.summary,
      expectedAt: current.expectedAt?.toISOString() ?? null,
      estimatedWindowStart: current.estimatedWindowStart?.toISOString() ?? null,
      estimatedWindowEnd: current.estimatedWindowEnd?.toISOString() ?? null,
      tweetId: current.post.id,
      tweetText: postText(current.post),
      tweetCreatedAt: current.createdAt.toISOString(),
      tweetUrl: `https://x.com/${encodeURIComponent(this.username)}/status/${current.post.id}`,
      resetLikelihood: current.resetLikelihood,
      confidence: current.confidence,
      checkedAt: this.lastCheckedAt?.toISOString() ?? null,
    };
  }
}
