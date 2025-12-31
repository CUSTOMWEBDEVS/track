(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const el={
    app:$('app'),
    viewport:$('viewport'),
    video:$('video'),
    overlay:$('overlay'),
    tapHint:$('tapHint'),
    status:$('status'),
    fps:$('fps'),
    startBtn:$('startBtn'),
    torchBtn:$('torchBtn'),
    alertBtn:$('alertBtn'),
    flash:$('flash'),
    sens:$('sens'),
    thr:$('thr'),
    stability:$('stability'),
    opacity:$('opacity'),
    installBtn:$('installBtn'),
    installShell:$('installShell'),
    installSteps:$('installSteps'),
    installClose:$('installClose'),
    installEnv:$('installEnv'),
    lastSignBtn:$('lastSignBtn'),
    lsLock:$('lsLock'),
    lsExitBtn:$('lsExitBtn'),
    lsMarkBtn:$('lsMarkBtn'),
    lsSetBtn:$('lsSetBtn'),
    lsClearBtn:$('lsClearBtn'),
    lsArrow:$('lsArrow'),
    lsDistance:$('lsDistance'),
    lsBearing:$('lsBearing'),
    lsSignal:$('lsSignal'),
    lsAge:$('lsAge'),
    lsHint:$('lsHint')
  };

  const setStatus=s=>{ if(el.status) el.status.textContent=s };
  const octx=el.overlay.getContext('2d');
  let stream=null, anim=null, lastTS=0, frames=0;
  let procW=320, procH=240;
  const proc=document.createElement('canvas'), pctx=proc.getContext('2d',{willReadFrequently:true});

  // ---------- Haptics ---------
  const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent);
  let aCtx; try{ aCtx=new (window.AudioContext||window.webkitAudioContext)() }catch{}
  async function pulse(){
    if(el.alertBtn && el.alertBtn.getAttribute('aria-pressed')!=='true') return;
    if('vibrate' in navigator && !isIOS){ navigator.vibrate(40); return; }
    try{
      if(aCtx && aCtx.state==='suspended') await aCtx.resume();
      if(aCtx){
        const o=aCtx.createOscillator(),g=aCtx.createGain();
        o.type='square'; o.frequency.value=1100; g.gain.value=0.05;
        o.connect(g); g.connect(aCtx.destination); o.start(); setTimeout(()=>o.stop(),60);
      }
    }catch{}
    if(el.flash){ el.flash.style.opacity='0.45'; setTimeout(()=>el.flash.style.opacity='0',120); }
  }

  // ---------- Color helpers ----------
  function toHSV(r,g,b){
    const rn=r/255,gn=g/255,bn=b/255;
    const max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min;let h=0;
    if(d){
      if(max===rn)h=((gn-bn)/d+(gn<bn?6:0));
      else if(max===gn)h=((bn-rn)/d+2);
      else h=((rn-gn)/d+4);
      h/=6;
    }
    const s=max===0?0:d/max,v=max;
    return {h,s,v};
  }
  function toYCbCr(r,g,b){
    const y=0.299*r+0.587*g+0.114*b;
    const cb=128-0.168736*r-0.331264*g+0.5*b;
    const cr=128+0.5*r-0.418688*g-0.081312*b;
    return {y,cb,cr};
  }
  function srgb2lin(c){
    c/=255;return(c<=0.04045)?c/12.92:Math.pow((c+0.055)/1.055,2.4);
  }
  function toLab(r,g,b){
    const R=srgb2lin(r),G=srgb2lin(g),B=srgb2lin(b);
    const X=0.4124564*R+0.3575761*G+0.1804375*B;
    const Y=0.2126729*R+0.7151522*G+0.0721750*B;
    const Z=0.0193339*R+0.1191920*G+0.9503041*B;
    const Xn=0.95047,Yn=1.0,Zn=1.08883;
    const f=t=>{const d=6/29;return(t>Math.pow(d,3))?Math.cbrt(t):t/(3*d*d)+4/29};
    const fx=f(X/Xn),fy=f(Y/Yn),fz=f(Z/Zn);
    return {L:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)};
  }
  const hueDist=(deg,ref)=>{let d=Math.abs(deg-ref)%360;return d>180?360-d:d};

  // Slightly relaxed “is-blood-like” boolean gate
  function isBloodish(r,g,b,sens){
    if(!(r>g && g>=b)) return 0;
    const {h,s,v}=toHSV(r,g,b); const hDeg=h*360;
    const hTol = 14 + 6*(1-sens);                 // widen hue window a bit
    if(hueDist(hDeg,0)>hTol) return 0;
    if(s < (0.53 - 0.10*(sens))) return 0;        // allow slightly lower saturation
    if(v < 0.08 || v > (0.70 + 0.04*(1-sens))) return 0; // allow brighter dark reds but still cap bright highlights

    // Channel dominance (slightly looser)
    if((r-g) < 12 || (r-b) < 20) return 0;

    // YCbCr: lower Cr' threshold, raise Y cap a touch
    const {y,cb,cr}=toYCbCr(r,g,b);
    const crRel = cr - 0.55*cb;
    if (crRel < (85 - 8*sens)) return 0;
    if (y > (192 + 8*(1-sens))) return 0;

    // Lab anti-plastic loosened
    const L = toLab(r,g,b);
    if (L.a < (30 - 6*(1-sens)) || L.b > (26 + 6*(1-sens)) || L.L > 72) return 0;

    return 1;
  }

  function blobs(binary,w,h,minArea,maxArea){
    const vis=new Uint8Array(w*h), out=[];
    function flood(s){
      const q=[s]; vis[s]=1; let area=0,cx=0,cy=0;
      while(q.length){
        const i=q.pop(); area++;
        const x=i%w,y=(i-x)/w; cx+=x; cy+=y;
        const ns=[i-1,i+1,i-w,i+w,i-w-1,i-w+1,i+w-1,i+w+1];
        for(const n of ns){
          if(n<0||n>=w*h) continue;
          if(!vis[n] && binary[n]){ vis[n]=1; q.push(n); }
        }
      }
      return {area, centroid:{x:cx/area,y:cy/area}};
    }
    for(let i=0;i<w*h;i++){
      if(!vis[i] && binary[i]){
        const r=flood(i);
        if(r.area>=minArea && r.area<=maxArea) out.push(r);
      }
    }
    return out;
  }

  function setSizes(){
    const W=el.video.videoWidth||el.viewport.clientWidth||640;
    const H=el.video.videoHeight||el.viewport.clientHeight||480;
    el.overlay.width=W; el.overlay.height=H;
    procW=Math.max(240, Math.round(W*0.5)); procH=Math.max(180, Math.round(H*0.5));
    proc.width=procW; proc.height=procH;
  }
  window.addEventListener('resize',()=>{ if(stream) setSizes() });

  let starting=false;
  async function start(){
    if(stream||starting) return; starting=true; setStatus('Requesting camera…');
    try{
      const tries=[
        {video:{facingMode:{exact:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false},
        {video:{facingMode:{ideal:'environment'}},audio:false},
        {video:true,audio:false},
      ]; let s=null;
      for(const c of tries){
        try{ s=await navigator.mediaDevices.getUserMedia(c); if(s)break; }catch{}
      }
      if(!s){ setStatus('Camera failed'); starting=false; return; }
      stream=s; el.video.srcObject=s; await el.video.play().catch(()=>{});
      setSizes(); frames=0; lastTS=performance.now();
      if(el.tapHint) el.tapHint.style.display='none'; setStatus('Streaming…'); loop();
    }catch{
      setStatus('Camera error');
    } finally{
      starting=false;
    }
  }
  function stop(){
    cancelAnimationFrame(anim); anim=null;
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    octx.clearRect(0,0,el.overlay.width,el.overlay.height);
    if(el.tapHint) el.tapHint.style.display=''; setStatus('Stopped.');
  }

  el.startBtn?.addEventListener('click',e=>{ e.stopPropagation(); stream?stop():start(); },true);
  el.tapHint?.addEventListener('click',()=>{ if(!stream) start(); },true);
  el.viewport?.addEventListener('click',()=>{},true);

  async function torch(){
    try{
      if(stream){
        const t=stream.getVideoTracks()[0], caps=t.getCapabilities?.();
        if(caps && 'torch' in caps){
          const cons=t.getConstraints?.()||{};
          const cur=!!(cons.advanced||[]).find(o=>o&&o.torch===true);
          await t.applyConstraints({advanced:[{torch:!cur}]}); return;
        }
      }
    }catch{}
    if(el.flash) el.flash.style.opacity=(el.flash.style.opacity==='1'?'0':'1');
  }
  el.torchBtn?.addEventListener('click',e=>{ e.stopPropagation(); torch(); },true);
  el.alertBtn?.addEventListener('click',e=>{
    e.stopPropagation();
    const on=el.alertBtn.getAttribute('aria-pressed')!=='true';
    el.alertBtn.setAttribute('aria-pressed',String(on));
    el.alertBtn.textContent=on?'Alert: On':'Alert: Off';
  },true);

  let persist=null, stable=null;
  function loop(ts){
    if(!stream){ cancelAnimationFrame(anim); return; }
    frames++;
    if(ts-lastTS>1000){
      if (el.fps) el.fps.textContent=frames+' fps';
      frames=0; lastTS=ts;
    }

    pctx.drawImage(el.video,0,0,procW,procH);
    const img=pctx.getImageData(0,0,procW,procH), d=img.data;
    // Use your older “good” feel: Sens ~0.70, Thr ~0.65, Stability ~2
    const sens = el.sens ? Number(el.sens.value)/100 : 0.70;
    let thr  = el.thr  ? Number(el.thr.value)/100  : 0.65;
    const need = el.stability ? Math.max(1, Number(el.stability.value)) : 2;
    const alpha= el.opacity ? Number(el.opacity.value)/100 : 0.60;

    const score=new Float32Array(procW*procH);
    let max=-1e9,min=1e9;
    let sumY=0;
    for(let p=0,i=0;p<d.length;p+=4,i++){
      // Average luminance (night boost): helps in dark woods where the camera is noisy.
      sumY += (0.299*d[p] + 0.587*d[p+1] + 0.114*d[p+2]);
      const s=isBloodish(d[p],d[p+1],d[p+2],sens)?1:0;
      score[i]=s; if(s>max)max=s; if(s<min)min=s;
    }
    const avgY = sumY / (score.length||1);
    // If it's very dark, make the mask more permissive so you don't have to be inches from the ground.
    if(avgY < 55) thr = Math.max(0.40, thr - 0.10);
    else if(avgY < 75) thr = Math.max(0.45, thr - 0.06);
    const rng=Math.max(1e-6,max-min);
    const bin=new Uint8Array(procW*procH);
    for(let i=0;i<score.length;i++){
      const n=(score[i]-min)/rng;
      if(n>=thr) bin[i]=1;
    }

    if(!persist){ persist=new Uint8Array(procW*procH); stable=new Uint8Array(procW*procH); }
    for(let i=0;i<bin.length;i++){
      persist[i]=bin[i]?Math.min(255,persist[i]+1):Math.max(0,persist[i]-1);
      stable[i]=(persist[i]>=need)?1:0;
    }

    const minArea=Math.max(6, Math.floor(procW*procH*0.00018));
    const maxArea=Math.floor(procW*procH*0.16);
    const found=blobs(stable,procW,procH,minArea,maxArea);

    octx.clearRect(0,0,el.overlay.width,el.overlay.height);
    if(alpha>0){
      const mask=pctx.createImageData(procW,procH), md=mask.data;
      for(let i=0,p=0;i<stable.length;i++,p+=4){
        if(stable[i]){
          md[p]=235; md[p+1]=20; md[p+2]=20; md[p+3]=Math.floor(alpha*255);
        }
      }
      pctx.putImageData(mask,0,0);
      octx.drawImage(proc,0,0,el.overlay.width,el.overlay.height);
    }
    let any=false;
    for(const b of found){
      const cx=b.centroid.x*el.overlay.width/procW, cy=b.centroid.y*el.overlay.height/procH;
      octx.save(); octx.strokeStyle='#b400ff'; octx.lineWidth=3; octx.shadowBlur=10; octx.shadowColor='rgba(180,0,255,0.95)';
      octx.beginPath(); octx.arc(cx,cy,18,0,Math.PI*2); octx.stroke();
      octx.beginPath(); octx.arc(cx,cy,28,0,Math.PI*2); octx.stroke(); octx.restore(); any=true;
    }
    if(any) pulse();
    anim=requestAnimationFrame(loop);
  }


  // ===========================
  // Last Sign Lock Mode (killer feature)
  // ===========================
  const LS_STORAGE_KEY = 'ttd_last_sign_v1';
  const LS_MARKERS_KEY = 'ttd_sign_markers_v1';

  const LS = {
    enabled: false,
    watchId: null,
    cur: null,       // {lat, lon, acc, ts, heading}
    last: null,      // {lat, lon, ts}
    markers: []      // [{lat, lon, ts, note}]
  };

  function lsLoad(){
    try{
      const last = JSON.parse(localStorage.getItem(LS_STORAGE_KEY) || 'null');
      const markers = JSON.parse(localStorage.getItem(LS_MARKERS_KEY) || '[]');
      if(last && typeof last.lat==='number' && typeof last.lon==='number'){
        LS.last = last;
      }
      if(Array.isArray(markers)) LS.markers = markers.slice(-200);
    }catch{}
  }
  function lsSave(){
    try{
      if(LS.last) localStorage.setItem(LS_STORAGE_KEY, JSON.stringify(LS.last));
      else localStorage.removeItem(LS_STORAGE_KEY);
      localStorage.setItem(LS_MARKERS_KEY, JSON.stringify(LS.markers.slice(-200)));
    }catch{}
  }

  function toRad(d){ return d*Math.PI/180; }
  function haversineMeters(aLat,aLon,bLat,bLon){
    const R=6371000;
    const dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
    const s1=Math.sin(dLat/2), s2=Math.sin(dLon/2);
    const A=s1*s1 + Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*s2*s2;
    return 2*R*Math.asin(Math.min(1, Math.sqrt(A)));
  }
  function bearingDeg(aLat,aLon,bLat,bLon){
    const y = Math.sin(toRad(bLon-aLon))*Math.cos(toRad(bLat));
    const x = Math.cos(toRad(aLat))*Math.sin(toRad(bLat)) - Math.sin(toRad(aLat))*Math.cos(toRad(bLat))*Math.cos(toRad(bLon-aLon));
    let brng = Math.atan2(y,x) * 180/Math.PI;
    brng = (brng + 360) % 360;
    return brng;
  }
  function fmtDist(m){
    if(!isFinite(m)) return '—';
    if(m < 15) return Math.round(m) + ' m';
    if(m < 1000) return Math.round(m/5)*5 + ' m';
    const mi = m / 1609.344;
    if(mi < 0.75) return (mi*5280).toFixed(0) + ' ft';
    return mi.toFixed(mi < 2 ? 2 : 1) + ' mi';
  }
  function fmtBearing(d){
    if(!isFinite(d)) return '—';
    const dirs=['N','NE','E','SE','S','SW','W','NW','N'];
    const idx=Math.round(d/45);
    return d.toFixed(0)+'° '+dirs[idx];
  }
  function fmtAge(ts){
    if(!ts) return '—';
    const s = Math.max(0, Math.floor((Date.now()-ts)/1000));
    if(s < 60) return s+'s ago';
    const m = Math.floor(s/60);
    if(m < 60) return m+'m ago';
    const h = Math.floor(m/60);
    if(h < 24) return h+'h '+(m%60)+'m ago';
    const d = Math.floor(h/24);
    return d+'d ago';
  }

  function lsShow(on){
    if(!el.lsLock) return;
    if(on){
      el.lsLock.classList.add('show');
      el.lsLock.setAttribute('aria-hidden','false');
    }else{
      el.lsLock.classList.remove('show');
      el.lsLock.setAttribute('aria-hidden','true');
    }
  }

  function lsUpdateUI(){
    if(!el.lsDistance) return;
    if(!LS.last){
      el.lsDistance.textContent='Set last sign';
      el.lsBearing.textContent='Tap “Set / Move last sign”';
      if(el.lsAge) el.lsAge.textContent='Last sign: —';
      return;
    }
    if(el.lsAge) el.lsAge.textContent='Last sign: '+fmtAge(LS.last.ts);
    if(LS.cur){
      const dist = haversineMeters(LS.cur.lat, LS.cur.lon, LS.last.lat, LS.last.lon);
      const brng = bearingDeg(LS.cur.lat, LS.cur.lon, LS.last.lat, LS.last.lon);
      const heading = (typeof LS.cur.heading === 'number' && isFinite(LS.cur.heading)) ? LS.cur.heading : 0;
      const rel = (brng - heading + 360) % 360;

      el.lsDistance.textContent = fmtDist(dist);
      el.lsBearing.textContent = 'To last sign: ' + fmtBearing(brng) + (heading ? '  •  Heading '+fmtBearing(heading) : '');

      if(el.lsArrow){
        el.lsArrow.style.transform = 'rotate('+rel.toFixed(0)+'deg)';
      }
      if(el.lsSignal){
        const acc = LS.cur.acc ? Math.round(LS.cur.acc) : null;
        el.lsSignal.textContent = 'GPS: ' + (acc ? '±'+acc+' m' : '—');
      }
    }else{
      el.lsDistance.textContent='Getting GPS…';
      el.lsBearing.textContent='Allow location to show direction + distance.';
      if(el.lsSignal) el.lsSignal.textContent='GPS: —';
    }
  }

  function lsStartWatch(){
    if(LS.watchId!=null) return;
    if(!('geolocation' in navigator)){
      setStatus('No GPS available on this device.');
      return;
    }
    try{
      LS.watchId = navigator.geolocation.watchPosition(
        pos=>{
          const c = pos.coords;
          LS.cur = {
            lat: c.latitude,
            lon: c.longitude,
            acc: c.accuracy,
            heading: (typeof c.heading === 'number') ? c.heading : null,
            ts: Date.now()
          };
          lsUpdateUI();
        },
        err=>{
          LS.cur = null;
          lsUpdateUI();
          setStatus('GPS: ' + (err && err.message ? err.message : 'permission denied'));
        },
        { enableHighAccuracy:true, maximumAge:1000, timeout:12000 }
      );
    }catch{
      setStatus('GPS error');
    }
  }
  function lsStopWatch(){
    if(LS.watchId!=null){
      try{ navigator.geolocation.clearWatch(LS.watchId); }catch{}
      LS.watchId=null;
    }
  }

  function lsEnter(){
    LS.enabled = true;
    lsShow(true);
    lsStartWatch();
    lsUpdateUI();
    if(el.lastSignBtn) el.lastSignBtn.textContent='Locked';
    setStatus('Last Sign Lock: ON');
  }
  function lsExit(){
    LS.enabled = false;
    lsShow(false);
    lsStopWatch();
    if(el.lastSignBtn) el.lastSignBtn.textContent='Last Sign';
    setStatus('Last Sign Lock: OFF');
  }

  function lsSetFromCurrent(){
    if(!LS.cur){
      setStatus('Getting GPS… try again in a second.');
      lsStartWatch();
      return;
    }
    LS.last = { lat: LS.cur.lat, lon: LS.cur.lon, ts: Date.now() };
    lsSave();
    pulse(); // tiny confirmation feedback
    lsUpdateUI();
    setStatus('Saved last sign.');
  }

  function lsMarkNewSign(){
    if(!LS.cur){
      setStatus('Getting GPS… try again in a second.');
      lsStartWatch();
      return;
    }
    // Save previous last sign as a marker (breadcrumbs) then move last sign to the new spot.
    if(LS.last){
      LS.markers.push({ lat: LS.last.lat, lon: LS.last.lon, ts: LS.last.ts, note:'previous last sign' });
      if(LS.markers.length>200) LS.markers = LS.markers.slice(-200);
    }
    LS.last = { lat: LS.cur.lat, lon: LS.cur.lon, ts: Date.now() };
    lsSave();
    pulse();
    lsUpdateUI();
    setStatus('Marked new sign.');
  }

  function lsClearAll(){
    const ok = window.confirm('Clear last sign + saved sign markers?');
    if(!ok) return;
    LS.last = null;
    LS.markers = [];
    lsSave();
    pulse();
    lsUpdateUI();
    setStatus('Cleared.');
  }

  // UI wiring
  lsLoad();
  el.lastSignBtn?.addEventListener('click', e=>{
    e.stopPropagation();
    if(!LS.enabled){
      lsEnter();
      // If we have no last sign yet, guide the user immediately.
      if(!LS.last && el.lsHint) el.lsHint.textContent='Step 1: Tap “Set / Move last sign” where you last saw blood.';
    }else{
      lsExit();
    }
  }, true);

  el.lsExitBtn?.addEventListener('click', e=>{ e.stopPropagation(); lsExit(); }, true);
  el.lsSetBtn?.addEventListener('click', e=>{ e.stopPropagation(); lsSetFromCurrent(); if(el.lsHint) el.lsHint.textContent='Now walk slow. Tap “Mark new sign” the second you see blood.'; }, true);
  el.lsMarkBtn?.addEventListener('click', e=>{ e.stopPropagation(); lsMarkNewSign(); if(el.lsHint) el.lsHint.textContent='Good. Keep going. If you lose it, the arrow brings you back.'; }, true);
  el.lsClearBtn?.addEventListener('click', e=>{ e.stopPropagation(); lsClearAll(); }, true);

  // --- PWA / "Add to Home Screen" helper UI ---

  // If we’re already running as an installed app, hide the install button.
  const isStandalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (window.navigator && window.navigator.standalone);
  if (isStandalone && el.installBtn) {
    el.installBtn.style.display='none';
  }

  let deferredPrompt=null;

  // Capture Android/desktop PWA install prompt when the browser decides we’re installable
  window.addEventListener('beforeinstallprompt', e=>{
    e.preventDefault();
    deferredPrompt=e;
    if(el.installBtn){
      el.installBtn.disabled=false;
      el.installBtn.textContent='Install app';
    }
  });

  function detectEnv(){
    const ua = navigator.userAgent.toLowerCase();
    const isAndroid = ua.includes('android');
    const isIOS = /iphone|ipad|ipod/.test(ua);
    let browser = 'unknown';

    if (ua.includes('duckduckgo')) browser = 'duckduckgo';
    else if (ua.includes('samsungbrowser')) browser = 'samsung';
    else if (ua.includes('firefox')) browser = 'firefox';
    else if (ua.includes('opr') || ua.includes('opera')) browser = 'opera';
    else if (ua.includes('crios') && isIOS) browser = 'chrome-ios';
    else if (ua.includes('chrome') && ua.includes('safari')) browser = 'chrome';
    else if (ua.includes('safari')) browser = 'safari';

    const os = isAndroid ? 'android' : (isIOS ? 'ios' : 'other');

    return { os, browser };
  }

  function openInstallHelp(){
    if(!el.installShell) return;
    const env = detectEnv();
    if (el.installEnv) {
      let label = 'We could not detect your phone.';
      if (env.os === 'android') {
        if (env.browser === 'duckduckgo') label = 'We think you are on: Android — DuckDuckGo browser';
        else if (env.browser === 'chrome') label = 'We think you are on: Android — Chrome browser';
        else if (env.browser === 'samsung') label = 'We think you are on: Android — Samsung Internet';
        else if (env.browser === 'firefox') label = 'We think you are on: Android — Firefox browser';
        else if (env.browser === 'opera') label = 'We think you are on: Android — Opera browser';
        else label = 'We think you are on: Android phone';
      } else if (env.os === 'ios') {
        if (env.browser === 'safari') label = 'We think you are on: iPhone — Safari browser';
        else if (env.browser === 'chrome-ios') label = 'We think you are on: iPhone — Chrome app';
        else label = 'We think you are on: iPhone / iPad';
      } else {
        label = 'We think you are on: Other device';
      }
      el.installEnv.textContent = label;
    }

    renderInstallSteps(env);

    el.installShell.classList.add('show');
    el.installShell.setAttribute('aria-hidden','false');
  }
  function closeInstallHelp(){
    if(!el.installShell) return;
    el.installShell.classList.remove('show');
    el.installShell.setAttribute('aria-hidden','true');
  }

  function renderInstallSteps(env){
    if (!el.installSteps) return;

    // Clear previous content
    el.installSteps.innerHTML = '';

    const wrapper = document.createElement('div');

    // Android + Chrome (and compatible) with beforeinstallprompt: give big install button
    if (env.os === 'android' && (env.browser === 'chrome' || env.browser === 'samsung' || env.browser === 'opera') && deferredPrompt) {
      wrapper.innerHTML =
        '<div class="install-step-title">Fast install (recommended)</div>' +
        '<ol>' +
          '<li><span class="install-step-body">Tap the big green button below.</span></li>' +
          '<li><span class="install-step-body">When the box pops up, tap <strong>Install</strong> or <strong>Add</strong>.</span></li>' +
        '</ol>' +
        '<button class="install-now-btn" id="installNowBtn">⬇️  Install TrackTheDrops</button>' +
        '<div class="install-small-hint">Your phone will drop an icon on your home screen like a normal app.</div>';
      el.installSteps.appendChild(wrapper);

      const btn = document.getElementById('installNowBtn');
      if (btn) {
        btn.addEventListener('click', async () => {
          try {
            deferredPrompt.prompt();
            const choice = await deferredPrompt.userChoice;
            if (choice && choice.outcome === 'accepted') {
              el.installSteps.innerHTML =
                '<p class="install-note">Nice. Look for the new <strong>TrackTheDrops</strong> icon on your home screen. You can open it from there like a normal app.</p>';
            } else {
              el.installSteps.innerHTML =
                '<p class="install-note">If you changed your mind, open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>';
            }
          } catch(_){}
          deferredPrompt = null;
        });
      }
      return;
    }

    // Android + DuckDuckGo: manual steps
    if (env.os === 'android' && env.browser === 'duckduckgo') {
      wrapper.innerHTML =
        '<div class="install-step-title">Steps for DuckDuckGo on Android</div>' +
        '<ol>' +
          '<li>' +
            '<span class="install-step-body">Look at the top-right of the screen and tap the <strong>⋮ three dots</strong> menu.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">In that menu, tap <strong>Add to Home screen</strong> or <strong>Add to Home Screen (shortcut)</strong>.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">If it asks for a name, leave it as <strong>TrackTheDrops</strong> and tap <strong>Add</strong>.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Go back to your phone\'s main screen. You should see a new <strong>TrackTheDrops</strong> icon you can tap.</span>' +
          '</li>' +
        '</ol>' +
        '<p class="install-note">Once you see the icon, you can open it even with bad service — the app works offline after the first load.</p>';
      el.installSteps.appendChild(wrapper);
      return;
    }

    // Generic Android manual steps (Chrome / Firefox / Samsung / etc. when no prompt)
    if (env.os === 'android') {
      wrapper.innerHTML =
        '<div class="install-step-title">Steps for Android phone</div>' +
        '<ol>' +
          '<li>' +
            '<span class="install-step-body">Find the <strong>menu button</strong> in your browser (it\'s usually <strong>⋮ three dots</strong> in the top-right).</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Tap it, then look for <strong>Add to Home screen</strong> or <strong>Install app</strong>.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">If it asks for a name, use <strong>TrackTheDrops</strong> and tap <strong>Add</strong>.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Go to your phone\'s main screen and look for the new <strong>TrackTheDrops</strong> icon.</span>' +
          '</li>' +
        '</ol>' +
        '<p class="install-note">Open it from the icon next time instead of the browser. It will run full-screen and keep working in the woods.</p>';
      el.installSteps.appendChild(wrapper);
      return;
    }

    // iOS Safari
    if (env.os === 'ios' && env.browser === 'safari') {
      wrapper.innerHTML =
        '<div class="install-step-title">Steps for iPhone (Safari)</div>' +
        '<ol>' +
          '<li>' +
            '<span class="install-step-body">At the bottom of Safari, tap the <strong>square with the ↑ arrow</strong> (the Share button).</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Scroll the list and tap <strong>Add to Home Screen</strong>.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Leave the name as <strong>TrackTheDrops</strong> and tap <strong>Add</strong> in the top-right.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Go back to your home screen. You\'ll see a new <strong>TrackTheDrops</strong> icon.</span>' +
          '</li>' +
        '</ol>' +
        '<p class="install-note">Always open the app from that icon. It will run full-screen and work even when service is spotty.</p>';
      el.installSteps.appendChild(wrapper);
      return;
    }

    // iOS Chrome or unknown iOS: still must use Safari UI
    if (env.os === 'ios') {
      wrapper.innerHTML =
        '<div class="install-step-title">Best way on iPhone</div>' +
        '<ol>' +
          '<li>' +
            '<span class="install-step-body">First, open this same page in <strong>Safari</strong> (Apple\'s built-in browser).</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">In Safari, tap the <strong>square with the ↑ arrow</strong> at the bottom.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</span>' +
          '</li>' +
          '<li>' +
            '<span class="install-step-body">Now you will have a <strong>TrackTheDrops</strong> icon on your home screen.</span>' +
          '</li>' +
        '</ol>' +
        '<p class="install-note">Apple only lets this work properly from Safari, not other browsers.</p>';
      el.installSteps.appendChild(wrapper);
      return;
    }

    // Other devices
    wrapper.innerHTML =
      '<div class="install-step-title">General steps</div>' +
      '<ol>' +
        '<li><span class="install-step-body">Open your browser\'s main menu.</span></li>' +
        '<li><span class="install-step-body">Look for <strong>Add to Home screen</strong> or <strong>Install app</strong>.</span></li>' +
        '<li><span class="install-step-body">Confirm the name and add it.</span></li>' +
      '</ol>' +
      '<p class="install-note">After that, launch TrackTheDrops from your home screen instead of from the browser.</p>';
    el.installSteps.appendChild(wrapper);
  }

  el.installBtn?.addEventListener('click', ev=>{
    ev.stopPropagation();
    openInstallHelp();
  }, true);

  el.installShell?.addEventListener('click', ev=>{
    if(ev.target===el.installShell){
      closeInstallHelp();
    }
  }, true);

  el.installClose?.addEventListener('click', ev=>{
    ev.stopPropagation();
    closeInstallHelp();
  }, true);

  setStatus('Booting…');

  // Service Worker (offline cache)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  window.__TTD__={
    start:()=>{ if(!stream) start(); },
    stop:()=>{ if(stream) stop(); }
  };
})();
