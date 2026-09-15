// ==========================================
// 📁 6. ai.js
// ==========================================
async function createNewChat() {
    try {
        // Create the chat on the server first — it returns the canonical ID.
        const created = await Api.createChat('New Chat');
        const newChat = {
            id: created.id,
            title: created.title || 'New Chat',
            messages: created.messages || []
        };
        state.chats.unshift(newChat);
        state.currentChatId = newChat.id;
        renderChatList();
        renderChatMessages();
        els.chatInput.focus();
        if (typeof closeChatHistory === 'function') closeChatHistory();
    } catch (err) {
        console.error('Failed to create new chat:', err);
        showModal('Error', `Could not create chat: ${escapeHtml(String(err))}`);
    }
}

async function switchChat(chatId) {
    state.currentChatId = chatId;
    renderChatList();
    renderChatMessages();
    if (typeof closeChatHistory === 'function') closeChatHistory();
}

async function deleteChat(chatId, event) {
    if(event) event.stopPropagation();
    if(!confirm("Delete this chat history?")) return;

    state.chats = state.chats.filter(c => c.id !== chatId);
    await deleteChatFromDB(chatId);

    if (state.currentChatId === chatId) {
        if (state.chats.length > 0) {
            state.currentChatId = state.chats[0].id;
        } else {
            createNewChat();
            return; 
        }
    }
    renderChatList();
    renderChatMessages();
}

async function renameChat(chatId, currentTitle, event) {
    if(event) event.stopPropagation();
    
    const newTitle = await showPromptModal("Rename Chat", currentTitle);
    if (newTitle && newTitle.trim() !== "") {
        const chat = state.chats.find(c => c.id === chatId);
        if (chat) {
            chat.title = newTitle.trim();
            await saveChatToDB(chat);
            renderChatList();
        }
    }
}

function renderChatList() {
    els.chatList.innerHTML = '';
    state.chats.forEach(chat => {
        const div = document.createElement('div');
        div.className = `chat-list-item ${chat.id === state.currentChatId ? 'active' : ''}`;
        div.innerHTML = `
            <div class="truncate pr-6">${chat.title}</div>
            <div class="chat-item-actions">
                <div class="action-btn action-rename" onclick="renameChat('${chat.id}', '${escapeHtml(chat.title)}', event)" title="Rename"><i class="fa-solid fa-pen"></i></div>
                <div class="action-btn action-delete" onclick="deleteChat('${chat.id}', event)" title="Delete"><i class="fa-solid fa-trash"></i></div>
            </div>
        `;
        div.onclick = () => switchChat(chat.id);
        els.chatList.appendChild(div);
    });
}

