// ==========================================
// 📁 api.js — REST API client for the FastAPI backend.
// All persistent data goes through these functions; the rest of the frontend
// never talks to IndexedDB or Ollama directly.
// ==========================================

const API_BASE = '/api';  // Same origin — served by FastAPI

// ---- Internal fetch helper ----
async function _fetch(path, options = {}) {
    const opts = {
        headers: {},
        ...options,
    };
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
    // Don't try to parse empty bodies (e.g. from DELETE)
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        return resp.json();
    }
    return resp.text();
}

async function _fetchBlob(path, options = {}) {
    const resp = await fetch(API_BASE + path, options);
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

    // ---- Projects ----
    async exportProjectUrl() {
        // Returns a URL the browser can use to download the SQLite file.
        return `${API_BASE}/projects/export`;
    },
    async importProject(file) {
        const form = new FormData();
        form.append('file', file);
        return _fetch('/projects/import', { method: 'POST', body: form });
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
            fetch(API_BASE + '/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
                        // SSE events are separated by \n\n
                        const events = buffer.split('\n\n');
                        buffer = events.pop();  // Keep the partial last event
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
