/** Caller identity: claims → caller, stable user ids, preamble, approval replies (port of test_identity.py). */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalNeeded,
  ApprovalId,
  type ApprovalPolicy,
  ClaimNames,
  DEFAULT_CLAIMS,
  type DirectoryEntry,
  displayName,
  EmailAddress,
  finish,
  firstPromptPreamble,
  humanUser,
  identityResolverFrom,
  IdentityResolver,
  InMemoryUserDirectory,
  LOCAL_USER,
  type Parsed,
  parseClaims,
  parseSettings,
  PersonName,
  PrincipalId,
  renderReply,
  type Reply,
  resolveCaller,
  type RunningAgentCoreServer,
  serviceClient,
  startAgentCoreServer,
  ThreadState,
  ToolName,
  unwrap,
  UserId,
} from "../src/index.ts";

const NS = "https://fintech.example/";

function jwt(claims: Record<string, unknown>): Record<string, string> {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { Authorization: `Bearer eyJhbGciOiJub25lIn0.${body}.sig` };
}

function errorOf<T>(result: Parsed<T>) {
  if (result.kind !== "err") throw new Error("expected an error");
  return result.error;
}

function resolver(mint = "usr_1", localUser?: null): IdentityResolver {
  return new IdentityResolver({
    names: DEFAULT_CLAIMS,
    directory: new InMemoryUserDirectory(),
    mint: () => UserId.of(mint),
    ...(localUser === null ? { localUser } : {}),
  });
}

test("email is required, names optional", () => {
  assert.equal(errorOf(parseClaims({ sub: "auth0|1" }, DEFAULT_CLAIMS)).path, `$.jwt.${NS}email`);
  const claims = unwrap(parseClaims({ sub: "auth0|1", [`${NS}email`]: "Jane.Doe@Fintech.EXAMPLE" }, DEFAULT_CLAIMS));
  assert.equal(claims.kind, "human");
  if (claims.kind !== "human") return;
  assert.equal(claims.email, "Jane.Doe@fintech.example"); // domain lower-cased
  assert.equal(claims.givenName, null);
  assert.equal(claims.userId, null);
});

test("standard claims are fallbacks and names are cleaned", () => {
  const claims = unwrap(
    parseClaims({ sub: "auth0|1", email: "j@x.io", given_name: "  Jane   Ann ", family_name: "Doe" }, DEFAULT_CLAIMS),
  );
  assert.equal(claims.kind === "human" && claims.givenName, "Jane Ann");
  // The namespaced claim wins over the standard one; empty values count as absent.
  const both = unwrap(parseClaims({ sub: "auth0|1", email: "std@x.io", [`${NS}email`]: "ns@x.io", given_name: "" }, DEFAULT_CLAIMS));
  assert.equal(both.kind === "human" && both.email, "ns@x.io");
  assert.equal(both.kind === "human" && both.givenName, null);
  assert.equal(errorOf(parseClaims({ sub: "auth0|1", email: "j@x.io", given_name: "<script>" }, DEFAULT_CLAIMS)).path, "$.jwt.given_name");
  assert.equal(errorOf(parseClaims({ sub: "auth0|1", email: "not-an-email" }, DEFAULT_CLAIMS)).path, "$.jwt.email");
  assert.equal(errorOf(parseClaims({ sub: "auth0|1", email: "j@x.io", [`${NS}user_id`]: "-bad" }, DEFAULT_CLAIMS)).path, `$.jwt.${NS}user_id`);
  assert.equal(errorOf(parseClaims({ email: "j@x.io" }, DEFAULT_CLAIMS)).path, "$.jwt.sub");
  assert.equal(errorOf(parseClaims([], DEFAULT_CLAIMS)).path, "$.jwt");
});

test("value types enforce their invariants", () => {
  assert.throws(() => UserId.of("-x"));
  assert.throws(() => EmailAddress.of("a b@x.io"));
  assert.throws(() => PersonName.of("a{b}"));
  assert.equal(errorOf(EmailAddress.parse("a@b@x.io", "$.e")).path, "$.e");
  assert.equal(unwrap(EmailAddress.parse(" a@X.IO ", "$.e")), "a@x.io");
  assert.equal(errorOf(PersonName.parse("x".repeat(101), "$.n")).detail, "must be at most 100 characters");
});

