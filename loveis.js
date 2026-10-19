// LOVE IS (2024) — the heart-machines, in the browser.
//
// Press and hold a heart: after a few patient seconds it "hears" you and starts to beat.
// The soundscape is a Web Audio port of the installation's SuperCollider design
// (LOVE_IS_h/0.final/supercollider: synths.scd + pdef.scd). Every layer follows ~bpm,
// here the mean bpm of the hearts that are beating:
//   heartbeat   SinOsc 50 Hz + 70 Hz, perc 5 ms / 150 ms, LPF 150      (one per heart, panned)
//   sand        Crackle × Resonz(Crackle), long perc envelopes, every 1 s (2 streams)
//   organ       SinOscFB pair (L/R) through a 200→4000 Hz RLPF sweep, every 2–7 s (2 streams)
//   backbeating slow sine swell + smooth noise, every 15–35 s (2 streams)
// Differences from the original, on purpose:
//   - the heartbeat repeats every 60/bpm s (pdef.scd used (60/bpm).reciprocal, i.e. bpm/60 s)
//   - a soft saturation adds overtones to the 50/70 Hz thump so laptop speakers can carry it
//   - layer levels are balanced for a browser (the SC amps assume an installation PA)
// The page opens Love Is in an expanding catalog panel: LoveIs.mount(root) wires a freshly
// cloned panel, LoveIs.unmount() lets the hearts go quiet when the panel closes.
window.LoveIs = (function(){
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let hint = null, photo = null, H = [], io = null;

  // ---------- helpers mirroring SC's mapping methods ----------
  const clip = (x,a,b)=> Math.min(b, Math.max(a, x));
  const linlin = (x,a,b,c,d)=> c + (clip(x,a,b)-a)/(b-a)*(d-c);
  const linexp = (x,a,b,c,d)=> c * Math.pow(d/c, (clip(x,a,b)-a)/(b-a));
  const rrand = (a,b)=> a + Math.random()*(b-a);
  const exprand = (a,b)=> a * Math.pow(b/a, Math.random());

  // ---------- audio ----------
  let ctx = null, out = null, layers = null, running = false, stopTimer = null;
  const timers = [];
  let crackles = [], fbWaves = new Map();

  function ensureAudio(){
    if(ctx){ if(ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.3;
    out = ctx.createGain(); out.gain.value = 0;
    out.connect(comp).connect(ctx.destination);
    layers = {};
    // relative balance of the four layers (see note above)
    [['heart',1.0],['sand',0.55],['organ',0.9],['back',1.0]].forEach(([k,g])=>{ const n = ctx.createGain(); n.gain.value = g; n.connect(out); layers[k] = n; });
    // Crackle.ar(p): y0 = |p*y1 - y2 - 0.05|  — a few pre-rendered seconds per chaos parameter
    crackles = [0.6, 1.0, 1.4, 1.8].map(p=>{
      const len = ctx.sampleRate * 3, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
      let y1 = 0.3, y2 = 0, mean = 0;
      for(let i=0;i<len;i++){ const y0 = Math.abs(p*y1 - y2 - 0.05); y2 = y1; y1 = y0; d[i] = y0; mean += y0; }
      mean /= len; for(let i=0;i<len;i++) d[i] -= mean;
      return b;
    });
  }

  // SinOscFB(freq, fb): y = sin(phase + fb*y_prev) — one period, turned into a PeriodicWave
  function fbWave(fb){
    const key = Math.round(fb*20)/20;
    if(fbWaves.has(key)) return fbWaves.get(key);
    const N = 512, s = new Float32Array(N); let y = 0;
    for(let pass=0; pass<3; pass++) for(let i=0;i<N;i++){ y = Math.sin(2*Math.PI*i/N + key*y); s[i] = y; }
    const H = 24, re = new Float32Array(H), im = new Float32Array(H);
    for(let h=1; h<H; h++){ let c=0, si=0; for(let i=0;i<N;i++){ const a = 2*Math.PI*h*i/N; c += s[i]*Math.cos(a); si += s[i]*Math.sin(a); } re[h] = c/N; im[h] = si/N; }
    const w = ctx.createPeriodicWave(re, im, {disableNormalization:false});
    fbWaves.set(key, w); return w;
  }

  // Env.perc(atk, rel, level, curve) on a gain param
  function perc(param, t, atk, rel, level, curve){
    param.setValueAtTime(0.0001, t);
    if(curve === 'lin'){ param.linearRampToValueAtTime(level, t+atk); param.linearRampToValueAtTime(0.0001, t+atk+rel); }
    else { param.exponentialRampToValueAtTime(Math.max(level,0.0002), t+atk); param.exponentialRampToValueAtTime(0.0001, t+atk+rel); }
    return t+atk+rel;
  }
  // Env.linen(atk, sus, rel, level)
  function linen(param, t, atk, sus, rel, level){
    param.setValueAtTime(0, t); param.linearRampToValueAtTime(level, t+atk);
    param.setValueAtTime(level, t+atk+sus); param.linearRampToValueAtTime(0, t+atk+sus+rel);
    return t+atk+sus+rel;
  }
  const panner = (p)=>{ const n = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(); if(n.pan) n.pan.value = p; return n; };
  let shaper = null;
  const softSat = ()=>{ if(shaper) return shaper; shaper = ctx.createWaveShaper(); const c = new Float32Array(1024); for(let i=0;i<1024;i++){ const x = i/511.5-1; c[i] = Math.tanh(3*x)/Math.tanh(3); } shaper.curve = c; return shaper; };

  // \heartbeat
  function thump(bpm, pan){
    if(!ctx) return;
    const t = ctx.currentTime, amp = linlin(bpm,30,120,0.2,0.9);
    const env = ctx.createGain(), lpf = ctx.createBiquadFilter(), pn = panner(pan);
    lpf.type = 'lowpass'; lpf.frequency.value = 150;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o1.frequency.value = 50; o2.frequency.value = 70; g2.gain.value = 0.6;
    o1.connect(env); o2.connect(g2).connect(env);
    const end = perc(env.gain, t, 0.005, 0.15, amp, 'exp');
    // dry thump + a little saturated copy for small speakers
    const sat = ctx.createGain(); sat.gain.value = 0.35;
    env.connect(lpf).connect(pn); env.connect(softSat()); shaper.connect(sat).connect(pn);
    pn.connect(layers.heart);
    o1.start(t); o2.start(t); o1.stop(end+0.05); o2.stop(end+0.05);
    o2.onended = ()=>{ try{ env.disconnect(); sat.disconnect(); }catch(e){} };
  }

  // \noise  (Pdef \sand)
  function sand(bpm){
    const t = ctx.currentTime;
    const freq = linexp(bpm,30,120,1000,2100), atk = linexp(bpm,30,120,1.5,2.5), rel = linexp(bpm,30,120,10,6), amp = linlin(bpm,30,120,0.05,0.09);
    const src = ctx.createBufferSource(); src.buffer = crackles[Math.floor(Math.random()*crackles.length)]; src.loop = true;
    const res = ctx.createBiquadFilter(); res.type = 'bandpass'; res.frequency.value = freq*clip(bpm/120,0.5,2); res.Q.value = 100;
    const ring = ctx.createGain(); ring.gain.value = 0;               // sig * res
    const boost = ctx.createGain(); boost.gain.value = 40;            // Resonz with rq 1/100 is very quiet
    src.connect(ring); src.connect(res).connect(boost).connect(ring.gain);
    const env = ctx.createGain(), pn = panner(rrand(-1,1));
    ring.connect(env).connect(pn).connect(layers.sand);
    const end = perc(env.gain, t, atk*(120/bpm), rel*(bpm/120), amp, 'exp');
    src.start(t, Math.random()*2); src.stop(end+0.1);
    src.onended = ()=>{ try{ ring.disconnect(); env.disconnect(); }catch(e){} };
  }

  // \organ
  function organ(bpm){
    const t = ctx.currentTime, k = bpm/120;
    const f1 = linlin(bpm,30,120,250,750), f2 = linlin(bpm,30,120,1200,2200), fb = exprand(0.1,1), amp = linlin(bpm,30,120,0.03,0.01);
    const env = ctx.createGain();
    const end = linen(env.gain, t, 5/k, 12*k, 10*k, amp*0.25*4);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 10;
    lp.frequency.setValueAtTime(200*k, t); lp.frequency.exponentialRampToValueAtTime(4000*k, t+25);
    env.connect(lp).connect(layers.organ);
    [[f1,-0.8],[f2,0.8]].forEach(([f,p])=>{
      const o = ctx.createOscillator(); o.setPeriodicWave(fbWave(fb/k)); o.frequency.value = f*k;
      o.connect(panner(p)).connect(env); o.start(t); o.stop(end+0.1);
    });
  }

  // \backbeating
  function backbeat(bpm){
    const t = ctx.currentTime, k = bpm/120;
    const f = linexp(bpm,30,120,1200,250) * linexp(k,0.5,2,0.5,2);
    const atk = linexp(bpm,30,120,1.5,10), rel = linlin(bpm,30,120,15,25), amp = linlin(bpm,30,120,0.005,0.008)*20;
    const o = ctx.createOscillator(); o.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1150*k;
    const g = ctx.createGain(); g.gain.value = 0.25*0.25*rrand(2,5);
    const env = ctx.createGain(); const e1 = perc(env.gain, t, atk/k, rel*k, amp, 'lin');
    o.connect(lp).connect(g).connect(env).connect(layers.back);
    // LFDNoise3(freq): smooth random line, then LPF 220
    const n = ctx.createBufferSource(), len = ctx.sampleRate*2, b = ctx.createBuffer(1,len,ctx.sampleRate), d = b.getChannelData(0);
    for(let i=0;i<len;i++) d[i] = Math.random()*2-1;
    n.buffer = b; n.loop = true;
    const nl = ctx.createBiquadFilter(); nl.type = 'lowpass'; nl.frequency.value = Math.min(f, 220*k);
    const env2 = ctx.createGain(); const e2 = linen(env2.gain, t, 1, 10*k, 5, 0.6*amp*0.5*0.25*6);
    n.connect(nl).connect(env2).connect(layers.back);
    o.start(t); n.start(t); o.stop(e1+0.1); n.stop(Math.max(e1,e2)+0.1);
  }

  // Pbind-like streams that read the current bpm every event
  function stream(fn, dur){
    const tick = ()=>{ if(!running) return; fn(bpmNow()); timers.push(setTimeout(tick, dur(bpmNow())*1000)); };
    timers.push(setTimeout(tick, Math.random()*600));
  }
  function startEngine(){
    if(!ctx || running) return;
    clearTimeout(stopTimer); running = true;
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setTargetAtTime(0.9, ctx.currentTime, 0.8);
    for(let i=0;i<2;i++){
      stream(sand, ()=> 1);
      stream(organ, ()=> exprand(2,7));
      stream(backbeat, b=> linexp(b,30,120,15,35));
    }
  }
  function stopEngine(){
    if(!running) return;
    out.gain.setTargetAtTime(0, ctx.currentTime, 2);      // ~6 s fade
    stopTimer = setTimeout(()=>{ running = false; timers.splice(0).forEach(clearTimeout); }, 7000);
  }

  // ---------- the hearts ----------
  const beating = ()=> H.filter(h=> h.state==='beating' || h.state==='fading');
  function bpmNow(){ const b = beating(); return b.length ? b.reduce((s,h)=>s+h.bpm,0)/b.length : 60; }

  function setState(h, s){
    h.state = s; h.el.dataset.state = s;
    if(h.el) h.el.setAttribute('aria-pressed', s==='beating' ? 'true' : 'false');
    updateHint();
  }
  function updateHint(){
    if(!hint) return;
    const n = H.filter(h=>h.state==='beating').length, l = H.some(h=>h.state==='listening');
    hint.textContent = n ? (n===1 ? 'It hears you. This is not your pulse, but the pulse you give it. Hold another heart too.' : n+' hearts beating together, talking to each other, and to you.')
                     : l ? 'Listening… be patient, let the machine listen to you.'
                     : 'Press and hold a heart. Be patient, let the machine listen to you.';
  }

  function beat(h){
    if(h.state!=='beating' && h.state!=='fading') return;
    thump(h.bpm, h.pan);
    if(!reduce) h.el.animate([{transform:'scale(1)'},{transform:'scale(1.07)',offset:.12},{transform:'scale(1)',offset:.3},{transform:'scale(1.035)',offset:.42},{transform:'scale(1)'}],{duration:Math.min(700, 60000/h.bpm*0.8),easing:'ease-out'});
    h.el.classList.remove('li-flash'); void h.el.offsetWidth; h.el.classList.add('li-flash');
    if(h.vibrate && navigator.vibrate) navigator.vibrate([35,90,25]);
    if(photo) photo.style.setProperty('--li-period', (60/bpmNow()).toFixed(2)+'s');
    if(h.held){ h.bpm = Math.min(96, h.bpm + 0.6); h.warm = Math.min(1, h.warm + 0.04); h.el.style.setProperty('--warm', h.warm); }
    if(h.state==='fading'){ h.fadeBeats--; h.bpm = Math.max(40, h.bpm*0.9); if(h.fadeBeats<=0){ setState(h,'idle'); if(!beating().length) stopEngine(); return; } }
    h.beatT = setTimeout(()=> beat(h), 60000/h.bpm);
  }

  function hold(h, e){
    ensureAudio();
    h.held = true; h.heldSince = performance.now(); h.vibrate = e && e.pointerType === 'touch';
    if(h.state==='fading'){ setState(h,'beating'); return; }
    if(h.state!=='idle') return;
    setState(h,'listening');
    h.t = setTimeout(()=>{
      if(!h.held) return;
      h.bpm = rrand(58,74); setState(h,'beating'); startEngine(); beat(h);
    }, rrand(2200, 4200));
  }
  function release(h){
    if(!h.held) return;
    h.held = false; clearTimeout(h.t);
    if(h.state==='listening') setState(h,'idle');
    else if(h.state==='beating'){ h.fadeBeats = 4; setState(h,'fading'); }
    const cool = setInterval(()=>{ if(h.held) return clearInterval(cool); h.warm = Math.max(0, h.warm-0.02); h.el.style.setProperty('--warm', h.warm); if(!h.warm) clearInterval(cool); }, 400);
  }

  function mount(root){
    unmount();
    hint = root.querySelector('.li-hint'); photo = root.querySelector('.li-pulse');
    H = [...root.querySelectorAll('.li-heart')].map((el,i)=>({ el, i, state:'idle', bpm:0, warm:0, held:false, t:null, beatT:null, heldSince:0, pan:[-0.6,0.6,-0.3,0.3][i]||0 }));
    H.forEach(h=>{
      h.el.addEventListener('pointerdown', e=>{ e.preventDefault(); try{ h.el.setPointerCapture(e.pointerId); }catch(_){} hold(h, e); });
      ['pointerup','pointercancel','lostpointercapture'].forEach(ev=> h.el.addEventListener(ev, ()=> release(h)));
      h.el.addEventListener('keydown', e=>{ if((e.key===' '||e.key==='Enter') && !e.repeat){ e.preventDefault(); hold(h, e); } });
      h.el.addEventListener('keyup', e=>{ if(e.key===' '||e.key==='Enter') release(h); });
      h.el.addEventListener('blur', ()=> release(h));
      h.el.addEventListener('contextmenu', e=> e.preventDefault());
    });
    // scrolling the panel away lets the hearts go quiet
    if('IntersectionObserver' in window){
      io = new IntersectionObserver(es=> es.forEach(en=>{ if(!en.isIntersecting) quiet(); }), {threshold:0});
      io.observe(root);
    }
    updateHint();
  }
  function quiet(){ H.forEach(h=>{ h.held=false; clearTimeout(h.t); clearTimeout(h.beatT); setState(h,'idle'); }); stopEngine(); }
  function unmount(){ if(io){ io.disconnect(); io = null; } quiet(); H = []; hint = null; photo = null; }
  return { mount, unmount };
})();
