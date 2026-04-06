/* ========================================
   MangaReader - Main Application
   ======================================== */

// ==========================================
// IndexedDB Database Manager
// ==========================================
class MangaDB {
    constructor() {
        this.dbName = 'MangaReaderDB';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                // Store manga metadata
                if (!db.objectStoreNames.contains('manga')) {
                    const store = db.createObjectStore('manga', { keyPath: 'id' });
                    store.createIndex('title', 'title', { unique: false });
                    store.createIndex('addedAt', 'addedAt', { unique: false });
                }
                // Store page images (blobs)
                if (!db.objectStoreNames.contains('pages')) {
                    const pageStore = db.createObjectStore('pages', { keyPath: 'id' });
                    pageStore.createIndex('mangaId', 'mangaId', { unique: false });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }

    async addManga(manga) {
        return this._tx('manga', 'readwrite', store => store.put(manga));
    }

    async getManga(id) {
        return this._tx('manga', 'readonly', store => store.get(id));
    }

    async getAllManga() {
        return this._tx('manga', 'readonly', store => store.getAll());
    }

    async deleteManga(id) {
        // Delete all pages first
        const pages = await this.getPagesByManga(id);
        if (pages.length > 0) {
            const tx = this.db.transaction('pages', 'readwrite');
            const store = tx.objectStore('pages');
            for (const page of pages) {
                store.delete(page.id);
            }
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        }
        // Delete manga metadata
        return this._tx('manga', 'readwrite', store => store.delete(id));
    }

    async addPage(page) {
        return this._tx('pages', 'readwrite', store => store.put(page));
    }

    async getPage(id) {
        return this._tx('pages', 'readonly', store => store.get(id));
    }

    async getPagesByManga(mangaId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pages', 'readonly');
            const store = tx.objectStore('pages');
            const index = store.index('mangaId');
            const request = index.getAll(mangaId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async updateProgress(mangaId, currentPage) {
        const manga = await this.getManga(mangaId);
        if (manga) {
            manga.currentPage = currentPage;
            manga.lastReadAt = Date.now();
            return this.addManga(manga);
        }
    }

    _tx(storeName, mode, callback) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            const request = callback(store);
            if (request && request.onsuccess !== undefined) {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } else {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            }
        });
    }
}

// ==========================================
// App State
// ==========================================
const db = new MangaDB();

// Configure PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
let currentManga = null;
let currentPageIndex = 0;
let totalPages = 0;
let pageCache = new Map(); // page index → blob URL
let isUIVisible = true;
let deleteTargetId = null;

// Zoom state
let isZoomed = false;
let zoomScale = 1;
let panX = 0;
let panY = 0;
let lastPinchDist = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;

// ==========================================
// DOM Elements
// ==========================================
const $ = (id) => document.getElementById(id);

const libraryView = $('library-view');
const readerView = $('reader-view');
const mangaGrid = $('manga-grid');
const emptyState = $('empty-state');
const headerStats = $('header-stats');
const fileInput = $('file-input');
const loadingOverlay = $('loading-overlay');
const loadingText = $('loading-text');

// Reader
const readerHeader = $('reader-header');
const readerFooter = $('reader-footer');
const readerCanvas = $('reader-canvas');
const readerImage = $('reader-image');
const readerTitle = $('reader-title');
const readerPageInfo = $('reader-page-info');
const readerSlider = $('reader-slider');
const pageLabelCurrent = $('page-label-current');
const pageLabelTotal = $('page-label-total');
const navPrev = $('nav-prev');
const navNext = $('nav-next');

// Dialog
const deleteDialog = $('delete-dialog');
const deleteDialogText = $('delete-dialog-text');

// ==========================================
// Initialize App
// ==========================================
async function init() {
    await db.init();

    // Register service worker
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('sw.js');
        } catch (err) {
            console.log('SW registration failed:', err);
        }
    }

    // Bind events
    bindEvents();

    // Load library
    await renderLibrary();
}