function renderChatMessages() {
    els.chatHistory.innerHTML = '';
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return;

    if (chat.messages.length === 0) {
        els.chatHistory.innerHTML = `
            <div class="text-center text-xs text-gray-400 mt-4">
                Ask a question about the loaded PDFs.
                <br>Uses <span class="font-mono">nomic-embed-text</span> & local LLM.
            </div>`;
        return;
    }

    chat.messages.forEach(msg => {
        let htmlContent = msg.html;

        if (msg.role === 'assistant' && msg.context && htmlContent.includes('jumpToCitation')) {
            // Helper: server sources use snake_case (doc_id, page_id, docName);
            // older in-memory chunks used camelCase. Normalize.
            const getDocId = (chunk) => chunk.doc_id || chunk.docId;
            const getPageId = (chunk) => chunk.page_id || chunk.pageId;
            const getDocName = (chunk) => chunk.docName || chunk.doc_name || 'Unknown';
            const getTooltip = (chunk) => {
                const snippet = chunk.text.length > 150 ? chunk.text.substring(0, 150) + "..." : chunk.text;
                return `Source: ${getDocName(chunk)} (Page ${getCurrentPageNumForChunk(chunk)})&#10;Text: ${snippet}`;
            };

            htmlContent = htmlContent.replace(
                /<span class="citation-chip" onclick="jumpToCitation\((\d+)\)">(\d+)<\/span>/g,
                (match, idxStr, text) => {
                    const idx = parseInt(idxStr);
                    const chunk = msg.context[idx];
                    if (chunk) {
                        return `<span class="citation-chip" onclick="handleCitationClick(this)" data-doc="${getDocId(chunk)}" data-page-id="${getPageId(chunk)}" data-text="${encodeURIComponent(chunk.text)}" title="${escapeHtml(getTooltip(chunk))}">${text}</span>`;
                    }
                    return match;
                }
            );

            htmlContent = htmlContent.replace(
                /<span class="text-\[10px\] bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-100" onclick="jumpToCitation\((\d+)\)">.*?<\/span>/g,
                (match, idxStr) => {
                    const idx = parseInt(idxStr);
                    const chunk = msg.context[idx];
                    if (chunk) {
                        return `<span class="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-100" onclick="handleCitationClick(this)" data-doc="${getDocId(chunk)}" data-page-id="${getPageId(chunk)}" data-text="${encodeURIComponent(chunk.text)}" title="${escapeHtml(getTooltip(chunk))}">[${idx+1}]</span>`;
                    }
                    return match;
                }
            );
        }
        appendMessageToDOM(msg.role, htmlContent);
    });
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

function appendMessageToDOM(role, htmlContent) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message ${role}`;
    msgDiv.innerHTML = `<div class="ai-bubble">${htmlContent}</div>`;
    els.chatHistory.appendChild(msgDiv);
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getCurrentPageNumForChunk(chunk) {
    const docId = chunk.doc_id || chunk.docId;
    const pageId = chunk.page_id || chunk.pageId;
    const doc = state.documents[docId];
    return doc ? pageNumFromId(doc, pageId) : (chunk.pageNum || '?');
}

async function getEmbedding(text) {
    // Deprecated — embeddings are now computed server-side during indexing.
    // Kept for backward compatibility with any code that still calls it.
    console.warn('getEmbedding() is deprecated — embeddings are computed server-side.');
    return null;
}

async function generateLLMResponse(prompt, onChunk) {
    // Deprecated — chat now goes through Api.streamChat() which does retrieval + LLM in one call.
    // This stub is kept so any external callers don't crash.
    console.warn('generateLLMResponse() is deprecated — use Api.streamChat() instead.');
    if (onChunk) onChunk("LLM generation has moved to the server. Use the chat input to ask questions.");
    return "LLM generation has moved to the server. Use the chat input to ask questions.";
}

async function indexDocuments(force = false) {
    if (state.isIndexing) return;

    state.isIndexing = true;
    updateAIStatus("Indexing PDFs on server...");

    try {
        // Trigger server-side indexing. This call blocks until done — for large
        // libraries (100+ PDFs), consider running this in a background task on
        // the server. For now, we wait synchronously.
        const result = await Api.triggerIndexing(force);
        if (result && result.total_embeddings !== undefined) {
            state.embeddings = [];  // Embeddings now live server-side; we don't keep them in browser memory.
            updateAIStatus(`Ready. ${result.total_embeddings} segments indexed.`);
        } else {
            updateAIStatus("Ready.");
        }
    } catch (err) {
        console.error('Indexing failed:', err);
        updateAIStatus("Indexing failed. Is Ollama running on the server?");
        showModal("Indexing Error",
            `Could not index documents. Make sure Ollama is running on the server PC<br>` +
            `and the embedding model ("${state.aiSettings?.model || 'gemma3:1b'}") is pulled.<br><br>` +
            `Error: ${escapeHtml(String(err))}`);
    } finally {
        state.isIndexing = false;
    }
}

function updateAIStatus(msg) {
    els.aiStatus.innerText = msg;
}

// Utility function to extract clean text from HTML
function extractTextFromHTML(html) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    return tempDiv.innerText || tempDiv.textContent || "";
}

// Renders raw LLM markdown text into safe HTML: markdown -> math (KaTeX) -> citation chips.
// Mirrors the text-box rendering pipeline in annotations.js (marked + katex) so AI answers
// look consistent with the rest of the app (headings, lists, tables, code blocks, bold/italic, math).
function renderMarkdownToHtml(rawText) {
    if (!rawText) return '';

    // 1. Protect math segments from marked (marked would otherwise mangle $...$ / $$...$$)
    let raw = rawText;
    const mathSegments = [];
    let mi = 0;

    raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
        const key = `MATHBLOCK${mi++}END`;
        mathSegments.push({ key, expr, display: true });
        return key;
    });
    raw = raw.replace(/\$([^\n$]+?)\$/g, (_, expr) => {
        const key = `MATHINLINE${mi++}END`;
        mathSegments.push({ key, expr, display: false });
        return key;
    });

    // 2. Markdown -> HTML (headings, lists, tables, bold/italic, fenced code w/ hljs, etc.)
    let html = marked.parse(raw);

    // 3. Re-insert math as rendered KaTeX
    mathSegments.forEach(({ key, expr, display }) => {
        let rendered;
        try {
            rendered = katex.renderToString(expr.trim(), {
                displayMode: display,
                throwOnError: false,
                output: 'html',
            });
        } catch (err) {
            rendered = `<span class="math-error">${escapeHtml(expr)}</span>`;
        }
        html = html.replaceAll(key, rendered);
    });

    return html;
}

// Inserts citation chips for [n] markers, but only in plain text — never inside <code> blocks,
// so code samples containing things like array[1] are left untouched.
function insertCitationChips(html, scoredEmbeddings) {
    const buildChip = (num) => {
        const idx = parseInt(num) - 1;
        const emb = scoredEmbeddings[idx];
        if (!emb) return null;

        const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
        const tooltipText = `Source: ${emb.docName} (Page ${getCurrentPageNumForChunk(emb)})&#10;Text: ${snippet}`;

        return `<span class="citation-chip" onclick="handleCitationClick(this)" data-doc="${emb.docId}" data-page-id="${emb.pageId}" data-text="${encodeURIComponent(emb.text)}" title="${escapeHtml(tooltipText)}">${num}</span>`;
    };

    // Split on <pre>...</pre> and <code>...</code> blocks so we skip citation replacement inside them
    const parts = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g);
    return parts.map(part => {
        if (part.startsWith('<pre') || part.startsWith('<code')) return part; // leave code untouched
        return part.replace(/\[(\d+)\]/g, (match, num) => buildChip(num) || match);
    }).join('');
}

