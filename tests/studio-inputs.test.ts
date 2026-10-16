import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getModel } from "../src/generation/catalog";
import { MediaStrip } from "../src/openhiggsfield/media-tray";
import { Topbar } from "../src/openhiggsfield/topbar";

test("empty Face Swap inputs are accessible buttons for both target and reference", () => {
  const html = renderToStaticMarkup(createElement(MediaStrip, { model: getModel("local-reactor-faceswap"), onPick: () => {} } as any));
  assert.match(html, /<button[^>]*aria-label="Add start frame"/);
  assert.match(html, /<button[^>]*aria-label="Add reference"/);
  assert.doesNotMatch(html, /aria-hidden="true"/);
});

test("Character Swap exposes a clickable reference input", () => {
  const html = renderToStaticMarkup(createElement(MediaStrip, { model: getModel("local-character-ipadapter"), onPick: () => {} } as any));
  assert.match(html, /<button[^>]*aria-label="Add reference"/);
});

test("an owner session shows connected independently of account identity or hosted keys", () => {
  const html = renderToStaticMarkup(createElement(Topbar, {
    view: "image", onView() {}, busy: false, keyConfigured: false, local: false,
    onKeys() {}, loginUrl: "/owner", onLogin() {}, onLogout() {},
    accountLabel: "Sign in", authenticated: false, ownerConnected: true,
  } as any));
  assert.match(html, /Owner connected/);
  assert.doesNotMatch(html, /aria-label="Sign in"/);
  assert.match(html, /Add platform key/); // Owner status must NOT grant hosted spend.
});
