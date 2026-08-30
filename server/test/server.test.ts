import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InvalidClassificationError,
  OpenRouterClassifier,
  ResetMonitor,
  XClient,
  createStatusServer,
  isSanFranciscoQuietHour,
  loadStateSnapshot,
  loadConfig,
  saveStateSnapshot,
  type TimelineItem,
} from "../src/index.js";
import {
  ResetState,
  isExpired,
  parseClassification,
  passesKeywordGate,
  type Classification,
  type ResetEvent,
  type XPost,
} from "../src/reset.js";

const baseTime = new Date("2026-08-27T18:00:00Z");

function post(id: string, text: string, createdAt = baseTime.toISOString()): XPost {
  return { id, text, created_at: createdAt };
}

function classification(
  phase: Classification["phase"],
  overrides: Partial<Classification> = {},
): Classification {
  return {
    relevant: true,
    phase,
    expectedAt: phase === "scheduled" ? "2026-08-27T19:00:00Z" : null,
    estimatedWindowStart: null,
    estimatedWindowEnd: null,
    summary: "Reset status changed",
    resetLikelihood: phase === "announced" || phase === "none" ? 0 : 80,
    confidence: 0.9,
    ...overrides,
  };
}

test("config requires only secrets and keeps public settings in code", () => {
  const config = loadConfig({
    X_BEARER_TOKEN: "x-token",
    OPENROUTER_API_KEY: "openrouter-key",
  });

  assert.equal(config.xUsername, "thsottiaux");
  assert.equal(config.openRouterModel, "openai/gpt-5.6-sol");
  assert.equal(config.pollIntervalMs, 7_200_000);
  assert.equal(config.port, 3000);
  assert.equal(config.stateFilePath, null);
  assert.equal(loadConfig({
    X_BEARER_TOKEN: "x-token",
    OPENROUTER_API_KEY: "openrouter-key",
    RENDER: "true",
  }).stateFilePath, "/var/data/tibotokens-state.json");
});

test("quiet hours follow San Francisco local time across daylight saving", () => {
  assert.equal(isSanFranciscoQuietHour(new Date("2026-08-29T07:59:00Z")), false);
  assert.equal(isSanFranciscoQuietHour(new Date("2026-08-29T08:00:00Z")), true);
  assert.equal(isSanFranciscoQuietHour(new Date("2026-08-29T13:59:00Z")), true);
  assert.equal(isSanFranciscoQuietHour(new Date("2026-08-29T14:00:00Z")), false);
  assert.equal(isSanFranciscoQuietHour(new Date("2026-01-15T09:00:00Z")), true);
  assert.equal(isSanFranciscoQuietHour(new Date("2026-01-15T15:00:00Z")), false);
});

test("strict classification parsing accepts the schema and rejects bad invariants", () => {
  const valid = parseClassification({
    relevant: true,
    phase: "scheduled",
    expectedAt: "2026-08-27T19:00:00Z",
    estimatedWindowStart: null,
    estimatedWindowEnd: null,
    summary: "Reset expected within the hour",
    resetLikelihood: 98,
    confidence: 0.94,
  });
  assert.equal(valid.phase, "scheduled");

  assert.throws(() => parseClassification({ ...valid, extra: true }), /unexpected fields/);
  assert.throws(
    () => parseClassification({ ...valid, expectedAt: null }),
    /needs a UTC expectedAt/,
  );

  const windowed = parseClassification({
    ...valid,
    phase: "possible",
    expectedAt: null,
    estimatedWindowStart: "2026-08-28T15:00:00Z",
    estimatedWindowEnd: "2026-08-28T23:00:00Z",
  });
  assert.equal(windowed.estimatedWindowStart, "2026-08-28T15:00:00Z");
  assert.throws(
    () => parseClassification({ ...windowed, estimatedWindowEnd: null }),
    /needs both start and end/,
  );
  assert.throws(
    () => parseClassification({ ...windowed, estimatedWindowEnd: "2026-08-28T14:00:00Z" }),
    /estimated window is invalid/,
  );
  assert.throws(
    () => parseClassification({ ...windowed, phase: "announced" }),
    /Only a possible classification/,
  );
  assert.throws(
    () => parseClassification({ ...valid, relevant: false }),
    /irrelevant classification/,
  );
  assert.throws(
    () => parseClassification({ ...valid, phase: "possible" }),
    /Only a scheduled classification/,
  );
  assert.throws(
    () => parseClassification({ ...valid, expectedAt: "2026-02-30T19:00:00Z" }),
    /needs a UTC expectedAt/,
  );
  assert.throws(
    () => parseClassification({ ...valid, resetLikelihood: 100.1 }),
    /resetLikelihood is invalid/,
  );
  assert.throws(
    () => parseClassification({ ...valid, resetLikelihood: 101 }),
    /resetLikelihood is invalid/,
  );
});

