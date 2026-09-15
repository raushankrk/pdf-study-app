// ==========================================
// 📁 dashboard.js — Project manager UI
// Shown at the root URL. Lists all projects on the server, lets the user
// create/open/rename/export/import/delete projects — including bulk operations.
// ==========================================

const Dashboard = (() => {
    let projects = [];
    let selectedProjectIds = new Set();  // Multi-select (bulk ops)
    let pendingImportFile = null;       // File object awaiting conflict resolution
    let pendingDeleteProjectIds = null; // Project IDs awaiting delete confirmation (single or bulk)
    let pendingRenameProjectId = null;  // Project ID awaiting rename confirmation
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

    function getSelectedProjects() {
        return projects.filter(p => selectedProjectIds.has(p.id));
    }

    function updateBulkActionBar() {
        const bar = document.getElementById('bulk-action-bar');
        const countLabel = document.getElementById('bulk-selection-count');
        if (!bar || !countLabel) return;
        const count = selectedProjectIds.size;
        if (count === 0) {
            bar.classList.add('hidden');
        } else {
            bar.classList.remove('hidden');
            countLabel.innerText = `${count} project${count === 1 ? '' : 's'} selected`;
        }
    }

    // ---- Loading / rendering ----
    async function refresh() {
        document.getElementById('dashboard-loading').classList.remove('hidden');
        document.getElementById('dashboard-error').classList.add('hidden');
        document.getElementById('dashboard-empty').classList.add('hidden');
        document.getElementById('project-grid').innerHTML = '';
        selectedProjectIds.clear();
        updateBulkActionBar();

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
            if (selectedProjectIds.has(p.id)) card.classList.add('selected');

            const color = p.color || '#3b82f6';
            const docCount = p.docCount || 0;
            const folderCount = p.folderCount || 0;
            const sizeStr = formatSize(p.size);
            const isDefault = p.id === 'default';

            card.innerHTML = `
                <div class="color-bar" style="background:${color}"></div>
                <div class="card-checkbox">
                    <input type="checkbox" ${selectedProjectIds.has(p.id) ? 'checked' : ''} title="Select for bulk action">
                </div>
                <div class="actions">
                    <button class="action-btn open-btn" title="Open project">
                        <i class="fa-solid fa-folder-open"></i>
                    </button>
                    <button class="action-btn rename-btn" title="Rename project">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="action-btn export-btn" title="Export as .plsx backup">
                        <i class="fa-solid fa-download"></i>
                    </button>
                    <button class="action-btn delete-btn ${isDefault ? 'disabled' : ''}" title="${isDefault ? 'Default project cannot be deleted' : 'Delete project'}" ${isDefault ? 'disabled' : ''}>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <div class="flex items-start gap-3 pr-16 mt-2">
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

            // Checkbox click → toggle selection (don't open the project)
            const checkbox = card.querySelector('.card-checkbox input');
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                if (selectedProjectIds.has(p.id)) {
                    selectedProjectIds.delete(p.id);
                } else {
                    selectedProjectIds.add(p.id);
                }
                render();  // Re-render to update the visual state
                updateBulkActionBar();
            });

            // Card click (not on checkbox or action buttons) → open the project
            card.addEventListener('click', (e) => {
                if (e.target.closest('.actions') || e.target.closest('.card-checkbox')) return;
                openProject(p.id);
            });
            card.addEventListener('dblclick', (e) => {
                if (e.target.closest('.actions') || e.target.closest('.card-checkbox')) return;
                openProject(p.id);
            });

            // Open button
            card.querySelector('.open-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openProject(p.id);
            });
            // Rename button
            card.querySelector('.rename-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                showRenameModal(p.id);
            });
            // Export button
            card.querySelector('.export-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                exportProject(p.id);
            });
            // Delete button (disabled for default)
            const delBtn = card.querySelector('.delete-btn');
            if (!isDefault) {
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    confirmDelete([p.id]);
                });
            }

            grid.appendChild(card);
        });
    }

    // ---- Actions ----
    function openProject(projectId) {
        window.location.href = `/editor/${encodeURIComponent(projectId)}`;
    }

    async function createNewProject() {
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

        const exists = projects.some(p => p.name.toLowerCase() === name.toLowerCase());
        if (exists) {
            showAlert('Duplicate Name',
                `A project named <b>${escapeHtml(name)}</b> already exists. Please choose a different name.`);
            return;
        }

        try {
            const created = await Api.createProject(name, description, selectedColor);
            showToast(`Project "${created.name}" created`);
            setTimeout(() => openProject(created.id), 500);
        } catch (err) {
            showAlert('Error', `Could not create project: ${escapeHtml(String(err))}`);
        } finally {
            cancelNewProject();
        }
    }

    // ---- Rename ----
    function showRenameModal(projectId) {
        const project = projects.find(p => p.id === projectId);
        if (!project) return;
        pendingRenameProjectId = projectId;
        document.getElementById('rename-project-name').value = project.name;
        document.getElementById('rename-modal-title').innerText = `Rename "${project.name}"`;
        document.getElementById('rename-modal').classList.remove('hidden');
        setTimeout(() => {
            const input = document.getElementById('rename-project-name');
            input.focus();
            input.select();
        }, 100);
    }

    function cancelRename() {
        pendingRenameProjectId = null;
        document.getElementById('rename-modal').classList.add('hidden');
    }

    async function confirmRename() {
        if (!pendingRenameProjectId) return;
        const newName = document.getElementById('rename-project-name').value.trim();
        if (!newName) {
            alert('Project name cannot be empty.');
            return;
        }
        const projectId = pendingRenameProjectId;
        const oldProject = projects.find(p => p.id === projectId);
        if (!oldProject) { cancelRename(); return; }
        if (newName === oldProject.name) {
            cancelRename();
            return;
        }
        // Check for duplicate name (excluding self)
        const dup = projects.some(p => p.id !== projectId && p.name.toLowerCase() === newName.toLowerCase());
        if (dup) {
            alert(`A project named "${newName}" already exists. Please choose another name.`);
            return;
        }
        document.getElementById('rename-modal').classList.add('hidden');
        pendingRenameProjectId = null;
        showToast(`Renaming "${oldProject.name}" → "${newName}"...`);
        try {
            await Api.updateProject(projectId, { name: newName });
            showToast(`Project renamed to "${newName}"`);
            await refresh();
        } catch (err) {
            showAlert('Rename Failed', escapeHtml(String(err)));
        }
    }

    // ---- Export ----
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

    async function bulkExport() {
        const selected = getSelectedProjects();
        if (selected.length === 0) return;
        showToast(`Exporting ${selected.length} project${selected.length === 1 ? '' : 's'}...`, 10000);
        let ok = 0, fail = 0;
        for (const p of selected) {
            try {
                await Api.exportProject(p.id);
                ok++;
            } catch (err) {
                console.error(`Export failed for ${p.name}:`, err);
                fail++;
            }
        }
        if (fail === 0) {
            showToast(`Exported ${ok} project${ok === 1 ? '' : 's'}. Check downloads.`);
        } else {
            showAlert('Bulk Export Partial',
                `Exported: ${ok}<br>Failed: ${fail}<br>Check the browser console for details.`);
        }
    }

    // ---- Import ----
    function importProject() {
        const input = document.getElementById('import-file-input-real');
        input.value = '';
        input.click();
        input.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;
            // Multiple files → import all sequentially
            if (files.length === 1) {
                await handleImportFile(files[0]);
            } else {
                await bulkImportFiles(files);
            }
        };
    }

    async function handleImportFile(file) {
        try {
            const manifest = await peekManifest(file);
            const originalName = manifest.project_name || 'Imported Project';
            const exists = projects.some(p => p.name.toLowerCase() === originalName.toLowerCase());

            if (exists) {
                pendingImportFile = file;
                document.getElementById('conflict-name').innerText = originalName;
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

            pendingImportFile = file;
            const proceed = confirm(
                `Import project "${originalName}"?\n\n` +
                `This will create a new project on the server with new IDs for all data.`
            );
            if (!proceed) return;
            await doImport(file, originalName);
        } catch (err) {
            console.error('Manifest peek failed:', err);
            const proceed = confirm(
                `Import this backup file?\n\n` +
                `Could not read the project name from the backup. The imported project ` +
                `will be named "Imported Project". You can rename it afterwards.`
            );
            if (!proceed) return;
            await doImport(file, 'Imported Project');
        }
    }

    async function bulkImportFiles(files) {
        showToast(`Importing ${files.length} backup file${files.length === 1 ? '' : 's'}...`, 15000);
        let ok = 0, fail = 0;
        for (const file of files) {
            try {
                // For bulk import, always use 'copy' mode with a default name.
                // The server generates a unique name if there's a conflict.
                const result = await Api.importProject(file, null, 'copy');
                ok++;
                console.log(`Imported: ${result.name}`);
            } catch (err) {
                console.error(`Import failed for ${file.name}:`, err);
                fail++;
            }
        }
        showToast(`Imported ${ok} of ${files.length} file${files.length === 1 ? '' : 's'}`, 4000);
        if (fail > 0) {
            showAlert('Bulk Import Partial',
                `Imported: ${ok}<br>Failed: ${fail}<br>Check the browser console for details.`);
        }
        await refresh();
    }

    function peekManifest(file) {
        return new Promise((resolve, reject) => {
            file.arrayBuffer().then(buf => {
                try {
                    const manifest = _extractManifestFromZip(buf);
                    if (manifest) resolve(manifest);
                    else reject(new Error('manifest.json not found in zip'));
                } catch (e) { reject(e); }
            }).catch(reject);
        });
    }

    function _extractManifestFromZip(buf) {
        // Try to find "manifest.json" content in the zip.
        // Python's zipfile uses DEFLATE by default, so we can't rely on string scanning.
        // Return null → caller falls back to "Imported Project".
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

    // ---- Delete ----
    function confirmDelete(projectIds) {
        // projectIds can be a single ID or an array
        const ids = Array.isArray(projectIds) ? projectIds : [projectIds];
        if (ids.length === 0) return;

        // Filter out the default project (can't be deleted)
        const deletable = ids.filter(id => id !== 'default');
        const skipped = ids.length - deletable.length;
        if (deletable.length === 0) {
            showAlert('Cannot Delete',
                'The default project holds migrated data and cannot be deleted. ' +
                'You can still open or export it.');
            return;
        }

        pendingDeleteProjectIds = deletable;
        const names = deletable.map(id => projects.find(p => p.id === id)?.name || id);
        const isBulk = deletable.length > 1;

        // Update the modal content
        document.getElementById('delete-project-name').innerHTML = names
            .map(n => `<b>${escapeHtml(n)}</b>`).join('<br>');
        const warningEl = document.getElementById('delete-warning-count');
        if (warningEl) {
            warningEl.innerText = `${deletable.length} project${deletable.length === 1 ? '' : 's'}`;
        }
        if (skipped > 0) {
            const noteEl = document.getElementById('delete-skipped-note');
            if (noteEl) {
                noteEl.innerText = `(${skipped} default project${skipped === 1 ? '' : 's'} skipped — cannot be deleted)`;
                noteEl.classList.remove('hidden');
            }
        } else {
            const noteEl = document.getElementById('delete-skipped-note');
            if (noteEl) noteEl.classList.add('hidden');
        }

        // Show the export-then-delete button only for single-project deletes
        // (bulk export-then-delete would be confusing)
        const exportBtn = document.querySelector('#delete-confirm-modal .export-backup-btn');
        if (exportBtn) {
            if (isBulk) {
                exportBtn.classList.add('hidden');
            } else {
                exportBtn.classList.remove('hidden');
            }
        }

        document.getElementById('delete-confirm-modal').classList.remove('hidden');
    }

    function cancelDelete() {
        pendingDeleteProjectIds = null;
        document.getElementById('delete-confirm-modal').classList.add('hidden');
    }

    async function confirmDeleteAction() {
        if (!pendingDeleteProjectIds || pendingDeleteProjectIds.length === 0) return;
        const ids = [...pendingDeleteProjectIds];
        const names = ids.map(id => projects.find(p => p.id === id)?.name || id);
        document.getElementById('delete-confirm-modal').classList.add('hidden');
        pendingDeleteProjectIds = null;
        showToast(`Deleting ${ids.length} project${ids.length === 1 ? '' : 's'}...`, 5000);
        let ok = 0, fail = 0;
        for (let i = 0; i < ids.length; i++) {
            try {
                await Api.deleteProject(ids[i]);
                ok++;
            } catch (err) {
                console.error(`Delete failed for ${names[i]}:`, err);
                fail++;
            }
        }
        if (fail === 0) {
            showToast(`Deleted ${ok} project${ok === 1 ? '' : 's'}`);
        } else {
            showAlert('Bulk Delete Partial',
                `Deleted: ${ok}<br>Failed: ${fail}<br>Check the browser console for details.`);
        }
        selectedProjectIds.clear();
        await refresh();
    }

    async function exportThenDelete() {
        if (!pendingDeleteProjectIds || pendingDeleteProjectIds.length !== 1) return;
        const projectId = pendingDeleteProjectIds[0];
        document.getElementById('delete-confirm-modal').classList.add('hidden');
        await exportProject(projectId);
        setTimeout(() => {
            const project = projects.find(p => p.id === projectId);
            if (project) {
                pendingDeleteProjectIds = [projectId];
                document.getElementById('delete-project-name').innerHTML = `<b>${escapeHtml(project.name)}</b>`;
                document.querySelector('#delete-confirm-modal .export-backup-btn')?.classList.remove('hidden');
                document.getElementById('delete-confirm-modal').classList.remove('hidden');
            }
        }, 800);
    }

    // ---- Bulk actions ----
    function selectAll() {
        projects.forEach(p => selectedProjectIds.add(p.id));
        render();
        updateBulkActionBar();
    }

    function deselectAll() {
        selectedProjectIds.clear();
        render();
        updateBulkActionBar();
    }

    function bulkDelete() {
        const selected = getSelectedProjects();
        if (selected.length === 0) return;
        confirmDelete(selected.map(p => p.id));
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
        showRenameModal, cancelRename, confirmRename,
        exportProject, bulkExport,
        importProject, cancelImport, confirmImportAsCopy,
        confirmDelete, cancelDelete, confirmDeleteAction, exportThenDelete,
        selectAll, deselectAll, bulkDelete,
        closeAlert,
    };
})();

window.Dashboard = Dashboard;

document.addEventListener('DOMContentLoaded', () => Dashboard.init());
