// ==========================================
// 📁 1. utils.js
// ==========================================
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

function generateId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

const blobToUint8Array = async (blob) => {
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
};

const uint8ArrayToBlob = (u8Array, mimeType) => {
    return new Blob([u8Array], { type: mimeType });
};

function getCssFontFamily(pdfFontName) {
    if (!pdfFontName) return 'sans-serif';
    const n = pdfFontName.toLowerCase();
    if (n.includes('times')) return 'Times New Roman, serif';
    if (n.includes('helvetica')) return 'Helvetica, Arial, sans-serif';
    if (n.includes('courier')) return 'Courier New, monospace';
    return 'sans-serif'; 
}

function distToSegmentSquared(p, v, w) {
    const l2 = (v.x - w.x)**2 + (v.y - w.y)**2;
    if (l2 === 0) return (p.x - v.x)**2 + (p.y - v.y)**2;
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return (p.x - (v.x + t * (w.x - v.x)))**2 + 
            (p.y - (v.y + t * (w.y - v.y)))**2;
}

function rectsIntersect(r1, r2) {
    return !(r2.x > r1.x + r1.w || 
                r2.x + r2.w < r1.x || 
                r2.y > r1.y + r1.h || 
                r2.y + r2.h < r1.y);
}

function getStrokeBounds(stroke) {
    if (!stroke.points || stroke.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    stroke.points.forEach(p => {
        if(p.x < minX) minX = p.x;
        if(p.x > maxX) maxX = p.x;
        if(p.y < minY) minY = p.y;
        if(p.y > maxY) maxY = p.y;
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

