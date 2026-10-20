/* Portable series import. Existing single-section ZIPs still use ZipIO. */
(function (global) {
  'use strict';
  async function importFile(file, options) {
    const opts = options || {}, storage = opts.storage || global.ProjectStorage;
    const outer = await global.JSZip.loadAsync(file);
    const indexFile = outer.file('series.json');
    if (!indexFile) {
      const result = await global.ZipIO.importZip(file, { storage });
      return { projects: [result.project], warnings: result.warnings, series: null };
    }
    const index = JSON.parse(await indexFile.async('string'));
    if (index.format !== 'mouse_atlas_series_v1' || index.version !== 1 ||
        !index.atlas || !index.atlas.seriesId || !Array.isArray(index.projects) ||
        !index.projects.length || index.projects.length > 1000) {
      throw new Error('系列ZIPの形式が不正です。');
    }
    const seriesId = index.atlas.seriesId;
    const existing = await storage.listProjects();
    if (existing.some(p => p.atlas && p.atlas.seriesId === seriesId)) {
      throw new Error('この系列はすでに登録されています。既存データを開いてください。未アップロードの切片は、一覧の「アップロード」から再送できます: ' + seriesId);
    }
    // An uncached cloud series is absent from IndexedDB. Check the current
    // remote inventory before staging any section, including on every retry.
    // A partial earlier upload must not become a second set of project IDs.
    const cloud = global.Cloud;
    if (cloud?.configured?.()) {
      if (!cloud.signedIn?.()) {
        throw new Error('系列の重複を確認するため、クラウドにログインしてからZIPを読み込み直してください。');
      }
      let rows;
      try {
        rows = await cloud.listProjects();
        if (!Array.isArray(rows)) throw new Error('Invalid project inventory');
      } catch (_) {
        throw new Error('クラウドの系列一覧を確認できないため、読み込みを開始していません。接続を確認して同じZIPを読み込み直してください。');
      }
      if (rows.some(row => row?.meta?.atlas?.seriesId === seriesId || row?.state?.atlas?.seriesId === seriesId)) {
        throw new Error('この系列はクラウドにすでに登録されています。一覧を再読み込みして既存データを開いてください。未アップロードの切片は、登録したPCの一覧の「アップロード」から再送できます: ' + seriesId);
      }
    }
    // Validate every nested manifest before creating any project.
    const prepared = [], numbers = new Set(), paths = new Set();
    for (const item of index.projects) {
      if (!item || typeof item.path !== 'string' || !/^[^/\\]+\.zip$/i.test(item.path) ||
          paths.has(item.path) || !Number.isSafeInteger(item.sectionNumber) ||
          item.sectionNumber < 1 || numbers.has(item.sectionNumber)) {
        throw new Error('系列内のZIPパスまたは切片番号が不正・重複しています。');
      }
      const entry = outer.file(item.path);
      if (!entry) throw new Error('切片ZIPがありません: ' + item.path);
      const bytes = await entry.async('uint8array'), zip = await global.JSZip.loadAsync(bytes);
      const manifests = [];
      for (const name of Object.keys(zip.files).filter(n => /\.json$/i.test(n) && !zip.files[n].dir)) {
        const doc = JSON.parse(await zip.file(name).async('string'));
        if (doc.format === global.ZipIO.FORMAT) manifests.push(doc);
      }
      const doc = manifests[0], atlas = doc && doc.atlas;
      if (manifests.length !== 1 || !atlas || atlas.seriesId !== seriesId ||
          atlas.sectionNumber !== item.sectionNumber ||
          atlas.species !== index.atlas.species ||
          atlas.coordinateMode !== index.atlas.coordinateMode ||
          (item.sourceCandidateId && atlas.sourceCandidateId !== item.sourceCandidateId) ||
          !doc.data || !zip.file(doc.data.path)) {
        throw new Error('系列索引と切片データが一致しません: ' + item.path);
      }
      paths.add(item.path); numbers.add(item.sectionNumber);
      prepared.push({ item, bytes });
    }
    prepared.sort((a, b) => a.item.sectionNumber - b.item.sectionNumber);
    const projects = [], warnings = [];
    try {
      for (const entry of prepared) {
        const result = await global.ZipIO.importZip(entry.bytes, { storage });
        projects.push(result.project);
        warnings.push(...result.warnings.map(w => entry.item.path + ': ' + w));
        if (opts.onProgress) opts.onProgress({ completed: projects.length, total: prepared.length });
      }
    } catch (error) {
      const retained = [];
      for (const project of projects) {
        try { await storage.deleteProject(project.id, { expectedUpdatedAt: project.updatedAt }); }
        catch (_) { retained.push(project.displayName); }
      }
      if (retained.length) error.message += '\n取り込みを戻せなかったデータ: ' + retained.join(', ');
      throw error;
    }
    return { projects, warnings, series: index.atlas };
  }
  global.AtlasSeriesImport = { importFile };
})(window);
