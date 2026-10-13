/* Dataset reference notes. Rendering never creates a saved notes record. */
(function (global) {
  'use strict';

  function create(root, { onChange, onCompositionChange }) {
    const atlas = root.querySelector('#notes-atlas-url');
    const gene = root.querySelector('#notes-gene-atlas-url');
    const list = root.querySelector('#notes-others');
    const add = root.querySelector('#notes-add');
    let draft, composing = false;
    const string = value => typeof value === 'string' ? value : '';
    const uid = () => global.crypto.randomUUID();

    function updateLink(input, link) {
      let url;
      try {
        const parsed = new URL(input.value.trim());
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href;
      } catch (_) {}
      if (url) link.href = url;
      else link.removeAttribute('href');
      link.setAttribute('aria-disabled', String(!url));
      link.tabIndex = url ? 0 : -1;
      const invalid = !!input.value.trim() && !url;
      input.setAttribute('aria-invalid', String(invalid));
      const hint = input.parentElement.querySelector('.notes-url-hint');
      hint.hidden = !invalid;
    }
    function emit() { onChange(structuredClone(draft)); }
    function bind(input, set, link) {
      input.addEventListener('input', () => {
        set(input.value);
        if (link) updateLink(input, link);
        // Keep partial text in memory; composition itself must not redraw the DOM.
        emit();
      });
      input.addEventListener('compositionstart', () => { composing = true; onCompositionChange(true); });
      input.addEventListener('compositionend', () => {
        set(input.value);
        composing = false;
        if (link) updateLink(input, link);
        emit(); onCompositionChange(false);
      });
    }
    function rowElement(item) {
      const row = document.createElement('div');
      row.className = 'notes-other-row'; row.dataset.noteId = item.id;
      const heading = document.createElement('div'); heading.className = 'notes-row-heading';
      const label = document.createElement('input');
      label.type = 'text'; label.dataset.noteField = 'label'; label.value = item.label;
      label.placeholder = '項目名'; label.setAttribute('aria-label', 'others 項目名');
      const remove = document.createElement('button');
      remove.type = 'button'; remove.dataset.noteAction = 'delete'; remove.textContent = '削除';
      remove.setAttribute('aria-label', 'このメモを削除');
      remove.addEventListener('click', () => {
        const index = draft.others.indexOf(item);
        if (index < 0) return;
        draft.others.splice(index, 1);
        row.remove(); emit();
        const next = list.children[index] || list.children[index - 1];
        (next?.querySelector('input') || add).focus();
      });
      heading.append(label, remove);
      const urlRow = document.createElement('div'); urlRow.className = 'notes-url-row';
      const url = document.createElement('input');
      url.type = 'url'; url.dataset.noteField = 'url'; url.value = item.url;
      url.placeholder = 'URL（任意）'; url.setAttribute('aria-label', 'others URL');
      const link = document.createElement('a');
      link.dataset.noteAction = 'open'; link.textContent = '開く'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', 'others URL を別タブで開く');
      const hint = document.createElement('small');
      hint.className = 'notes-url-hint'; hint.id = 'notes-hint-' + uid();
      hint.textContent = 'http:// または https:// のURLを入力してください（入力内容は保持します）。';
      url.setAttribute('aria-describedby', hint.id);
      urlRow.append(url, link, hint);
      const text = document.createElement('textarea');
      text.rows = 2; text.dataset.noteField = 'text'; text.value = item.text;
      text.placeholder = 'メモ（URLなしでも入力できます）'; text.setAttribute('aria-label', 'others メモ');
      row.append(heading, urlRow, text);
      bind(label, value => { item.label = value; });
      bind(url, value => { item.url = value; }, link);
      bind(text, value => { item.text = value; });
      updateLink(url, link);
      return row;
    }
    function render(value) {
      // Preserve unrecognized properties when editing known fields. Missing legacy
      // records remain UI defaults until the first real edit calls onChange.
      draft = { version: 1, ...structuredClone(value || {}), atlasUrl: string(value?.atlasUrl),
        geneAtlasUrl: string(value?.geneAtlasUrl), others: (Array.isArray(value?.others) ? value.others : [])
          .filter(item => item && typeof item === 'object').map(item => ({ ...structuredClone(item),
            id: string(item.id) || uid(), label: string(item.label), url: string(item.url), text: string(item.text) })) };
      atlas.value = draft.atlasUrl; gene.value = draft.geneAtlasUrl;
      updateLink(atlas, root.querySelector('#notes-atlas-open'));
      updateLink(gene, root.querySelector('#notes-gene-atlas-open'));
      list.replaceChildren(...draft.others.map(rowElement));
    }
    bind(atlas, value => { draft.atlasUrl = value; }, root.querySelector('#notes-atlas-open'));
    bind(gene, value => { draft.geneAtlasUrl = value; }, root.querySelector('#notes-gene-atlas-open'));
    add.addEventListener('click', () => {
      const item = { id: uid(), label: '', url: '', text: '' };
      draft.others.push(item);
      const row = rowElement(item); list.append(row); emit();
      row.querySelector('input').focus();
    });
    root.addEventListener('click', event => {
      if (event.target.closest('a[aria-disabled="true"]')) event.preventDefault();
    });
    return { render, get composing() { return composing; } };
  }
  global.ViewerNotes = { create };
})(window);