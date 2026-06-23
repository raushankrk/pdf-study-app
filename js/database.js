// ==========================================
// 📁 4. database.js
// ==========================================
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('links')) db.createObjectStore('links', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('annotations')) db.createObjectStore('annotations', { keyPath: 'docId' });
            if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject('IndexedDB error: ' + e.target.errorCode);
    });
}

async function saveDocumentToDB(docData) {
    const tx = db.transaction(['documents'], 'readwrite');
    tx.objectStore('documents').put(docData);
}

async function saveLinkToDB(linkData) {
    const tx = db.transaction(['links'], 'readwrite');
    tx.objectStore('links').put(linkData);
}

async function deleteLinkFromDB(linkId) {
    const tx = db.transaction(['links'], 'readwrite');
    tx.objectStore('links').delete(linkId);
}

async function saveAnnotationsToDB(docId, data) {
    const tx = db.transaction(['annotations'], 'readwrite');
    tx.objectStore('annotations').put({ docId, data });
}

async function saveChatToDB(chatData) {
    const tx = db.transaction(['chats'], 'readwrite');
    tx.objectStore('chats').put(chatData);
}

async function deleteChatFromDB(chatId) {
    const tx = db.transaction(['chats'], 'readwrite');
    tx.objectStore('chats').delete(chatId);
}

async function saveSettings() {
    if (!db) return;
    const settings = {
        id: 'appState',
        view: state.view,
        splitRatio: state.splitRatio,
        appMode: state.appMode,
        annoTool: state.annoTool,
        annoColor: state.annoColor,
        annoThickness: state.annoThickness,
        leftSidebarCollapsed: document.body.classList.contains('left-sidebar-collapsed'),
        aiSidebarCollapsed: document.body.classList.contains('ai-sidebar-collapsed')
    };
    const tx = db.transaction(['settings'], 'readwrite');
    tx.objectStore('settings').put(settings);
}

async function clearDB() {
    const tx = db.transaction(['documents', 'links', 'settings', 'annotations', 'chats'], 'readwrite');
    tx.objectStore('documents').clear();
    tx.objectStore('links').clear();
    tx.objectStore('settings').clear();
    tx.objectStore('annotations').clear();
    tx.objectStore('chats').clear();
}

async function loadStateFromDB() {
    return new Promise((resolve, reject) => {
        const result = { documents: [], links: [], settings: null, annotations: {}, chats: [] };
        const tx = db.transaction(['documents', 'links', 'settings', 'annotations', 'chats'], 'readonly');
        
        tx.objectStore('documents').getAll().onsuccess = (e) => result.documents = e.target.result;
        tx.objectStore('links').getAll().onsuccess = (e) => result.links = e.target.result;
        tx.objectStore('settings').get('appState').onsuccess = (e) => result.settings = e.target.result;
        tx.objectStore('annotations').getAll().onsuccess = (e) => {
            e.target.result.forEach(item => result.annotations[item.docId] = item.data);
        };
        tx.objectStore('chats').getAll().onsuccess = (e) => result.chats = e.target.result;

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
    });
}

