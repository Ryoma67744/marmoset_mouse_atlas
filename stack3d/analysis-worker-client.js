/* Owns only temporary buffers. The 3D renderer's source arrays never transfer. */
(function (global) {
  'use strict';
  const base = document.currentScript?.src || global.location.href;
  const workerURL = new URL('analysis-worker.js', base).href;
  const abortError = () => Object.assign(new Error('集計を取り消しました'), { name: 'AbortError' });
  function create() {
    let worker = null, nextId = 0, disposed = false, disabled = false;
    const pending = new Map();
    function stop(error) {
      worker?.terminate(); worker = null;
      for (const task of pending.values()) { task.cleanup(); task.reject(error); }
      pending.clear();
    }
    function ensureWorker() {
      if (worker) return worker;
      worker = new Worker(workerURL);
      worker.onmessage = event => {
        const task = pending.get(event.data.id); if (!task) return;
        pending.delete(event.data.id); task.cleanup();
        if (event.data.error) task.reject(new Error(event.data.error)); else task.resolve(event.data.distribution);
      };
      worker.onerror = event => { event.preventDefault(); disabled = true; stop(new Error('解析処理を開始できませんでした。再読込して再試行してください。')); };
      return worker;
    }
    async function summarize(values, options = {}) {
      if (disposed || options.signal?.aborted) throw abortError();
      const maxPoints = options.maxPoints === undefined ? global.RoiDistribution.DEFAULT_MAX_POINTS : options.maxPoints;
      if (values.length < 50000 || !global.Worker || disabled) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (disposed || options.signal?.aborted) throw abortError();
        return global.RoiDistribution.summarize(values, { maxPoints });
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const onAbort = () => stop(abortError());
        const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
        try {
          const target = ensureWorker(), copy = Float64Array.from(values);
          pending.set(id, { resolve, reject, cleanup });
          options.signal?.addEventListener('abort', onAbort, { once: true });
          if (options.signal?.aborted) { onAbort(); return; }
          target.postMessage({ id, values: copy, maxPoints }, [copy.buffer]);
        } catch (error) {
          pending.delete(id); cleanup(); reject(error);
        }
      });
    }
    return { summarize, dispose() { disposed = true; stop(abortError()); } };
  }
  global.Stack3DAnalysisWorker = { create };
})(window);