async function handleChat() {
    const question = els.chatInput.value.trim();
    if (!question) return;

    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return;

    if (chat.messages.length === 0) {
        chat.title = question.substring(0, 30) + (question.length > 30 ? "..." : "");
        saveChatToDB(chat);
        renderChatList();
    }

    // User message
    chat.messages.push({ role: 'user', html: escapeHtml(question) });
    appendMessageToDOM('user', escapeHtml(question));

    els.chatInput.value = '';
    updateAIStatus("Thinking...");

    // Build chat history to send to server (last 6 messages, excluding the just-added user question).
    const chatHistory = state.aiSettings.includeChatHistory
        ? chat.messages.slice(0, -1).slice(-6).map(m => ({ role: m.role, html: m.html }))
        : [];

    // Placeholder for the assistant response.
    const assistantMsg = { role: 'assistant', html: '', context: [] };
    chat.messages.push(assistantMsg);

    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message assistant`;
    msgDiv.innerHTML = `
        <div class="ai-bubble">
            <div class="streaming-content"><span class="text-gray-400 italic">Generating response...</span></div>
            <div class="sources-container"></div>
        </div>
    `;
    els.chatHistory.appendChild(msgDiv);
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;

    const contentBubble = msgDiv.querySelector('.streaming-content');
    const sourcesContainer = msgDiv.querySelector('.sources-container');

    let scoredEmbeddings = [];

    // Build the chat request — the server will handle retrieval + LLM streaming.
    const request = {
        question: question,
        system_prompt: state.aiSettings.systemPrompt,
        chat_history: chatHistory,
        model: state.aiSettings.model,
        temperature: state.aiSettings.temperature,
        response_style: state.aiSettings.responseStyle,
        strict_rag: state.aiSettings.strictRag,
        skip_llm: state.aiSettings.skipLlm,
        include_chat_history: state.aiSettings.includeChatHistory,
        similarity_threshold: state.aiSettings.similarityThreshold,
        context_budget: state.aiSettings.contextBudget,
        max_chunks: state.aiSettings.maxChunks,
    };

    try {
        const finalAnswer = await Api.streamChat(request, {
            onSources: (sources) => {
                scoredEmbeddings = sources || [];
                state.currentContextChunks = scoredEmbeddings;
                assistantMsg.context = scoredEmbeddings;
                // Render sources footer
                if (scoredEmbeddings.length > 0) {
                    let sourcesHtml = '<div class="mt-2 pt-2 border-t border-gray-200 flex flex-wrap gap-1">';
                    scoredEmbeddings.forEach((emb, idx) => {
                        const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
                        const tooltipText = `Source: ${emb.docName} (Page ${emb.pageNum || '?'})&#10;Text: ${snippet}`;
                        sourcesHtml += `<span class="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-100" onclick="handleCitationClick(this)" data-doc="${emb.doc_id}" data-page-id="${emb.page_id || ''}" data-text="${encodeURIComponent(emb.text)}" title="${escapeHtml(tooltipText)}">[${idx+1}]</span>`;
                    });
                    sourcesHtml += '</div>';
                    sourcesContainer.innerHTML = sourcesHtml;
                }
            },
            onToken: (chunk, fullText) => {
                let htmlText = renderMarkdownToHtml(fullText);
                htmlText = insertCitationChips(htmlText, scoredEmbeddings);
                contentBubble.innerHTML = htmlText;
                if (typeof renderMath === 'function') renderMath(contentBubble);
                els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
            },
            onDone: (answer) => {
                let finalHtml = renderMarkdownToHtml(answer);
                finalHtml = insertCitationChips(finalHtml, scoredEmbeddings);
                contentBubble.innerHTML = finalHtml;
                if (typeof renderMath === 'function') renderMath(contentBubble);
                assistantMsg.html = `<div class="streaming-content">${finalHtml}</div>${sourcesContainer.innerHTML}`;
            },
            onError: (msg) => {
                contentBubble.innerHTML = `<span class="text-red-500">Error: ${escapeHtml(msg)}</span>`;
                assistantMsg.html = `<div class="streaming-content"><span class="text-red-500">Error: ${escapeHtml(msg)}</span></div>`;
            },
        });
        await saveChatToDB(chat);
        updateAIStatus("Ready");
    } catch (err) {
        console.error('Chat failed:', err);
        contentBubble.innerHTML = `<span class="text-red-500">Error: ${escapeHtml(String(err))}</span>`;
        updateAIStatus("Error");
    }
}