test("service clients have no profile", () => {
  const claims = unwrap(parseClaims({ sub: "abc@clients", gty: "client-credentials" }, DEFAULT_CLAIMS));
  const [caller, update] = resolveCaller(claims, null, UserId.of("usr_new"));
  assert.deepEqual(caller, serviceClient(PrincipalId.of("abc@clients")));
  assert.equal(update, null);
  // gty alone marks a service, even without the @clients suffix.
  assert.equal(unwrap(parseClaims({ sub: "m2m", gty: "client-credentials" }, DEFAULT_CLAIMS)).kind, "service");
  assert.equal(displayName(caller), "service abc@clients");
});

test("user id precedence: claim, then known, then minted", () => {
  const base = { sub: "auth0|1", [`${NS}email`]: "j@x.io" };
  const minted = UserId.of("usr_minted");
  const [caller, update] = resolveCaller(unwrap(parseClaims(base, DEFAULT_CLAIMS)), null, minted);
  assert.equal(caller.kind === "human" && caller.userId, minted);
  assert.notEqual(update, null);
  const [caller2] = resolveCaller(unwrap(parseClaims(base, DEFAULT_CLAIMS)), update, UserId.of("usr_other"));
  assert.equal(caller2.kind === "human" && caller2.userId, minted); // remembered
  const claimed = { ...base, [`${NS}user_id`]: "emp-42" };
  const [caller3] = resolveCaller(unwrap(parseClaims(claimed, DEFAULT_CLAIMS)), update, UserId.of("usr_other"));
  assert.equal(caller3.kind === "human" && caller3.userId, "emp-42"); // IdP-assigned wins
});

test("email and name change keep the user id", async () => {
  const r = resolver("usr_1");
  const first = unwrap(await r.resolve(jwt({ sub: "auth0|1", [`${NS}email`]: "old@x.io", [`${NS}given_name`]: "Jane" })));
  const later = unwrap(
    await r.resolve(
      jwt({ sub: "auth0|1", [`${NS}email`]: "new@x.io", [`${NS}given_name`]: "Janet", [`${NS}family_name`]: "Roe" }),
    ),
  );
  assert.ok(first.kind === "human" && later.kind === "human");
  assert.equal(first.userId, "usr_1");
  assert.equal(later.userId, "usr_1");
  assert.equal(later.email, "new@x.io");
  assert.equal(displayName(later), "Janet Roe");
});

test("an unchanged known entry means no write", async () => {
  const entry: DirectoryEntry = {
    subject: PrincipalId.of("auth0|1"),
    userId: UserId.of("usr_1"),
    email: EmailAddress.of("j@x.io"),
    givenName: null,
    familyName: null,
  };
  const [, update] = resolveCaller(unwrap(parseClaims({ sub: "auth0|1", email: "j@x.io" }, DEFAULT_CLAIMS)), entry, UserId.of("x1"));
  assert.equal(update, null);

  let writes = 0;
  const directory = new InMemoryUserDirectory();
  const counting = { get: (s: PrincipalId) => directory.get(s), put: async (e: DirectoryEntry) => void (writes += 1, await directory.put(e)) };
  const r = new IdentityResolver({ names: DEFAULT_CLAIMS, directory: counting, mint: () => UserId.of("usr_1") });
  await r.resolve(jwt({ sub: "auth0|1", email: "j@x.io" }));
  await r.resolve(jwt({ sub: "auth0|1", email: "j@x.io" }));
  assert.equal(writes, 1);
});

test("local development user and strict mode", async () => {
  assert.deepEqual(unwrap(await resolver().resolve({})), LOCAL_USER);
  assert.equal(errorOf(await resolver("usr_1", null).resolve({})).path, "$.headers.authorization");
  assert.equal(errorOf(await identityResolverFrom(DEFAULT_CLAIMS, { REQUIRE_TOKEN: "true" }).resolve({})).path, "$.headers.authorization");
  assert.deepEqual(unwrap(await identityResolverFrom(DEFAULT_CLAIMS, {}).resolve({})), LOCAL_USER);
  assert.equal(errorOf(await resolver().resolve({ authorization: "Bearer nope" })).path, "$.headers.authorization");
});

test("the preamble uses the first name only", () => {
  assert.equal(firstPromptPreamble(LOCAL_USER), "[Context: you are assisting Local.]");
  assert.equal(firstPromptPreamble(serviceClient(PrincipalId.of("abc@clients"))), null);
  const noName = humanUser({ ...LOCAL_USER, givenName: null });
  assert.equal(firstPromptPreamble(noName), null);
});

