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
                <br>Uses <span class="font-mono">nomic-embed-text</span> & local LLM.
            </div>`;
        return;
    }

    chat.messages.forEach(msg => {
        let htmlContent = msg.html;

        if (msg.role === 'assistant' && msg.context && htmlContent.includes('jumpToCitation')) {
            const getTooltip = (chunk) => {
                const snippet = chunk.text.length > 150 ? chunk.text.substring(0, 150) + "..." : chunk.text;
                return `Source: ${chunk.docName} (Page ${chunk.pageNum})&#10;Text: ${snippet}`;
            };

            htmlContent = htmlContent.replace(
                /<span class="citation-chip" onclick="jumpToCitation\((\d+)\)">(\d+)<\/span>/g, 
                (match, idxStr, text) => {
                    const idx = parseInt(idxStr);
                    const chunk = msg.context[idx];
                    if (chunk) {
                        return `<span class="citation-chip" onclick="handleCitationClick(this)" data-doc="${chunk.docId}" data-page="${chunk.pageNum}" data-text="${encodeURIComponent(chunk.text)}" title="${escapeHtml(getTooltip(chunk))}">${text}</span>`;
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
                        return `<span class="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-100" onclick="handleCitationClick(this)" data-doc="${chunk.docId}" data-page="${chunk.pageNum}" data-text="${encodeURIComponent(chunk.text)}" title="${escapeHtml(getTooltip(chunk))}">[${idx+1}]</span>`;
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

async function generateLLMResponse(prompt, onChunk) {
    try {
        const payload = { 
            model: state.aiSettings.model, 
            prompt: prompt, 
            stream: !!onChunk,
            options: {
                temperature: state.aiSettings.temperature
            }
        };

        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

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
            
            buffer = lines.pop(); 
            
            for (const line of lines) {
                if (line.trim() === '') continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.response) {
                        fullResponse += parsed.response;
                        onChunk(fullResponse);
                    }
                } catch (e) {
                    console.error("Error parsing JSON line:", e, line);
                }
            }
        }

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
        return "Error connecting to LLM. Please check your Ollama configuration and selected model.";
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
    
    // Use dynamically configured chunk size
    const chunkSize = state.aiSettings.chunkSize || 500;
    const overlap = Math.floor(chunkSize * 0.1); // 10% overlap

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

// Utility function to extract clean text from HTML
function extractTextFromHTML(html) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    return tempDiv.innerText || tempDiv.textContent || "";
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
    // BUDGET RETRIEVAL STRATEGY (Using user configurations)
    // ---------------------------------------------------------
    const allScoredEmbeddings = state.embeddings
        .map(emb => ({ ...emb, score: cosineSimilarity(questionVector, emb.vector) }))
        .sort((a, b) => b.score - a.score);

    let scoredEmbeddings = [];
    let totalContextChars = 0;
    let highestScore = allScoredEmbeddings.length > 0 ? allScoredEmbeddings[0].score : 0;
    let lowestSelectedScore = highestScore;

    if (allScoredEmbeddings.length > 0) {
        if (allScoredEmbeddings[0].score < state.aiSettings.similarityThreshold) {
            // Fallback: If no chunk meets the threshold, use the single highest scoring chunk (let LLM reject it if Strict RAG is on)
            scoredEmbeddings.push(allScoredEmbeddings[0]);
            totalContextChars = allScoredEmbeddings[0].text.length;
            lowestSelectedScore = allScoredEmbeddings[0].score;
        } else {
            // Configurable Budget Retrieval
            for (const chunk of allScoredEmbeddings) {
                if (chunk.score < state.aiSettings.similarityThreshold) break; 
                if (scoredEmbeddings.length >= state.aiSettings.maxChunks) break; 
                if (totalContextChars + chunk.text.length > state.aiSettings.contextBudget) break;

                scoredEmbeddings.push(chunk);
                totalContextChars += chunk.text.length;
                lowestSelectedScore = chunk.score;
            }
        }
    }

    console.log(`[Retrieval] Selected Chunks: ${scoredEmbeddings.length}`);
    console.log(`[Retrieval] Total Characters: ${totalContextChars}`);
    console.log(`[Retrieval] Highest Score: ${highestScore.toFixed(4)}`);
    console.log(`[Retrieval] Lowest Selected Score: ${lowestSelectedScore.toFixed(4)}`);
    // ---------------------------------------------------------

    state.currentContextChunks = scoredEmbeddings;

    const contextText = scoredEmbeddings.map((emb, idx) => 
        `[${idx + 1}] Source: ${emb.docName} (Page ${emb.pageNum})\nText: ${emb.text}`
    ).join("\n---\n");

    // Construct Prompt via AI Settings 
    let systemPrompt = state.aiSettings.systemPrompt;
    
    if (state.aiSettings.strictRag) {
        systemPrompt += "\n\nSTRICT RAG INSTRUCTION: Answer ONLY using the provided Context. If the context does not contain the answer, reply exactly with: 'I don't know based on the provided context.' Do not use outside knowledge.";
    }

    const style = state.aiSettings.responseStyle;
    if (style === "Concise") {
        systemPrompt += "\n\nResponse Style Instruction: Be extremely concise and direct. Provide only the essential facts extracted from the context. Keep your response brief (2-3 sentences if possible) without unnecessary fluff or conversational filler.";
    } else if (style === "Expert") {
        systemPrompt += "\n\nResponse Style Instruction: Answer as a domain expert. Use precise, technical, and professional language. Provide a nuanced, highly rigorous analysis based on the context. Assume the reader possesses advanced technical knowledge.";
    } else {
        // Detailed (Default)
        systemPrompt += "\n\nResponse Style Instruction: Provide a thorough, comprehensive, and detailed explanation. Break down the information clearly, step-by-step. Use formatting like bullet points or bold text if helpful to make the detailed answer highly readable.";
    }

    // Chat History Construction
    let historyText = "";
    if (state.aiSettings.includeChatHistory && chat.messages.length > 1) {
        // Get the last 6 messages excluding the user's latest question (which is at the end)
        const recentMessages = chat.messages.slice(0, -1).slice(-6);
        if (recentMessages.length > 0) {
            historyText = "--- Recent Chat History ---\n";
            recentMessages.forEach(m => {
                const cleanText = extractTextFromHTML(m.html).trim();
                historyText += `${m.role === 'user' ? 'User' : 'Assistant'}: ${cleanText}\n\n`;
            });
            historyText += "---------------------------\n\n";
        }
    }

    const fullPrompt = `${systemPrompt}\n\nContext:\n${contextText}\n\n${historyText}User Question: ${question}\n\nAnswer:`;

    // Pre-build the sources footer HTML
    let sourcesHtml = '';
    if (scoredEmbeddings.length > 0) {
        sourcesHtml = `<div class="mt-2 pt-2 border-t border-gray-200 flex flex-wrap gap-1">`;
        scoredEmbeddings.forEach((emb, idx) => {
            const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
            const tooltipText = `Source: ${emb.docName} (Page ${emb.pageNum})&#10;Text: ${snippet}`;

            sourcesHtml += `<span class="text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-100" onclick="handleCitationClick(this)" data-doc="${emb.docId}" data-page="${emb.pageNum}" data-text="${encodeURIComponent(emb.text)}" title="${escapeHtml(tooltipText)}">[${idx+1}]</span>`;
        });
        sourcesHtml += `</div>`;
    }

    if (state.aiSettings.skipLlm) {
        let finalHtml = "<em class='text-gray-500'>LLM generation skipped. Returning sources only.</em>";
        if (scoredEmbeddings.length === 0) {
            finalHtml = "<em class='text-gray-500'>LLM generation skipped. No relevant sources found for your query.</em>";
        }
        
        const assistantMsg = { role: 'assistant', html: `<div class="streaming-content">${finalHtml}</div>${sourcesHtml}`, context: scoredEmbeddings };
        chat.messages.push(assistantMsg);

        const msgDiv = document.createElement('div');
        msgDiv.className = `ai-message assistant`;
        msgDiv.innerHTML = `
            <div class="ai-bubble">
                <div class="streaming-content">${finalHtml}</div>
                ${sourcesHtml}
            </div>
        `;
        els.chatHistory.appendChild(msgDiv);
        els.chatHistory.scrollTop = els.chatHistory.scrollHeight;

        await saveChatToDB(chat);
        updateAIStatus("Ready");
        return;
    }

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

    // Stream the LLM response
    const answer = await generateLLMResponse(fullPrompt, (fullText) => {
        let htmlText = fullText.replace(/\n/g, '<br>');
        
        htmlText = htmlText.replace(/\[(\d+)\]/g, (match, num) => {
            const idx = parseInt(num) - 1;
            const emb = scoredEmbeddings[idx];
            if (!emb) return match; 

            const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
            const tooltipText = `Source: ${emb.docName} (Page ${emb.pageNum})&#10;Text: ${snippet}`;

            return `<span class="citation-chip" onclick="handleCitationClick(this)" data-doc="${emb.docId}" data-page="${emb.pageNum}" data-text="${encodeURIComponent(emb.text)}" title="${escapeHtml(tooltipText)}">${num}</span>`;
        });
        
        contentBubble.innerHTML = htmlText;
        els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    });

    let finalHtml = answer.replace(/\n/g, '<br>');
    
    finalHtml = finalHtml.replace(/\[(\d+)\]/g, (match, num) => {
        const idx = parseInt(num) - 1;
        const emb = scoredEmbeddings[idx];
        if (!emb) return match; 

        const snippet = emb.text.length > 150 ? emb.text.substring(0, 150) + "..." : emb.text;
        const tooltipText = `Source: ${emb.docName} (Page ${emb.pageNum})&#10;Text: ${snippet}`;

        return `<span class="citation-chip" onclick="handleCitationClick(this)" data-doc="${emb.docId}" data-page="${emb.pageNum}" data-text="${encodeURIComponent(emb.text)}" title="${escapeHtml(tooltipText)}">${num}</span>`;
    });

    contentBubble.innerHTML = finalHtml;
    
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