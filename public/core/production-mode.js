/**
 * Production Mode Guard — Phase 20
 *
 * Runs before any other runtime script.  Detects environment and applies
 * the appropriate security posture:
 *
 *   PRODUCTION  — suppresses Phase-tagged console noise, blocks public
 *                 activation of admin-only debug APIs.
 *   DEVELOPMENT — complete no-op; full verbosity preserved.
 *
 * Exposes: window.IplvEnv  { isProd: bool, isDev: bool }
 *          window.__IPLV_IS_PROD__  (boolean, read-only in prod)
 */
(function (G) {
  'use strict';

  /* ── Environment detection ─────────────────────────────────────────────── */
  var host = G.location ? G.location.hostname : '';

  var _isDev = (
    host === 'localhost'   ||
    host === '127.0.0.1'  ||
    host === ''            ||
    /\.replit\.dev$/.test(host) ||
    /\.repl\.co$/.test(host)    ||
    G.__IPLV_DEV_MODE__  === true
  );

  if (G.__IPLV_FORCE_DEV__  === true) _isDev = true;
  if (G.__IPLV_FORCE_PROD__ === true) _isDev = false;

  var IS_PROD = !_isDev;

  /* ── Expose env flags ──────────────────────────────────────────────────── */
  try {
    Object.defineProperty(G, '__IPLV_IS_PROD__', {
      value: IS_PROD, writable: false, configurable: false,
    });
  } catch (_) { G.__IPLV_IS_PROD__ = IS_PROD; }

  G.IplvEnv = { isProd: IS_PROD, isDev: !IS_PROD };

  if (!IS_PROD) return; /* ← development: nothing more to do */

  /* ── Production: block public activation of admin-only debug APIs ──────── */
  try {
    Object.defineProperty(G, '__IPLV_ADMIN_RUNTIME__', {
      get: function () { return false; },
      set: function () {},
      configurable: false,
    });
  } catch (_) {}

  /* ── Production: silence Phase-tagged console spam ─────────────────────── */
  var PHASE_TAG = /^\[(?:DASH17|JD|AOSU|RT|KRN|FED|AI|WRK|MEM|STR|RTDB|LABA|P\d+)\]/;
  var noop      = function () {};

  /* debug / trace — always silent in production */
  console.debug    = noop;
  console.trace    = noop;
  console.group    = noop;
  console.groupEnd = noop;

  /* log / info — silent only for tagged Phase messages */
  var _origLog  = console.log;
  var _origInfo = console.info;

  console.log = function () {
    if (arguments.length && PHASE_TAG.test(String(arguments[0]))) return;
    _origLog.apply(console, arguments);
  };
  console.info = function () {
    if (arguments.length && PHASE_TAG.test(String(arguments[0]))) return;
    _origInfo.apply(console, arguments);
  };

}(window));
