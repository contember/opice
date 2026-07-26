/**
 * React component names, via the DevTools hook.
 *
 * React looks for `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` before it renders and,
 * if one is there, hands it every commit. Installing a minimal stand-in before
 * the app's own scripts run — the same `addInitScript` trick the video cursor
 * uses — makes the rendered component tree readable without touching the app's
 * build or code.
 *
 * What this yields is component *names*, not files. React 19 dropped
 * `_debugSource` from fibers, so a fiber no longer knows where it was written;
 * anyone claiming to map a component to a file from the runtime alone is
 * guessing. Names are still worth having (they're what a person actually reads
 * on a dashboard, and a component name maps to a same-named source file by
 * convention well enough for impact analysis), so they're reported as their own
 * dimension rather than pretending to be paths.
 *
 * Cost is kept off the app's critical path two ways: the tree walk is throttled
 * to a few times a second, and only *newly seen* names cross the binding back
 * into the test process.
 */

/** Name of the Playwright binding the page calls with newly discovered components. */
export const COMPONENT_BINDING = '__opiceReportComponents'

/**
 * Injected into every document before the app boots.
 *
 * Deliberately defensive: if anything here throws, the app under test breaks —
 * so every hook method is wrapped, the walk is bounded by both a node cap and a
 * time throttle, and a real DevTools hook already on the page is left completely
 * alone (a developer debugging locally must not have their tools hijacked).
 */
export const COMPONENT_SCRIPT = `(() => {
  try {
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
    var seen = new Set();
    // Types already named, so a re-walk skips the derivation (and the memo/
    // forwardRef recursion) for every node it has seen before.
    var namedTypes = new WeakSet();
    var pending = [];
    var lastWalk = 0;
    var scheduled = false;
    // The most recent root, so a commit that lands inside the throttle window is
    // walked when the window closes rather than dropped.
    var pendingRoot = null;
    var THROTTLE_MS = 250;
    var MAX_NODES = 20000;
    // Set once the node cap has cut a walk short. Reported alongside the names,
    // because a capped walk means the component list is a SAMPLE — and the index
    // replaces a scenario's component edges wholesale, so it must not treat a
    // sample as the whole set.
    var truncated = false;
    var flush = function () {
      if (pending.length === 0 && !truncated) return;
      var batch = pending.splice(0, pending.length);
      try { window.${COMPONENT_BINDING} && window.${COMPONENT_BINDING}({ names: batch, truncated: truncated }); } catch (e) {}
    };
    var nameOf = function (type) {
      if (!type) return null;
      if (typeof type === 'string') return null;
      if (typeof type === 'function') return type.displayName || type.name || null;
      if (typeof type === 'object') {
        if (type.displayName) return type.displayName;
        // memo() / forwardRef() / lazy() wrappers keep the real component inside.
        return nameOf(type.type) || nameOf(type.render) || null;
      }
      return null;
    };
    var walk = function (fiber) {
      var count = 0;
      var node = fiber;
      // Iterative traversal — a deep tree would blow the stack, and this runs
      // inside the app's commit.
      while (node) {
        if (count >= MAX_NODES) { truncated = true; break; }
        count++;
        var type = node.elementType || node.type;
        // Only functions and objects may enter the WeakSet. React's built-ins
        // (Fragment, StrictMode, Suspense) carry a REGISTERED symbol as their
        // elementType, and WeakSet.add throws on one — which would abort this
        // traversal and leave the component set empty. They have no name to
        // collect anyway.
        var memoizable = type !== null && (typeof type === 'function' || typeof type === 'object');
        if (memoizable && !namedTypes.has(type)) {
          namedTypes.add(type);
          var name = nameOf(type);
          if (name && !seen.has(name)) { seen.add(name); pending.push(name); }
        }
        if (node.child) { node = node.child; continue; }
        while (node && !node.sibling && node !== fiber) node = node.return;
        if (!node || node === fiber) break;
        node = node.sibling;
      }
      flush();
    };
    var runWalk = function () {
      scheduled = false;
      lastWalk = Date.now();
      var root = pendingRoot;
      try { if (root && root.current) walk(root.current); } catch (e) {}
    };
    var hook = {
      renderers: new Map(),
      supportsFiber: true,
      isDisabled: false,
      checkDCE: function () {},
      inject: function (renderer) {
        var id = hook.renderers.size + 1;
        hook.renderers.set(id, renderer);
        return id;
      },
      onCommitFiberRoot: function (id, root) {
        // Never walk inside the commit: the app under test would pay a full tree
        // traversal on its own main thread, several times a second, for the whole
        // scenario. Defer to a timer so the commit costs only this bookkeeping.
        try {
          if (root) pendingRoot = root;
          if (scheduled) return;
          scheduled = true;
          // Trailing, not leading-only: a commit arriving inside the throttle
          // window still gets walked when the window closes. Dropping it would
          // permanently lose whatever the scenario's last interaction rendered.
          var wait = Math.max(0, THROTTLE_MS - (Date.now() - lastWalk));
          setTimeout(runWalk, wait);
        } catch (e) {}
      },
      onCommitFiberUnmount: function (id, fiber) {
        try {
          var name = nameOf(fiber && (fiber.elementType || fiber.type));
          if (name && !seen.has(name)) { seen.add(name); pending.push(name); flush(); }
        } catch (e) {}
      },
      onPostCommitFiberRoot: function () {},
      on: function () {},
      off: function () {},
      sub: function () { return function () {}; },
      emit: function () {},
      getFiberRoots: function () { return new Set(); },
    };
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });
    // A last sweep before the page goes away, so anything rendered after the most
    // recent walk still reaches the collector. The pagehide event alone isn't
    // enough — a scenario usually ends with the context closing, not a navigation
    // — so the collector calls this directly before it finishes.
    var finalSweep = function () {
      try {
        var root = pendingRoot;
        if (root && root.current) walk(root.current);
        flush();
      } catch (e) {}
    };
    window.__opiceFootprintSweep = finalSweep;
    window.addEventListener('pagehide', finalSweep);
  } catch (e) {}
})()`
