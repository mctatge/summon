# Teach Summon in Chrome

This prototype connects one existing Chrome/Chromium tab to Summon. A spoken or
typed "watch me" / "no, like this" starts a short demonstration; Summon records
the page controls you type into and click, infers a reusable procedure, and can
run the procedure with another named input. It does not record the desktop or
keys typed in other apps.

## Connect

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked**, and select this `integrations/browser-teaching` folder.
2. In Summon's teaching panel, start the browser connection and copy its
   connection details. Keep Summon running.
3. Open the page you want to teach. Click the Summon extension icon, paste the
   copied connection, and choose **Connect this tab**. The extension shows `ON`.
4. Tell Summon what you want to do and say **watch me** or **no, like this**.
   When the extension shows `REC`, perform the example. Say **done teaching**
   or use Summon's finish control. Then ask it to repeat with a different input.

You can also expand the popup's connection details and enter the port/token
separately. Pairing is held in Chrome session storage, never in page content.
Navigation, reload, a closed tab, or closing Summon ends the connection. Reconnect
the page using the extension icon when needed. Clicking **Disconnect tab** also
discards an active recording.

## Scope and limits

- Chrome grants page access only through the explicit extension click. There is
  no `<all_urls>`, browsing-history, debugger, or desktop permission.
- Local traffic uses a random bearer token, is bound to `127.0.0.1`, and accepts
  only the paired extension origin. Every command belongs to one tab/document
  session. Expired or stale commands cannot be reused after reconnecting.
- Recording captures trusted human input/change/click events in the top-level
  document for up to five minutes and 23 usable steps. Reaching the cap fails
  visibly instead of silently learning an incomplete demonstration.
- Password, email, phone, payment, credential, file, and editable-document fields
  are excluded. This prototype refuses submit/send/purchase/delete/sign-in
  controls and navigation away from the connected route.
- Replay resolves a fresh, unique named control for each step; unnamed fields can
  reuse an exact ID captured in the demonstration. It never evaluates
  model-generated JavaScript or CSS selector expressions. Ambiguous, hidden, disabled, or
  missing controls stop execution. Standard text fields, buttons, custom
  image-labelled tiles, and native select controls are supported; iframe/shadow
  DOM controls and synthetic keyboard procedures are not yet supported.
- Before/after page text and control labels provide verification evidence, not
  a guarantee of success. Summon decides whether the requested result appeared.
- The extension sends page evidence only to local Summon. Summon supplies the
  bounded demonstration to the selected installed reasoning CLI under its own
  login, as described in the app's teaching UI.

MV3 stays connected through bounded 20-second HTTP long polls and extension API
activity. A content-free heartbeat from the explicitly connected document wakes
the worker after sleep. No persistent background page or additional alarm/offscreen
permissions are required. A connection that stops responding expires in Summon.

## Local smoke fixture

Serve this folder with a local HTTP server and open `fixture.html` in the test
browser. It has a map search, brawler search, Najia/Jessie buttons, a result label,
and deliberate ambiguous/sensitive controls. The fixture does not contact any
remote service. Demonstrate choosing Najia, finish, and request Jessie. The
"Selected brawler" label must change to Jessie; a typed search alone is not a
completed selection. Enable duplicate Jessie buttons to check ambiguity handling.

Transport regression tests live in `tests/browser-teaching-bridge.test.mjs` and
run against real temporary loopback ports.
