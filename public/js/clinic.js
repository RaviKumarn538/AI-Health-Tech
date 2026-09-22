/**
 * AI Clinical Records — Workstation Interaction Controller
 * Human-in-the-loop clinical documentation workflows
 */
(function () {
  'use strict';

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  // Dismiss Flash Messages
  $$('[data-dismiss-flash]').forEach((button) => {
    button.addEventListener('click', () => {
      button.closest('.clinical-flash')?.remove();
    });
  });

  // -------------------------------------------------------------
  // 0. Authentication UX: safe sign-out
  // -------------------------------------------------------------
  $$('.signout-form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm('Do you want to sign out of the clinical workstation?')) event.preventDefault();
    });
  });

  // -------------------------------------------------------------
  // 1. Mobile Menu & Sidebar Drawer
  // -------------------------------------------------------------
  const mobileToggle = $('#mobileMenuToggle');
  const sidebar = $('#clinicalSidebar');
  const backdrop = $('#sidebarBackdrop');
  const sidebarClose = $('#sidebarCloseBtn');

  if (sidebar) {
    const toggleSidebar = (force) => {
      const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('mobile-open');
      sidebar.classList.toggle('mobile-open', open);
      if (backdrop) {
        if (open) {
          backdrop.style.display = 'block';
          requestAnimationFrame(() => backdrop.classList.add('is-active'));
        } else {
          backdrop.classList.remove('is-active');
          setTimeout(() => {
            if (!backdrop.classList.contains('is-active')) {
              backdrop.style.display = 'none';
            }
          }, 260);
        }
      }
      if (mobileToggle) mobileToggle.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('sidebar-drawer-open', open);
    };

    mobileToggle?.addEventListener('click', () => toggleSidebar());
    sidebarClose?.addEventListener('click', () => toggleSidebar(false));
    backdrop?.addEventListener('click', () => toggleSidebar(false));

    // Auto-close sidebar on mobile when navigating
    $$('#clinicalSidebar a').forEach((link) => {
      link.addEventListener('click', () => {
        if (window.innerWidth <= 1024) {
          toggleSidebar(false);
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('mobile-open')) {
        toggleSidebar(false);
      }
    });
  }

  // -------------------------------------------------------------
  // 2. Popover & Dropdown State Manager (Strict Single-Open Rule)
  // -------------------------------------------------------------
  const profileBtn = $('#profileChipBtn');
  const profileMenu = $('#profileMenuDropdown');
  const searchContainer = $('#globalSearchContainer');
  const searchInput = $('#globalSearchInput');
  const searchDropdown = $('#searchResultsDropdown');
  const clearBtn = $('#globalSearchClearBtn');

  const closeAllPopovers = (except = null) => {
    if (except !== 'profile' && profileMenu && profileBtn) {
      profileMenu.style.display = 'none';
      profileBtn.setAttribute('aria-expanded', 'false');
    }
    if (except !== 'search' && searchDropdown) {
      searchDropdown.style.display = 'none';
    }
  };

  if (profileBtn && profileMenu) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isExpanded = profileBtn.getAttribute('aria-expanded') === 'true';
      closeAllPopovers('profile');
      if (!isExpanded) {
        profileBtn.setAttribute('aria-expanded', 'true');
        profileMenu.style.display = 'block';
      } else {
        profileBtn.setAttribute('aria-expanded', 'false');
        profileMenu.style.display = 'none';
      }
    });
  }

  // Global click-outside listener ensuring strictly at most one popover is open
  document.addEventListener('click', (e) => {
    const inProfile = (profileBtn && profileBtn.contains(e.target)) || (profileMenu && profileMenu.contains(e.target));
    const inSearch = (searchInput && searchInput.contains(e.target)) || (searchDropdown && searchDropdown.contains(e.target)) || (searchContainer && searchContainer.contains(e.target)) || e.target.closest('.js-open-global-search');

    if (!inProfile && !inSearch) {
      closeAllPopovers();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllPopovers();
    }
  });

  // -------------------------------------------------------------
  // 3. Single Unified Global Clinical Search (Navbar, Sidebar, Page)
  // -------------------------------------------------------------
  if (searchInput && searchDropdown) {
    let activeCategory = 'ALL';
    let selectedIndex = -1;

    // Check if current page is /search and has a query param 'q'
    const currentUrlParams = new URLSearchParams(window.location.search);
    const existingQ = currentUrlParams.get('q');
    const existingCat = currentUrlParams.get('category');
    if (existingQ && window.location.pathname.startsWith('/search')) {
      searchInput.value = existingQ;
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    }
    if (existingCat) {
      activeCategory = existingCat.toUpperCase();
    }

    const topbar = $('.clinical-topbar');
    const mobileSearchToggle = $('#mobileSearchToggle');
    const mobileSearchBackBtn = $('#mobileSearchBackBtn');

    const openAndFocusGlobalSearch = () => {
      closeAllPopovers('search');
      if (topbar && window.innerWidth <= 1024) {
        topbar.classList.add('mobile-search-active');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => {
        searchInput.focus();
        searchInput.select();
      }, 50);
      if (searchContainer) {
        searchContainer.classList.add('search-focus-glow');
        setTimeout(() => searchContainer.classList.remove('search-focus-glow'), 1400);
      }
      if (!searchInput.value.trim()) {
        renderQuickCategories();
        searchDropdown.style.display = 'block';
      } else {
        performSearch(searchInput.value.trim());
      }
    };

    const closeMobileSearch = () => {
      if (topbar) topbar.classList.remove('mobile-search-active');
      searchDropdown.style.display = 'none';
      searchInput.blur();
    };

    if (mobileSearchToggle) {
      mobileSearchToggle.addEventListener('click', (e) => {
        e.preventDefault();
        openAndFocusGlobalSearch();
      });
    }

    if (mobileSearchBackBtn) {
      mobileSearchBackBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeMobileSearch();
      });
    }

    // Wire all triggers with class .js-open-global-search (Sidebar, Footer, Dashboard)
    $$('.js-open-global-search').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openAndFocusGlobalSearch();
      });
    });

    // Global Keydown shortcuts: '/' (when not editing an input) and Ctrl+K / Cmd+K
    document.addEventListener('keydown', (e) => {
      const isSearchShortcut =
        (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k');

      if (isSearchShortcut) {
        e.preventDefault();
        openAndFocusGlobalSearch();
      } else if (e.key === 'Escape') {
        if (topbar && topbar.classList.contains('mobile-search-active')) {
          closeMobileSearch();
        } else if (document.activeElement === searchInput) {
          searchDropdown.style.display = 'none';
          searchInput.blur();
        }
      }
    });

    // Clear button functionality
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        searchDropdown.style.display = 'none';
        searchInput.focus();
        if (window.location.pathname.startsWith('/search')) {
          window.location.href = '/search';
        }
      });
    }

    const renderQuickCategories = () => {
      searchDropdown.innerHTML = `
        <div class="search-category-pill-bar">
          <span class="category-pill-title">Filters:</span>
          <button type="button" class="dsa-cat-chip ${activeCategory === 'ALL' ? 'is-active' : ''}" data-cat="ALL">All</button>
          <button type="button" class="dsa-cat-chip ${activeCategory === 'PATIENT' ? 'is-active' : ''}" data-cat="PATIENT">👥 Patients</button>
          <button type="button" class="dsa-cat-chip ${activeCategory === 'MEDICATION' ? 'is-active' : ''}" data-cat="MEDICATION">💊 Medications</button>
          <button type="button" class="dsa-cat-chip ${activeCategory === 'LAB_TEST' ? 'is-active' : ''}" data-cat="LAB_TEST">🧪 Labs</button>
          <button type="button" class="dsa-cat-chip ${activeCategory === 'DOCUMENT' ? 'is-active' : ''}" data-cat="DOCUMENT">📄 Docs</button>
          <button type="button" class="dsa-cat-chip ${activeCategory === 'RECORD' ? 'is-active' : ''}" data-cat="RECORD">🗂 Records</button>
        </div>
        <div class="search-initial-prompt">
          <span>Search across patient demographics, verified prescriptions, lab values, and clinical notes.</span>
          <div class="search-quick-tags">
            <span class="quick-tag-label">Try:</span>
            <button type="button" class="quick-suggest-btn" data-query="Paracetamol">Paracetamol</button>
            <button type="button" class="quick-suggest-btn" data-query="Metformin">Metformin</button>
            <button type="button" class="quick-suggest-btn" data-query="HbA1c">HbA1c</button>
            <button type="button" class="quick-suggest-btn" data-query="Hypertension">Hypertension</button>
          </div>
        </div>
      `;
      wireDropdownInteractions();
    };

    const wireDropdownInteractions = () => {
      // Category click
      searchDropdown.querySelectorAll('.dsa-cat-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          activeCategory = chip.dataset.cat;
          searchDropdown.querySelectorAll('.dsa-cat-chip').forEach((c) => c.classList.remove('is-active'));
          chip.classList.add('is-active');
          const q = searchInput.value.trim();
          if (q) performSearch(q);
        });
      });

      // Quick suggestions
      searchDropdown.querySelectorAll('.quick-suggest-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          searchInput.value = btn.dataset.query;
          if (clearBtn) clearBtn.style.display = 'inline-flex';
          performSearch(btn.dataset.query);
        });
      });
    };

    let debounceTimer = null;
    const performSearch = async (query) => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&category=${encodeURIComponent(activeCategory)}`);
        if (!res.ok) return;
        const data = await res.json();

        let html = `
          <div class="search-category-pill-bar">
            <span class="category-pill-title">Filters:</span>
            <button type="button" class="dsa-cat-chip ${activeCategory === 'ALL' ? 'is-active' : ''}" data-cat="ALL">All (${data.facets?.ALL || 0})</button>
            <button type="button" class="dsa-cat-chip ${activeCategory === 'PATIENT' ? 'is-active' : ''}" data-cat="PATIENT">👥 Patients (${data.facets?.PATIENT || 0})</button>
            <button type="button" class="dsa-cat-chip ${activeCategory === 'MEDICATION' ? 'is-active' : ''}" data-cat="MEDICATION">💊 Medications (${data.facets?.MEDICATION || 0})</button>
            <button type="button" class="dsa-cat-chip ${activeCategory === 'LAB_TEST' ? 'is-active' : ''}" data-cat="LAB_TEST">🧪 Labs (${data.facets?.LAB_TEST || 0})</button>
            <button type="button" class="dsa-cat-chip ${activeCategory === 'DOCUMENT' ? 'is-active' : ''}" data-cat="DOCUMENT">📄 Docs (${data.facets?.DOCUMENT || 0})</button>
            <button type="button" class="dsa-cat-chip ${activeCategory === 'RECORD' ? 'is-active' : ''}" data-cat="RECORD">🗂 Records (${data.facets?.RECORD || 0})</button>
          </div>
        `;

        // Typo suggestion banner
        if (data.suggestedQuery) {
          html += `
            <div class="search-dropdown-typo">
              💡 Did you mean: <a href="javascript:void(0)" class="typo-apply-link" data-query="${escapeHtml(data.suggestedQuery)}"><strong>${escapeHtml(data.suggestedQuery)}</strong></a>?
            </div>
          `;
        }

        if (data.results && data.results.length) {
          html += `<div class="search-results-list" role="listbox">`;
          data.results.slice(0, 8).forEach((item, idx) => {
            const badgeClass = (item.entityType || '').toLowerCase();
            html += `
              <a href="${item.url}" class="search-result-item dsa-result-item" data-index="${idx}" role="option">
                <div class="result-item-main">
                  <span class="dsa-entity-pill ${badgeClass}">${item.entityType || 'RECORD'}</span>
                  <div class="result-title-group">
                    <strong class="result-title">${escapeHtml(item.title)}</strong>
                    <small class="result-sub">${escapeHtml(item.subtitle)}</small>
                  </div>
                </div>
                <div class="result-item-aside">
                  <span class="result-score-badge">${Math.round(Math.max(0, Math.min(100, Number(item.score) > 1 ? Number(item.score) : Number(item.score || 0.9) * 100)))}% match</span>
                  <span class="result-jump-arrow">↗</span>
                </div>
              </a>
            `;
          });
          html += `</div>`;
        } else {
          html += `
            <div class="search-no-results-box">
              <span class="no-res-icon">🔎</span>
              <span>No clinical matches found for "${escapeHtml(query)}"</span>
              <small>Press Enter to open full results cockpit.</small>
            </div>
          `;
        }

        html += `
          <div class="search-dropdown-footer">
            <div class="footer-keyboard-hint">
              <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span><kbd>↵</kbd> open</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
            <a class="view-all-results-link" href="/search?q=${encodeURIComponent(query)}&category=${encodeURIComponent(activeCategory)}">
              <span>View full results (${data.total || 0})</span>
              <span>→</span>
            </a>
          </div>
        `;

        searchDropdown.innerHTML = html;
        searchDropdown.style.display = 'block';
        selectedIndex = -1;
        wireDropdownInteractions();

        // Wire typo apply link
        searchDropdown.querySelectorAll('.typo-apply-link').forEach((lnk) => {
          lnk.addEventListener('click', (e) => {
            e.preventDefault();
            searchInput.value = lnk.dataset.query;
            performSearch(lnk.dataset.query);
          });
        });
      } catch (err) {
        console.error('Unified Global search failed:', err);
      }
    };

    searchInput.addEventListener('input', () => {
      closeAllPopovers('search');
      clearTimeout(debounceTimer);
      const query = searchInput.value.trim();
      if (clearBtn) clearBtn.style.display = query ? 'inline-flex' : 'none';

      if (!query) {
        renderQuickCategories();
        searchDropdown.style.display = 'block';
        return;
      }

      debounceTimer = setTimeout(() => performSearch(query), 140);
    });

    searchInput.addEventListener('focus', () => {
      closeAllPopovers('search');
      const query = searchInput.value.trim();
      if (!query) {
        renderQuickCategories();
      } else {
        performSearch(query);
      }
      searchDropdown.style.display = 'block';
    });

    // Keyboard Arrow Navigation & Enter execution
    searchInput.addEventListener('keydown', (e) => {
      const items = searchDropdown.querySelectorAll('.dsa-result-item');
      if (items.length && searchDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIndex = (selectedIndex + 1) % items.length;
          updateSelectedResult(items);
          return;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          updateSelectedResult(items);
          return;
        } else if (e.key === 'Enter') {
          if (selectedIndex >= 0 && selectedIndex < items.length) {
            e.preventDefault();
            items[selectedIndex].click();
            return;
          }
        }
      }

      if (e.key === 'Enter') {
        const query = searchInput.value.trim();
        if (query) {
          e.preventDefault();
          searchDropdown.style.display = 'none';
          window.location.href = `/search?q=${encodeURIComponent(query)}&category=${encodeURIComponent(activeCategory)}`;
        }
      }
    });

    const updateSelectedResult = (items) => {
      items.forEach((item, idx) => {
        if (idx === selectedIndex) {
          item.classList.add('is-selected');
          item.scrollIntoView({ block: 'nearest' });
        } else {
          item.classList.remove('is-selected');
        }
      });
    };
  }

  // -------------------------------------------------------------
  // 4. Upload Page (Drag & Drop + Stepped Processing Overlay)
  // -------------------------------------------------------------
  const uploadForm = $('#clinicalUploadForm');
  const dropzone = $('#clinicalDropzone');
  const fileInput = $('#clinicalFileInput');
  const browseTrigger = $('#browseTrigger');
  const dropzoneContent = $('#dropzoneContent');
  const selectedBanner = $('#selectedFileBanner');
  const selectedName = $('#selectedFileName');
  const selectedSize = $('#selectedFileSize');
  const removeFileBtn = $('#removeFileBtn');
  const processingOverlay = $('#processingOverlay');
  const uploadClientError = $('#uploadClientError');
  const submitUploadBtn = $('#submitUploadBtn');
  const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
  const ALLOWED_UPLOAD_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp']);

  if (uploadForm && fileInput && dropzone) {
    const setClientError = (message) => {
      if (!uploadClientError) return;
      uploadClientError.textContent = message || '';
      uploadClientError.hidden = !message;
    };

    const fileExtension = (file) => String(file?.name || '').split('.').pop().toLowerCase();

    const validateFile = (file) => {
      if (!file) return 'Choose a clinical document before continuing.';
      if (!ALLOWED_UPLOAD_EXTENSIONS.has(fileExtension(file))) {
        return 'Upload a PDF, PNG, JPG, JPEG, or WEBP clinical record.';
      }
      if (file.size > MAX_UPLOAD_SIZE) {
        return 'This record is larger than the 15 MB upload limit.';
      }
      return '';
    };

    const handleFile = (file) => {
      if (!file) return;
      const validationError = validateFile(file);
      if (validationError) {
        fileInput.value = '';
        if (selectedBanner) selectedBanner.style.display = 'none';
        if (dropzoneContent) dropzoneContent.style.display = 'block';
        setClientError(validationError);
        return false;
      }
      setClientError('');
      if (selectedName) selectedName.textContent = file.name;
      if (selectedSize) selectedSize.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
      if (dropzoneContent) dropzoneContent.style.display = 'none';
      if (selectedBanner) selectedBanner.style.display = 'flex';
      return true;
    };

    browseTrigger?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileInput.click();
    });

    dropzone.addEventListener('click', () => {
      if (!fileInput.files.length) fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      handleFile(fileInput.files[0]);
    });

    fileInput.addEventListener('invalid', () => {
      setClientError('Choose a clinical document before continuing.');
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('drag-over');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const file = dt?.files?.[0];
      if (!file) return;
      if (!handleFile(file)) return;
      try {
        if (typeof DataTransfer !== 'undefined') {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          fileInput.files = transfer.files;
        }
      } catch (error) {
        // Older browsers may not allow programmatic assignment to file inputs.
        // The browse control remains available as a safe fallback.
        setClientError('The dropped file could not be attached in this browser. Please use “browse files”.');
        if (selectedBanner) selectedBanner.style.display = 'none';
        if (dropzoneContent) dropzoneContent.style.display = 'block';
      }
    });

    removeFileBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.value = '';
      if (selectedBanner) selectedBanner.style.display = 'none';
      if (dropzoneContent) dropzoneContent.style.display = 'block';
      setClientError('');
    });

    // Stepped Processing Simulation on Submit
    uploadForm.addEventListener('submit', (e) => {
      const file = fileInput.files[0];
      const validationError = validateFile(file);
      if (validationError) {
        e.preventDefault();
        setClientError(validationError);
        fileInput.focus();
        if (processingOverlay) processingOverlay.style.display = 'none';
        return;
      }
      setClientError('');
      if (submitUploadBtn) {
        submitUploadBtn.disabled = true;
        submitUploadBtn.setAttribute('aria-busy', 'true');
      }
      if (processingOverlay) {
        processingOverlay.style.display = 'flex';
        processingOverlay.setAttribute('aria-hidden', 'false');
        simulateProcessingSteps();
      }
    });

    function simulateProcessingSteps() {
      const steps = [
        { id: 'step-1', delay: 200 },
        { id: 'step-2', delay: 700 },
        { id: 'step-3', delay: 1300 },
        { id: 'step-4', delay: 1900 },
        { id: 'step-5', delay: 2400 },
      ];

      steps.forEach((s) => {
        setTimeout(() => {
          const el = document.getElementById(s.id);
          if (el) {
            el.classList.add('active');
            el.classList.add('done');
          }
        }, s.delay);
      });
    }
  }

  // -------------------------------------------------------------
  // 5. Hero Feature: 3-Zone Clinical Verification Workspace
  // -------------------------------------------------------------
  const workspaceContainer = $('.verification-workspace-container');
  if (workspaceContainer) {
    const stage = $('#viewerStage');
    const viewport = $('#viewerViewport');
    const highlightsOverlay = $('#highlightsOverlay');
    const btnZoomIn = $('#btnZoomIn');
    const btnZoomOut = $('#btnZoomOut');
    const btnZoomReset = $('#btnZoomReset');
    const btnRotate = $('#btnRotate');
    const btnToggleHighlights = $('#btnToggleHighlights');
    const btnFocusSource = $('#btnFocusSourceImage');

    let currentScale = 1;
    let currentRotation = 0;
    let highlightsVisible = true;
    const correctedFields = { ...(window.clinicalWorkspaceData?.fieldStates || {}) };

    const updateFieldState = (card, status, originalValue, value) => {
      const entityId = card.dataset.entityId || 'field';
      correctedFields[entityId] = {
        status,
        section: card.dataset.section || 'field',
        field: card.dataset.fieldName || card.dataset.name || card.dataset.testName || entityId,
        originalValue,
        value,
        updatedAt: new Date().toISOString(),
      };
    };

    const updateTransform = () => {
      if (stage) {
        stage.style.transform = `scale(${currentScale}) rotate(${currentRotation}deg)`;
      }
    };

    btnZoomIn?.addEventListener('click', () => {
      currentScale = Math.min(currentScale + 0.2, 3);
      updateTransform();
    });

    btnZoomOut?.addEventListener('click', () => {
      currentScale = Math.max(currentScale - 0.2, 0.4);
      updateTransform();
    });

    btnZoomReset?.addEventListener('click', () => {
      currentScale = 1;
      currentRotation = 0;
      updateTransform();
      if (viewport) {
        viewport.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
      }
    });

    btnRotate?.addEventListener('click', () => {
      currentRotation = (currentRotation + 90) % 360;
      updateTransform();
    });

    btnToggleHighlights?.addEventListener('click', () => {
      highlightsVisible = !highlightsVisible;
      btnToggleHighlights.classList.toggle('is-active', highlightsVisible);
      if (highlightsOverlay) {
        highlightsOverlay.style.display = highlightsVisible ? 'block' : 'none';
      }
    });

    // Relink patient match toggle
    const btnToggleRelink = $('#btnToggleRelink');
    const patientMatchSelectionBox = $('#patientMatchSelectionBox');
    btnToggleRelink?.addEventListener('click', () => {
      if (patientMatchSelectionBox) {
        const isHidden = patientMatchSelectionBox.style.display === 'none';
        patientMatchSelectionBox.style.display = isHidden ? 'block' : 'none';
        btnToggleRelink.textContent = isHidden ? 'Cancel Re-match' : 'Change Patient Match';
      }
    });

    // Build interactive bounding boxes across ALL 7 clinical sections
    const entityCards = $$('.entity-item-card', workspaceContainer);
    const boundingBoxes = [];

    const sourceDocumentImage = $('#sourceDocumentImage');
    const sourceUnavailable = $('#sourceUnavailable');
    const setHighlightAvailability = (available) => {
      if (!btnToggleHighlights) return;
      btnToggleHighlights.disabled = !available;
      btnToggleHighlights.classList.toggle('is-disabled', !available);
      if (!available) btnToggleHighlights.title = 'Source image is unavailable, so field highlights cannot be shown';
    };

    const clearHighlights = () => {
      boundingBoxes.splice(0, boundingBoxes.length);
      if (highlightsOverlay) highlightsOverlay.replaceChildren();
    };

    const buildHighlights = () => {
      if (!highlightsOverlay || !sourceDocumentImage || sourceDocumentImage.naturalWidth < 1) return;
      clearHighlights();

      entityCards.forEach((card, idx) => {
        let boundingBox = null;
        try { boundingBox = JSON.parse(card.dataset.boundingBox || 'null'); } catch { boundingBox = null; }
        if (!Array.isArray(boundingBox) || boundingBox.length !== 4 || boundingBox.some((value) => !Number.isFinite(Number(value)))) return;
        const [ymin, xmin, ymax, xmax] = boundingBox.map(Number);
        if (ymin < 0 || xmin < 0 || ymax > 100 || xmax > 100 || ymax <= ymin || xmax <= xmin) return;

        const name = String(card.dataset.fieldName || card.dataset.name || card.dataset.testName || 'Clinical field');
        const section = card.dataset.section || 'field';
        const entityId = card.dataset.entityId || `entity-${idx}`;
        const box = document.createElement('div');
        box.className = `source-bounding-box section-${section}`;
        box.style.left = `${xmin}%`;
        box.style.top = `${ymin}%`;
        box.style.width = `${xmax - xmin}%`;
        box.style.height = `${ymax - ymin}%`;
        box.dataset.entityId = entityId;
        box.dataset.entityIndex = idx;
        box.innerHTML = `<span class="source-bounding-box-label">${escapeHtml(name)}</span>`;
        box.addEventListener('click', (event) => {
          event.stopPropagation();
          selectEntityCard(card, true);
        });
        highlightsOverlay.appendChild(box);
        boundingBoxes.push(box);
      });

      setHighlightAvailability(boundingBoxes.length > 0);
    };

    if (sourceDocumentImage) {
      const showUnavailableSource = () => {
        sourceDocumentImage.style.display = 'none';
        if (sourceUnavailable) sourceUnavailable.style.display = 'block';
        clearHighlights();
        setHighlightAvailability(false);
      };
      sourceDocumentImage.addEventListener('load', buildHighlights, { once: true });
      sourceDocumentImage.addEventListener('error', showUnavailableSource, { once: true });
      if (sourceDocumentImage.complete) {
        if (sourceDocumentImage.naturalWidth > 0) buildHighlights();
        else showUnavailableSource();
      }
    } else {
      setHighlightAvailability(false);
    }

    // Inspector Elements
    const inspectorTypeBadge = $('#inspectorFieldTypeBadge');
    const inspectorScore = $('#inspectorConfidenceScore');
    const snippetDisplay = $('#snippetTextDisplay');
    const aiValDisplay = $('#inspectorAiValDisplay');
    const medicationFields = $('#medicationEditFields');
    const genericFields = $('#genericEditFields');
    const genericLabel = $('#genericEditLabel');
    const genericInput = $('#editGenericValue');
    const editName = $('#editFieldName');
    const editDosage = $('#editFieldDosage');
    const editFrequency = $('#editFieldFrequency');
    const editInstructions = $('#editFieldInstructions');
    const btnAcceptAi = $('#btnAcceptAiValue');
    const btnUpdateField = $('#btnUpdateActiveField');
    const btnMarkUnclear = $('#btnMarkUnclear');

    let activeSelectedCard = entityCards[0] || null;

    Object.entries(correctedFields).forEach(([entityId, state]) => {
      const card = entityCards.find((candidate) => candidate.dataset.entityId === entityId);
      if (!card || !state || typeof state !== 'object') return;
      const status = String(state.status || '');
      if (!status) return;
      card.dataset.status = status;
      if (state.value !== undefined && state.value !== null) card.dataset.currentValue = String(state.value);
      card.classList.toggle('has-warning', status === 'review_required' || status === 'unresolved');
      if (!['clinician_corrected', 'clinician_verified', 'unresolved'].includes(status)) return;
      let stamp = card.querySelector('.field-verified-stamp');
      if (!stamp) {
        stamp = document.createElement('span');
        stamp.className = 'field-verified-stamp';
        (card.querySelector('.entity-source-footer') || card).appendChild(stamp);
      }
      stamp.textContent = status === 'clinician_corrected' ? '✓ Corrected' : status === 'clinician_verified' ? '✓ Verified' : '⚠ Unclear';
      stamp.style.color = status === 'clinician_corrected' ? '#0284c7' : status === 'clinician_verified' ? '#15803d' : '#d97706';
    });

    function focusBoundingBox(card) {
      if (!card) return;
      let boundingBox = null;
      try { boundingBox = JSON.parse(card.dataset.boundingBox || 'null'); } catch { boundingBox = null; }
      if (!Array.isArray(boundingBox) || !viewport) return;
      const [ymin, xmin, ymax, xmax] = boundingBox.map(Number);
      const stageHeight = stage?.clientHeight || 800;
      const targetY = (ymin / 100) * stageHeight;
      viewport.scrollTo({
        top: Math.max(0, targetY - 120),
        behavior: 'smooth',
      });
    }

    btnFocusSource?.addEventListener('click', () => {
      focusBoundingBox(activeSelectedCard);
    });

    function selectEntityCard(card, shouldScrollCard = false) {
      if (!card) return;
      activeSelectedCard = card;

      entityCards.forEach((c) => c.classList.remove('is-selected'));
      card.classList.add('is-selected');

      if (shouldScrollCard && card.scrollIntoView) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      const cardEntityId = card.dataset.entityId;
      boundingBoxes.forEach((b) => {
        b.classList.toggle('is-active-highlight', b.dataset.entityId === cardEntityId);
      });

      // Populate Inspector
      const section = card.dataset.section || 'field';
      const fieldName = card.dataset.fieldName || card.dataset.name || card.dataset.testName || 'Field';
      const conf = Number(card.dataset.confidence || 90);
      const aiValue = card.dataset.aiValue || '';
      const currentValue = card.dataset.currentValue || aiValue;
      const editorValue = section === 'investigation' ? (card.dataset.value || '') : currentValue;
      const snippet = card.dataset.sourceSnippet || '';
      const status = card.dataset.status || 'ai_extracted';

      if (inspectorTypeBadge) {
        inspectorTypeBadge.textContent = `${section.toUpperCase()} · ${fieldName.toUpperCase()}`;
      }

      if (inspectorScore) {
        if (status === 'clinician_corrected') {
          inspectorScore.innerHTML = '<span class="status-dot green"></span> Clinician Corrected';
        } else if (status === 'clinician_verified') {
          inspectorScore.innerHTML = '<span class="status-dot green"></span> Clinician Accepted';
        } else if (conf < 70 || status === 'review_required') {
          inspectorScore.innerHTML = `<span class="status-dot red"></span> Review Required · Signal: ${conf}%`;
        } else {
          inspectorScore.innerHTML = `<span class="status-dot green"></span> Confidence: ${conf}% · AI extracted`;
        }
      }

      if (snippetDisplay) {
        snippetDisplay.textContent = snippet ? `"${snippet}"` : `No OCR snippet. Refer to document ink.`;
      }

      if (aiValDisplay) {
        aiValDisplay.textContent = aiValue || 'None extracted by model';
      }

      // Toggle between medication multi-field and generic single-field editors
      if (section === 'medication') {
        if (medicationFields) medicationFields.style.display = 'block';
        if (genericFields) genericFields.style.display = 'none';
        if (editName) editName.value = card.dataset.name || '';
        if (editDosage) editDosage.value = card.dataset.dosage || '';
        if (editFrequency) editFrequency.value = card.dataset.frequency || '';
        if (editInstructions) editInstructions.value = card.dataset.instructions || '';
      } else {
        if (medicationFields) medicationFields.style.display = 'none';
        if (genericFields) genericFields.style.display = 'block';
        if (genericLabel) genericLabel.textContent = section === 'investigation' ? `Verified ${fieldName} result` : `Verified ${fieldName}`;
        if (genericInput) genericInput.value = editorValue;
      }
    }

    entityCards.forEach((card) => {
      card.addEventListener('click', () => {
        selectEntityCard(card, false);
        focusBoundingBox(card);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectEntityCard(card, false);
          focusBoundingBox(card);
        }
      });
    });

    // Action 1: Accept AI Value
    btnAcceptAi?.addEventListener('click', () => {
      if (!activeSelectedCard) return;
      const aiVal = activeSelectedCard.dataset.aiValue || '';
      const section = activeSelectedCard.dataset.section || 'field';
      const oldVal = activeSelectedCard.dataset.currentValue || aiVal;

      activeSelectedCard.dataset.status = 'clinician_verified';
      activeSelectedCard.dataset.currentValue = aiVal;
      activeSelectedCard.classList.remove('has-warning');

      let stamp = activeSelectedCard.querySelector('.field-verified-stamp');
      if (!stamp) {
        stamp = document.createElement('span');
        stamp.className = 'field-verified-stamp';
        const footer = activeSelectedCard.querySelector('.entity-source-footer') || activeSelectedCard;
        footer.appendChild(stamp);
      }
      stamp.textContent = '✓ Verified';
      stamp.style.color = '#15803d';

      if (section === 'medication') {
        activeSelectedCard.dataset.isVerified = 'true';
      } else if (section === 'investigation') {
        activeSelectedCard.dataset.currentValue = activeSelectedCard.dataset.value || '';
        if (genericInput) genericInput.value = activeSelectedCard.dataset.value || '';
      } else if (genericInput) {
        genericInput.value = aiVal;
      }
      const acceptedValue = section === 'investigation' ? (activeSelectedCard.dataset.value || '') : aiVal;
      updateFieldState(activeSelectedCard, 'clinician_verified', oldVal, acceptedValue);

      syncPayloadInputs();
      selectEntityCard(activeSelectedCard);

      btnAcceptAi.textContent = '✓ Accepted';
      setTimeout(() => { btnAcceptAi.textContent = '✓ Accept'; }, 1200);
    });

    // Action 2: Apply Clinician Correction
    btnUpdateField?.addEventListener('click', () => {
      if (!activeSelectedCard) return;
      const section = activeSelectedCard.dataset.section || 'field';
      const entityId = activeSelectedCard.dataset.entityId || 'field';
      const oldVal = activeSelectedCard.dataset.currentValue || activeSelectedCard.dataset.aiValue || '';

      let newVal = '';
      if (section === 'medication') {
        const newName = editName ? editName.value.trim() : '';
        const newDose = editDosage ? editDosage.value.trim() : '';
        const newFreq = editFrequency ? editFrequency.value.trim() : '';
        const newInst = editInstructions ? editInstructions.value.trim() : '';

        activeSelectedCard.dataset.name = newName;
        activeSelectedCard.dataset.dosage = newDose;
        activeSelectedCard.dataset.frequency = newFreq;
        activeSelectedCard.dataset.instructions = newInst;
        newVal = `${newName} ${newDose} ${newFreq}`.trim();
        activeSelectedCard.dataset.currentValue = newVal;

        const titleEl = $('.entity-primary-name', activeSelectedCard);
        if (titleEl) titleEl.textContent = newName;

        const subEl = $('.entity-sub-row', activeSelectedCard);
        if (subEl) {
          subEl.innerHTML = `<span class="entity-detail">${escapeHtml(newDose)}</span> <span class="bullet-sep">·</span> <span class="entity-detail">${escapeHtml(newFreq)}</span>`;
        }
      } else {
        newVal = genericInput ? genericInput.value.trim() : '';
        activeSelectedCard.dataset.currentValue = newVal;
        if (section === 'investigation') activeSelectedCard.dataset.value = newVal;

        if (section === 'investigation') {
          const resultEl = $('.lab-val', activeSelectedCard);
          if (resultEl) resultEl.textContent = `${newVal}${activeSelectedCard.dataset.units ? ` ${activeSelectedCard.dataset.units}` : ''}`;
        } else {
          const titleEl = $('.entity-primary-name', activeSelectedCard);
          if (titleEl) titleEl.textContent = newVal;
        }
      }

      activeSelectedCard.dataset.status = 'clinician_corrected';
      activeSelectedCard.classList.remove('has-warning');

      let stamp = activeSelectedCard.querySelector('.field-verified-stamp');
      if (!stamp) {
        stamp = document.createElement('span');
        stamp.className = 'field-verified-stamp';
        const footer = activeSelectedCard.querySelector('.entity-source-footer') || activeSelectedCard;
        footer.appendChild(stamp);
      }
      stamp.textContent = '✓ Corrected';
      stamp.style.color = '#0284c7';

      // Record field correction audit trail
      updateFieldState(activeSelectedCard, 'clinician_corrected', oldVal, newVal);

      syncPayloadInputs();
      selectEntityCard(activeSelectedCard);

      btnUpdateField.textContent = '✓ Saved';
      setTimeout(() => { btnUpdateField.textContent = '✎ Apply Correction'; }, 1200);
    });

    // Action 3: Mark Unclear / Review Required
    btnMarkUnclear?.addEventListener('click', () => {
      if (!activeSelectedCard) return;
      const oldVal = activeSelectedCard.dataset.currentValue || activeSelectedCard.dataset.aiValue || '';
      activeSelectedCard.dataset.status = 'review_required';
      activeSelectedCard.classList.add('has-warning');

      let stamp = activeSelectedCard.querySelector('.field-verified-stamp');
      if (!stamp) {
        stamp = document.createElement('span');
        stamp.className = 'field-verified-stamp';
        const footer = activeSelectedCard.querySelector('.entity-source-footer') || activeSelectedCard;
        footer.appendChild(stamp);
      }
      stamp.textContent = '⚠ Unclear';
      stamp.style.color = '#d97706';

      updateFieldState(activeSelectedCard, 'unresolved', oldVal, oldVal);

      syncPayloadInputs();
      selectEntityCard(activeSelectedCard);

      btnMarkUnclear.textContent = '⚠ Flagged';
      setTimeout(() => { btnMarkUnclear.textContent = '⚠ Mark Unclear'; }, 1200);
    });

    const cloneStructuredData = () => {
      const source = window.clinicalWorkspaceData?.structuredData;
      try { return JSON.parse(JSON.stringify(source && typeof source === 'object' ? source : {})); } catch { return {}; }
    };

    const sourceForCard = (card, boundingBox) => ({
      page: 1,
      boundingBox: Array.isArray(boundingBox) ? boundingBox : null,
      textSnippet: card.dataset.sourceSnippet || '',
    });

    const reviewField = (existing, value, status, confidence, source) => {
      const prior = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      return {
        ...prior,
        value,
        confidence: Number.isFinite(Number(prior.confidence)) ? Number(prior.confidence) : confidence,
        status,
        source: prior.source && typeof prior.source === 'object' ? prior.source : source,
      };
    };

    const setStructuredField = (target, path, value, status, confidence, source) => {
      if (!path) return;
      const segments = path.split('.').filter(Boolean);
      let cursor = target;
      segments.forEach((segment, index) => {
        const isLast = index === segments.length - 1;
        if (isLast) {
          cursor[segment] = reviewField(cursor[segment], value, status, confidence, source);
          return;
        }
        const nextIsIndex = /^\d+$/.test(segments[index + 1]);
        if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = nextIsIndex ? [] : {};
        cursor = cursor[segment];
      });
    };

    function syncPayloadInputs() {
      const meds = [];
      const labs = [];
      const structuredCopy = cloneStructuredData();
      const structuredMeds = Array.isArray(structuredCopy.medications) ? structuredCopy.medications : [];
      const structuredLabs = Array.isArray(structuredCopy.investigations) ? structuredCopy.investigations : [];

      $$('.entity-item-card', workspaceContainer).forEach((card) => {
        const section = card.dataset.section;
        const status = card.dataset.status || 'ai_extracted';
        const confidence = Number(card.dataset.confidence || 90) / 100;
        let boundingBox = null;
        try { boundingBox = JSON.parse(card.dataset.boundingBox || 'null'); } catch {}
        const source = sourceForCard(card, boundingBox);

        if (section === 'medication') {
          const medication = {
            name: card.dataset.name || '',
            dosage: card.dataset.dosage || '',
            frequency: card.dataset.frequency || '',
            route: card.dataset.route || '',
            duration: card.dataset.duration || '',
            instructions: card.dataset.instructions || '',
            confidence,
            confidenceTier: card.dataset.tier || (confidence >= 0.8 ? 'HIGH' : 'NEEDS_VERIFICATION'),
            sourceRegion: source,
            isVerified: status === 'clinician_verified' || status === 'clinician_corrected',
          };
          meds.push(medication);
          const index = Number(card.dataset.index || meds.length - 1);
          const previous = structuredMeds[index] && typeof structuredMeds[index] === 'object' ? structuredMeds[index] : {};
          structuredMeds[index] = {
            ...previous,
            name: reviewField(previous.name, medication.name, status, confidence, source),
            dosage: reviewField(previous.dosage, medication.dosage, status, confidence, source),
            frequency: reviewField(previous.frequency, medication.frequency, status, confidence, source),
            route: reviewField(previous.route, medication.route, status, confidence, source),
            duration: reviewField(previous.duration, medication.duration, status, confidence, source),
            instructions: reviewField(previous.instructions, medication.instructions, status, confidence, source),
            overallStatus: status,
          };
        } else if (section === 'investigation') {
          const clinicalStatus = card.dataset.clinicalStatus || 'UNKNOWN';
          const lab = {
            testName: card.dataset.testName || '',
            resultValue: card.dataset.value || '',
            units: card.dataset.units || '',
            referenceRange: card.dataset.range || '',
            status: clinicalStatus,
            confidence,
            sourceRegion: source,
            isVerified: status === 'clinician_verified' || status === 'clinician_corrected',
          };
          labs.push(lab);
          const index = Number(card.dataset.index || labs.length - 1);
          const previous = structuredLabs[index] && typeof structuredLabs[index] === 'object' ? structuredLabs[index] : {};
          structuredLabs[index] = {
            ...previous,
            testName: reviewField(previous.testName, lab.testName, status, confidence, source),
            resultValue: reviewField(previous.resultValue, lab.resultValue, status, confidence, source),
            units: reviewField(previous.units, lab.units, status, confidence, source),
            referenceRange: reviewField(previous.referenceRange, lab.referenceRange, status, confidence, source),
            abnormalFlag: clinicalStatus,
            overallStatus: status,
          };
        } else {
          const value = card.dataset.currentValue || card.dataset.aiValue || '';
          setStructuredField(structuredCopy, card.dataset.structuredPath, value, status, confidence, source);
        }
      });

      structuredCopy.medications = structuredMeds;
      structuredCopy.investigations = structuredLabs;
      if (window.clinicalWorkspaceData) window.clinicalWorkspaceData.structuredData = structuredCopy;

      const medsInput = $('#medicationsJsonInput');
      const labsInput = $('#labResultsJsonInput');
      const structuredInput = $('#structuredDataJsonInput');
      const correctedInput = $('#correctedFieldsJsonInput');
      if (medsInput) medsInput.value = JSON.stringify(meds);
      if (labsInput) labsInput.value = JSON.stringify(labs);
      if (correctedInput) correctedInput.value = JSON.stringify(correctedFields);
      if (structuredInput) structuredInput.value = JSON.stringify(structuredCopy);
    }

    // Save Draft Handlers
    const docId = workspaceContainer.dataset.docId;
    const saveDraftAction = async () => {
      syncPayloadInputs();
      const form = $('#reviewForm');
      if (!form) return;
      const notes = $('#doctorNotesInput')?.value || '';
      const summary = $('#aiSummaryDisplay')?.textContent?.trim() || '';

      const draftForm = document.createElement('form');
      draftForm.method = 'post';
      draftForm.action = `/documents/${docId}/draft`;

      const appendHidden = (name, val) => {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = name;
        inp.value = val;
        draftForm.appendChild(inp);
      };

      appendHidden('medicationsJson', $('#medicationsJsonInput')?.value || '[]');
      appendHidden('labResultsJson', $('#labResultsJsonInput')?.value || '[]');
      appendHidden('structuredDataJson', $('#structuredDataJsonInput')?.value || '{}');
      appendHidden('correctedFieldsJson', $('#correctedFieldsJsonInput')?.value || '{}');
      appendHidden('fieldStatesJson', $('#correctedFieldsJsonInput')?.value || '{}');
      appendHidden('doctorNotes', notes);
      appendHidden('summary', summary);

      document.body.appendChild(draftForm);
      draftForm.submit();
    };

    $('#btnSaveDraftTop')?.addEventListener('click', saveDraftAction);
    $('#btnSaveDraftZone3')?.addEventListener('click', saveDraftAction);

    // Strict Approval Validation
    const reviewForm = $('#reviewForm');
    const handleApprovalSubmit = (e) => {
      syncPayloadInputs();
      const chk1 = $('#chkIdentity');
      const chk2 = $('#chkDosage');
      const chk3 = $('#chkFlags');
      const doctorInput = $('#doctorNameInput');

      if (!window.clinicalWorkspaceData?.patientId) {
        if (e) e.preventDefault();
        alert('Patient confirmation is required before this record can be approved & locked into EHR.');
        return false;
      }

      if ((chk1 && !chk1.checked) || (chk2 && !chk2.checked) || (chk3 && !chk3.checked)) {
        if (e) e.preventDefault();
        alert('Mandatory safety check: Please verify all three pre-approval validation checkboxes before signing.');
        return false;
      }

      if (doctorInput && !doctorInput.value.trim()) {
        if (e) e.preventDefault();
        alert('A signing healthcare professional name is required.');
        doctorInput.focus();
        return false;
      }

      return true;
    };

    reviewForm?.addEventListener('submit', (e) => {
      if (!handleApprovalSubmit(e)) e.preventDefault();
    });

    // Select initial card
    if (entityCards[0]) {
      selectEntityCard(entityCards[0], false);
    }
    syncPayloadInputs();
  }

  // -------------------------------------------------------------
  // 6. Patient Profile Tabs & Slide-out Ask AI Drawer
  // -------------------------------------------------------------
  const patientTabs = $$('.patient-tab-nav .tab-btn');
  const tabPanels = $$('.patient-tab-panels .tab-panel');

  if (patientTabs.length && tabPanels.length) {
    patientTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.tabTarget;
        patientTabs.forEach((b) => {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        tabPanels.forEach((p) => {
          p.classList.remove('is-active');
          p.style.display = 'none';
        });

        btn.classList.add('is-active');
        btn.setAttribute('aria-selected', 'true');
        const targetPanel = document.getElementById(targetId);
        if (targetPanel) {
          targetPanel.classList.add('is-active');
          targetPanel.style.display = 'block';
        }
      });
    });
  }

  // Contextual Ask AI Drawer
  const openAskAiBtn = $('#btnOpenAskAiDrawer');
  const closeAskAiBtn = $('#btnCloseAskAiDrawer');
  const askAiDrawer = $('#askAiDrawer');
  const askAiBackdrop = $('#askAiBackdrop');
  const drawerChatForm = $('#drawerChatForm');
  const drawerChatInput = $('#drawerChatInput');
  const drawerMessages = $('#drawerChatMessages');
  const patientContainer = $('.patient-profile-container');

  if (openAskAiBtn && askAiDrawer) {
    const toggleDrawer = (open) => {
      askAiDrawer.classList.toggle('is-open', open);
      if (askAiBackdrop) askAiBackdrop.style.display = open ? 'block' : 'none';
      if (open && drawerChatInput) drawerChatInput.focus();
    };

    openAskAiBtn.addEventListener('click', () => toggleDrawer(true));
    closeAskAiBtn?.addEventListener('click', () => toggleDrawer(false));
    askAiBackdrop?.addEventListener('click', () => toggleDrawer(false));

    // Chat execution
    const patientId = patientContainer?.dataset.patientId || '';

    const appendChatMessage = (role, text) => {
      const msg = document.createElement('div');
      msg.className = `chat-msg ${role === 'user' ? 'user-msg' : 'ai-msg'}`;
      msg.innerHTML = `<span class="chat-sender">${role === 'user' ? 'Clinician' : 'Clinical AI'}</span><p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>`;
      drawerMessages.appendChild(msg);
      drawerMessages.scrollTop = drawerMessages.scrollHeight;
    };

    const sendDrawerQuestion = async (query) => {
      if (!query.trim()) return;
      appendChatMessage('user', query);

      const loadingMsg = document.createElement('div');
      loadingMsg.className = 'chat-msg ai-msg';
      loadingMsg.innerHTML = '<span class="chat-sender">Clinical AI</span><p>Synthesizing verified medical records...</p>';
      drawerMessages.appendChild(loadingMsg);
      drawerMessages.scrollTop = drawerMessages.scrollHeight;

      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patientId, message: query }),
        });
        const data = await res.json();
        loadingMsg.remove();
        if (res.ok) {
          appendChatMessage('ai', data.reply || 'No direct record found for this query.');
        } else {
          appendChatMessage('ai', data.error || 'Clinical intelligence service is unavailable.');
        }
      } catch (err) {
        loadingMsg.remove();
        appendChatMessage('ai', 'Error connecting to clinical AI sandbox.');
      }
    };

    drawerChatForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = drawerChatInput.value.trim();
      if (!val) return;
      drawerChatInput.value = '';
      sendDrawerQuestion(val);
    });

    $$('.prompt-chip', askAiDrawer).forEach((chip) => {
      chip.addEventListener('click', () => {
        const p = chip.dataset.prompt;
        if (p) sendDrawerQuestion(p);
      });
    });
  }

  // -------------------------------------------------------------
  // 7. Clinical Record Detail (Version Comparison & Amendment Modal)
  // -------------------------------------------------------------
  const btnToggleCompare = $('#btnToggleCompare');
  const btnViewV1 = $('#btnViewV1');
  const btnCloseCompare = $('#btnCloseCompare');
  const comparePanel = $('#versionComparisonPanel');

  if (comparePanel) {
    const toggleCompare = () => {
      const isVisible = comparePanel.style.display !== 'none';
      comparePanel.style.display = isVisible ? 'none' : 'block';
    };

    btnToggleCompare?.addEventListener('click', toggleCompare);
    btnViewV1?.addEventListener('click', () => {
      comparePanel.style.display = 'block';
      comparePanel.scrollIntoView({ behavior: 'smooth' });
    });
    btnCloseCompare?.addEventListener('click', () => {
      comparePanel.style.display = 'none';
    });
  }

  // Amendment Modal
  const btnOpenAmend = $('#btnOpenAmendModal');
  const amendModal = $('#amendModalBackdrop');
  const btnCloseAmend = $('#btnCloseAmendModal');
  const btnCancelAmend = $('#btnCancelAmend');

  if (amendModal && btnOpenAmend) {
    btnOpenAmend.addEventListener('click', () => {
      amendModal.style.display = 'flex';
      const reasonBox = $('#amendmentReasonInput');
      if (reasonBox) reasonBox.focus();
    });

    const closeAmend = () => {
      amendModal.style.display = 'none';
    };

    btnCloseAmend?.addEventListener('click', closeAmend);
    btnCancelAmend?.addEventListener('click', closeAmend);
    amendModal.addEventListener('click', (e) => {
      if (e.target === amendModal) closeAmend();
    });
  }

  // -------------------------------------------------------------
  // 8. Integration Page: Copy FHIR JSON
  // -------------------------------------------------------------
  const btnCopyFhir = $('#btnCopyFhir');
  const fhirPreviewBlock = $('#fhirPreviewBlock');

  if (btnCopyFhir && fhirPreviewBlock) {
    btnCopyFhir.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(fhirPreviewBlock.textContent.trim());
        const copyLabel = btnCopyFhir.querySelector('.copy-label') || btnCopyFhir;
        const originalText = copyLabel.textContent;
        copyLabel.textContent = 'Copied ✓';
        btnCopyFhir.classList.add('is-copied');
        setTimeout(() => {
          copyLabel.textContent = originalText;
          btnCopyFhir.classList.remove('is-copied');
        }, 1500);
      } catch (err) {
        console.error('Clipboard copy failed:', err);
      }
    });
  }

  // -------------------------------------------------------------
  // 9. Audit Trail: Payload Inspector Drawer
  // -------------------------------------------------------------
  const auditDrawerOverlay = $('#auditDrawerOverlay');
  const auditDrawerCloseBtn = $('#auditDrawerCloseBtn');
  const drawerEventBadge = $('#drawerEventBadge');
  const drawerEventTitle = $('#drawerEventTitle');
  const drawerActorName = $('#drawerActorName');
  const drawerTimestamp = $('#drawerTimestamp');
  const drawerPatientName = $('#drawerPatientName');
  const drawerPayloadCode = $('#drawerPayloadCode');
  const btnCopyPayload = $('#btnCopyPayload');

  if (auditDrawerOverlay) {
    const openDrawer = (btn) => {
      const eventName = btn.dataset.event || 'EVENT';
      const actor = btn.dataset.actor || 'System';
      const role = btn.dataset.role || 'DOCTOR';
      const time = btn.dataset.time || '—';
      const patient = btn.dataset.patient || 'System Event';
      const doc = btn.dataset.doc || '';
      let payload = '{}';
      try {
        payload = decodeURIComponent(btn.dataset.payload || '{}');
      } catch {
        payload = btn.dataset.payload || '{}';
      }

      if (drawerEventBadge) drawerEventBadge.textContent = eventName;
      if (drawerEventTitle) drawerEventTitle.textContent = `${eventName.replace(/_/g, ' ')} Details`;
      if (drawerActorName) drawerActorName.textContent = `${actor} (${role})`;
      if (drawerTimestamp) drawerTimestamp.textContent = time;
      if (drawerPatientName) drawerPatientName.textContent = doc ? `${patient} · ${doc}` : patient;
      if (drawerPayloadCode) drawerPayloadCode.textContent = payload;

      auditDrawerOverlay.style.display = 'flex';
      auditDrawerOverlay.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    };

    const closeDrawer = () => {
      auditDrawerOverlay.style.display = 'none';
      auditDrawerOverlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    };

    $$('.js-open-audit-payload').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openDrawer(btn);
      });
    });

    auditDrawerCloseBtn?.addEventListener('click', closeDrawer);

    auditDrawerOverlay.addEventListener('click', (e) => {
      if (e.target === auditDrawerOverlay) closeDrawer();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && auditDrawerOverlay.style.display === 'flex') {
        closeDrawer();
      }
    });

    btnCopyPayload?.addEventListener('click', async () => {
      try {
        if (drawerPayloadCode) {
          await navigator.clipboard.writeText(drawerPayloadCode.textContent);
          const textSpan = $('.copy-text', btnCopyPayload);
          if (textSpan) textSpan.textContent = 'Copied ✓';
          setTimeout(() => {
            if (textSpan) textSpan.textContent = 'Copy JSON';
          }, 1500);
        }
      } catch (err) {
        console.error('Clipboard copy failed:', err);
      }
    });
  }

  // -------------------------------------------------------------
  // 10. Clinical Copilot Workspace (/assistant)
  // -------------------------------------------------------------
  const assistantContainer = $('[data-assistant]');
  if (assistantContainer) {
    const patientSelect = $('[data-assistant-patient]');
    const messageList = $('[data-message-list]', assistantContainer);
    const chatForm = $('[data-chat-form]', assistantContainer);
    const chatInput = chatForm ? $('input[name="message"]', chatForm) : null;
    const soapPrompt = $('[data-soap-prompt]', assistantContainer);
    const btnGenerateSoap = $('[data-generate-soap]', assistantContainer);
    const soapOutput = $('[data-soap-output]', assistantContainer);
    const btnCopySoap = $('[data-copy-soap]');
    let activeSoapText = '';

    // Patient Context Switcher
    patientSelect?.addEventListener('change', () => {
      const selectedId = patientSelect.value;
      if (selectedId) {
        window.location.href = `/assistant?patient=${encodeURIComponent(selectedId)}`;
      }
    });

    // Chat Message Rendering
    const appendUserMessage = (text) => {
      const el = document.createElement('div');
      el.className = 'message user';
      el.innerHTML = `<p>${escapeHtml(text)}</p>`;
      messageList.appendChild(el);
      messageList.scrollTop = messageList.scrollHeight;
    };

    const appendAssistantMessage = (reply, citations = [], flags = []) => {
      const el = document.createElement('div');
      el.className = 'message assistant';
      let metaHtml = '';
      if (citations && citations.length) {
        metaHtml = `<span class="message-meta">Source: ${escapeHtml(citations.join(' · '))}</span>`;
      }
      el.innerHTML = `<p>${escapeHtml(reply)}${metaHtml}</p>`;
      messageList.appendChild(el);

      if (flags && flags.length) {
        const alertEl = document.createElement('div');
        alertEl.className = 'message alert';
        alertEl.innerHTML = `<p>⚠ ${escapeHtml(flags.join('; '))}</p>`;
        messageList.appendChild(alertEl);
      }

      messageList.scrollTop = messageList.scrollHeight;
    };

    const appendLoadingIndicator = () => {
      const el = document.createElement('div');
      el.className = 'message assistant is-loading';
      el.innerHTML = '<p>Synthesizing verified medical records…</p>';
      messageList.appendChild(el);
      messageList.scrollTop = messageList.scrollHeight;
      return el;
    };

    // Chat Form Submission
    chatForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = (chatInput?.value || '').trim();
      if (!question) return;
      const patientId = patientSelect?.value || '';
      if (!patientId) {
        alert('Please select a patient context.');
        return;
      }

      appendUserMessage(question);
      chatInput.value = '';
      const loader = appendLoadingIndicator();

      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patientId, message: question }),
        });
        const data = await res.json();
        loader.remove();
        if (res.ok) {
          appendAssistantMessage(data.reply || 'No direct record found.', data.citations, data.clinicalFlags);
        } else {
          appendAssistantMessage(data.error || 'The clinical assistant is currently unavailable.');
        }
      } catch (err) {
        loader.remove();
        appendAssistantMessage('Connection error. Please try again.');
      }
    });

    // Suggestion Prompt Chips
    $$('.suggestion-row button[data-prompt]', assistantContainer).forEach((btn) => {
      btn.addEventListener('click', () => {
        const prompt = btn.dataset.prompt;
        if (prompt && chatInput) {
          chatInput.value = prompt;
          chatForm?.requestSubmit();
        }
      });
    });

    // SOAP Note Generation
    btnGenerateSoap?.addEventListener('click', async () => {
      const patientId = patientSelect?.value || '';
      if (!patientId) {
        alert('Please select a patient context.');
        return;
      }
      const doctorPrompt = (soapPrompt?.value || '').trim();

      const originalText = btnGenerateSoap.textContent;
      btnGenerateSoap.disabled = true;
      btnGenerateSoap.textContent = '✦ Generating structured note…';

      try {
        const res = await fetch('/api/assistant/soap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patientId, doctorPrompt }),
        });
        const data = await res.json();
        if (res.ok && soapOutput) {
          activeSoapText = `SUBJECTIVE:\n${data.subjective || 'Not documented'}\n\nOBJECTIVE:\n${data.objective || 'Not documented'}\n\nASSESSMENT:\n${data.assessment || 'Not documented'}\n\nPLAN:\n${data.plan || 'Not documented'}`;

          soapOutput.innerHTML = `
            <div class="soap-section">
              <b>S <span>Subjective</span></b>
              <p>${escapeHtml(data.subjective || 'Not documented')}</p>
            </div>
            <div class="soap-section">
              <b>O <span>Objective</span></b>
              <p>${escapeHtml(data.objective || 'Not documented')}</p>
            </div>
            <div class="soap-section">
              <b>A <span>Assessment</span></b>
              <p>${escapeHtml(data.assessment || 'Not documented')}</p>
            </div>
            <div class="soap-section">
              <b>P <span>Plan</span></b>
              <p>${escapeHtml(data.plan || 'Not documented')}</p>
            </div>
          `;
          if (btnCopySoap) btnCopySoap.hidden = false;
        } else {
          alert(data.error || 'Failed to generate consultation note.');
        }
      } catch (err) {
        alert('Failed to connect to consultation note service.');
      } finally {
        btnGenerateSoap.disabled = false;
        btnGenerateSoap.textContent = originalText;
      }
    });

    // Copy SOAP Note to Clipboard
    btnCopySoap?.addEventListener('click', async () => {
      if (!activeSoapText) return;
      try {
        await navigator.clipboard.writeText(activeSoapText);
        btnCopySoap.textContent = 'Copied ✓';
        setTimeout(() => {
          btnCopySoap.textContent = 'Copy';
        }, 1500);
      } catch (err) {
        console.error('Clipboard copy failed:', err);
      }
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
})();