test("keyword gate admits reset hints and their reply or quote context", () => {
  assert.equal(passesKeywordGate(post("1", "OK"), [post("2", "Can you reset the Codex usage limit tonight?")]), true);
  assert.equal(passesKeywordGate(post("3", "Reset the router tonight"), []), true);
  assert.equal(passesKeywordGate(post("4", "A Codex milestone deserves a celebration"), []), true);
  assert.equal(passesKeywordGate(post("5", "We are changing Codex usage conditions"), []), true);
  assert.equal(passesKeywordGate(post("6", "Might press the button and put something in the bank"), []), true);
  assert.equal(passesKeywordGate(post("7", "Nice weather today"), []), false);
});

test("events expire at the specified boundaries", () => {
  const possible: ResetEvent = {
    phase: "possible",
    expectedAt: null,
    estimatedWindowStart: null,
    estimatedWindowEnd: null,
    summary: "Maybe tonight",
    resetLikelihood: 75,
    confidence: 0.8,
    post: post("10", "Codex reset may happen"),
    createdAt: baseTime,
  };
  const announced: ResetEvent = { ...possible, phase: "announced" };
  const scheduled: ResetEvent = {
    ...possible,
    phase: "scheduled",
    expectedAt: new Date("2026-08-27T19:00:00Z"),
  };

  assert.equal(isExpired(possible, new Date("2026-08-30T17:59:59.999Z")), false);
  assert.equal(isExpired(possible, new Date("2026-08-30T18:00:00Z")), true);
  assert.equal(isExpired(announced, new Date("2026-08-27T20:00:00Z")), true);
  assert.equal(isExpired(scheduled, new Date("2026-08-27T20:59:59.999Z")), false);
  assert.equal(isExpired(scheduled, new Date("2026-08-27T21:00:00Z")), true);
});

test("state moves through reset phases and a relevant none clears it", () => {
  const state = new ResetState("thsottiaux");
  state.apply(post("100", "A Codex reset might happen"), classification("possible"), baseTime);
  assert.equal(state.status(baseTime).status, "possible");
  assert.equal(state.status(baseTime).tweetCreatedAt, baseTime.toISOString());

  state.apply(post("101", "Codex reset in an hour"), classification("scheduled"), baseTime);
  assert.equal(state.status(baseTime).status, "scheduled");

  state.apply(post("102", "Codex usage reset is live"), classification("announced"), baseTime);
  assert.equal(state.status(baseTime).status, "announced");

  state.apply(
    post("103", "No Codex reset after all"),
    classification("none", { summary: "No reset expected" }),
    baseTime,
  );
  state.markChecked(baseTime);
  const status = state.status(baseTime);
  assert.equal(status.status, "none");
  assert.equal(status.tweetId, null);
  assert.equal(status.checkedAt, baseTime.toISOString());
});

test("duplicate, equal, older, and irrelevant posts do not replace current state", () => {
  const state = new ResetState("@thsottiaux");
  assert.equal(state.apply(post("200", "Maybe a Codex reset"), classification("possible"), baseTime), true);
  assert.equal(state.apply(post("200", "It is live"), classification("announced"), baseTime), false);
  assert.equal(state.apply(post("199", "It is live"), classification("announced"), baseTime), false);
  assert.equal(
    state.apply(
      post("201", "Unrelated"),
      classification("none", { relevant: false, summary: "Not relevant" }),
      baseTime,
    ),
    true,
  );
  assert.equal(state.status(baseTime).status, "possible");
});