test("the approval reply shows the requester to approvers", () => {
  const policy: ApprovalPolicy = { selfApproval: false, approvers: new Set([PrincipalId.of("lead")]) };
  const requester = humanUser({
    userId: UserId.of("usr_1"),
    subject: PrincipalId.of("auth0|1"),
    email: EmailAddress.of("jane@x.io"),
    givenName: PersonName.of("Jane"),
    familyName: null,
  });
  const [, reply] = finish(
    ThreadState.initial(),
    approvalNeeded(ApprovalId.of("ap"), ToolName.of("create_ticket"), "x"),
    requester.subject,
    policy,
    requester,
  );
  assert.equal(reply.kind, "approval_requested");
  assert.deepEqual(renderReply(reply)["requester"], { kind: "user", user_id: "usr_1", name: "Jane", email: "jane@x.io" });
  const service: Reply = { ...(reply as Extract<Reply, { kind: "approval_requested" }>), requester: serviceClient(PrincipalId.of("abc@clients")) };
  assert.deepEqual(renderReply(service)["requester"], { kind: "service", client: "abc@clients" });
  // Without a requester (the default), the field is absent.
  const [, anonymous] = finish(ThreadState.initial(), approvalNeeded(ApprovalId.of("ap"), ToolName.of("t"), "x"), requester.subject, policy);
  assert.equal("requester" in renderReply(anonymous), false);
});

test("settings: [identity].claim_namespace", () => {
  assert.deepEqual(unwrap(ClaimNames.parse({})), DEFAULT_CLAIMS);
  assert.deepEqual(unwrap(ClaimNames.parse({ claim_namespace: "https://acme.example/" })).email, "https://acme.example/email");
  assert.equal(errorOf(ClaimNames.parse({ claim_namespace: "acme/" })).path, "$.identity.claim_namespace");
  assert.deepEqual(unwrap(ClaimNames.parse({ claim_namespace: "" })).email, "email");
  const doc = {
    agent: { name: "demo" },
    model: { id: "global.anthropic.claude-sonnet-4-6", region: "eu-west-1", price: { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0, cache_write_per_mtok: 0 } },
    limits: { max_turns: 1, max_total_tokens: 1, max_usd: "1", max_wall_seconds: 1, max_tool_calls: 1, repeat_threshold: 3 },
    tools: { allowed: [] },
  };
  assert.deepEqual(unwrap(parseSettings(doc, {}, "p")).identity, DEFAULT_CLAIMS);
  const custom = unwrap(parseSettings({ ...doc, identity: { claim_namespace: "https://acme.example/" } }, {}, "p"));
  assert.equal(custom.identity.userId, "https://acme.example/user_id");
  assert.equal(errorOf(parseSettings({ ...doc, identity: { claim_namespace: 3 } }, {}, "p")).path, "$.identity.claim_namespace");
});

test("the AgentCore server resolves the caller: sender = subject, missing email → invalid_request", async () => {
  const seen: unknown[] = [];
  const server: RunningAgentCoreServer = await startAgentCoreServer({
    host: "127.0.0.1",
    port: 0,
    identity: new IdentityResolver({
      names: ClaimNames.namespaced("https://acme.example/"),
      directory: new InMemoryUserDirectory(),
      mint: () => UserId.of("usr_minted"),
    }),
    handler: async (_session, incoming, context): Promise<Reply> => {
      seen.push([incoming.sender, context.caller]);
      return { kind: "answer", texts: ["ok"] };
    },
  });
  const invoke = async (headers: Record<string, string>) =>
    (await fetch(`${server.url}/invocations`, { method: "POST", headers, body: JSON.stringify({ prompt: "hi" }) })).json();
  try {
    assert.deepEqual(await invoke(jwt({ sub: "auth0|9", "https://acme.example/email": "nine@x.io" })), {
      status: "completed",
      answers: ["ok"],
    });
    assert.deepEqual(seen.at(-1), [
      "auth0|9",
      humanUser({
        userId: UserId.of("usr_minted"),
        subject: PrincipalId.of("auth0|9"),
        email: EmailAddress.of("nine@x.io"),
        givenName: null,
        familyName: null,
      }),
    ]);
    assert.deepEqual(await invoke(jwt({ sub: "auth0|9" })), {
      status: "invalid_request",
      path: "$.jwt.https://acme.example/email",
      error: "is required for human users (add it in the Auth0 Action)",
    });
    assert.equal(seen.length, 1);
  } finally {
    await server.close();
  }
});
