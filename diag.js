// Failure reporting for the demo pages. A classic script, deliberately ES5, deliberately not a
// module: it is loaded from <head> before anything else, so it is already listening when the
// module scripts are parsed and run.
//
// Why it exists: a WebGPU demo that cannot start has nowhere to say so. An uncaught throw in a
// `<script type="module">` — a missing navigator.gpu, a null adapter, a module that failed to
// parse — goes to the console and nothing else, and a phone has no console. The page just sits
// there looking loaded, which reads as "the JavaScript never ran". This turns every one of those
// into a banner on the page, with the environment details needed to tell the cases apart.
//
// The global is TWG_DIAG:
//   TWG_DIAG.fail(title, detail)   show the banner (first call wins; later ones are ignored)
//   TWG_DIAG.report()              Promise<string> of the environment report
//   TWG_DIAG.shown                 whether a banner is up

(function () {
  'use strict';

  var W = window;
  if (W.TWG_DIAG) return;

  var CHECK = 'webgpu-check.html';   // resolved against this script's own URL below
  var checkHref = (function () {
    var s = document.currentScript;
    try { return new URL('docs/' + CHECK, s ? s.src : location.href).href; } catch (e) { return ''; }
  })();

  var api = { shown: false };
  W.TWG_DIAG = api;

  // ---- the environment report ---------------------------------------------------------------
  // Everything that decides whether a WebGPU page can run, in the order you would check it by
  // hand. The adapter probe is async and best-effort: a browser without navigator.gpu never
  // reaches it, and one that hangs on requestAdapter is cut off rather than left pending.
  var lines = function (o) {
    var out = [], k;
    for (k = 0; k < o.length; k++) out.push(o[k][0] + ': ' + o[k][1]);
    return out.join('\n');
  };

  api.report = function () {
    var base = [
      ['page', location.href],
      ['userAgent', navigator.userAgent],
      ['secure context', String(W.isSecureContext)],
      ['navigator.gpu', navigator.gpu ? 'present' : 'MISSING'],
      ['viewport', W.innerWidth + '×' + W.innerHeight + ' @ dpr ' + (W.devicePixelRatio || 1)],
    ];
    if (!navigator.gpu) return Promise.resolve(lines(base));

    var timeout = new Promise(function (res) {
      setTimeout(function () { res(null); }, 4000);
    });
    var probe = Promise.resolve()
      .then(function () { return navigator.gpu.requestAdapter(); })
      .then(function (a) {
        if (!a) { base.push(['adapter', 'NULL — the browser has WebGPU but this device/driver gave no adapter']); return; }
        var info = a.info || {};
        base.push(['adapter', [info.vendor, info.architecture, info.device, info.description]
          .filter(Boolean).join(' / ') || '(no info exposed)']);
        base.push(['features', a.features ? a.features.size + ' available' : '?']);
        var L = a.limits || {};
        base.push(['maxBufferSize', String(L.maxBufferSize)]);
        base.push(['maxStorageBufferBindingSize', String(L.maxStorageBufferBindingSize)]);
        base.push(['maxComputeInvocationsPerWorkgroup', String(L.maxComputeInvocationsPerWorkgroup)]);
        base.push(['maxComputeWorkgroupStorageSize', String(L.maxComputeWorkgroupStorageSize)]);
        base.push(['maxStorageBuffersPerShaderStage', String(L.maxStorageBuffersPerShaderStage)]);
      })
      .catch(function (e) { base.push(['adapter', 'requestAdapter threw: ' + (e && e.message || e)]); });

    return Promise.race([probe, timeout]).then(function (r) {
      if (r === null) base.push(['adapter', 'requestAdapter did not answer within 4s']);
      return lines(base);
    });
  };

  // ---- the banner ---------------------------------------------------------------------------
  var CSS =
    '#twg-diag{position:fixed;left:0;right:0;top:0;z-index:2147483647;box-sizing:border-box;' +
    'max-height:80vh;overflow:auto;padding:.8rem 2.5rem .8rem 1rem;background:#2c2413;color:#f0d79a;' +
    'border-bottom:1px solid rgba(240,215,154,.4);' +
    'font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    '-webkit-text-size-adjust:100%;text-align:left}' +
    '#twg-diag b{color:#ffe9b8}' +
    '#twg-diag a{color:#9fc0ff}' +
    '#twg-diag pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:.5rem 0 0;' +
    'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d8c79c}' +
    '#twg-diag summary{cursor:pointer;margin-top:.5rem;color:#e8c983}' +
    '#twg-diag .x{position:absolute;top:.35rem;right:.5rem;background:none;border:0;' +
    'color:#f0d79a;font-size:20px;line-height:1;padding:.2rem .45rem;cursor:pointer}';

  var mount = function (node) {
    var to = document.body || document.documentElement;
    to.appendChild(node);
  };

  api.fail = function (title, detail) {
    if (api.shown) return;                     // the first failure is the interesting one
    api.shown = true;

    var run = function () {
      var style = document.createElement('style');
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);

      var box = document.createElement('div');
      box.id = 'twg-diag';
      box.setAttribute('role', 'alert');

      var close = document.createElement('button');
      close.className = 'x';
      close.setAttribute('aria-label', 'dismiss');
      close.textContent = '×';
      close.onclick = function () { box.parentNode.removeChild(box); };

      var head = document.createElement('div');
      var b = document.createElement('b');
      b.textContent = title;
      head.appendChild(b);
      if (detail) {
        head.appendChild(document.createTextNode(' '));
        head.appendChild(document.createTextNode(detail));
      }
      if (checkHref) {
        head.appendChild(document.createTextNode(' '));
        var a = document.createElement('a');
        a.href = checkHref;
        a.textContent = 'Run the WebGPU check →';
        head.appendChild(a);
      }

      var det = document.createElement('details');
      var sum = document.createElement('summary');
      sum.textContent = 'Environment details';
      var pre = document.createElement('pre');
      pre.textContent = 'collecting…';
      det.appendChild(sum);
      det.appendChild(pre);
      api.report().then(function (t) { pre.textContent = t; });

      box.appendChild(close);
      box.appendChild(head);
      box.appendChild(det);
      mount(box);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  };

  // ---- the traps ----------------------------------------------------------------------------
  // A module that fails to parse, a module that throws while evaluating, and a rejected promise
  // nobody caught all end up here. Without these three, each of them is a silent blank page.
  var describe = function (e) {
    if (!e) return 'Unknown error.';
    if (typeof e === 'string') return e;
    return (e.name ? e.name + ': ' : '') + (e.message || String(e));
  };

  W.addEventListener('error', function (ev) {
    // Resource errors (a 404 on <img>/<script src>) do not bubble as ErrorEvent with .error, but
    // they do arrive here in the capture phase; only the script-level ones matter for the banner.
    if (ev.target && ev.target !== W && ev.target.tagName) {
      var tag = ev.target.tagName;
      if (tag === 'SCRIPT' || tag === 'LINK') {
        var url = ev.target.src || ev.target.href;
        api.fail('This page could not load one of its scripts.', url
          ? 'The browser failed to fetch ' + url + '.'
          : 'A module script failed to load or parse — check that the library files under ' +
            'src/ and dist/ are being served, and as JavaScript.');
      }
      return;
    }
    api.fail('This page stopped with an error.', describe(ev.error || ev.message));
  }, true);

  W.addEventListener('unhandledrejection', function (ev) {
    api.fail('This page stopped with an error.', describe(ev.reason));
  });
})();