function bindEvents() {
    // Import buttons
    $('btn-import-fab').addEventListener('click', () => fileInput.click());
    $('btn-import-empty').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileImport);

    // Keep trying fullscreen on every interaction until it sticks
    document.addEventListener('click', () => {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            enterFullscreen();
        }
    });

    // Reader navigation - RTL: left = next, right = prev
    navPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        navigatePage(1); // left side = next page (RTL)
    });
    navNext.addEventListener('click', (e) => {
        e.stopPropagation();
        navigatePage(-1); // right side = prev page (RTL)
    });

    // Back button
    $('btn-back').addEventListener('click', closeReader);

    // Toggle UI on center tap
    readerCanvas.addEventListener('click', (e) => {
        const rect = readerCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        // Only toggle UI for center taps (middle 30%)
        if (x > 0.35 && x < 0.65) {
            toggleReaderUI();
        }
    });

    // Slider
    readerSlider.addEventListener('input', (e) => {
        const page = parseInt(e.target.value);
        goToPage(page - 1);
    });

    // Delete dialog
    $('delete-cancel').addEventListener('click', closeDeleteDialog);
    $('delete-confirm').addEventListener('click', confirmDelete);

    // Double tap to zoom
    let lastTap = 0;
    readerCanvas.addEventListener('touchend', (e) => {
        const now = Date.now();
        if (now - lastTap < 300 && e.changedTouches.length === 1) {
            e.preventDefault();
            toggleZoom(e.changedTouches[0]);
        }
        lastTap = now;
    });

    // Double click to zoom (desktop)
    readerCanvas.addEventListener('dblclick', (e) => {
        e.preventDefault();
        toggleZoom(e);
    });

    // Pinch to zoom
    readerCanvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    readerCanvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    readerCanvas.addEventListener('touchend', handleTouchEnd, { passive: false });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (!readerView.classList.contains('active')) return;

        switch (e.key) {
            case 'ArrowLeft':
                navigatePage(1); // RTL: left = next
                break;
            case 'ArrowRight':
                navigatePage(-1); // RTL: right = prev
                break;
            case 'Escape':
                if (isZoomed) resetZoom();
                else closeReader();
                break;
        }
    });

    // Prevent default zoom on mobile
    document.addEventListener('gesturestart', (e) => e.preventDefault());
}

// ==========================================
// File Import
// ==========================================
async function handleFileImport(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    showLoading('Importazione in corso...');

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        loadingText.textContent = files.length > 1
            ? `Importazione ${i + 1}/${files.length}: ${file.name}`
            : `Importazione: ${file.name}`;

        try {
            const isPDF = file.name.toLowerCase().endsWith('.pdf');
            if (isPDF) {
                await importPDF(file);
            } else {
                await importCBZ(file);
            }
        } catch (err) {
            console.error('Import error:', err);
            alert(`Errore importando "${file.name}": ${err.message}`);
        }
    }

    hideLoading();
    await renderLibrary();
    fileInput.value = '';
}

async function importCBZ(file) {
    const zip = await JSZip.loadAsync(file);

    // Get image files sorted naturally
    const imageFiles = [];
    zip.forEach((path, entry) => {
        if (!entry.dir && isImageFile(path)) {
            imageFiles.push({ path, entry });
        }
    });

    imageFiles.sort((a, b) => naturalSort(a.path, b.path));

    if (imageFiles.length === 0) {
        throw new Error('Nessuna immagine trovata nel file');
    }

    const mangaId = 'manga_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const title = file.name.replace(/\.(cbz|zip|pdf)$/i, '');

    // Extract and store pages
    let coverBlob = null;

    for (let i = 0; i < imageFiles.length; i++) {
        const { path, entry } = imageFiles[i];
        const blob = await entry.async('blob');
        const mimeType = getMimeType(path);
        const typedBlob = new Blob([blob], { type: mimeType });

        const pageData = {
            id: `${mangaId}_page_${i}`,
            mangaId: mangaId,
            pageIndex: i,
            blob: typedBlob,
            filename: path
        };

        await db.addPage(pageData);

        if (i === 0) {
            coverBlob = typedBlob;
        }

        // Update progress
        loadingText.textContent = `Estrazione pagine: ${i + 1}/${imageFiles.length}`;
    }

    // Create cover thumbnail
    let coverData = null;
    if (coverBlob) {
        coverData = await createThumbnail(coverBlob, 300, 450);
    }

    // Save manga metadata
    const manga = {
        id: mangaId,
        title: title,
        pageCount: imageFiles.length,
        currentPage: 0,
        coverData: coverData,
        addedAt: Date.now(),
        lastReadAt: null
    };

    await db.addManga(manga);
}

