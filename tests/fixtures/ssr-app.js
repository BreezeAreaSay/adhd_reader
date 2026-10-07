/*
 * A small React app used by the server-side-rendering e2e test. Rendered to HTML in Node by the test
 * server and hydrated in the browser (window.makeSsrApp), with a lazily loaded part in a <Suspense>
 * boundary that the browser only hydrates once its "code" arrives (lazyDelayMs).
 */
(function (root) {
  function makeSsrApp(React, lazyDelayMs) {
    const e = React.createElement;
    const LazyPart = React.lazy(
      () =>
        new Promise((resolve) => {
          const done = () => resolve({ default: () => e('p', { id: 'lazy' }, 'Lazy section hydrated later on purpose') });
          if (lazyDelayMs > 0) setTimeout(done, lazyDelayMs);
          else done();
        }),
    );
    return function App() {
      const [count, setCount] = React.useState(0);
      return e(
        'main',
        null,
        e('h1', null, 'Server rendered heading'),
        e('p', { id: 'shell' }, 'Shell paragraph rendered on the server'),
        e('button', { id: 'more', onClick: () => setCount((c) => c + 1) }, 'Clicked ', count, ' times'),
        e(React.Suspense, { fallback: e('p', null, 'Loading part') }, e(LazyPart)),
      );
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = makeSsrApp;
  else root.makeSsrApp = makeSsrApp;
})(globalThis);
