'use strict';
/**
 * TEST ONLY. A tiny stand-in for express.Router() that can dispatch a fake request through the
 * real route table (middleware chain, role guards, controllers, error handler) and return {status, body}.
 */
function Router() {
  const layers = [];
  let errorHandler = null;
  const router = {};

  const compile = (method, path, handlers) => {
    const keys = [];
    const regex = new RegExp(`^${path.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), '([^/]+)'))}/?$`);
    return { method, path, regex, keys, handlers };
  };

  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    router[m] = (path, ...handlers) => {
      layers.push(compile(m.toUpperCase(), path, handlers));
      return router;
    };
  }
  router.use = (fn) => {
    if (typeof fn === 'function' && fn.length === 4) errorHandler = fn;
    return router;
  };
  router.routes = () => layers.map((l) => `${l.method} ${l.path}`);

  router.dispatch = ({ method, url, headers = {}, body, query = {}, rawBody }) =>
    new Promise((resolve, reject) => {
      const [pathname] = url.split('?');
      const lower = {};
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
      const req = {
        method,
        url,
        params: {},
        query,
        body,
        rawBody,
        headers: lower,
        get: (n) => lower[String(n).toLowerCase()],
      };
      let done = false;
      const finish = (status, b) => {
        if (done) return;
        done = true;
        resolve({ status, body: b === undefined || b === null ? null : JSON.parse(JSON.stringify(b)) });
      };
      const res = {
        statusCode: 200,
        status(c) {
          this.statusCode = c;
          return this;
        },
        json(b) {
          finish(this.statusCode, b);
          return this;
        },
      };

      const layer = layers.find((l) => l.method === method && l.regex.test(pathname));
      if (!layer) return finish(404, null);
      const m = pathname.match(layer.regex);
      layer.keys.forEach((k, i) => {
        req.params[k] = decodeURIComponent(m[i + 1]);
      });

      const fail = (err) => {
        if (!errorHandler) return reject(err);
        try {
          errorHandler(err, req, res, () => {});
        } catch (e) {
          reject(e);
        }
      };
      let i = 0;
      const next = (err) => {
        if (err) return fail(err);
        const h = layer.handlers[i++];
        if (!h) return finish(404, null);
        try {
          const r = h(req, res, next);
          if (r && typeof r.catch === 'function') r.catch(fail);
        } catch (e) {
          fail(e);
        }
      };
      next();
    });

  return router;
}

const express = () => {
  throw new Error('fake express: app creation not supported');
};
express.Router = Router;

module.exports = { express };