test("state keeps the strongest possible signal and its estimate in a rolling 72-hour window", () => {
  const state = new ResetState("thsottiaux");
  state.apply(post("210", "Strong Codex reset hint"), classification("possible", {
    resetLikelihood: 80,
    estimatedWindowStart: "2026-08-28T15:00:00Z",
    estimatedWindowEnd: "2026-08-28T23:00:00Z",
  }), baseTime);
  state.apply(
    post("211", "Weak Codex reset hint", "2026-08-27T19:00:00Z"),
    classification("possible", { resetLikelihood: 30 }),
    new Date("2026-08-27T19:00:00Z"),
  );
  state.markChecked(new Date("2026-08-30T17:00:00Z"));

  const strongest = state.status(new Date("2026-08-30T17:00:00Z"));
  assert.equal(strongest.tweetId, "210");
  assert.equal(strongest.resetLikelihood, 80);
  assert.equal(strongest.estimatedWindowStart, "2026-08-28T15:00:00.000Z");
  assert.equal(strongest.estimatedWindowEnd, "2026-08-28T23:00:00.000Z");
  assert.equal(state.status(new Date("2026-08-30T18:00:00Z")).tweetId, "211");
  assert.equal(state.status(new Date("2026-08-30T19:00:00Z")).status, "none");
});

test("state survives an atomic disk snapshot and rejects corrupt state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tibotokens-state-"));
  const stateFile = join(directory, "state.json");
  try {
    const state = new ResetState("thsottiaux");
    state.apply(post("220", "Strong Codex reset hint"), classification("possible", {
      resetLikelihood: 85,
      estimatedWindowStart: "2026-08-28T15:00:00Z",
      estimatedWindowEnd: "2026-08-28T23:00:00Z",
    }), baseTime);
    state.apply(
      post("221", "Weak Codex reset hint", "2026-08-27T19:00:00Z"),
      classification("possible", { resetLikelihood: 30 }),
      new Date("2026-08-27T19:00:00Z"),
    );
    state.apply(
      post("222", "Unrelated post"),
      classification("none", { relevant: false, summary: "Not relevant" }),
      baseTime,
    );
    state.markChecked(baseTime);

    await saveStateSnapshot(stateFile, state);
    const restored = await loadStateSnapshot(stateFile, "thsottiaux");
    assert.ok(restored);
    assert.equal(restored.sinceId, "222");
    assert.equal(restored.status(baseTime).tweetId, "220");
    assert.equal(restored.status(new Date("2026-08-30T18:00:00Z")).tweetId, "221");
    assert.equal(await loadStateSnapshot(join(directory, "missing.json"), "thsottiaux"), null);

    await writeFile(stateFile, "{}\n", "utf8");
    await assert.rejects(loadStateSnapshot(stateFile, "thsottiaux"), /State snapshot is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("X client includes context, excludes reposts, and paginates since_id catch-up", async () => {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.includes("/by/username/")) {
      return new Response(JSON.stringify({ data: { id: "42", username: "thsottiaux" } }));
    }
    if (url.searchParams.has("start_time")) {
      if (!url.searchParams.has("pagination_token")) {
        return new Response(JSON.stringify({
          data: [{ id: "306", text: "Manual newest post" }],
          meta: { next_token: "manual-next-page" },
        }));
      }
      return new Response(JSON.stringify({
        data: [{ id: "305", text: "Manual older post" }],
      }));
    }
    if (!url.searchParams.has("since_id")) {
      return new Response(JSON.stringify({
        data: [
          { id: "302", text: "Later post", created_at: baseTime.toISOString() },
          {
            id: "301",
            text: "OK",
            created_at: baseTime.toISOString(),
            referenced_tweets: [{ type: "replied_to", id: "299" }],
          },
        ],
        includes: {
          tweets: [{ id: "299", text: "Can you reset Codex usage tonight?" }],
        },
      }));
    }
    if (!url.searchParams.has("pagination_token")) {
      return new Response(JSON.stringify({
        data: [{ id: "304", text: "Newest post" }],
        meta: { next_token: "next-page" },
      }));
    }
    return new Response(JSON.stringify({
      data: [{ id: "303", text: "Older unseen post" }],
    }));
  };

  const client = new XClient("secret", "thsottiaux", fetcher);
  const first = await client.fetchTimeline(null);
  assert.deepEqual(first.map((item) => item.post.id), ["301", "302"]);
  assert.equal(first[0]?.references[0]?.post.id, "299");
  assert.equal(requests[1]?.searchParams.get("exclude"), "retweets");
  assert.equal(requests[1]?.searchParams.get("since_id"), null);
  assert.match(requests[1]?.searchParams.get("expansions") ?? "", /referenced_tweets\.id/);

  const catchUp = await client.fetchTimeline("302");
  assert.deepEqual(catchUp.map((item) => item.post.id), ["303", "304"]);
  assert.equal(requests.length, 4, "user lookup should be cached and two pages fetched");
  assert.equal(requests[2]?.searchParams.get("since_id"), "302");
  assert.equal(requests[2]?.searchParams.get("max_results"), "100");
  assert.equal(requests[3]?.searchParams.get("pagination_token"), "next-page");

  const startTime = new Date("2026-08-26T18:00:00Z");
  const manual = await client.fetchTimeline(null, startTime);
  assert.deepEqual(manual.map((item) => item.post.id), ["305", "306"]);
  assert.equal(requests[4]?.searchParams.get("start_time"), startTime.toISOString());
  assert.equal(requests[4]?.searchParams.get("max_results"), "100");
  assert.equal(requests[5]?.searchParams.get("pagination_token"), "manual-next-page");
});

