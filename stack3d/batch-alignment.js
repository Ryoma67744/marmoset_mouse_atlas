/* Whole-stack alignment proposals. Preview and adoption stay in memory until
 * the explicit, revision-guarded all-or-nothing local save. */
(function (global) {
  'use strict';
  const SOURCE_FIELDS = ['displayName', 'name', 'grid', 'molecules', 'images', 'rotation', 'world_coords', 'roi', 'stack3d',
    'folderId', 'normalization', 'normalizationBinding', 'layerDisplay', 'valueDisplay'];
  const CLOUD_QUEUE_KEY = 'atlas-stack3d-batch-cloud-pending-v1';
  const fingerprint = project => JSON.stringify(SOURCE_FIELDS.map(key => project[key] ?? null));
  const samePlacement = (a, b) => ['offsetXUm', 'offsetYUm', 'rotationDeg'].every(key => a[key] === b[key]);
  const finitePlacement = value => value && ['offsetXUm', 'offsetYUm', 'rotationDeg'].every(key => Number.isFinite(value[key]));
  const format = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const clone = value => global.structuredClone ? global.structuredClone(value) : JSON.parse(JSON.stringify(value));
  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

  function create(context) {
    const $ = id => document.getElementById(id);
    let proposal = null, generation = 0, working = false, persisting = false;
    const cloudQueue = new Set();
    try {
      const pending = JSON.parse(global.sessionStorage?.getItem(CLOUD_QUEUE_KEY) || '[]');
      if (Array.isArray(pending)) for (const id of pending) if (typeof id === 'string' && id) cloudQueue.add(id);
    } catch (_) {}
    const message = text => { $('batch-message').textContent = text; };
    const cloudReady = () => !!(global.Cloud?.configured?.() && global.Cloud?.signedIn?.());
    const locked = () => working || persisting || context.isLocked();
    function saveCloudQueue() {
      try { global.sessionStorage?.setItem(CLOUD_QUEUE_KEY, JSON.stringify([...cloudQueue])); } catch (_) {}
    }

    function sync() {
      const unavailable = locked(), sections = context.getSections();
      // At construction / the start of a reload there may be no loaded
      // sections yet. Reconcile only against the completed current inventory.
      if (sections.length && !context.isLocked()) {
        const loadedIds = new Set(sections.map(section => section.id));
        let changed = false;
        for (const id of cloudQueue) if (!loadedIds.has(id)) { cloudQueue.delete(id); changed = true; }
        if (changed) saveCloudQueue();
      }
      $('batch-calculate').disabled = unavailable || !!proposal || sections.length < 3;
      $('batch-preview').disabled = unavailable || !proposal?.adjusted.length || proposal.adopted || proposal.stale;
      $('batch-preview').setAttribute('aria-pressed', String(!!proposal?.previewing));
      $('batch-preview').textContent = proposal?.previewing ? '元の配置と比較' : '全体の候補を仮表示';
      $('batch-adopt').disabled = unavailable || !proposal?.previewing || proposal.adopted || proposal.stale;
      $('batch-save').disabled = unavailable || !proposal?.adopted || proposal.stale;
      // A running calculation/reference check is cancellable. A storage
      // transaction or cloud write must finish before the controls unlock.
      $('batch-cancel').disabled = persisting || context.isLocked() || (!proposal && !working);
      $('batch-cloud').hidden = !sections.length || !cloudQueue.size || !cloudReady();
      $('batch-cloud').disabled = unavailable || !!proposal || !sections.length || !cloudQueue.size;
      $('batch-cloud').textContent = `クラウドにも一括保存（${cloudQueue.size}切片）`;
      for (const button of $('batch-rows').querySelectorAll('.batch-section-select')) {
        button.disabled = context.isLocked() || persisting;
        button.setAttribute('aria-current', String(Number(button.dataset.index) === context.getSelected()));
      }
    }
    function notify() { sync(); context.onChange(); }
    function clearResult() {
      $('batch-result').hidden = true;
      $('batch-rows').replaceChildren(); $('batch-summary').textContent = '';
    }
    function restore(snapshot) {
      const loaded = new Map(context.getSections().map(section => [section.id, section]));
      for (const reference of snapshot.references) {
        const section = loaded.get(reference.id); if (!section) continue;
        if (!samePlacement(context.placementOf(section), reference.placement)) context.applyPlacement(section, reference.placement);
        context.setDirty(section.id, snapshot.dirtyIds.has(section.id));
      }
    }
    function cancel(text = '') {
      if (persisting) return false;
      generation++; working = false;
      const previous = proposal; proposal = null;
      if (previous) restore(previous);
      clearResult(); message(text); notify(); return true;
    }
    function reset() {
      if (persisting) return false;
      cancel(); sync(); return true;
    }
    function snapshot() {
      const sections = context.getSections();
      return { references: sections.map(section => ({ id: section.id, name: section.name,
        placement: { ...context.placementOf(section) }, source: fingerprint(section.project) })),
        dirtyIds: new Set(context.getDirtyIds()),
        // The solver must never read a plane that the live renderer can move.
        sections: sections.map(section => ({ ...section, ...context.placementOf(section), project: clone(section.project) })) };
    }
    async function checkReferences(candidate) {
      const sections = context.getSections();
      if (sections.length !== candidate.references.length || sections.some((section, index) => section.id !== candidate.references[index].id)) {
        throw new Error('対象切片が変わりました。全体の候補を計算し直してください。');
      }
      const latest = await Promise.all(candidate.references.map(reference => global.ProjectStorage.getProject(reference.id)));
      const rowMap = new Map((candidate.adjusted || []).map(row => [row.id, row]));
      for (let index = 0; index < candidate.references.length; index++) {
        const reference = candidate.references[index], project = latest[index], section = context.getSections()[index];
        const expectedPlacement = candidate.previewing && rowMap.has(reference.id) ? rowMap.get(reference.id).placement : reference.placement;
        if (!project || !section || section.id !== reference.id || fingerprint(project) !== reference.source ||
            fingerprint(section.project) !== reference.source || !samePlacement(context.placementOf(section), expectedPlacement)) {
          throw new Error(`${reference.name} のデータ・ROI・配置が更新されました。再読込して全体の候補を計算し直してください。`);
        }
      }
      return latest;
    }
    function drawResult() {
      const candidate = proposal, result = candidate.result;
      const unsupported = result.rows.filter(row => row.status === 'unsupported').length;
      $('batch-summary').textContent = `${result.rows.length}切片 · 調整 ${candidate.adjusted.length} / 変更なし ${result.rows.length - candidate.adjusted.length - unsupported} / 対象外 ${unsupported}\n` +
        `前後ROI重心の差（RMS）：${format(result.rmsBeforeMm)} → ${format(result.rmsAfterMm)} mm\n` +
        `${result.tripletCount}組・${result.roiCount}領域の対応を同時に計算。収束しました。`;
      $('batch-rows').replaceChildren();
      const base = new Map(candidate.references.map(reference => [reference.id, reference.placement]));
      for (const row of result.rows) {
        const card = document.createElement('div'), button = document.createElement('button'), detail = document.createElement('small');
        card.className = 'batch-alignment-row'; card.dataset.status = row.status;
        button.type = 'button'; button.className = 'batch-section-select'; button.dataset.index = String(row.index);
        button.textContent = `${row.name} · ${row.status === 'adjusted' ? '調整候補' : row.status === 'unchanged' ? '変更なし' : '対象外'}`;
        button.addEventListener('click', () => {
          if (context.isLocked() || persisting) return;
          const index = context.getSections().findIndex(section => section.id === row.id);
          if (index >= 0) context.selectSection(index);
          sync();
        });
        const original = base.get(row.id);
        detail.textContent = row.status === 'unsupported' ? row.reason || '前後ROIの対応が不足しています。' :
          `ΔX ${format(row.placement.offsetXUm - original.offsetXUm, 1)} µm / ΔY ${format(row.placement.offsetYUm - original.offsetYUm, 1)} µm / Δ回転 ${format(row.placement.rotationDeg - original.rotationDeg, 2)}°\n` +
          `ROI ${row.roiCount} · 関連する前後ROIのRMS ${format(row.rmsBeforeMm)} → ${format(row.rmsAfterMm)} mm`;
        card.append(button, detail); $('batch-rows').append(card);
      }
      $('batch-result').hidden = false;
    }
    function validateResult(result, base) {
      if (!result?.available) throw new Error(result?.reason || '全体の配置候補を計算できませんでした。');
      if (result.converged !== true || !Number.isFinite(result.rmsBeforeMm) || !Number.isFinite(result.rmsAfterMm) ||
          result.rmsBeforeMm < 0 || result.rmsAfterMm < 0 || result.rmsAfterMm > result.rmsBeforeMm + Math.max(1e-10, result.rmsBeforeMm * 1e-9)) {
        throw new Error('全体の計算が収束しないか、ROI重心の差が増加したため、候補は適用していません。');
      }
      if (!Array.isArray(result.rows) || result.rows.length !== base.references.length ||
          result.rows.some((row, index) => row.id !== base.references[index].id || row.index !== index ||
            !['adjusted', 'unchanged', 'unsupported'].includes(row.status) || !finitePlacement(row.placement))) {
        throw new Error('計算結果の切片・配置を確認できません。候補は適用していません。');
      }
    }
    async function calculate() {
      if (locked() || proposal || context.getSections().length < 3) return;
      context.onBeforeCalculate();
      const token = ++generation;
      working = true; clearResult(); message('全切片のデータとROIを確認しています…'); notify();
      try {
        await yieldUI(); if (token !== generation) return;
        const base = snapshot();
        await checkReferences(base); if (token !== generation) return;
        const result = await global.Stack3DBatchAlignment.solve(base.sections, {
          isCancelled: () => token !== generation,
          onProgress(progress) {
            if (token !== generation) return;
            message(`全体の配置候補を計算中… ${progress.completed ?? 0} / ${progress.total ?? base.references.length}` +
              (Number.isFinite(progress.iteration) ? ` · 反復 ${progress.iteration}` : ''));
          }
        });
        if (token !== generation) return;
        validateResult(result, base);
        await checkReferences(base); if (token !== generation) return;
        proposal = { references: base.references, dirtyIds: base.dirtyIds, result,
          adjusted: result.rows.filter(row => row.status === 'adjusted'), previewing: false, adopted: false, stale: false };
        drawResult();
        message((proposal.adjusted.length ? '全体の候補を計算しました。仮表示してから採用してください。' : '調整が必要な候補はありません。元の配置を保持しています。') +
          (result.warnings?.length ? '\n' + result.warnings.join('\n') : ''));
      } catch (error) { if (token === generation) message(error.message); }
      finally { if (token === generation) { working = false; notify(); } }
    }
    function applyCandidate(candidate, previewing) {
      const loaded = new Map(context.getSections().map(section => [section.id, section]));
      const base = new Map(candidate.references.map(reference => [reference.id, reference.placement]));
      for (const row of candidate.adjusted) {
        const section = loaded.get(row.id);
        if (section) context.applyPlacement(section, previewing ? row.placement : base.get(row.id));
      }
      candidate.previewing = previewing;
    }
    async function preview() {
      const candidate = proposal;
      if (locked() || !candidate?.adjusted.length || candidate.adopted || candidate.stale) return;
      if (candidate.previewing) {
        applyCandidate(candidate, false); message('計算前の配置を比較表示中です。候補はまだ採用していません。'); notify(); return;
      }
      const token = generation; working = true; notify();
      try {
        await checkReferences(candidate); if (token !== generation || proposal !== candidate) return;
        applyCandidate(candidate, true); message('全体の候補を仮表示中です。切片を選び直して確認できます。まだ保存していません。');
      } catch (error) { if (token === generation) cancel(error.message); }
      finally { if (token === generation) { working = false; notify(); } }
    }
    async function adopt() {
      const candidate = proposal;
      if (locked() || !candidate?.previewing || candidate.adopted || candidate.stale) return;
      const token = generation; working = true; notify();
      try {
        await checkReferences(candidate); if (token !== generation || proposal !== candidate) return;
        candidate.adopted = true;
        for (const row of candidate.adjusted) context.setDirty(row.id, true);
        message(`${candidate.adjusted.length}切片の候補を採用しました。「まとめて保存」でこのブラウザーに保存します。`);
      } catch (error) { if (token === generation) cancel(error.message); }
      finally { if (token === generation) { working = false; notify(); } }
    }
    async function save() {
      const candidate = proposal;
      if (locked() || !candidate?.adopted || candidate.stale) return;
      const token = generation; working = true; persisting = true;
      message('対象の全切片を確認し、配置を一括保存しています…'); notify();
      try {
        const latest = await checkReferences(candidate);
        if (token !== generation || proposal !== candidate) return;
        const changes = candidate.adjusted.map(row => ({ id: row.id, ...row.placement }));
        const saved = await global.ProjectStorage.saveStack3DPlacements(changes, {
          expectedProjectRevisions: latest.map(project => ({ id: project.id, updatedAt: project.updatedAt }))
        });
        // No asynchronous gap between the successful transaction and the
        // in-memory acknowledgement: cancellation must never undo saved poses.
        proposal = null; generation++; context.onSaved(saved);
        for (const project of saved) cloudQueue.add(project.id);
        saveCloudQueue();
        clearResult();
        const remaining = context.getDirtyIds().size;
        message(`${saved.length}切片の配置をこのブラウザーに一括保存しました。ZIP出力にも含まれます。` +
          (remaining ? `\n対象外・変更なしの切片などに、以前からの未保存の配置が${remaining}件残っています。` : '') +
          (cloudReady() ? '\n必要に応じてクラウドにも一括保存できます。' : ''));
      } catch (error) {
        if (proposal === candidate) message(`一括保存できませんでした。候補は未保存のまま保持しています：${error.message}`);
      } finally { working = false; persisting = false; notify(); }
    }
    async function saveCloud() {
      if (locked() || proposal || !context.getSections().length || !cloudQueue.size || !cloudReady()) return;
      if ([...cloudQueue].some(id => context.getDirtyIds().has(id))) {
        message('クラウド保存の対象に未保存の配置があります。先に配置を保存してください。'); return;
      }
      working = true; persisting = true; notify();
      const ids = [...cloudQueue], failures = []; let succeeded = 0;
      try {
        for (let index = 0; index < ids.length; index++) {
          const id = ids[index]; message(`クラウドへ一括保存中… ${index + 1} / ${ids.length}`);
          try {
            if (context.getDirtyIds().has(id)) throw new Error('配置に未保存の変更があります。');
            const project = await global.ProjectStorage.getProject(id);
            if (!project) throw new Error('保存する切片が見つかりません。');
            const saved = await global.ProjectSync.saveState(project);
            const status = global.ProjectSync.statusOf?.(saved);
            context.onCloudSaved(saved);
            if (status && status.status !== 'saved') throw new Error(status.reason || 'クラウド保存後の状態を確認してください。');
            cloudQueue.delete(id); saveCloudQueue(); succeeded++;
          } catch (error) {
            const name = context.getSections().find(section => section.id === id)?.name || id;
            failures.push(`${name}：${error.message}`);
          }
          await yieldUI();
        }
        message(`クラウド保存：${succeeded} / ${ids.length}切片を完了しました。` +
          (failures.length ? `\nこのブラウザーへの一括保存は完了しています。未完了の${failures.length}切片だけ再試行できます。\n${failures.join('\n')}` : ''));
      } finally { working = false; persisting = false; notify(); }
    }
    function sourceChanged(ids) {
      if (persisting) return;
      const relevant = !ids?.length || (proposal?.references || context.getSections()).some(reference => ids.includes(reference.id));
      if (!relevant || (!working && !proposal)) return;
      const text = '参照したデータが更新されました。再読込して全体の候補を計算し直してください。';
      if (proposal?.adopted) {
        generation++; working = false; proposal.stale = true;
        message(text + '\n採用した配置は未保存のまま保持しています。「取り消す」で計算前に戻せます。'); notify();
      } else cancel(text);
    }

    $('batch-calculate').addEventListener('click', calculate);
    $('batch-preview').addEventListener('click', preview);
    $('batch-adopt').addEventListener('click', adopt);
    $('batch-save').addEventListener('click', save);
    $('batch-cancel').addEventListener('click', () => cancel('候補を取り消し、計算前の配置と未保存の状態に戻しました。'));
    $('batch-cloud').addEventListener('click', saveCloud);
    return { get active() { return !!proposal; }, get working() { return working; }, get saving() { return persisting; },
      sync, cancel, reset, sourceChanged };
  }
  global.Stack3DBatchUI = Object.freeze({ create });
})(window);
