(function(){
const row=document.querySelector('body > .flex.flex-1.overflow-hidden');
const rail=document.getElementById('right-mini-rail');
if(!row||!rail)return;
const fs=document.getElementById('float-sidebar'),ft=document.getElementById('float-toolbar');
if(fs)row.insertBefore(fs,rail);
if(ft)row.insertBefore(ft,rail);
try{if(typeof setFloatToolbarOrientation==='function')setFloatToolbarOrientation('vertical');}catch(e){}
if(ft)ft.classList.add('ft-vertical');
if(fs){
const h=document.createElement('div');h.id='fs-resizer';fs.appendChild(h);
try{const w=+localStorage.getItem('aiPanelW');if(w)document.documentElement.style.setProperty('--ai-w',w+'px');}catch(e){}
h.addEventListener('pointerdown',e=>{
e.preventDefault();h.setPointerCapture(e.pointerId);
const mv=ev=>{const w=Math.min(600,Math.max(260,fs.getBoundingClientRect().right-ev.clientX));document.documentElement.style.setProperty('--ai-w',w+'px');};
const up=()=>{h.removeEventListener('pointermove',mv);h.removeEventListener('pointerup',up);try{localStorage.setItem('aiPanelW',parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ai-w')));}catch(_){}};
h.addEventListener('pointermove',mv);h.addEventListener('pointerup',up);});
}
['left','right'].forEach(side=>{
const vp=document.getElementById(side+'-viewport');if(!vp||!window.ResizeObserver)return;
let last=0,t;
new ResizeObserver(es=>{
const w=es[0].contentRect.width;
if(Math.abs(w-last)<24)return;
last=w;clearTimeout(t);
t=setTimeout(()=>{try{resetZoom(side);}catch(e){}},300);
}).observe(vp);
});
})();