test("OpenRouter classifier requests strict structured output through a mocked fetch", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(typeof init?.body, "string");
    requestBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            relevant: true,
            phase: "possible",
            expectedAt: null,
            estimatedWindowStart: "2026-08-28T15:00:00Z",
            estimatedWindowEnd: "2026-08-28T23:00:00Z",
            summary: "Reset may happen tonight",
            resetLikelihood: 82,
            confidence: 0.82,
          }),
        },
      }],
    }));
  };

  const classifier = new OpenRouterClassifier("secret", "openai/gpt-5.6-sol", fetcher);
  const result = await classifier.classify(post("400", "Codex usage reset may happen tonight"), [], baseTime);
  assert.equal(result.phase, "possible");
  assert.equal(result.resetLikelihood, 82);
  assert.equal(result.estimatedWindowStart, "2026-08-28T15:00:00Z");
  assert.equal(requestBody?.max_tokens, 1_000);
  assert.equal("temperature" in (requestBody ?? {}), false);
  assert.deepEqual(requestBody?.provider, { require_parameters: true });
  assert.equal(
    (requestBody?.response_format as { json_schema?: { strict?: boolean } }).json_schema?.strict,
    true,
  );
  assert.match(JSON.stringify(requestBody?.messages), /never from observedAt/);
  assert.match(JSON.stringify(requestBody?.messages), /next 72 hours/);
  assert.match(JSON.stringify(requestBody?.messages), /already applied/);
  assert.match(JSON.stringify(requestBody?.messages), /milestones/);
  assert.match(JSON.stringify(requestBody?.messages), /America\/Los_Angeles/);
  assert.match(JSON.stringify(requestBody?.messages), /08:00 through 16:00/);
  assert.match(JSON.stringify(requestBody?.messages), /not today/);
});

test("monitor classifies a duplicate post only once", async () => {
  const item: TimelineItem = {
    post: post("500", "Codex usage limit reset might happen tonight"),
    references: [],
  };
  const seenSinceIds: Array<string | null> = [];
  const timeline = {
    async fetchTimeline(sinceId: string | null): Promise<TimelineItem[]> {
      seenSinceIds.push(sinceId);
      return [item, item];
    },
  };
  let classifierCalls = 0;
  const classifier = {
    async classify(): Promise<Classification> {
      classifierCalls += 1;
      return classification("possible");
    },
  };
  const state = new ResetState("thsottiaux");
  const monitor = new ResetMonitor(timeline, classifier, state, () => baseTime);

  await monitor.poll();
  await monitor.poll();
  assert.equal(classifierCalls, 1);
  assert.deepEqual(seenSinceIds, [null, "500"]);
  assert.equal(state.status(baseTime).status, "possible");
});

