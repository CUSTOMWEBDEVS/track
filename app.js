/* TrackTheDrops - app.js
 * Baseline + experiment patch
 * NOTE: This file includes an experiment toggle:
 *   const USE_SEED_GROW = true;
 * Set it to false to use the original baseline detector.
 */
(function(){
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (id)=>document.getElementById(id);
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const now = ()=>performance.now();

  // ---------- elements ----------
  const el = {
    video: $('video'),
    canvas: $('canvas'),
    overlay: $('overlay'),
    startBtn: $('startBtn'),
    torchBtn: $('torchBtn'),
    alertBtn: $('alertBtn'),
    installBtn: $('installBtn'),
    status: $('status'),
    fps: $('fps'),
    // optional sliders (baseline has these sometimes)
    sens: $('sens'),
    thr: $('thr'),
    stability: $('stability'),
    opacity: $('opacity')
  };

  // ---------- state ----------
  let stream = null;
  let track = null;
  let torchOn = false;

  let running = false;
  let rafId = 0;

  // mask persistence
  let persist = null;    // Float32Array
  let persistW = 0, persistH = 0;

  // strictness (baseline)
  let STRICTNESS = 50; // baseline default

  // ---------- install (PWA) ----------
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredPrompt = e;
    if(el.installBtn){
      el.installBtn.disabled = false;
      el.installBtn.classList.add('ready');
    }
  });

  async function doInstall(){
    if(!el.installBtn) return;

    // Android/Chromium
    if(deferredPrompt){
      deferredPrompt.prompt();
      const res = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if(res && res.outcome === 'accepted'){
        setStatus('Installed ✅');
      } else {
        setStatus('Install canceled');
      }
      return;
    }

    // iOS Safari: cannot trigger install, show instructions
    // (Baseline behavior: status text only)
    setStatus('On iPhone: Share → Add to Home Screen');
  }

  // ---------- camera ----------
  async function startCamera(){
    if(stream) return;

    const constraints = {
      audio:false,
      video:{
        facingMode:{ ideal:'environment' }
      }
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    el.video.srcObject = stream;
    await el.video.play();

    track = stream.getVideoTracks()[0] || null;
  }

  function stopCamera(){
    if(stream){
      stream.getTracks().forEach(t=>t.stop());
    }
    stream = null;
    track = null;
    torchOn = false;
  }

  async function setTorch(on){
    if(!track) return;
    try{
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if(!caps.torch){
        setStatus('Torch not supported on this device');
        return;
      }
      await track.applyConstraints({ advanced:[{ torch: !!on }] });
      torchOn = !!on;
      if(el.torchBtn) el.torchBtn.textContent = torchOn ? 'Flashlight: On' : 'Flashlight';
    }catch(err){
      console.warn('torch error', err);
      setStatus('Torch toggle failed');
    }
  }

  // ---------- color space ----------
  function toHSV(r,g,b){
    r/=255; g/=255; b/=255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    const d=max-min;
    let h=0;
    if(d!==0){
      if(max===r) h=((g-b)/d)%6;
      else if(max===g) h=(b-r)/d+2;
      else h=(r-g)/d+4;
      h/=6;
      if(h<0) h+=1;
    }
    const s = max===0 ? 0 : d/max;
    const v = max;
    return {h,s,v};
  }

  function isBloodish(r,g,b,sens){
    // Baseline boolean detector (simple + tunable via STRICTNESS)
    // Higher STRICTNESS => tighter gates
    const strict = clamp(STRICTNESS, 0, 100) / 100;

    const {h,s,v} = toHSV(r,g,b);
    const hDeg = h*360;

    const Y  = 0.299*r + 0.587*g + 0.114*b;
    const Cb = 128 - 0.168736*r - 0.331264*g + 0.5*b;
    const Cr = 128 + 0.5*r - 0.418688*g - 0.081312*b;

    const hueMax = 28 - strict*10;           // ~28 -> ~18
    const redDom = (r > g + (12+strict*18)) && (r > b + (12+strict*18));
    const hueOk  = (hDeg <= hueMax) || (hDeg >= 350);

    const satGate = s > (0.10 + strict*0.08);
    const valGate = v > (0.06 + strict*0.06);

    const yGate  = Y  > (14 + strict*12);
    const cbGate = Cb < (140 - strict*12);
    const crGate = Cr > (142 + strict*10);

    if(Y > 190 && !redDom) return false;

    const ok = (hueOk && satGate && valGate && (redDom || (yGate && cbGate && crGate)));
    // sens is a multiplier; if sens is lower, require more conditions
    if(!ok) return false;
    if(sens >= 0.7) return true;
    // lower sens => require red dominance too
    return redDom && hueOk;
  }

  // ============================================================
  // EXPERIMENT: Seed+Grow blood mask (cuts false positives hard)
  // ============================================================
  function _clamp01(x){ return x<0?0:(x>1?1:x); }

  function _ycbcr(r,g,b){
    const Y  = 0.299*r + 0.587*g + 0.114*b;
    const Cb = 128 - 0.168736*r - 0.331264*g + 0.5*b;
    const Cr = 128 + 0.5*r - 0.418688*g - 0.081312*b;
    return {Y,Cb,Cr};
  }

  function _bloodScore(r,g,b, mode){
    const {h,s,v} = toHSV(r,g,b);
    const hDeg = h*360;
    const {Y,Cb,Cr} = _ycbcr(r,g,b);

    const hueOk = (hDeg <= (mode==='seed'? 18 : 28)) || (hDeg >= 350);
    const redDom = (r > g + (mode==='seed'? 20 : 12)) && (r > b + (mode==='seed'? 20 : 12));
    const satOk = s > (mode==='seed'? 0.18 : 0.10);
    const valOk = v > (mode==='seed'? 0.10 : 0.05);

    const yOk  = Y  > (mode==='seed'? 24 : 14);
    const cbOk = Cb < (mode==='seed'? 128 : 140);
    const crOk = Cr > (mode==='seed'? 152 : 142);

    if(Y > 190 && !redDom) return 0;

    let score = 0;
    score += hueOk ? 0.25 : 0;
    score += redDom ? 0.25 : 0;
    score += (satOk && valOk) ? 0.20 : 0;
    score += (yOk && cbOk && crOk) ? 0.30 : 0;

    if(mode==='seed' && Cr < 156) score *= 0.6;
    return _clamp01(score);
  }

  function _seedGrowMask(d, w, h, strictness){
    const s = _clamp01((strictness ?? 50) / 100);
    const seedThr = 0.78 + (s*0.12);  // 0.78..0.90
    const growThr = 0.52 + (s*0.18);  // 0.52..0.70

    const n = w*h;
    const grow = new Uint8Array(n);
    const cand = new Uint8Array(n);

    for(let i=0, p=0; i<n; i++, p+=4){
      const r=d[p], g=d[p+1], b=d[p+2];
      const scSeed = _bloodScore(r,g,b,'seed');
      if(scSeed >= seedThr){
        grow[i]=1;
      } else {
        const scGrow = _bloodScore(r,g,b,'grow');
        if(scGrow >= growThr) cand[i]=1;
      }
    }

    const iters = 2;
    for(let it=0; it<iters; it++){
      let changed = 0;
      for(let y=1; y<h-1; y++){
        let row = y*w;
        for(let x=1; x<w-1; x++){
          const idx = row + x;
          if(grow[idx] || !cand[idx]) continue;

          const hasNeighbor =
            grow[idx-1] || grow[idx+1] ||
            grow[idx-w] || grow[idx+w] ||
            grow[idx-w-1] || grow[idx-w+1] ||
            grow[idx+w-1] || grow[idx+w+1];

          if(hasNeighbor){
            grow[idx]=1;
            changed++;
          }
        }
      }
      if(!changed) break;
    }

    return grow;
  }

  // ---------- UI ----------
  function setStatus(msg){
    if(el.status) el.status.textContent = msg;
  }

  // ---------- main loop ----------
  function loop(){
    if(!running) return;

    const t0 = now();

    const w = el.video.videoWidth|0;
    const h = el.video.videoHeight|0;
    if(!w || !h){
      rafId = requestAnimationFrame(loop);
      return;
    }

    // processing resolution (keep it small)
    const procW = 240;
    const procH = Math.round(procW * (h/w));

    // setup buffers
    const c = el.canvas;
    c.width = procW;
    c.height = procH;
    const ctx = c.getContext('2d', { willReadFrequently:true });

    const o = el.overlay;
    o.width = procW;
    o.height = procH;
    const octx = o.getContext('2d');

    ctx.drawImage(el.video,0,0,procW,procH);
    const img=ctx.getImageData(0,0,procW,procH), d=img.data;

    // Use your older “good” feel defaults (still controlled by sliders if present)
    const sens = el.sens ? Number(el.sens.value)/100 : 0.70;
    const thr  = el.thr  ? Number(el.thr.value)/100  : 0.65;
    const need = el.stability ? Math.max(1, Number(el.stability.value)) : 2;
    const alpha= el.opacity ? Number(el.opacity.value)/100 : 0.60;

    // EXPERIMENT TOGGLE (keep false to use original detector)
    // When true: uses "seed + grow" connected-region logic to reduce false positives.
    const USE_SEED_GROW = true;

    let score, max=-1e9, min=1e9;
    const bin=new Uint8Array(procW*procH);

    if(USE_SEED_GROW){
      // Seed+Grow returns a Uint8Array mask (0/1). We treat 1 as "blood".
      score = _seedGrowMask(d, procW, procH, (typeof STRICTNESS!=='undefined' ? STRICTNESS : 50));
      // Note: thr slider is not applied here (mask is already thresholded by the experiment).
      for(let i=0;i<score.length;i++){
        if(score[i]) bin[i]=1;
      }
      max=1; min=0;
    } else {
      // ORIGINAL baseline detector (do not touch)
      score=new Float32Array(procW*procH);
      for(let p=0,i=0;p<d.length;p+=4,i++){
        const s=isBloodish(d[p],d[p+1],d[p+2],sens)?1:0;
        score[i]=s; if(s>max)max=s; if(s<min)min=s;
      }
      const rng=Math.max(1e-6,max-min);
      for(let i=0;i<score.length;i++){
        const n=(score[i]-min)/rng;
        if(n>=thr) bin[i]=1;
      }
    }

    if(!persist || persistW!==procW || persistH!==procH){
      persist = new Float32Array(procW*procH);
      persistW = procW;
      persistH = procH;
    }

    // stability accumulation
    for(let i=0;i<bin.length;i++){
      const v = bin[i] ? 1 : 0;
      const p = persist[i];
      // accumulate towards 1 when detected; decay when not
      persist[i] = v ? Math.min(1, p + 0.25) : Math.max(0, p - 0.10);
    }

    // draw overlay
    const out = octx.createImageData(procW, procH);
    const od = out.data;

    // grayscale background
    for(let p=0,i=0;p<d.length;p+=4,i++){
      const r=d[p], g=d[p+1], b=d[p+2];
      const y = (0.299*r + 0.587*g + 0.114*b)|0;
      od[p]=y; od[p+1]=y; od[p+2]=y; od[p+3]=255;
    }

    // apply blood tint where stability reached "need"
    const a = clamp(alpha, 0, 1);
    for(let i=0;i<persist.length;i++){
      const strong = persist[i] >= (need*0.25); // need==2 => >=0.5-ish
      if(!strong) continue;
      const p = i*4;
      // tint red
      od[p]   = clamp(od[p]   + 140*a, 0, 255);
      od[p+1] = clamp(od[p+1] -  40*a, 0, 255);
      od[p+2] = clamp(od[p+2] -  40*a, 0, 255);
    }

    octx.putImageData(out,0,0);

    // fps
    const dt = now()-t0;
    const fps = dt>0 ? (1000/dt) : 0;
    if(el.fps) el.fps.textContent = `${fps.toFixed(0)} fps`;

    rafId = requestAnimationFrame(loop);
  }

  // ---------- controls ----------
  async function start(){
    try{
      setStatus('Booting…');
      await startCamera();
      running = true;
      setStatus('Streaming…');
      rafId = requestAnimationFrame(loop);
    }catch(err){
      console.error(err);
      setStatus('Camera failed (check permissions)');
    }
  }

  function stop(){
    running = false;
    if(rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    stopCamera();
    setStatus('Stopped');
  }

  if(el.startBtn){
    el.startBtn.addEventListener('click', async ()=>{
      if(!running) await start();
      else stop();
    });
  }

  if(el.torchBtn){
    el.torchBtn.addEventListener('click', async ()=>{
      if(!stream) await start();
      await setTorch(!torchOn);
    });
  }

  if(el.alertBtn){
    el.alertBtn.addEventListener('click', ()=>{
      const on = el.alertBtn.getAttribute('aria-pressed') === 'true';
      el.alertBtn.setAttribute('aria-pressed', String(!on));
      el.alertBtn.textContent = !on ? 'Alert: On' : 'Alert: Off';
    });
  }

  if(el.installBtn){
    el.installBtn.addEventListener('click', async ()=>{
      await doInstall();
    });
  }

})();
