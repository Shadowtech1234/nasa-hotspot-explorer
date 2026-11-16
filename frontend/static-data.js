"use strict";

const staticData = (() => {
  const useLocalSample = new URLSearchParams(window.location.search).get("data") === "local";
  const indexUrl = new URL(useLocalSample ? "./data/local/index.json" : "./data/index.json",
    window.location.href);
  const runtime = "https://pyscript.net/releases/2026.7.2/core.js";
  let workerPromise;

  async function fetchFile(url, signal, cache = "default") {
    const response = await fetch(url, {signal, cache});
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response;
  }

  function overlaps(a, b) {
    return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  }

  function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        const {PyWorker} = await import(runtime);
        const analysis = new URL("./analysis/", window.location.href);
        return await PyWorker(new URL("worker.py", analysis).href, {
          config: {
            sync_main_only: true,
            files: {
              [new URL("detail.py", analysis).href]: "detail.py",
              [new URL("normalize.py", analysis).href]: "normalize.py"
            }
          }
        });
      })().catch(error => {
        workerPromise = undefined;
        throw error;
      });
    }
    return workerPromise;
  }

  async function analyze(catalog, selection, signal, onAnalyze) {
    const {bbox, start, end_exclusive} = selection;
    const applies = item => overlaps(item.bbox, bbox)
      && item.start < end_exclusive && start < item.end_exclusive;
    const coverage = catalog.coverage.filter(applies);
    const sensors = new Map(Object.entries(catalog.sources).map(([sensor, product]) => [product, sensor]));
    const coveredSelection = coverage.map(item => ({
      product: item.product,
      bbox: [
        Math.max(bbox[0], item.bbox[0]), Math.max(bbox[1], item.bbox[1]),
        Math.min(bbox[2], item.bbox[2]), Math.min(bbox[3], item.bbox[3])
      ],
      start: start > item.start ? start : item.start,
      end: end_exclusive < item.end_exclusive ? end_exclusive : item.end_exclusive
    }));
    const matching = catalog.packets.filter(packet => coveredSelection.some(area =>
      area.product === packet.product && overlaps(area.bbox, packet.bbox)
      && packet.start < area.end && area.start < packet.end_exclusive));
    const packets = [];
    // Bound simultaneous requests and stop starting new work when the selection changes.
    for (let offset = 0; offset < matching.length; offset += 8) {
      const batch = await Promise.all(matching.slice(offset, offset + 8).map(async packet => {
        let text = null;
        try {
          text = await (await fetchFile(new URL(packet.url, indexUrl), signal)).text();
        } catch (error) {
          if (signal.aborted) throw error;
        }
        return {...packet, sensor: sensors.get(packet.product), text};
      }));
      packets.push(...batch);
    }
    signal.throwIfAborted();
    onAnalyze();
    const worker = await getWorker();
    signal.throwIfAborted();
    return JSON.parse(await worker.sync.analyze(JSON.stringify({...selection, coverage, packets})));
  }

  return {
    analyze,
    indexUrl,
    monthly: async (path, signal) =>
      (await fetchFile(new URL(path, indexUrl), signal, "no-cache")).json(),
    index: async signal => (await fetchFile(indexUrl, signal, "no-cache")).json(),
    overview: async (catalog, signal) => (await fetchFile(new URL(catalog.overview, indexUrl), signal, "no-cache")).json()
  };
})();