test("monitor retries a broken classification three times, then continues", async () => {
  const broken: TimelineItem = {
    post: post("600", "Codex usage limit reset might happen tonight"),
    references: [],
  };
  const valid: TimelineItem = {
    post: post("601", "Codex usage limit reset is live"),
    references: [],
  };
  const timeline = {
    async fetchTimeline(): Promise<TimelineItem[]> {
      return [broken, valid];
    },
  };
  const attempts = new Map<string, number>();
  const classifier = {
    async classify(value: XPost): Promise<Classification> {
      attempts.set(value.id, (attempts.get(value.id) ?? 0) + 1);
      if (value.id === "600") {
        throw new InvalidClassificationError("Invalid model output");
      }
      return classification("announced");
    },
  };
  const state = new ResetState("thsottiaux");
  const monitor = new ResetMonitor(timeline, classifier, state, () => baseTime);

  await assert.rejects(monitor.poll(), /Invalid model output/);
  await assert.rejects(monitor.poll(), /Invalid model output/);
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await monitor.poll();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(attempts.get("600"), 3);
  assert.equal(attempts.get("601"), 1);
  assert.equal(state.status(baseTime).status, "announced");
  assert.equal(state.sinceId, "601");
});

test("monitor never consumes a post during a classifier transport outage", async () => {
  const item: TimelineItem = {
    post: post("700", "Codex usage limit reset is live"),
    references: [],
  };
  const timeline = {
    async fetchTimeline(): Promise<TimelineItem[]> {
      return [item];
    },
  };
  let attempts = 0;
  const classifier = {
    async classify(): Promise<Classification> {
      attempts += 1;
      throw new Error("OpenRouter returned HTTP 503");
    },
  };
  const state = new ResetState("thsottiaux");
  const monitor = new ResetMonitor(timeline, classifier, state, () => baseTime);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(monitor.poll(), /HTTP 503/);
  }
  assert.equal(attempts, 4);
  assert.equal(state.sinceId, null);
  assert.equal(state.status(baseTime).status, "none");
});

test("startup catch-up scans three days, then resumes from the newest post", async () => {
  const requests: Array<{ sinceId: string | null; startTime?: Date }> = [];
  const timeline = {
    async fetchTimeline(sinceId: string | null, startTime?: Date): Promise<TimelineItem[]> {
      requests.push({ sinceId, startTime });
      if (!startTime) {
        return [];
      }
      return [
        { post: post("800", "Codex usage reset might happen tonight"), references: [] },
        { post: post("801", "Codex usage reset is live"), references: [] },
      ];
    },
  };
  const classifier = {
    async classify(value: XPost): Promise<Classification> {
      return classification(value.id === "801" ? "announced" : "possible");
    },
  };
  const state = new ResetState("thsottiaux");
  const monitor = new ResetMonitor(timeline, classifier, state, () => baseTime);
  const startTime = new Date("2026-08-24T18:00:00.000Z");

  await monitor.poll(startTime);
  await monitor.poll();

  assert.equal(state.status(baseTime).status, "announced");
  assert.equal(state.sinceId, "801");
  assert.equal(requests[0]?.sinceId, null);
  assert.equal(requests[0]?.startTime?.toISOString(), startTime.toISOString());
  assert.equal(requests[1]?.sinceId, "801");
  assert.equal(requests[1]?.startTime, undefined);
});

test("health and status endpoints return no-store JSON", async () => {
  const state = new ResetState("thsottiaux");
  const server = createStatusServer(state);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { ok: true });

    const unready = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(unready.status, 503);
    assert.deepEqual(await unready.json(), { error: "Not ready" });

    state.markChecked(baseTime);
    const status = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(status.status, 200);
    const statusBody = await status.json() as Record<string, unknown>;
    assert.equal(typeof statusBody.sleeping, "boolean");
    delete statusBody.sleeping;
    assert.deepEqual(statusBody, {
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
      checkedAt: baseTime.toISOString(),
    });

    const manualCheck = await fetch(`http://127.0.0.1:${address.port}/check?hours=24`, {
      method: "POST",
    });
    assert.equal(manualCheck.status, 404);

    const pollInterval = await fetch(`http://127.0.0.1:${address.port}/poll-interval?minutes=30`, {
      method: "POST",
    });
    assert.equal(pollInterval.status, 404);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    });
  }
});
