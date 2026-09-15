// ==========================================
// 📁 api.js — REST API client for the FastAPI backend.
// All persistent data goes through these functions; the rest of the frontend
// never talks to IndexedDB or Ollama directly.
// ==========================================

const API_BASE = '/api';  // Same origin — served by FastAPI

// The current project ID is read from the URL (/editor/<project_id>) on init,
// and sent as the X-Project-Id header on every API request so the server can
// scope all data to the current project. The dashboard doesn't set this.
let CURRENT_PROJECT_ID = null;

function setProjectId(pid) {
    CURRENT_PROJECT_ID = pid;
}
function getProjectId() {
    return CURRENT_PROJECT_ID;
}

// ---- Internal fetch helper ----
async function _fetch(path, options = {}) {
    const opts = {
        headers: {},
        ...options,
    };
    // Always include the project ID header (when set) so the server can scope
    // all queries to the current project.
    if (CURRENT_PROJECT_ID) {
        opts.headers['X-Project-Id'] = CURRENT_PROJECT_ID;
    }
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body === 'object') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
    }
    const resp = await fetch(API_BASE + path, opts);
    if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const err = await resp.json(); msg = err.detail || err.error || msg; }
        catch (e) { /* keep default */ }
        throw new Error(msg);
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        return resp.json();
    }
    return resp.text();
}