async function importPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  if (numPages === 0) {
    throw new Error('Il PDF non contiene pagine');
  }

  const mangaId = 'manga_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const title = file.name.replace(/\.pdf$/i, '');

  let coverBlob = null;
  const SCALE = 2; // High quality rendering

  for (let i = 1; i <= numPages; i++) {
    loadingText.textContent = `Rendering pagina: ${i}/${numPages}`;

    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport: viewport }).promise;

    // Convert canvas to blob
    const blob = await new Promise(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85)
    );

    const pageData = {
      id: `${mangaId}_page_${i - 1}`,
      mangaId: mangaId,
      pageIndex: i - 1,
      blob: blob,
      filename: `page_${i}.jpg`
    };

    await db.addPage(pageData);

    if (i === 1) {
      coverBlob = blob;
    }

    // Yield to main thread
    if (i % 5 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Create cover thumbnail
  let coverData = null;
  if (coverBlob) {
    coverData = await createThumbnail(coverBlob, 300, 450);
  }

  // Save manga metadata
  const manga = {
    id: mangaId,
    title: title,
    pageCount: numPages,
    currentPage: 0,
    coverData: coverData,
    addedAt: Date.now(),
    lastReadAt: null
  };

  await db.addManga(manga);
}

function isImageFile(path) {
    const name = path.toLowerCase().split('/').pop();
    // Skip hidden/system files
    if (name.startsWith('.') || name.startsWith('__')) return false;
    return /\.(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(name);
}

function getMimeType(path) {
    const ext = path.toLowerCase().split('.').pop();
    const types = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg',
        png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp',
        avif: 'image/avif'
    };
    return types[ext] || 'image/jpeg';
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function createThumbnail(blob, maxW, maxH) {
    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width;
            let h = img.height;

            if (w > maxW || h > maxH) {
                const ratio = Math.min(maxW / w, maxH / h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }

            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);

            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', 0.75));
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
        };

        img.src = url;
    });
}