window.handleCitationClick = function(el) {
    const docId = el.dataset.doc;
    const pageId = el.dataset.pageId;
    const text = decodeURIComponent(el.dataset.text);

    if (!docId || !state.documents[docId]) return;

    const doc = state.documents[docId];
    // Resolve the CURRENT page number for this stable pageId — correct even if pages
    // were inserted or deleted in this doc since the citation was created.
    const pageNum = pageNumFromId(doc, pageId);

    // Track active citation state (rendered directly inside the upcoming renderPage cycle)
    state.activeCitation = {
        docId: docId,
        pageId: pageId,
        pageNum: pageNum,
        text: text,
        side: 'right',
        scrolled: false // Freshly clicked, ensure it scrolls to view
    };

    state.view.right.docId = docId;
    state.view.right.pageId = pageId;
    state.view.right.pageNum = pageNum;
    
    renderPage('right');
};

window.jumpToCitation = function(index) {
    const chunk = state.currentContextChunks[index];
    if (!chunk) return;

    // Sources from the server use doc_id / page_id (snake_case); old in-memory
    // chunks used docId / pageId. Support both for robustness.
    const docId = chunk.doc_id || chunk.docId;
    const pageId = chunk.page_id || chunk.pageId;

    const doc = state.documents[docId];
    const pageNum = doc ? pageNumFromId(doc, pageId) : 1;

    state.activeCitation = {
        docId: docId,
        pageId: pageId,
        pageNum: pageNum,
        text: chunk.text,
        side: 'right',
        scrolled: false
    };

    state.view.right.docId = docId;
    state.view.right.pageId = pageId;
    state.view.right.pageNum = pageNum;

    renderPage('right');
};