async function _fetchBlob(path, options = {}) {
    const opts = { headers: {}, ...options };
    if (CURRENT_PROJECT_ID) {
        opts.headers['X-Project-Id'] = CURRENT_PROJECT_ID;
    }
    const resp = await fetch(API_BASE + path, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.blob();
}

// ---- Documents ----
const Api = {
    async listDocuments() {
        return _fetch('/documents');
    },
    async getDocument(docId) {
        return _fetch(`/documents/${docId}`);
    },
    async getDocumentFileUrl(docId) {
        // Returns a URL that can be passed to pdfjsLib.getDocument() / fetch()
        return `${API_BASE}/documents/${docId}/file`;
    },
    async fetchDocumentBlob(docId) {
        return _fetchBlob(`/documents/${docId}/file`);
    },
    async fetchDocumentBlobWithProjectHeader(docId) {
        // PDF.js fetches the URL directly without our headers — so we use a
        // query parameter as a fallback for the project_id.
        const qs = CURRENT_PROJECT_ID ? `?project_id=${encodeURIComponent(CURRENT_PROJECT_ID)}` : '';
        return _fetchBlob(`/documents/${docId}/file${qs}`);
    },
    async uploadDocuments(files, folderId = 'root') {
        const form = new FormData();
        files.forEach(f => form.append('files', f));
        form.append('folder_id', folderId);
        return _fetch('/documents/upload', { method: 'POST', body: form });
    },
    async updateDocument(docId, update) {
        return _fetch(`/documents/${docId}`, { method: 'PUT', body: update });
    },
    async duplicateDocument(docId) {
        return _fetch(`/documents/${docId}/duplicate`, { method: 'POST' });
    },
    async deleteDocument(docId) {
        return _fetch(`/documents/${docId}`, { method: 'DELETE' });
    },
    async moveDocument(docId, targetFolderId) {
        return _fetch(`/documents/${docId}/move`, { method: 'PUT', body: { target_folder_id: targetFolderId } });
    },
    async replaceDocumentFile(docId, blob) {
        const form = new FormData();
        form.append('file', blob, 'document.pdf');
        return _fetch(`/documents/${docId}/file`, { method: 'PUT', body: form });
    },

    // ---- Folders ----
    async listFolders() {
        return _fetch('/folders');
    },
    async getFolderTree() {
        return _fetch('/folders/tree');
    },
    async createFolder(name, parentId = 'root') {
        return _fetch('/folders', { method: 'POST', body: { name, parent_id: parentId } });
    },
    async renameFolder(folderId, name) {
        return _fetch(`/folders/${folderId}`, { method: 'PUT', body: { name } });
    },
    async moveFolder(folderId, targetFolderId) {
        return _fetch(`/folders/${folderId}/move`, { method: 'PUT', body: { target_folder_id: targetFolderId } });
    },
    async setFolderExpanded(folderId, expanded) {
        return _fetch(`/folders/${folderId}/expanded`, { method: 'PUT', body: { expanded } });
    },
    async deleteFolder(folderId, moveContentsToRoot = false) {
        const qs = moveContentsToRoot ? '?move_contents_to_root=true' : '';
        return _fetch(`/folders/${folderId}${qs}`, { method: 'DELETE' });
    },

    // ---- Annotations ----
    async getAnnotations(docId) {
        return _fetch(`/annotations/${docId}`);
    },
    async getAnnotation(docId, pageId) {
        return _fetch(`/annotations/${docId}/${pageId}`);
    },
    async saveAnnotation(docId, pageId, data) {
        return _fetch(`/annotations/${docId}/${pageId}`, { method: 'PUT', body: { data } });
    },
    async saveAllAnnotations(docId, annotationsByPageId) {
        return _fetch(`/annotations/${docId}`, { method: 'PUT', body: annotationsByPageId });
    },
    async deleteAnnotation(docId, pageId) {
        return _fetch(`/annotations/${docId}/${pageId}`, { method: 'DELETE' });
    },
    async deleteAllAnnotations(docId) {
        return _fetch(`/annotations/${docId}`, { method: 'DELETE' });
    },

    // ---- Links ----
    async listLinks() {
        return _fetch('/links');
    },
    async createLink(link) {
        return _fetch('/links', { method: 'POST', body: link });
    },
    async deleteLink(linkId) {
        return _fetch(`/links/${linkId}`, { method: 'DELETE' });
    },
    async deleteAllLinks() {
        return _fetch('/links', { method: 'DELETE' });
    },

    // ---- Chats ----
    async listChats() {
        return _fetch('/chats');
    },
    async getChat(chatId) {
        return _fetch(`/chats/${chatId}`);
    },
    async createChat(title = 'New Chat') {
        return _fetch('/chats', { method: 'POST', body: { title } });
    },
    async updateChat(chatId, update) {
        return _fetch(`/chats/${chatId}`, { method: 'PUT', body: update });
    },
    async deleteChat(chatId) {
        return _fetch(`/chats/${chatId}`, { method: 'DELETE' });
    },

    // ---- Settings ----
    async getSettings() {
        return _fetch('/settings');
    },
    async saveSettings(settings) {
        return _fetch('/settings', { method: 'PUT', body: settings });
    },

    // ---- Projects (multi-project dashboard) ----
    async listProjects() {
        // NOTE: this is NOT project-scoped (we don't have a current project yet —
        // we're listing them all). So no X-Project-Id header is sent.
        const resp = await fetch(`${API_BASE}/projects`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    },
    async createProject(name, description = '', color = '#3b82f6') {
        const resp = await fetch(`${API_BASE}/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, color }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },
    async getProject(projectId) {
        const resp = await fetch(`${API_BASE}/projects/${projectId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    },
    async updateProject(projectId, update) {
        const resp = await fetch(`${API_BASE}/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },
    async deleteProject(projectId) {
        const resp = await fetch(`${API_BASE}/projects/${projectId}`, { method: 'DELETE' });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },
    // Export returns a binary file (zip). We navigate to it directly so the
    // browser triggers a download.
    exportProjectUrl(projectId) {
        return `${API_BASE}/projects/${projectId}/export`;
    },
    async exportProject(projectId) {
        // POST request that returns a binary blob — we trigger a download via an
        // invisible <a> element.
        const resp = await fetch(`${API_BASE}/projects/${projectId}/export`, { method: 'POST' });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        const blob = await resp.blob();
        const cd = resp.headers.get('content-disposition') || '';
        const match = cd.match(/filename="?([^";]+)"?/i);
        const filename = match ? match[1] : `project_${projectId}.plsx`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { filename };
    },
    async peekProjectBackup(file) {
        // Read just the manifest from a .plsx file (server-side) to get the
        // original project name before committing to an import.
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch(`${API_BASE}/projects/peek`, {
            method: 'POST',
            body: form,
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },
    async importProject(file, newName = null, onConflict = 'copy') {
        const form = new FormData();
        form.append('file', file);
        if (newName) form.append('new_name', newName);
        form.append('on_conflict', onConflict);
        const resp = await fetch(`${API_BASE}/projects/import`, {
            method: 'POST',
            body: form,
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },
    async checkProjectNameExists(name) {
        // Helper for the dashboard: check if a project name already exists.
        const projects = await Api.listProjects();
        return projects.some(p => p.name.toLowerCase() === name.toLowerCase());
    },

    // ---- AI / RAG ----
    async triggerIndexing(force = false) {
        return _fetch('/ai/index', { method: 'POST', body: { force } });
    },
    async getIndexingStatus() {
        return _fetch('/ai/index/status');
    },
    async getAIStatus() {
        return _fetch('/ai/status');
    },
    async semanticSearch(query, topK = 8, minScore = 0.65, contextBudget = 4000) {
        return _fetch('/ai/search', {
            method: 'POST',
            body: { query, top_k: topK, min_score: minScore, context_budget: contextBudget }
        });
    },

    /**
     * Stream chat completion via Server-Sent Events.
     * Calls onSources(sources), onToken(text, full), onDone(answer), onError(msg).
     */
    streamChat(request, callbacks) {
        return new Promise((resolve, reject) => {
            const headers = { 'Content-Type': 'application/json' };
            if (CURRENT_PROJECT_ID) headers['X-Project-Id'] = CURRENT_PROJECT_ID;
            fetch(API_BASE + '/ai/chat', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(request),
            }).then(resp => {
                if (!resp.ok) {
                    reject(new Error(`HTTP ${resp.status}`));
                    return;
                }
                const reader = resp.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';
                let finalAnswer = '';

                function pump() {
                    reader.read().then(({ done, value }) => {
                        if (done) {
                            resolve(finalAnswer);
                            return;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        const events = buffer.split('\n\n');
                        buffer = events.pop();
                        for (const evt of events) {
                            if (!evt.startsWith('data: ')) continue;
                            const payload = evt.slice(6).trim();
                            if (!payload) continue;
                            try {
                                const obj = JSON.parse(payload);
                                if (obj.type === 'sources' && callbacks.onSources) {
                                    callbacks.onSources(obj.data || []);
                                } else if (obj.type === 'token' && callbacks.onToken) {
                                    finalAnswer = obj.full || (finalAnswer + (obj.text || ''));
                                    callbacks.onToken(obj.text || '', finalAnswer);
                                } else if (obj.type === 'done') {
                                    finalAnswer = obj.answer || finalAnswer;
                                    if (callbacks.onDone) callbacks.onDone(finalAnswer, obj.sources || []);
                                    resolve(finalAnswer);
                                    return;
                                } else if (obj.type === 'error') {
                                    if (callbacks.onError) callbacks.onError(obj.message);
                                    reject(new Error(obj.message));
                                    return;
                                }
                            } catch (e) {
                                console.warn('SSE parse error:', e, payload);
                            }
                        }
                        pump();
                    }).catch(err => {
                        reject(err);
                    });
                }
                pump();
            }).catch(err => reject(err));
        });
    },

    async listEmbeddings(docId) {
        return _fetch(`/ai/embeddings/${docId}`);
    },

    // ---- Health ----
    async health() {
        return _fetch('/health');
    },
};

window.Api = Api;
window.setProjectId = setProjectId;
window.getProjectId = getProjectId;