window.exportProject = async function() {
    const docKeys = Object.keys(state.documents);
    if (docKeys.length === 0) { showModal("Export", "No documents loaded."); return; }

    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Creating SQLite Database...";

    try {
        const db = new window.SQL.Database();

        db.run(`
            CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                name TEXT,
                pdf_blob BLOB,
                thumbnail TEXT
            );
        `);

        db.run(`
            CREATE TABLE links (
                id TEXT PRIMARY KEY,
                source_json TEXT,
                target_json TEXT
            );
        `);

        db.run(`
            CREATE TABLE annotations (
                doc_id TEXT,
                page_num INTEGER,
                data_json TEXT,
                PRIMARY KEY (doc_id, page_num)
            );
        `);

        db.run(`
            CREATE TABLE embeddings (
                id TEXT PRIMARY KEY,
                text TEXT,
                vector_json TEXT,
                doc_id TEXT,
                page_num INTEGER
            );
        `);

        db.run(`
            CREATE TABLE chats (
                id TEXT PRIMARY KEY,
                title TEXT,
                messages_json TEXT
            );
        `);

        db.run(`
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);

        const stmtDoc = db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)");
        for (const id of docKeys) {
            const doc = state.documents[id];
            const pdfArray = await blobToUint8Array(doc.file);
            stmtDoc.run([id, doc.name, pdfArray, doc.thumbnail]);
        }
        stmtDoc.free();

        const stmtLink = db.prepare("INSERT INTO links VALUES (?, ?, ?)");
        for (const link of state.links) {
            stmtLink.run([link.id, JSON.stringify(link.source), JSON.stringify(link.target)]);
        }
        stmtLink.free();

        const stmtAnno = db.prepare("INSERT INTO annotations VALUES (?, ?, ?)");
        for (const docId in state.annotations) {
            for (const pageNum in state.annotations[docId]) {
                stmtAnno.run([docId, pageNum, JSON.stringify(state.annotations[docId][pageNum])]);
            }
        }
        stmtAnno.free();

        const stmtEmb = db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?)");
        for (const emb of state.embeddings) {
            stmtEmb.run([emb.id, emb.text, JSON.stringify(emb.vector), emb.docId, emb.pageNum]);
        }
        stmtEmb.free();

        const stmtChat = db.prepare("INSERT INTO chats VALUES (?, ?, ?)");
        for (const chat of state.chats) {
            stmtChat.run([chat.id, chat.title, JSON.stringify(chat.messages)]);
        }
        stmtChat.free();

        const settings = {
            id: 'appState',
            view: state.view,
            splitRatio: state.splitRatio,
            appMode: state.appMode,
            annoTool: state.annoTool,
            annoColor: state.annoColor,
            annoThickness: state.annoThickness,
            leftSidebarCollapsed: document.body.classList.contains('left-sidebar-collapsed'),
            aiSidebarCollapsed: document.body.classList.contains('ai-sidebar-collapsed')
        };
        const stmtSet = db.prepare("INSERT INTO settings VALUES (?, ?)");
        stmtSet.run(['appState', JSON.stringify(settings)]);
        stmtSet.free();

        const data = db.export();
        const blob = new Blob([data], { type: 'application/x-sqlite3' });
        
        let handle = state.projectFileHandle;
        
        if (!handle) {
            try {
                if (window.showSaveFilePicker) {
                    handle = await window.showSaveFilePicker({
                        suggestedName: 'pdf_linker_project.sqlite',
                        types: [{ description: 'SQLite Database', accept: {'application/x-sqlite3': ['.sqlite']}}],
                    });
                } else {
                    throw new Error("API not supported");
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    els.loadingSpinner.classList.add('hidden');
                    return; 
                }
                throw new Error("Use Standard Download");
            }
        }

        try {
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            state.projectFileHandle = handle;
            showModal("Saved", "Project saved successfully as SQLite database!");
        } catch (writeErr) {
            console.error(writeErr);
            throw new Error("Write failed");
        }

    } catch (err) {
        console.error("Save Error:", err);
        try {
            const data = db.export(); 
            const blob = new Blob([data], { type: 'application/x-sqlite3' });
            saveAs(blob, "pdf_linker_project.sqlite");
            showModal("Download", "Project downloaded.");
        } catch (fallbackErr) {
                showModal("Error", "Failed to save project.");
        }
    } finally {
        els.loadingSpinner.classList.add('hidden');
    }
};

async function handleProjectImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Loading SQLite Project...";

    try {
        const arrayBuffer = await file.arrayBuffer();
        const u8array = new Uint8Array(arrayBuffer);
        const db = new window.SQL.Database(u8array);

        // Load Documents
        const docRows = db.exec("SELECT * FROM documents");
        if (docRows.length > 0) {
            const rows = docRows[0].values;
            for (let i = 0; i < rows.length; i++) {
                const [id, name, blobData, thumb] = rows[i];
                
                const blob = uint8ArrayToBlob(blobData, 'application/pdf');
                const pdfArrayBuffer = await blob.arrayBuffer();
                const pdfDoc = await pdfjsLib.getDocument(pdfArrayBuffer).promise;

                state.documents[id] = {
                    id, name, file: blob, pdfDoc, 
                    pageCount: pdfDoc.numPages, thumbnail: thumb
                };
                await saveDocumentToDB({ id, name, pageCount: pdfDoc.numPages, thumbnail: thumb, fileBlob: blob });
            }
        }

        // Load Annotations
        const annoRows = db.exec("SELECT * FROM annotations");
        if (annoRows.length > 0) {
            const rows = annoRows[0].values;
            for (let i = 0; i < rows.length; i++) {
                const [docId, pageNum, json] = rows[i];
                
                if (!state.annotations[docId]) state.annotations[docId] = {};
                const data = JSON.parse(json);
                state.annotations[docId][pageNum] = data;
                
                if (data.images) {
                    data.images.forEach(img => {
                        const imageObj = new Image();
                        imageObj.src = img.src;
                        state.imageCache[img.id] = imageObj;
                    });
                }
                if (!data.textBoxes) data.textBoxes = [];
                
                await saveAnnotationsToDB(docId, state.annotations[docId]);
            }
        }

        // Load Links
        const linkRows = db.exec("SELECT * FROM links");
        if (linkRows.length > 0) {
            const rows = linkRows[0].values;
            for (let i = 0; i < rows.length; i++) {
                const [id, srcJson, tgtJson] = rows[i];
                state.links.push({
                    id,
                    source: JSON.parse(srcJson),
                    target: JSON.parse(tgtJson)
                });
                await saveLinkToDB(state.links[state.links.length-1]);
            }
        }

        // Load Embeddings from SQLite 
        const embRows = db.exec("SELECT * FROM embeddings");
        if (embRows.length > 0) {
            const rows = embRows[0].values;
            for (let i = 0; i < rows.length; i++) {
                const [id, text, vecJson, dId, pNum] = rows[i];
                if (state.documents[dId]) {
                    try {
                        const vector = JSON.parse(vecJson);
                        state.embeddings.push({
                            id,
                            text,
                            vector: vector,
                            docId: dId,
                            pageNum: pNum,
                            docName: state.documents[dId].name
                        });
                    } catch (err) {
                        console.error("Failed to parse embedding vector for", id, err);
                    }
                }
            }
        }
        
        // Load Chats
        const chatRows = db.exec("SELECT * FROM chats");
        if (chatRows.length > 0) {
            const rows = chatRows[0].values;
            state.chats = [];
            for (let i = 0; i < rows.length; i++) {
                const [id, title, msgsJson] = rows[i];
                state.chats.push({
                    id,
                    title,
                    messages: JSON.parse(msgsJson)
                });
                await saveChatToDB(state.chats[i]);
            }
            if (state.chats.length > 0) state.currentChatId = state.chats[0].id;
        } else {
            await createNewChat();
        }

        // Load Settings
        const setRows = db.exec("SELECT * FROM settings WHERE key='appState'");
        if (setRows.length > 0) {
            const rows = setRows[0].values;
            const s = JSON.parse(rows[0][1]);
            state.view = s.view;
            state.splitRatio = s.splitRatio;
            state.appMode = s.appMode;
            state.annoTool = s.annoTool;
            state.annoColor = s.annoColor;
            state.annoThickness = s.annoThickness;
            
            els.leftPanel.style.width = (state.splitRatio * 100) + '%';
            els.rightPanel.style.width = ((1 - state.splitRatio) * 100) + '%';
            
            setAppMode(state.appMode, false);
            setAnnoTool(state.annoTool, false);
            els.colorPicker.value = state.annoColor;
            els.thicknessPicker.value = s.annoThickness;

            if (s.leftSidebarCollapsed) document.body.classList.add('left-sidebar-collapsed');
            else document.body.classList.remove('left-sidebar-collapsed');
            
            if (s.aiSidebarCollapsed) document.body.classList.add('ai-sidebar-collapsed');
            else document.body.classList.remove('ai-sidebar-collapsed');

            saveSettings(); 
            updateLockVisuals(); 
        }

        state.projectFileHandle = null;
        showModal("Import Success", "Project loaded from SQLite.");
        
        renderDocList();
        renderChatList();
        renderChatMessages();
        updateZoomIndicator('left');
        updateZoomIndicator('right');
        if (state.view.left.docId) renderPage('left');
        if (state.view.right.docId) renderPage('right');
        
        indexDocuments(false);

    } catch (err) {
        console.error(err);
        showModal("Import Error", "Failed to load project. Ensure it is a valid .sqlite file.");
    } finally {
        els.loadingSpinner.classList.add('hidden');
    }
    e.target.value = '';
}
