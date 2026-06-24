// ==========================================
// 📁 6. ai.js
// ==========================================
async function createNewChat() {
    const newId = generateId();
    const newChat = {
        id: newId,
        title: 'New Chat',
        messages: []
    };
    state.chats.unshift(newChat);
    state.currentChatId = newId;
    await saveChatToDB(newChat);
    renderChatList();
    renderChatMessages();
    els.chatInput.focus();
}

async function switchChat(chatId) {
    state.currentChatId = chatId;
    renderChatList();
    renderChatMessages();
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
                <br>Uses <span class="font-mono">nomic-embed-text</span> & <span class="font-mono">llama3.2</span>.
            </div>`;
        return;
    }

    chat.messages.forEach(msg => {
        let htmlContent = msg.html;

        if (msg.role === 'assistant' && msg.context && htmlContent.includes('jumpToCitation')) {
            const getTooltip = (chunk) => {
                const snippet = chunk.text.length > 150 ? chunk.text.substring(0, 150) + "..." : chunk.text;
                return `Source: ${chunk.docName} (Page ${chunk.pageNum})\nText: ${snippet}`;
            };

            htmlContent = htmlContent.replace(
                /<span class="citation-chip" onclick="jumpToCitation\((\d+)\)">(\d+)<\/span>/g, 
                (match, idxStr, text) => {
                    const idx = parseInt(idxStr);
                    const chunk = msg.context[idx];
                    if (chunk) {
                        return `<span class="citation-chip" onclick="handleCitationClick(this)" 
                                    data-doc="${chunk.docId}" 
                                    data-page="${chunk.pageNum}" 
                                    data-text="${encodeURIComponent(chunk.text)}"
                                    title="${escapeHtml(getTooltip(chunk))}">${text}</span>`;
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
                        return `<span class="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-100" 
                                    onclick="handleCitationClick(this)"
                                    data-doc="${chunk.docId}" 
                                    data-page="${chunk.pageNum}" 
                                    data-text="${encodeURIComponent(chunk.text)}"
                                    title="${escapeHtml(getTooltip(chunk))}">
                                    [${idx+1}]
                                </span>`;
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

async function getEmbedding(text) {
    try {
        const response = await fetch('http://localhost:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: "nomic-embed-text:latest", prompt: text })
        });
        const data = await response.json();
        return data.embedding;
    } catch (error) {
        console.error("Embedding Error:", error);
        return null;
    }
}

// Rewritten to support streaming via a callback
async function generateLLMResponse(prompt, onChunk) {
    try {
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: "gemma3:1b", prompt: prompt, stream: !!onChunk })
        });

        // Fallback for non-streaming requests
        if (!onChunk) {
            const data = await response.json();
            return data.response;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullResponse = "";
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            
            // Keep the last partial line in the buffer
            buffer = lines.pop(); 
            
            for (const line of lines) {
                if (line.trim() === '') continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.response) {
                        fullResponse += parsed.response;
                        onChunk(fullResponse); // Send the accumulated text
                    }
                } catch (e) {
                    console.error("Error parsing JSON line:", e, line);
                }
            }
        }

        // Catch anything left in the buffer at the end of the stream
        if (buffer.trim() !== '') {
            try {
                const parsed = JSON.parse(buffer);
                if (parsed.response) {
                    fullResponse += parsed.response;
                    onChunk(fullResponse);
                }
            } catch (e) {
                console.error("Error parsing final JSON line:", e, buffer);
            }
        }

        return fullResponse;
    } catch (error) {
        console.error("LLM Error:", error);
        return "Error connecting to LLM.";
    }
}

async function indexDocuments(force = false) {
    if (state.isIndexing) return;
    
    const docIds = Object.keys(state.documents);
    const embeddedDocIds = new Set(state.embeddings.map(e => e.docId));
    const needsIndexing = force || docIds.some(id => !embeddedDocIds.has(id));

    if (!needsIndexing) {
        updateAIStatus(`Ready. Indexed ${state.embeddings.length} segments.`);
        return;
    }

    state.isIndexing = true;
    updateAIStatus("Indexing PDFs...");
    
    const chunkSize = 500;
    const overlap = 50;

    for (const docId of docIds) {
        if (embeddedDocIds.has(docId) && !force) continue; 

        const doc = state.documents[docId];
        const totalPages = Math.min(doc.pageCount, 50); 

        for (let i = 1; i <= totalPages; i++) {
            try {
                const page = await doc.pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ').trim();
                
                if(pageText.length < 10) continue;

                for (let start = 0; start < pageText.length; start += (chunkSize - overlap)) {
                    const chunk = pageText.substring(start, start + chunkSize);
                    if (chunk.trim().length > 10) {
                        const vector = await getEmbedding(chunk);
                        if (vector) {
                            state.embeddings.push({
                                id: `chunk_${docId}_${i}_${start}`,
                                text: chunk,
                                vector: vector,
                                docId: docId,
                                docName: doc.name,
                                pageNum: i
                            });
                        }
                    }
                }
            } catch (e) { console.error("Error indexing page", i, e); }
        }
    }
    
    state.isIndexing = false;
    updateAIStatus(`Ready. Indexed ${state.embeddings.length} segments.`);
}

function updateAIStatus(msg) {
    els.aiStatus.innerText = msg;
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

    // Process User Message
    chat.messages.push({ role: 'user', html: escapeHtml(question) });
    appendMessageToDOM('user', escapeHtml(question));
    
    els.chatInput.value = '';
    updateAIStatus("Thinking...");

    const questionVector = await getEmbedding(question);
    if (!questionVector) {
        appendMessageToDOM('assistant', "Failed to generate embedding for question.");
        updateAIStatus("Error");
        return;
    }

    // ---------------------------------------------------------
    // BUDGET RETRIEVAL STRATEGY
    // ---------------------------------------------------------
    const allScoredEmbeddings = state.embeddings
        .map(emb => ({ ...emb, score: cosineSimilarity(questionVector, emb.vector) }))
        .sort((a, b) => b.score - a.score);

    let scoredEmbeddings = [];
    let totalContextChars = 0;
    let highestScore = allScoredEmbeddings.length > 0 ? allScoredEmbeddings[0].score : 0;
    let lowestSelectedScore = highestScore;

    if (allScoredEmbeddings.length > 0) {
        if (allScoredEmbeddings[0].score < 0.65) {
            // Fallback: If no chunk meets the 0.65 threshold, use the single highest scoring chunk
            scoredEmbeddings.push(allScoredEmbeddings[0]);
            totalContextChars = allScoredEmbeddings[0].text.length;
            lowestSelectedScore = allScoredEmbeddings[0].score;
        } else {
            // Budget Retrieval
            for (const chunk of allScoredEmbeddings) {
                if (chunk.score < 0.65) break; // Reached chunks below threshold
                if (scoredEmbeddings.length >= 8) break; // Limit 1: Max 8 chunks
                if (totalContextChars + chunk.text.length > 4000) break; // Limit 2: Max 4000 chars

                scoredEmbeddings.push(chunk);
                totalContextChars += chunk.text.length;
                lowestSelectedScore = chunk.score;
            }
        }
    }

    // Output metrics to console as requested
    console.log(`[Budget Retrieval] Selected Chunks: ${scoredEmbeddings.length}`);
    console.log(`[Budget Retrieval] Total Characters: ${totalContextChars}`);
    console.log(`[Budget Retrieval] Highest Score: ${highestScore.toFixed(4)}`);
    console.log(`[Budget Retrieval] Lowest Selected Score: ${lowestSelectedScore.toFixed(4)}`);
    // ---------------------------------------------------------

    state.currentContextChunks = scoredEmbeddings;

    const contextText = scoredEmbeddings.map((emb, idx) => 
        `[${idx + 1}] Source: ${emb.docName} (Page ${emb.pageNum})\nText: ${emb.text}`
    ).join("\n---\n");

    const systemPrompt = `You are a helpful assistant answering questions based on the provided PDF context.
    Use the context below to answer the user's question.`;

    const fullPrompt = `${systemPrompt}\n\nContext:\n${contextText}\n\nUser Question: ${question}\n\nAnswer:`;

    // 1. Pre-build the sources footer HTML before starting the stream
    let sourcesHtml = '';
    if (scoredEmbeddings.length > 0) {
        sourcesHtml = `<div class="mt-2 pt-2 border-t border-gray-200 flex flex-wrap gap-1">`;
        scoredEmbeddings.forEach((emb, idx) => {
            const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
            const tooltipText = `Source: ${emb.docName} (Page ${emb.pageNum})\nText: ${snippet}`;

            sourcesHtml += `<span class="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-100" 
                onclick="handleCitationClick(this)"
                data-doc="${emb.docId}" 
                data-page="${emb.pageNum}" 
                data-text="${encodeURIComponent(emb.text)}"
                title="${escapeHtml(tooltipText)}">
                [${idx+1}]
            </span>`;
        });
        sourcesHtml += `</div>`;
    }

    // 2. Create a placeholder in the DOM & State for the streaming response (with sources attached early)
    const assistantMsg = { role: 'assistant', html: '', context: scoredEmbeddings };
    chat.messages.push(assistantMsg);

    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message assistant`;
    msgDiv.innerHTML = `
        <div class="ai-bubble">
            <div class="streaming-content"><span class="text-gray-400 italic">Generating response...</span></div>
            ${sourcesHtml}
        </div>
    `;
    els.chatHistory.appendChild(msgDiv);
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    
    const contentBubble = msgDiv.querySelector('.streaming-content');

    // 3. Stream the LLM response text chunk-by-chunk directly into the content container
    const answer = await generateLLMResponse(fullPrompt, (fullText) => {
        // Render inline citations dynamically as the text arrives
        const formattedAnswer = fullText.replace(/\[(\d+)\]/g, (match, num) => {
            const idx = parseInt(num) - 1;
            const emb = scoredEmbeddings[idx];
            if (!emb) return match; 

            const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
            const tooltipText = `Source: ${emb.docName} (Page ${emb.pageNum})\nText: ${snippet}`;

            return `<span class="citation-chip" onclick="handleCitationClick(this)" 
                        data-doc="${emb.docId}" 
                        data-page="${emb.pageNum}" 
                        data-text="${encodeURIComponent(emb.text)}"
                        title="${escapeHtml(tooltipText)}">${num}</span>`;
        });

        // Replace line breaks to preserve formatting in HTML
        contentBubble.innerHTML = formattedAnswer.replace(/\n/g, '<br>');
        els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    });

    // 4. Upon completion, finalize the text formatting
    const finalFormattedAnswer = answer.replace(/\[(\d+)\]/g, (match, num) => {
        const idx = parseInt(num) - 1;
        const emb = scoredEmbeddings[idx];
        if (!emb) return match; 

        const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
        const tooltipText = `Source: ${emb.docName} (Page ${emb.pageNum})\nText: ${snippet}`;

        return `<span class="citation-chip" onclick="handleCitationClick(this)" 
                    data-doc="${emb.docId}" 
                    data-page="${emb.pageNum}" 
                    data-text="${encodeURIComponent(emb.text)}"
                    title="${escapeHtml(tooltipText)}">${num}</span>`;
    });

    let finalHtml = finalFormattedAnswer.replace(/\n/g, '<br>');
    
    // Update the DOM one last time
    contentBubble.innerHTML = finalHtml;
    
    // Save to the state (wrap in streaming-content for visual parity and append sources)
    assistantMsg.html = `<div class="streaming-content">${finalHtml}</div>${sourcesHtml}`;
    
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    await saveChatToDB(chat);
    updateAIStatus("Ready");
}

window.handleCitationClick = function(el) {
    const docId = el.dataset.doc;
    const pageNum = parseInt(el.dataset.page);
    const text = decodeURIComponent(el.dataset.text);

    if (!docId || !state.documents[docId]) return;

    state.view.right.docId = docId;
    state.view.right.pageNum = pageNum;
    
    renderPage('right');

    setTimeout(() => {
        highlightChunk(text, 'right');
    }, 100);
};

window.jumpToCitation = function(index) {
    const chunk = state.currentContextChunks[index];
    if (!chunk) return;

    state.view.right.docId = chunk.docId;
    state.view.right.pageNum = chunk.pageNum;
    
    renderPage('right');

    setTimeout(() => {
        highlightChunk(chunk.text, 'right');
    }, 100);
};