/**
 * Obscura brand kernel tests (U1) — the reactive owl, stable output formatting, and the
 * never-echo-a-secret guarantee on every output helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { owl, owlArt, banner, bootBannerLine, ok, fail, note, redactTokenLike } from "../dist/cli/index.js";

test("owl is reactive: rest, wink on connected, eyes shut on down", () => {
  assert.equal(owl("rest"), "(o,o)");
  assert.equal(owl("connected"), "(^,o)"); // the wink
  assert.equal(owl("down"), "(-,-)"); // eyes shut
});

test("owlArt and banner embed the state-driven face", () => {
  assert.ok(owlArt("connected").includes("(^,o)"));
  assert.ok(owlArt("down").includes("(-,-)"));
  const b = banner();
  assert.ok(b.includes("O B S C U R A"));
  assert.ok(b.includes("(o,o)"));
  assert.ok(bootBannerLine().includes("OBSCURA"));
});

test("ok/fail/note formatting is stable", () => {
  assert.equal(ok("gateway healthy"), "✓ gateway healthy");
  assert.equal(fail("tunnel down"), "✗ tunnel down");
  assert.equal(note("staged only"), "· staged only");
});

test("output helpers never echo a token-like string", () => {
  const token = "a".repeat(64); // 32-byte hex token shape
  for (const helper of [ok, fail, note]) {
    const line = helper(`stored ${token} in keychain`);
    assert.ok(!line.includes(token), "token must not appear in output");
    assert.ok(line.includes("[redacted]"));
  }
  const bearer = fail("add failed: Authorization: Bearer abc123XYZ.token-value");
  assert.ok(!bearer.includes("abc123XYZ"));
});

test("redactTokenLike masks hex runs and bearer phrases, leaves prose alone", () => {
  assert.equal(redactTokenLike("plain message"), "plain message");
  assert.ok(!redactTokenLike(`token=${"f".repeat(48)}`).includes("ffff"));
  // short hex (a commit sha) is NOT masked — redaction targets credential-length runs
  assert.equal(redactTokenLike("deploy 7855d4b ok"), "deploy 7855d4b ok");
});
