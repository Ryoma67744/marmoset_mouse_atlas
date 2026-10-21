/* Adapted from Share_Test 1d3f4e1: display workspace only. Atlas owns raw
 * coordinates, orientation constraints, registration drafts and persistence. */
/* Display-only alignment workspace. It does not own landmarks or project data. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MsiAlignmentWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    function fitView(width, height, viewportWidth, viewportHeight) {
        if (!(width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0)) return null;
        return { centerX: 0.5, centerY: 0.5, pixelScale: Math.min(viewportWidth / width, viewportHeight / height) };
    }
    function validView(view) {
        return !!(view && Number.isFinite(view.centerX) && Number.isFinite(view.centerY)
            && Number.isFinite(view.pixelScale) && view.pixelScale > 0);
    }
    function imageRect(view, width, height, viewportWidth, viewportHeight) {
        if (!validView(view)) return null;
        const w = width * view.pixelScale, h = height * view.pixelScale;
        return { left: viewportWidth / 2 - view.centerX * w,
            top: viewportHeight / 2 - view.centerY * h, width: w, height: h };
    }
    function zoomView(view, factor, anchorX, anchorY, width, height, viewportWidth, viewportHeight) {
        if (!validView(view) || !(width > 0 && height > 0)) return view;
        const old = imageRect(view, width, height, viewportWidth, viewportHeight);
        const px = (anchorX - old.left) / old.width, py = (anchorY - old.top) / old.height;
        const pixelScale = clamp(view.pixelScale * factor, 0.00001, 1000);
        return { centerX: px - (anchorX - viewportWidth / 2) / (width * pixelScale),
            centerY: py - (anchorY - viewportHeight / 2) / (height * pixelScale), pixelScale };
    }
    function panView(view, dx, dy, width, height) {
        if (!validView(view) || !(width > 0 && height > 0)) return view;
        return { centerX: view.centerX - dx / (width * view.pixelScale),
            centerY: view.centerY - dy / (height * view.pixelScale), pixelScale: view.pixelScale };
    }
    function clientPoint(rect, x, y, width, height) {
        if (!rect || !(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)
            || !Number.isFinite(x) || !Number.isFinite(y)
            || x < rect.left || y < rect.top || x >= rect.left + rect.width || y >= rect.top + rect.height) return null;
        return [(x - rect.left) * width / rect.width, (y - rect.top) * height / rect.height];
    }

    /**
     * Keep the existing image / SVG / form nodes and all their listeners.
     * onComposite({canvas,width,height,opacity,signal,isCurrent}) paints into
     * a detached canvas; late results can never repaint a newer selection.
     * onViewChange is intended for re-rendering landmark markers only.
     */
    function mount(card, options) {
        options = options || {};
        if (!card || !card.ownerDocument) throw new Error('Alignment card is required');
        if (card._msiAlignmentWorkspace) return card._msiAlignmentWorkspace;
        const doc = card.ownerDocument, win = doc.defaultView || globalThis;
        const q = selector => card.querySelector(selector);
        const heWrap = q('[data-pane="he"]'), msiWrap = q('[data-pane="msi"]');
        const heImg = q('[data-img="he"]'), msiImg = q('[data-img="msi"]');
        const heSvg = null, msiSvg = null;
        if (!heWrap || !msiWrap || !heImg || !msiImg) {
            throw new Error('Alignment image elements are missing');
        }
        const originalFocus = doc.activeElement;
        const previousOverflow = doc.body.style.overflow;
        const listeners = [], inertNodes = [], moved = [], newNodes = [];
        const savedAttributes = new Map();
        const back = card._back || card.parentElement;
        let destroyed = false, raf = 0, compositeRaf = 0, viewNotification = false;
        let compositeGeneration = 0, compositeController = null, renderer = options.onComposite;
        let activeSide = 'msi', mode = 'split', syncing = false;
        const listen = (node, type, callback, settings) => {
            node.addEventListener(type, callback, settings);
            listeners.push(() => node.removeEventListener(type, callback, settings));
        };
        const saveAttr = (node, name) => {
            if (!node) return;
            if (!savedAttributes.has(node)) savedAttributes.set(node, new Map());
            const attrs = savedAttributes.get(node);
            if (!attrs.has(name)) attrs.set(name, node.getAttribute(name));
        };
        const create = (tag, cls, text) => {
            const node = doc.createElement(tag);
            if (cls) node.className = cls;
            if (text != null) node.textContent = text;
            return node;
        };
        const button = (text, title) => {
            const node = create('button', 'btn', text);
            node.type = 'button';
            if (title) node.title = title;
            return node;
        };
        const relocate = (node, parent) => {
            if (!node) return;
            const placeholder = doc.createComment('alignment workspace position');
            node.parentNode.insertBefore(placeholder, node);
            moved.push({ node, placeholder });
            parent.appendChild(node);
        };
        saveAttr(card, 'class'); saveAttr(card, 'role'); saveAttr(card, 'aria-modal'); saveAttr(card, 'aria-label');
        card.classList.add('msi-alignment-workspace');
        card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', 'HE/IF と MSI の位置合わせ');
        if (back) { saveAttr(back, 'class'); back.classList.add('msi-alignment-backdrop'); }

        // Inert every sibling along the modal's ancestor path. Never inert an
        // ancestor of this dialog or alter any underlying application state.
        for (let current = back || card; current && current !== doc.body; current = current.parentElement) {
            const parent = current.parentElement;
            if (!parent) break;
            for (const sibling of Array.from(parent.children)) {
                if (sibling === current || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
                inertNodes.push({ node: sibling, inert: sibling.inert, aria: sibling.getAttribute('aria-hidden') });
                sibling.inert = true; sibling.setAttribute('aria-hidden', 'true');
            }
        }
        doc.body.style.overflow = 'hidden';

        const header = create('header', 'msi-align-header');
        const toolbar = create('div', 'msi-align-toolbar');
        toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '対応点と表示の操作');
        const stage = create('main', 'msi-align-stage');
        const split = create('div', 'msi-align-split');
        const footer = create('footer', 'msi-align-footer');
        const details = create('details', 'msi-align-details');
        details.appendChild(create('summary', '', '詳細設定・対応点一覧'));
        const detailsBody = create('div', 'msi-align-details-body'); details.appendChild(detailsBody);
        for (const node of [header, toolbar, stage, footer]) { card.appendChild(node); newNodes.push(node); }
        stage.appendChild(split); footer.appendChild(details);

        // Keep Atlas controls and listeners; the wrapper owns presentation only.
        for (const selector of ['.align-header', '.align-stepper', '.align-reference']) relocate(q(selector), header);
        for (const selector of ['.align-orient-toolbar', '.align-pick-guide']) relocate(q(selector), toolbar);
        const actions = q('.align-actions');
        if (actions) { actions.dataset.stageOnly = '2'; relocate(actions, toolbar); }
        const pointButtons = create('div', 'msi-align-point-buttons'); pointButtons.dataset.stageOnly = '2';
        toolbar.appendChild(pointButtons);
        for (const action of ['undo', 'clear']) relocate(q('[data-act="' + action + '"]'), pointButtons);
        for (const selector of ['[data-el="status"]', '[data-el="solve-error"]']) relocate(q(selector), header);
        relocate(q('.align-controls'), detailsBody);
        const residualPanel = q('[data-pane="preview"]');
        if (residualPanel) { const parent = residualPanel.parentElement; parent.classList.add('msi-align-residual-panel'); relocate(parent, detailsBody); }
        relocate(q('[data-el="save-error"]'), footer);
        const status = q('[data-el="save-hint"]');
        if (status) { status.classList.add('msi-align-footer-status'); relocate(status, footer); }
        relocate(q('.align-next'), footer);
        const cancel = q('.align-footer [data-act="close"]'), save = q('[data-act="apply"]');
        for (const node of [cancel, save]) relocate(node, footer);

        const viewControls = create('div', 'msi-align-view-controls');
        const splitButton = button('左右比較'), overlayButton = button('重ね合わせ'), finalButton = button('保存後の表示');
        splitButton.dataset.viewMode = 'split'; overlayButton.dataset.viewMode = 'overlay'; finalButton.dataset.viewMode = 'final';
        finalButton.hidden = typeof options.onFinalComposite !== 'function'; finalButton.setAttribute('aria-pressed', 'false');
        splitButton.setAttribute('aria-pressed', 'true'); overlayButton.setAttribute('aria-pressed', 'false');
        viewControls.appendChild(splitButton); viewControls.appendChild(overlayButton); viewControls.appendChild(finalButton);
        const fitButton = button('全体表示', '左右の画像をそれぞれ画面内に収める');
        viewControls.appendChild(fitButton);
        const syncLabel = create('label', 'msi-align-sync');
        const syncInput = create('input'); syncInput.type = 'checkbox';
        syncLabel.appendChild(syncInput); syncLabel.appendChild(doc.createTextNode('左右の表示を同期'));
        viewControls.appendChild(syncLabel);
        toolbar.appendChild(viewControls);

        const compositeWrap = create('div', 'msi-align-composite');
        const compositeCanvas = create('canvas'); compositeCanvas.setAttribute('aria-label', 'HE/IF と MSI の重ね合わせ');
        compositeWrap.appendChild(compositeCanvas); stage.appendChild(compositeWrap);
        const opacityLabel = create('label', 'msi-align-opacity', 'MSI の濃さ');
        const opacityInput = create('input'); opacityInput.type = 'range'; opacityInput.min = '0'; opacityInput.max = '1';
        opacityInput.step = '0.01'; opacityInput.value = '0.5'; opacityInput.setAttribute('aria-label', 'MSI の濃さ');
        opacityLabel.appendChild(opacityInput); viewControls.appendChild(opacityLabel);
        const compositeMessage = create('span', 'msi-align-composite-message', '');
        compositeWrap.appendChild(compositeMessage);

        const panes = {};
        function addPane(side, wrap, source, svg, label) {
            const pane = create('section', 'msi-align-pane');
            const heading = create('div', 'msi-align-pane-header');
            const name = create('strong', '', label); heading.appendChild(name);
            const zoomOut = q('[data-act="zoom-out"][data-zoom-pane="' + side + '"]') || button('−', label + ' を縮小'), zoomIn = q('[data-act="zoom-in"][data-zoom-pane="' + side + '"]') || button('＋', label + ' を拡大');
            zoomOut.setAttribute('aria-label', label + ' を縮小'); zoomIn.setAttribute('aria-label', label + ' を拡大');
            const fit = q('[data-act="zoom-reset"][data-zoom-pane="' + side + '"]') || button('全体');
            for (const node of [zoomOut, zoomIn, fit]) { if (node.parentElement) relocate(node, heading); else heading.appendChild(node); }
            pane.appendChild(heading);
            saveAttr(wrap, 'class'); saveAttr(wrap, 'style');
            wrap.classList.add('msi-align-viewport'); wrap.removeAttribute('style');
            relocate(wrap, pane); split.appendChild(pane);
            const content = q('[data-layer="' + side + '"]');
            if (!content) throw new Error('Atlas point layer is missing');
            saveAttr(content, 'class'); saveAttr(content, 'style');
            content.classList.add('msi-align-content'); content.removeAttribute('style');
            saveAttr(source, 'style'); saveAttr(source, 'draggable'); source.removeAttribute('style'); source.draggable = false;
            // Existing corner labels belong to the viewport, not transformed pixels.
            for (const child of Array.from(wrap.children)) {
                if (child !== content) { saveAttr(child, 'hidden'); child.hidden = true; }
            }
            saveAttr(wrap, 'tabindex'); saveAttr(wrap, 'aria-label');
            wrap.tabIndex = 0;
            wrap.setAttribute('aria-label', label + '画像。ドラッグで移動、ホイールまたは拡大縮小ボタンで表示変更');
            const data = { side, wrap, content, source, svg, view: null, width: 0, height: 0,
                viewportWidth: 0, viewportHeight: 0, suppressedUntil: 0, drag: null };
            panes[side] = data;
            listen(zoomIn, 'click', () => zoom(data, 1.25));
            listen(zoomOut, 'click', () => zoom(data, 0.8));
            listen(fit, 'click', () => fitPane(data, true));
            listen(source, 'load', () => refresh());
            listen(source, 'dragstart', event => event.preventDefault());
            listen(wrap, 'pointerenter', () => { activeSide = side; });
            listen(wrap, 'focus', () => { activeSide = side; });
            listen(wrap, 'wheel', event => {
                if (!data.view) return;
                event.preventDefault(); activeSide = side;
                const r = wrap.getBoundingClientRect();
                zoom(data, Math.exp(-clamp(event.deltaY, -200, 200) * 0.002), event.clientX - r.left, event.clientY - r.top);
            }, { passive: false });
            listen(wrap, 'pointerdown', event => {
                if (event.button !== 0 && event.button !== 1) return;
                activeSide = side;
                data.drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
                    view: data.view && Object.assign({}, data.view), moved: false };
            });
            listen(wrap, 'pointermove', event => {
                const drag = data.drag;
                if (!drag || drag.id !== event.pointerId || !drag.view) return;
                const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
                if (!drag.moved && Math.hypot(dx, dy) < 4) return;
                if (!drag.moved) {
                    drag.moved = true;
                    if (wrap.setPointerCapture) try { wrap.setPointerCapture(event.pointerId); } catch (error) { /* detached pointer */ }
                }
                event.preventDefault();
                data.view = panView(drag.view, dx, dy, data.width, data.height);
                synchronize(data); schedule(true);
            });
            const finishDrag = event => {
                const drag = data.drag;
                if (!drag || drag.id !== event.pointerId) return;
                if (drag.moved) data.suppressedUntil = Date.now() + 350;
                data.drag = null;
                if (wrap.hasPointerCapture && wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId);
            };
            listen(wrap, 'pointerup', finishDrag); listen(wrap, 'pointercancel', finishDrag);
            listen(wrap, 'lostpointercapture', finishDrag);
            listen(wrap, 'click', event => {
                if (!acceptsPoint(side, event)) { event.preventDefault(); event.stopImmediatePropagation(); }
            }, true);
            listen(wrap, 'keydown', event => {
                if (event.target !== wrap || !data.view) return;
                const deltas = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };
                if (deltas[event.key]) {
                    event.preventDefault(); data.view = panView(data.view, ...deltas[event.key], data.width, data.height);
                    synchronize(data); schedule(true);
                } else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(data, 1.25); }
                else if (event.key === '-') { event.preventDefault(); zoom(data, 0.8); }
                else if (event.key === '0') { event.preventDefault(); fitPane(data, true); }
            });
            return data;
        }
        addPane('he', heWrap, heImg, heSvg, 'HE/IF');
        addPane('msi', msiWrap, msiImg, msiSvg, 'MSI');
        // The empty original containers are not part of the dedicated layout.
        for (const child of Array.from(card.children)) {
            if (newNodes.includes(child)) continue;
            saveAttr(child, 'hidden'); child.hidden = true;
        }

        function canSync() { return typeof options.canSync === 'function' && !!options.canSync(); }
        function synchronize(origin) {
            if (!syncing || !canSync() || !origin.view) return;
            const fit = fitView(origin.width, origin.height, origin.wrap.clientWidth, origin.wrap.clientHeight);
            if (!fit) return;
            const relativeScale = origin.view.pixelScale / fit.pixelScale;
            for (const pane of Object.values(panes)) if (pane !== origin) {
                const targetFit = fitView(pane.width, pane.height, pane.wrap.clientWidth, pane.wrap.clientHeight);
                if (targetFit) pane.view = { centerX: origin.view.centerX, centerY: origin.view.centerY,
                    pixelScale: targetFit.pixelScale * relativeScale };
            }
        }
        function fitPane(pane, notify) {
            pane.view = fitView(pane.width, pane.height, pane.wrap.clientWidth, pane.wrap.clientHeight);
            synchronize(pane); schedule(notify);
        }
        function zoom(pane, factor, x, y) {
            if (!pane.view) return;
            pane.view = zoomView(pane.view, factor, finite(x, pane.viewportWidth / 2), finite(y, pane.viewportHeight / 2),
                pane.width, pane.height, pane.viewportWidth, pane.viewportHeight);
            synchronize(pane); schedule(true);
        }
        function updatePane(pane, resetView) {
            const ss = Math.max(0.00001, finite(pane.source.dataset && pane.source.dataset.ss, 1));
            // HTMLImageElement.width can report CSS layout before a source is
            // decoded. It must not establish the first fitted image geometry.
            const ready = pane.source.tagName !== 'IMG' || pane.source.complete && pane.source.naturalWidth > 0;
            const width = ready ? finite(pane.source.dataset.frameWidth, finite(pane.source.tagName === 'IMG' ? pane.source.naturalWidth : pane.source.width, 0) / ss) : 0;
            const height = ready ? finite(pane.source.dataset.frameHeight, finite(pane.source.tagName === 'IMG' ? pane.source.naturalHeight : pane.source.height, 0) / ss) : 0;
            const vw = pane.wrap.clientWidth, vh = pane.wrap.clientHeight;
            const changed = pane.width !== width || pane.height !== height || pane.viewportWidth !== vw || pane.viewportHeight !== vh;
            pane.width = width; pane.height = height; pane.viewportWidth = vw; pane.viewportHeight = vh;
            if (!(width > 0 && height > 0)) { pane.content.style.visibility = 'hidden'; return changed; }
            pane.content.style.visibility = '';
            if (!pane.view || resetView) pane.view = fitView(width, height, vw, vh);
            if (!pane.view) return changed;
            const rect = imageRect(pane.view, width, height, vw, vh);
            pane.content.style.width = width + 'px'; pane.content.style.height = height + 'px';
            pane.content.style.transform = `translate(${rect.left}px, ${rect.top}px) scale(${pane.view.pixelScale})`;
            return changed;
        }
        function schedule(notify) {
            if (destroyed) return;
            viewNotification = viewNotification || !!notify;
            if (raf) return;
            raf = win.requestAnimationFrame(() => {
                raf = 0;
                if (destroyed) return;
                for (const pane of Object.values(panes)) updatePane(pane, false);
                const tell = viewNotification; viewNotification = false;
                if (tell && typeof options.onViewChange === 'function') options.onViewChange(getViewState());
            });
        }
        function refresh(settings) {
            if (destroyed) return;
            let changed = false;
            for (const pane of Object.values(panes)) changed = updatePane(pane, !!(settings && settings.resetView)) || changed;
            syncInput.disabled = !canSync();
            if (syncInput.disabled) { syncing = false; syncInput.checked = false; }
            overlayButton.disabled = typeof renderer !== 'function';
            if (changed) schedule(true);
            requestComposite();
        }
        function acceptsPoint(side, event) {
            const pane = panes[side];
            if (!pane || destroyed || mode !== 'split' || Date.now() < pane.suppressedUntil || (pane.drag && pane.drag.moved)) return false;
            if (event && event.detail === 0 && !Number.isFinite(event.clientX)) return false;
            const rect = pane.source.getBoundingClientRect();
            const viewport = pane.wrap.getBoundingClientRect();
            return !!(event && clientPoint(viewport, event.clientX, event.clientY, 1, 1)
                && clientPoint(rect, event.clientX, event.clientY, pane.source.naturalWidth, pane.source.naturalHeight));
        }
        function getViewState() {
            return { he: panes.he.view && Object.assign({}, panes.he.view),
                msi: panes.msi.view && Object.assign({}, panes.msi.view), sync: syncing, mode, opacity: Number(opacityInput.value) };
        }
        function setViewState(state) {
            state = state || {};
            for (const side of ['he', 'msi']) panes[side].view = validView(state[side]) ? Object.assign({}, state[side]) : null;
            syncing = !!state.sync && canSync(); syncInput.checked = syncing;
            opacityInput.value = String(clamp(finite(state.opacity, 0.5), 0, 1));
            setMode(state.mode === 'final' && typeof options.onFinalComposite === 'function' ? 'final' : state.mode === 'overlay' && typeof renderer === 'function' ? 'overlay' : 'split');
            refresh(); schedule(true);
        }
        function setMode(next) {
            mode = next;
            card.classList.toggle('msi-align-overlay-mode', mode !== 'split');
            card.classList.toggle('msi-align-final-mode', mode === 'final');
            finalButton.setAttribute('aria-pressed', String(mode === 'final'));
            splitButton.setAttribute('aria-pressed', String(mode === 'split'));
            overlayButton.setAttribute('aria-pressed', String(mode === 'overlay'));
            refresh();
        }
        function requestComposite() {
            // Invalidate immediately, even if a render for the new state has
            // not started yet. An old asynchronous render must never flash.
            compositeGeneration++;
            if (compositeController) compositeController.abort();
            if (destroyed || mode === 'split' || typeof (mode === 'final' ? options.onFinalComposite : renderer) !== 'function') return;
            if (compositeRaf) return;
            compositeRaf = win.requestAnimationFrame(async () => {
                compositeRaf = 0;
                if (destroyed || mode === 'split') return;
                const generation = compositeGeneration, renderMode = mode, render = mode === 'final' ? options.onFinalComposite : renderer;
                compositeController = new AbortController();
                const signal = compositeController.signal;
                const width = Math.max(1, Math.round(compositeWrap.clientWidth));
                const height = Math.max(1, Math.round(compositeWrap.clientHeight));
                const canvas = doc.createElement('canvas'); canvas.width = width; canvas.height = height;
                const isCurrent = () => !destroyed && mode === renderMode && generation === compositeGeneration && !signal.aborted;
                compositeMessage.textContent = '';
                try {
                    await render({ canvas, width, height, opacity: Number(opacityInput.value), signal, isCurrent });
                    if (!isCurrent()) return;
                    compositeCanvas.width = width; compositeCanvas.height = height;
                    const context = compositeCanvas.getContext('2d');
                    context.clearRect(0, 0, width, height); context.drawImage(canvas, 0, 0, width, height);
                } catch (error) {
                    if (!isCurrent()) return;
                    compositeCanvas.width = width; compositeCanvas.height = height;
                    compositeMessage.textContent = '重ね合わせを表示できません。左右比較で画像の読み込みを確認してください。';
                    if (typeof options.onCompositeError === 'function') options.onCompositeError(error);
                }
            });
        }
        listen(splitButton, 'click', () => setMode('split'));
        listen(overlayButton, 'click', () => { if (typeof renderer === 'function') setMode('overlay'); });
        listen(finalButton, 'click', () => { if (typeof options.onFinalComposite === 'function') setMode('final'); });
        listen(opacityInput, 'input', requestComposite);
        listen(fitButton, 'click', () => {
            for (const pane of Object.values(panes)) pane.view = fitView(pane.width, pane.height, pane.wrap.clientWidth, pane.wrap.clientHeight);
            if (syncing) synchronize(panes[activeSide]);
            schedule(true); requestComposite();
        });
        listen(syncInput, 'change', () => {
            syncing = syncInput.checked && canSync(); syncInput.checked = syncing;
            synchronize(panes[activeSide]); schedule(true);
        });
        // Opening the bottom drawer changes available image space. Fit both panes so
        // corner landmarks stay reachable; the registration matrix is untouched.
        listen(details, 'toggle', () => { refresh({ resetView: true }); });
        listen(card, 'keydown', event => {
            if (event.key === 'Escape' && typeof options.onClose === 'function') {
                event.preventDefault(); event.stopPropagation(); options.onClose(); return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(card.querySelectorAll('button,select,input,textarea,summary,[tabindex="0"]'))
                .filter(el => !el.disabled && !el.hidden && el.getClientRects().length > 0);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && (doc.activeElement === first || !card.contains(doc.activeElement))) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (doc.activeElement === last || !card.contains(doc.activeElement))) {
                event.preventDefault(); first.focus();
            }
        });
        const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => refresh()) : null;
        if (observer) { observer.observe(stage); observer.observe(heWrap); observer.observe(msiWrap); }
        else listen(win, 'resize', () => refresh());
        function destroy() {
            if (destroyed) return;
            destroyed = true; compositeGeneration++;
            if (compositeController) compositeController.abort();
            if (raf) win.cancelAnimationFrame(raf);
            if (compositeRaf) win.cancelAnimationFrame(compositeRaf);
            if (observer) observer.disconnect();
            for (const cleanup of listeners.reverse()) cleanup();
            for (const item of moved.reverse()) {
                if (item.placeholder.parentNode) { item.placeholder.parentNode.insertBefore(item.node, item.placeholder); item.placeholder.remove(); }
            }
            for (const node of newNodes) node.remove();
            for (const [node, attrs] of savedAttributes) {
                for (const [name, value] of attrs) {
                    if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
                }
            }
            for (const item of inertNodes) {
                item.node.inert = item.inert;
                if (item.aria == null) item.node.removeAttribute('aria-hidden'); else item.node.setAttribute('aria-hidden', item.aria);
            }
            doc.body.style.overflow = previousOverflow;
            delete card._msiAlignmentWorkspace;
            if (originalFocus && originalFocus.isConnected && typeof originalFocus.focus === 'function') originalFocus.focus({ preventScroll: true });
        }
        const api = { refresh, requestComposite, getViewState, setViewState, acceptsPoint, destroy,
            setMode,
            openDetails() { if (!destroyed) details.open = true; },
            setCompositeRenderer(fn) { renderer = fn; refresh(); },
            getContentRect(side) { return panes[side] ? panes[side].source.getBoundingClientRect() : null; },
            clientToImage(side, x, y) {
                const pane = panes[side];
                return pane ? clientPoint(pane.source.getBoundingClientRect(), x, y, pane.source.naturalWidth, pane.source.naturalHeight) : null;
            } };
        card._msiAlignmentWorkspace = api;
        refresh();
        return api;
    }
    return { mount, fitView, validView, imageRect, zoomView, panView, clientPoint };
});