// ==========================================
// Library Rendering
// ==========================================
async function renderLibrary() {
    const mangaList = await db.getAllManga();

    // Sort: last read first, then by added date
    mangaList.sort((a, b) => {
        const aTime = a.lastReadAt || a.addedAt;
        const bTime = b.lastReadAt || b.addedAt;
        return bTime - aTime;
    });

    if (mangaList.length === 0) {
        emptyState.style.display = 'flex';
        mangaGrid.style.display = 'none';
        $('btn-import-fab').classList.add('hidden');
        headerStats.textContent = '';
        return;
    }

    emptyState.style.display = 'none';
    mangaGrid.style.display = 'grid';
    $('btn-import-fab').classList.remove('hidden');

    const totalManga = mangaList.length;
    headerStats.textContent = `${totalManga} manga`;

    mangaGrid.innerHTML = mangaList.map(manga => {
        const progress = manga.pageCount > 0
            ? Math.round((manga.currentPage / (manga.pageCount - 1)) * 100)
            : 0;
        const coverSrc = manga.coverData || '';
        const pagesRead = manga.currentPage + 1;
        const safeTitle = escapeHtml(manga.title);

        return `
      <div class="manga-card" data-id="${manga.id}">
        <button class="manga-delete" data-delete-id="${manga.id}" data-delete-title="${safeTitle}" title="Elimina">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <div class="manga-cover-wrap">
          ${coverSrc
                ? `<img class="manga-cover" src="${coverSrc}" alt="${safeTitle}" loading="lazy">`
                : `<div class="manga-cover" style="display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--text-muted);">📖</div>`
            }
          ${progress > 0 ? `
            <div class="manga-progress">
              <div class="manga-progress-bar" style="width:${progress}%"></div>
            </div>
          ` : ''}
        </div>
        <div class="manga-info">
          <div class="manga-title" title="${safeTitle}">${safeTitle}</div>
          <div class="manga-pages">${pagesRead}/${manga.pageCount} pagine</div>
        </div>
      </div>
    `;
    }).join('');

    // Event delegation for manga cards
    mangaGrid.querySelectorAll('.manga-card').forEach(card => {
        card.addEventListener('click', (e) => {
            // Don't open if delete button was clicked
            if (e.target.closest('.manga-delete')) return;
            openManga(card.dataset.id);
        });
    });

    mangaGrid.querySelectorAll('.manga-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showDeleteDialog(btn.dataset.deleteId, btn.dataset.deleteTitle);
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==========================================
// Reader
// ==========================================
async function openManga(mangaId) {
    showLoading('Caricamento...');

    try {
        currentManga = await db.getManga(mangaId);
        if (!currentManga) throw new Error('Manga non trovato');

        // Load pages info
        const pages = await db.getPagesByManga(mangaId);
        pages.sort((a, b) => a.pageIndex - b.pageIndex);
        totalPages = pages.length;

        // Clear old cache
        for (const url of pageCache.values()) {
            URL.revokeObjectURL(url);
        }
        pageCache.clear();

        // Pre-cache first few pages
        const preloadCount = Math.min(3, pages.length);
        for (let i = 0; i < preloadCount; i++) {
            const url = URL.createObjectURL(pages[i].blob);
            pageCache.set(i, url);
        }

        // Set up reader UI
        readerTitle.textContent = currentManga.title;
        readerSlider.max = totalPages;
        pageLabelTotal.textContent = totalPages;
        currentPageIndex = currentManga.currentPage || 0;

        // Switch views
        libraryView.classList.remove('active');
        readerView.classList.add('active');
        // Start with UI hidden, user taps center to show
        isUIVisible = false;
        readerHeader.classList.add('hidden');
        readerFooter.classList.add('hidden');
        resetZoom();

        // Show current page
        await goToPage(currentPageIndex);

        // Pre-cache remaining pages in background
        preloadPages(pages, preloadCount);

    } catch (err) {
        console.error('Error opening manga:', err);
        alert('Errore aprendo il manga');
    }

    hideLoading();
}

async function preloadPages(pages, startFrom) {
    for (let i = startFrom; i < pages.length; i++) {
        if (!pageCache.has(i)) {
            const url = URL.createObjectURL(pages[i].blob);
            pageCache.set(i, url);
        }
        // Yield to main thread periodically
        if (i % 10 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }
}

async function goToPage(index, direction = 0) {
    if (index < 0 || index >= totalPages) return;

    if (!document.startViewTransition) {
        await _updatePageDOM(index);
    } else {
        // Handle slide direction for RTL layout
        // direction > 0 means Next page (which slides from left to right)
        // direction < 0 means Prev page (which slides from right to left)
        if (direction > 0) { 
            document.documentElement.classList.add('slide-next');
            document.documentElement.classList.remove('slide-prev');
        } else if (direction < 0) {
            document.documentElement.classList.add('slide-prev');
            document.documentElement.classList.remove('slide-next');
        } else {
            document.documentElement.classList.remove('slide-prev', 'slide-next');
        }
        
        const transition = document.startViewTransition(async () => {
            await _updatePageDOM(index);
        });
        
        // Clean up classes after transition
        transition.finished.finally(() => {
            document.documentElement.classList.remove('slide-prev', 'slide-next');
        });
    }
}

async function _updatePageDOM(index) {
    if (index < 0 || index >= totalPages) return;

    currentPageIndex = index;
    readerImage.classList.add('loading');

    // Get page URL
    let url = pageCache.get(index);
    if (!url) {
        const pageId = `${currentManga.id}_page_${index}`;
        const page = await db.getPage(pageId);
        if (page) {
            url = URL.createObjectURL(page.blob);
            pageCache.set(index, url);
        }
    }

    if (url) {
        if (readerImage.src !== url) {
            await new Promise(resolve => {
                readerImage.onload = () => {
                    readerImage.classList.remove('loading');
                    resolve();
                };
                readerImage.onerror = () => {
                    readerImage.classList.remove('loading');
                    resolve(); // resolve anyway to avoid stuck UI
                };
                readerImage.src = url;
            });
        } else {
            readerImage.classList.remove('loading');
        }
    }

    // Update UI
    const displayPage = index + 1;
    readerPageInfo.textContent = `${displayPage}/${totalPages}`;
    pageLabelCurrent.textContent = displayPage;
    readerSlider.value = displayPage;

    // Save progress
    db.updateProgress(currentManga.id, index);

    // Reset zoom on page change
    if (isZoomed) resetZoom();
}

function navigatePage(direction) {
    // direction: 1 = next, -1 = prev
    const newIndex = currentPageIndex + direction;

    if (newIndex >= 0 && newIndex < totalPages) {
        // Flash effect
        const zone = direction > 0 ? navPrev : navNext;
        zone.classList.add('flash');
        setTimeout(() => zone.classList.remove('flash'), 300);

        goToPage(newIndex, direction);
    }
}

function closeReader() {
    // Revoke cached blob URLs
    for (const url of pageCache.values()) {
        URL.revokeObjectURL(url);
    }
    pageCache.clear();

    currentManga = null;
    readerView.classList.remove('active');
    libraryView.classList.add('active');

    resetZoom();
    // Stay fullscreen when returning to library
    renderLibrary();
}

function toggleReaderUI() {
    isUIVisible = !isUIVisible;
    readerHeader.classList.toggle('hidden', !isUIVisible);
    readerFooter.classList.toggle('hidden', !isUIVisible);
}

// ==========================================
// Zoom & Pan
// ==========================================
function toggleZoom(point) {
    if (isZoomed) {
        resetZoom();
    } else {
        // Zoom into the tapped point
        zoomScale = 2.5;
        isZoomed = true;

        const rect = readerCanvas.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const px = (point.clientX || point.pageX) - rect.left;
        const py = (point.clientY || point.pageY) - rect.top;

        panX = (cx - px) * (zoomScale - 1);
        panY = (cy - py) * (zoomScale - 1);

        applyZoom();
        readerImage.classList.add('zoomed');

        // Hide UI when zoomed
        if (isUIVisible) toggleReaderUI();
    }
}

function resetZoom() {
    isZoomed = false;
    zoomScale = 1;
    panX = 0;
    panY = 0;
    isDragging = false;
    readerImage.style.transform = '';
    readerImage.classList.remove('zoomed', 'dragging');
}

function applyZoom() {
    readerImage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
}

function getPinchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function handleTouchStart(e) {
    if (e.touches.length === 2) {
        e.preventDefault();
        lastPinchDist = getPinchDistance(e.touches);
    } else if (e.touches.length === 1 && isZoomed) {
        isDragging = true;
        dragStartX = e.touches[0].clientX - panX;
        dragStartY = e.touches[0].clientY - panY;
        readerImage.classList.add('dragging');
    }
}

function handleTouchMove(e) {
    if (e.touches.length === 2) {
        e.preventDefault();
        const dist = getPinchDistance(e.touches);
        const delta = dist / lastPinchDist;
        lastPinchDist = dist;

        zoomScale = Math.max(1, Math.min(5, zoomScale * delta));

        if (zoomScale <= 1.05) {
            resetZoom();
            return;
        }

        isZoomed = true;
        readerImage.classList.add('zoomed');
        applyZoom();
    } else if (e.touches.length === 1 && isDragging && isZoomed) {
        e.preventDefault();
        panX = e.touches[0].clientX - dragStartX;
        panY = e.touches[0].clientY - dragStartY;
        applyZoom();
    }
}

function handleTouchEnd(e) {
    if (e.touches.length < 2) {
        lastPinchDist = 0;
    }
    if (e.touches.length === 0) {
        isDragging = false;
        readerImage.classList.remove('dragging');
    }
}

// ==========================================
// Delete Dialog
// ==========================================
function showDeleteDialog(id, title) {
    deleteTargetId = id;
    deleteDialogText.textContent = `Sei sicuro di voler eliminare "${title}"?`;
    deleteDialog.classList.add('active');
}

function closeDeleteDialog() {
    deleteDialog.classList.remove('active');
    deleteTargetId = null;
}

async function confirmDelete() {
    if (!deleteTargetId) return;

    const idToDelete = deleteTargetId;
    showLoading('Eliminazione...');
    closeDeleteDialog();

    try {
        await db.deleteManga(idToDelete);
        await renderLibrary();
    } catch (err) {
        console.error('Delete error:', err);
        alert('Errore durante l\'eliminazione');
    }

    hideLoading();
}

// ==========================================
// Loading Overlay
// ==========================================
function showLoading(text) {
    loadingText.textContent = text || 'Caricamento...';
    loadingOverlay.classList.add('active');
}

function hideLoading() {
    loadingOverlay.classList.remove('active');
}

// ==========================================
// Fullscreen
// ==========================================
function enterFullscreen() {
  const el = document.documentElement;
  const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (rfs) {
    rfs.call(el).catch(() => {});
  }
}

function exitFullscreen() {
  const efs = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if (efs && document.fullscreenElement) {
    efs.call(document).catch(() => {});
  }
}

// ==========================================
// Start App
// ==========================================
init().catch(err => {
  console.error('Failed to initialize MangaReader:', err);
});
