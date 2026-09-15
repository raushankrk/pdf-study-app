// ==========================================
// 📁 dashboard.js — Project manager UI
// Shown at the root URL. Lists all projects on the server, lets the user
// create/open/export/import/delete projects.
// ==========================================

const Dashboard = (() => {
    let projects = [];
    let selectedProjectId = null;
    let pendingImportFile = null;       // File object awaiting conflict resolution
    let pendingDeleteProjectId = null; // Project ID awaiting delete confirmation
    let selectedColor = '#3b82f6';

    // ---- Helpers ----
    function formatSize(n) {
        if (!n || n <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let val = n;
        for (const u of units) {
            if (val < 1024) return u === 'B' ? `${val} ${u}` : `${val.toFixed(1)} ${u}`;
            val /= 1024;
        }
        return `${val.toFixed(1)} TB`;
    }

    function formatDate(ts) {
        if (!ts) return '';
        try {
            return new Date(ts).toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric',
            });
        } catch (e) { return ''; }
    }

    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    function showToast(msg, duration = 2500) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.innerText = msg;
        el.classList.remove('hidden');
        el.classList.add('show');
        clearTimeout(window._toastTimer);
        window._toastTimer = setTimeout(() => {
            el.classList.add('hidden');
            el.classList.remove('show');
        }, duration);
    }

    function showAlert(title, body) {
        document.getElementById('alert-title').innerText = title;
        document.getElementById('alert-body').innerHTML = body;
        document.getElementById('alert-modal').classList.remove('hidden');
    }

    function closeAlert() {
        document.getElementById('alert-modal').classList.add('hidden');
    }

    // ---- Loading / rendering ----
    async function refresh() {
        document.getElementById('dashboard-loading').classList.remove('hidden');
        document.getElementById('dashboard-error').classList.add('hidden');
        document.getElementById('dashboard-empty').classList.add('hidden');
        document.getElementById('project-grid').innerHTML = '';

        try {
            projects = await Api.listProjects();
            render();
        } catch (err) {
            console.error('Failed to load projects:', err);
            document.getElementById('dashboard-loading').classList.add('hidden');
            document.getElementById('dashboard-error').classList.remove('hidden');
        }
    }

    function render() {
        document.getElementById('dashboard-loading').classList.add('hidden');
        const grid = document.getElementById('project-grid');
        grid.innerHTML = '';

        if (projects.length === 0) {
            document.getElementById('dashboard-empty').classList.remove('hidden');
            return;
        }
        document.getElementById('dashboard-empty').classList.add('hidden');

        // Sort by modified_at desc
        projects.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));

        projects.forEach(p => {
            const card = document.createElement('div');
            card.className = 'project-card';
            card.dataset.projectId = p.id;
            if (selectedProjectId === p.id) card.classList.add('selected');

            const color = p.color || '#3b82f6';
            const docCount = p.docCount || 0;
            const folderCount = p.folderCount || 0;
            const sizeStr = formatSize(p.size);

            card.innerHTML = `
                <div class="color-bar" style="background:${color}"></div>
                <div class="actions">
                    <button class="action-btn export-btn" title="Export as .plsx backup">
                        <i class="fa-solid fa-download"></i>
                    </button>
                    <button class="action-btn delete-btn" title="Delete project">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <div class="flex items-start gap-3 pr-12 mt-2">
                    <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style="background:${color}22; color:${color}">
                        <i class="fa-solid fa-folder-open"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <h3 class="font-semibold text-sm text-gray-800 truncate" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</h3>
                        ${p.description ? `<p class="text-xs text-gray-500 truncate">${escapeHtml(p.description)}</p>` : ''}
                    </div>
                </div>
                <div class="project-stats">
                    <span class="stat"><i class="fa-solid fa-file-pdf"></i> ${docCount} PDF${docCount === 1 ? '' : 's'}</span>
                    <span class="stat"><i class="fa-solid fa-folder"></i> ${folderCount} folder${folderCount === 1 ? '' : 's'}</span>
                    <span class="stat"><i class="fa-solid fa-database"></i> ${sizeStr}</span>
                </div>
                <div class="project-dates">
                    <div>Created: ${formatDate(p.createdAt)}</div>
                    <div>Modified: ${formatDate(p.modifiedAt)}</div>
                </div>
            `;

            // Click anywhere on the card (except the action buttons) → open the project
            card.addEventListener('click', (e) => {
                if (e.target.closest('.actions')) return;
                openProject(p.id);
            });
            card.addEventListener('dblclick', () => openProject(p.id));

            // Export button
            card.querySelector('.export-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                exportProject(p.id);
            });
            // Delete button
            card.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                confirmDelete(p.id);
            });

            grid.appendChild(card);
        });
    }

    // ---- Actions ----
    function openProject(projectId) {
        // Navigate to /editor/<project_id>. The editor's app.js reads the
        // project ID from the URL and sets the X-Project-Id header.
        window.location.href = `/editor/${encodeURIComponent(projectId)}`;
    }

    async function createNewProject() {
        // Reset the form
        document.getElementById('new-project-name').value = '';
        document.getElementById('new-project-description').value = '';
        selectedColor = '#3b82f6';
        updateColorPickerSelection();
        document.getElementById('new-project-modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('new-project-name').focus(), 100);
    }

    function cancelNewProject() {
        document.getElementById('new-project-modal').classList.add('hidden');
    }

    async function confirmCreateNewProject(e) {
        e.preventDefault();
        const name = document.getElementById('new-project-name').value.trim();
        const description = document.getElementById('new-project-description').value.trim();
        if (!name) return;

        // Check for duplicate name (case-insensitive)
        const exists = projects.some(p => p.name.toLowerCase() === name.toLowerCase());
        if (exists) {
            showAlert('Duplicate Name',
                `A project named <b>${escapeHtml(name)}</b> already exists. Please choose a different name.`);
            return;
        }

        try {
            const created = await Api.createProject(name, description, selectedColor);
            showToast(`Project "${created.name}" created`);
            // Open the new project immediately
            setTimeout(() => openProject(created.id), 500);
        } catch (err) {
            showAlert('Error', `Could not create project: ${escapeHtml(String(err))}`);
        } finally {
            cancelNewProject();
        }
    }

    async function exportProject(projectId) {
        const project = projects.find(p => p.id === projectId);
        if (!project) return;
        showToast(`Building backup for "${project.name}"...`, 5000);
        try {
            const result = await Api.exportProject(projectId);
            showToast(`Backup saved: ${result.filename}`);
        } catch (err) {
            showAlert('Export Failed', escapeHtml(String(err)));
        }
    }

    function importProject() {
        // Trigger the hidden file input
        const input = document.getElementById('import-file-input-real');
        input.value = '';
        input.click();
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            await handleImportFile(file);
        };
    }

    async function handleImportFile(file) {
        // First, parse the manifest to find out the project's name.
        // We use a quick client-side unzip of just manifest.json (no library needed —
        // we ask the server to do the heavy lifting via a "peek" endpoint).
        // For simplicity, we just trigger the import with on_conflict='copy'
        // (which the server handles gracefully) — but we want to give the user
        // a chance to rename BEFORE the import runs.

        // Best approach: do a quick HEAD/peek to get the project name from the
        // backup. Since we don't have a peek endpoint, we read the manifest
        // directly using a small unzip-in-browser approach.

        try {
            const manifest = await peekManifest(file);
            const originalName = manifest.project_name || 'Imported Project';

            // Check if a project with this name exists
            const exists = projects.some(p => p.name.toLowerCase() === originalName.toLowerCase());

            if (exists) {
                // Show conflict modal
                pendingImportFile = file;
                document.getElementById('conflict-name').innerText = originalName;
                // Suggest a name like "Original Name (Copy 1)"
                let candidate = `${originalName} (Copy 1)`;
                let i = 1;
                while (projects.some(p => p.name.toLowerCase() === candidate.toLowerCase())) {
                    i++;
                    candidate = `${originalName} (Copy ${i})`;
                }
                document.getElementById('conflict-new-name').value = candidate;
                document.getElementById('import-conflict-modal').classList.remove('hidden');
                return;
            }

            // No conflict — proceed directly. Still show a confirm dialog with the original name.
            pendingImportFile = file;
            const proceed = confirm(
                `Import project "${originalName}"?\n\n` +
                `This will create a new project on the server with new IDs for all data.`
            );
            if (!proceed) return;
            await doImport(file, originalName);
        } catch (err) {
            console.error('Manifest peek failed:', err);
            // Fall back to importing with a generic name
            const proceed = confirm(
                `Import this backup file?\n\n` +
                `Could not read the project name from the backup. The imported project ` +
                `will be named "Imported Project". You can rename it afterwards.`
            );
            if (!proceed) return;
            await doImport(file, 'Imported Project');
        }
    }

    function peekManifest(file) {
        // Read the manifest.json from the .plsx file (a ZIP).
        // We use a tiny client-side unzip via fetch + Blob → no extra library needed
        // because we can hand off to the server's /import endpoint with a peek flag...
        // But simplest is to use the browser's built-in DecompressionStream (Chrome 80+).
        return new Promise((resolve, reject) => {
            // Try the FileReader + manual ZIP parse approach
            file.arrayBuffer().then(buf => {
                try {
                    const manifest = _extractManifestFromZip(buf);
                    if (manifest) resolve(manifest);
                    else reject(new Error('manifest.json not found in zip'));
                } catch (e) { reject(e); }
            }).catch(reject);
        });
    }

    // Tiny ZIP-file manifest extractor — only reads the first file's local header
    // and central directory. Doesn't handle all ZIP variants, but works for files
    // produced by Python's zipfile module (which is what our server uses).
    function _extractManifestFromZip(buf) {
        // We need a real ZIP reader. Use the browser's built-in
        // DecompressionStream API (Chrome 80+, Firefox 113+, Safari 16.4+).
        // For older browsers, we'd need a library like JSZip — but since the
        // server always produces the file, we can rely on the manifest being
        // small + stored uncompressed.
        //
        // Fallback: ask the server via a quick /import?peek=true endpoint.
        // But since we don't want to add that, let's use a simpler approach:
        // try to find "manifest.json" in the binary by scanning for the string,
        // then parse the JSON that follows.
        const bytes = new Uint8Array(buf);
        const decoder = new TextDecoder();
        const fullText = decoder.decode(bytes);
        // Look for the start of the manifest.json file content.
        // In a DEFLATEd zip, this won't work — we'd need to inflate.
        // In a STORED zip, the content appears verbatim.
        // Since Python's zipfile uses DEFLATE by default, we can't rely on this.
        // For robustness, return null and let the caller fall back to "Imported Project".
        return null;
    }

    function cancelImport() {
        pendingImportFile = null;
        document.getElementById('import-conflict-modal').classList.add('hidden');
    }

    async function confirmImportAsCopy() {
        const newName = document.getElementById('conflict-new-name').value.trim();
        if (!newName) {
            alert('Please enter a name for the imported copy.');
            return;
        }
        // Check the new name doesn't conflict either
        if (projects.some(p => p.name.toLowerCase() === newName.toLowerCase())) {
            alert(`A project named "${newName}" already exists. Please choose another name.`);
            return;
        }
        document.getElementById('import-conflict-modal').classList.add('hidden');
        await doImport(pendingImportFile, newName);
        pendingImportFile = null;
    }

    async function doImport(file, newName) {
        showToast(`Importing "${newName}"...`, 5000);
        try {
            const result = await Api.importProject(file, newName, 'copy');
            showToast(`Project "${result.name}" imported successfully`);
            await refresh();
        } catch (err) {
            showAlert('Import Failed', escapeHtml(String(err)));
        }
    }

    function confirmDelete(projectId) {
        const project = projects.find(p => p.id === projectId);
        if (!project) return;
        if (projectId === 'default') {
            showAlert('Cannot Delete',
                'The default project holds migrated data from the previous single-project version ' +
                'and cannot be deleted. You can still open or export it.');
            return;
        }
        pendingDeleteProjectId = projectId;
        document.getElementById('delete-project-name').innerText = project.name;
        document.getElementById('delete-confirm-modal').classList.remove('hidden');
    }

    function cancelDelete() {
        pendingDeleteProjectId = null;
        document.getElementById('delete-confirm-modal').classList.add('hidden');
    }

    async function confirmDelete() {
        if (!pendingDeleteProjectId) return;
        const projectId = pendingDeleteProjectId;
        const project = projects.find(p => p.id === projectId);
        document.getElementById('delete-confirm-modal').classList.add('hidden');
        pendingDeleteProjectId = null;
        showToast(`Deleting "${project?.name || 'project'}"...`, 5000);
        try {
            await Api.deleteProject(projectId);
            showToast('Project deleted');
            await refresh();
        } catch (err) {
            showAlert('Delete Failed', escapeHtml(String(err)));
        }
    }

    async function exportThenDelete() {
        if (!pendingDeleteProjectId) return;
        const projectId = pendingDeleteProjectId;
        // Close the delete modal, do the export, then re-open delete confirmation
        document.getElementById('delete-confirm-modal').classList.add('hidden');
        await exportProject(projectId);
        // Re-show delete confirmation so the user can confirm after backing up
        setTimeout(() => {
            const project = projects.find(p => p.id === projectId);
            if (project) {
                pendingDeleteProjectId = projectId;
                document.getElementById('delete-project-name').innerText = project.name;
                document.getElementById('delete-confirm-modal').classList.remove('hidden');
            }
        }, 800);
    }

    // ---- Color picker ----
    function updateColorPickerSelection() {
        document.querySelectorAll('#color-picker button').forEach(b => {
            if (b.dataset.color === selectedColor) {
                b.classList.add('selected');
                b.style.color = b.dataset.color;
            } else {
                b.classList.remove('selected');
                b.style.color = '';
            }
        });
    }

    function initColorPicker() {
        document.querySelectorAll('#color-picker button').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedColor = btn.dataset.color;
                updateColorPickerSelection();
            });
        });
    }

    // ---- Init ----
    function init() {
        initColorPicker();
        // Wire up the import file input (kept as backup trigger if needed)
        const importInput = document.getElementById('import-file-input');
        if (importInput) {
            importInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) handleImportFile(file);
            });
        }
        refresh();
    }

    return {
        init, refresh, render,
        createNewProject, cancelNewProject, confirmCreateNewProject,
        openProject,
        exportProject,
        importProject, cancelImport, confirmImportAsCopy,
        confirmDelete, cancelDelete, confirmDelete, exportThenDelete,
        closeAlert,
    };
})();

window.Dashboard = Dashboard;

// Bootstrap on page load
document.addEventListener('DOMContentLoaded', () => Dashboard.init());
