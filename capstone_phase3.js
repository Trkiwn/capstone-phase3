(function(){
'use strict';

/* ================================================================================
   CONFIGURATION — teachers can change these values
   ================================================================================ */
const CONFIG = {
  timed: true,
  blockPaste: true,
  modules: [
    {id:'listening', label:'Listening', minutes:60},
    {id:'reading', label:'Reading', minutes:60},
    {id:'writing', label:'Writing', minutes:60}
  ],
  storeKey: 'p3cap.v1'
};

/* ================================================================================
   CONTENT (fallback placeholder content for standalone HTML use)
   ================================================================================ */
const DEFAULT_CONTENT = window.P3_DEFAULT_CONTENT;
const CONTENT = (typeof __CONTENT_JSON__ !== 'undefined' && __CONTENT_JSON__) || DEFAULT_CONTENT;

/* ================================================================================
   HELPERS
   ================================================================================ */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const pad = n => String(n).padStart(2,'0');
const fmt = sec => { sec = Math.max(0, Math.round(sec)); return pad(Math.floor(sec/60)) + ':' + pad(sec%60); };
const wordCount = t => ((t || '').trim().match(/\S+/g) || []).length;
const modById = id => CONFIG.modules.find(m => m.id === id);
const modIndex = id => CONFIG.modules.findIndex(m => m.id === id);
const hasMod = id => !!modById(id);
const isTestEnv = () => window.P3_TEST === true;

let toastTimer = null;
function toast(msg, ms){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3500);
}

/* ================================================================================
   STATE + PERSISTENCE
   ================================================================================ */
function freshState(){
  return {
    v: 1, name: '', date: '', step: 'cover',
    mod: { reading:{start:null,end:null}, writing:{start:null,end:null}, listening:{start:null,end:null} },
    r: {}, w: {t1:'', t2:''}, li: {answers:{}}, tab: {reading:'p1', writing:'t1'},
    sp: {mode:null, notes:'', log:[], interrupted:false, mime:'', stage:'prep'},
    submitted:false, submittedAt:null
  };
}
let storageOK = true;
function load(){
  try{
    const raw = localStorage.getItem(CONFIG.storeKey);
    if(!raw) return null;
    const s = JSON.parse(raw);
    if(!s || s.v !== 1) return null;
    return s;
  }catch(e){ return null; }
}
function save(){
  try{ localStorage.setItem(CONFIG.storeKey, JSON.stringify(S)); }catch(e){ storageOK = false; }
}
function clearSaved(){ try{ localStorage.removeItem(CONFIG.storeKey); }catch(e){} }

let S = load() || freshState();
if(!S.sp){ S.sp = {mode:null, notes:'', log:[], interrupted:false, mime:'', stage:'prep'}; }

/* ================================================================================
   SCREEN CONTROL
   ================================================================================ */
function screenIdFor(step){ return 'screen-' + step.replace(':','-'); }
function show(step){
  S.step = step;
  $$('.screen').forEach(s => s.classList.remove('active'));
  const el = $('#' + screenIdFor(step)); if(el) el.classList.add('active');
  const wide = (step === 'run:reading' || step === 'run:writing' || step === 'run:listening');
  $('main').classList.toggle('wide', wide);
  document.body.classList.toggle('is-reading', step === 'run:reading');
  renderRail(); tick(); window.scrollTo(0,0);
  save();
}
function renderRail(){
  const rail = $('#progress-rail'); rail.innerHTML = '';
  const m = /^(?:intro|run):(\w+)$/.exec(S.step);
  const curIdx = m ? modIndex(m[1]) : (S.step === 'done' ? CONFIG.modules.length : -1);
  CONFIG.modules.forEach((mod, i) => {
    const d = document.createElement('div');
    d.className = 'rail-step' + (i < curIdx ? ' done' : '') + (i === curIdx ? ' active' : '');
    d.innerHTML = '<i></i><span>' + esc(mod.label) + '</span>';
    rail.appendChild(d);
  });
  $('#hdr-title').textContent = 'Phase 3 Capstone' + (S.name ? ' · ' + S.name : '');
}

/* ================================================================================
   TIMER
   ================================================================================ */
const warned = {};
function currentModule(){
  const m = /^run:(\w+)$/.exec(S.step);
  return m ? modById(m[1]) : null;
}
function tick(){
  const t = $('#timer'), lab = $('#timer-label');
  const m = currentModule();
  if(!m){ t.textContent = '--:--'; t.className = ''; lab.textContent = ''; return; }
  const ms = S.mod[m.id];
  if(!ms.start){ return; }
  const elapsed = Math.floor((Date.now() - ms.start) / 1000);
  lab.textContent = m.label + (CONFIG.timed ? ' · time left' : ' · time used');
  if(CONFIG.timed){
    const rem = m.minutes * 60 - elapsed;
    if(rem <= 0){ t.textContent = '00:00'; finishModule(m.id, 'time'); return; }
    t.textContent = fmt(rem);
    t.className = rem <= 120 ? 'red' : (rem <= 600 ? 'amber' : '');
    [[600,'10 minutes left'],[300,'5 minutes left'],[120,'2 minutes left']].forEach(p => {
      const k = m.id + p[0];
      if(rem <= p[0] && !warned[k] && m.minutes*60 > p[0]+30){ warned[k] = true; toast(p[1] + ' in ' + m.label + '.'); }
    });
  } else {
    t.textContent = fmt(elapsed); t.className = '';
  }
}
setInterval(tick, 500);

/* ================================================================================
   RECORDING (Speaking)
   ================================================================================ */
const Rec = {
  stream:null, mr:null, chunks:[], blob:null, url:null, mime:'', ready:false, downloaded:false, startedAt:0,
  supported(){ return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); },
  pickMime(){
    const list = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
    if(!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for(const t of list){ try{ if(MediaRecorder.isTypeSupported(t)) return t; }catch(e){} }
    return '';
  },
  ext(){
    const m = (this.mime || '').toLowerCase();
    if(m.indexOf('mp4') >= 0) return 'm4a';
    if(m.indexOf('ogg') >= 0) return 'ogg';
    return 'webm';
  },
  async open(){
    this.stream = await navigator.mediaDevices.getUserMedia({audio:true});
    this.mime = this.pickMime();
    this.mr = this.mime ? new MediaRecorder(this.stream, {mimeType:this.mime}) : new MediaRecorder(this.stream);
    if(!this.mime) this.mime = this.mr.mimeType || 'audio/webm';
    this.chunks = [];
    this.mr.ondataavailable = e => { if(e.data && e.data.size) this.chunks.push(e.data); };
  },
  releaseStream(){
    if(this.stream){ this.stream.getTracks().forEach(t => { try{ t.stop(); }catch(e){} }); this.stream = null; }
  },
  async start(){ await this.open(); this.mr.start(1000); this.startedAt = Date.now(); },
  finalize(){
    this.releaseStream();
    if(this.chunks.length){
      this.blob = new Blob(this.chunks, {type: this.mime || 'audio/webm'});
      this.url = URL.createObjectURL(this.blob); this.ready = true;
    }
  },
  stop(){
    return new Promise(resolve => {
      if(!this.mr || this.mr.state === 'inactive'){ this.finalize(); resolve(); return; }
      this.mr.onstop = () => { this.finalize(); resolve(); };
      try{ this.mr.stop(); }catch(e){ this.finalize(); resolve(); }
    });
  },
  async test(seconds){
    await this.open(); this.mr.start();
    await new Promise(r => setTimeout(r, seconds * 1000));
    await new Promise(r => { this.mr.onstop = () => r(); try{ this.mr.stop(); }catch(e){ r(); } });
    const blob = new Blob(this.chunks, {type: this.mime || 'audio/webm'});
    this.releaseStream();
    this.chunks = []; this.mr = null;
    return URL.createObjectURL(blob);
  }
};

/* ================================================================================
   RENDER: COVER + INTRO SCREENS
   ================================================================================ */
function renderCover(){
  const chips = $('#cover-chips'); chips.innerHTML = '';
  CONFIG.modules.forEach(m => {
    const c = document.createElement('span'); c.className = 'chip';
    c.textContent = m.label + ' · ' + m.minutes + ' min'; chips.appendChild(c);
  });
  const c2 = document.createElement('span'); c2.className = 'chip amber'; c2.textContent = 'Target level: IELTS 5.0'; chips.appendChild(c2);
  $('#inp-date').value = S.date || new Date().toISOString().slice(0,10);
  if(S.name) $('#inp-name').value = S.name;
}
function introHTML(id){
  const idx = modIndex(id) + 1, total = CONFIG.modules.length;
  const head = '<div class="eyebrow">Section ' + idx + ' of ' + total + '</div>';
  const m = modById(id);
  const note = '<div class="note teal">Your timer for this section starts only when you press the button below. Take a breath first — you can take a short break before pressing it.</div>';
  const startBtn = '<div class="btn-row"><button class="btn btn-primary" data-start="' + id + '">Start ' + esc(m.label) + ' →</button></div>';
  if(id === 'reading'){
    return '<div class="card">' + head + '<h1>Reading</h1><p class="lead">' + m.minutes + ' minutes · 3 passages · 30 questions</p>' +
      '<ul class="rules"><li>Passage 1 has Questions 1–13: <b>Note Completion</b> and <b>True/False/Not Given</b>.</li>' +
      '<li>Passage 2 has Questions 14–26: <b>Matching Information</b>, <b>Summary Completion</b> and <b>Matching Features</b>.</li>' +
      '<li>Passage 3 has Questions 27–30: <b>Multiple Choice</b>.</li>' +
      '<li>You can switch between passages at any time with the tabs, and the numbered buttons at the bottom take you straight to a question.</li>' +
      '<li>There is no penalty for a wrong answer, so <b>answer every question</b>.</li>' +
      '<li>Follow the word limit shown with each completion question.</li></ul>' +
      '<p class="source-credit">Reading materials courtesy of <i>Cambridge IELTS 21</i> (Cambridge University Press &amp; Assessment).</p>' +
      note + startBtn + '</div>';
  }
  if(id === 'writing'){
    return '<div class="card">' + head + '<h1>Writing</h1><p class="lead">' + m.minutes + ' minutes · 2 tasks</p>' +
      '<ul class="rules"><li><b>Task 1</b> (diagram): about 20 minutes, at least 150 words.</li>' +
      '<li><b>Task 2</b> (essay): about 40 minutes, at least 250 words. Task 2 counts for <b>twice</b> as many marks as Task 1, so do not spend too long on Task 1.</li>' +
      '<li>You may switch between the two tasks at any time. Plan on paper first — four minutes of planning is a good investment.</li>' +
      '<li>Use the skills from Phase 3 and write in clear paragraphs. Check your work before the time ends.</li></ul>' + note + startBtn + '</div>';
  }
  return '<div class="card">' + head + '<h1>Listening</h1><p class="lead">' + m.minutes + ' minutes · 4 sections · 40 questions</p>' +
    '<ul class="rules"><li>Use the audio player at the start of each section to listen to its recording.</li>' +
    '<li>Answer the questions as you listen, following the instructions and word limits shown for each group.</li>' +
    '<li>Answers save automatically. Check your selections and typed answers before the section timer ends.</li></ul>' +
    '<p class="source-credit">Listening materials courtesy of <i>Cambridge IELTS 21</i> (Cambridge University Press &amp; Assessment).</p>' +
    note + startBtn + '</div>';
}
function renderIntros(){
  CONFIG.modules.forEach(m => { $('#screen-intro-' + m.id).innerHTML = introHTML(m.id); });
}
function renderListening(){
  const listening = CONTENT.listening || {};
  const sections = Array.isArray(listening.sections) && listening.sections.length ? listening.sections : [{
    title: listening.title || 'Listening placeholder',
    audio: listening.audio || './Audio/listening-placeholder.wav',
    instructions: listening.instructions || 'Listen and answer the questions.',
    questions: Array.isArray(listening.questions) ? listening.questions : []
  }];
  const panel = $('#screen-run-listening');
  const savedAnswers = S.li && S.li.answers ? S.li.answers : {};
  let removedLegacyAnswers = false;
  sections.forEach(section => (section.questions || []).forEach(question => {
    if(question.type === 'multi-select-pair') {
      (question.legacyKeys || []).forEach(key => {
        if(Object.prototype.hasOwnProperty.call(savedAnswers, key)) {
          delete savedAnswers[key];
          removedLegacyAnswers = true;
        }
      });
    }
  }));
  if(removedLegacyAnswers) save();

  const renderQuestion = q => {
    const qKey = 'q' + q.n;
    const saved = savedAnswers[qKey] || '';
    if(q.type === 'instruction') {
      return '<div class="listening-question-instruction"><h3 class="qg-title">' + esc(q.title) + '</h3><p class="qg-instr">' + esc(q.instructions) + '</p></div>';
    }
    if(q.type === 'text') {
      return '<p class="listening-static-text">' + esc(q.text) + '</p>';
    }
    if(q.type === 'matching-group') {
      const instructionBlock = q.instructions && q.instructions.length
        ? '<div class="listening-matching-instructions">' + q.instructions.map(text => '<p>' + esc(text) + '</p>').join('') + '</div>'
        : '';
      const title = '<h3 class="qg-title">' + esc(q.title) + '</h3>';
      const options = q.letters.map(([letter, text]) =>
        '<li><strong>' + esc(letter) + '</strong><span>— ' + esc(text) + '</span></li>'
      ).join('');
      const questions = q.items.map(item => {
        const answerKey = 'q' + item.n;
        const selected = savedAnswers[answerKey] || '';
        return '<div class="listening-match-row" data-qn="' + item.n + '">' +
          '<span class="qn">' + item.n + '</span><span class="listening-match-stem">' + esc(item.stem) + '</span>' +
          '<select data-q="' + answerKey + '" aria-label="Answer for question ' + item.n + '">' +
          '<option value="">—</option>' + q.letters.map(([letter]) =>
            '<option value="' + esc(letter) + '"' + (selected === letter ? ' selected' : '') + '>' + esc(letter) + '</option>'
          ).join('') + '</select></div>';
      }).join('');
      return '<section class="listening-matching-group" aria-label="' + esc(q.title) + '">' +
        (q.instructionsFirst ? instructionBlock + title : title + instructionBlock) +
        '<ul class="listening-matching-options">' + options + '</ul>' +
        '<div class="listening-match-questions">' + questions + '</div></section>';
    }
    if(q.type === 'note-list') {
      const instructionLines = q.instructions.map(text => '<p>' + esc(text) + '</p>').join('');
      let notes = '';
      let listOpen = false;
      const closeList = () => {
        if(listOpen) {
          notes += '</ul>';
          listOpen = false;
        }
      };
      q.items.forEach(item => {
        if(item.type === 'heading') {
          closeList();
          notes += '<h4>' + esc(item.text) + '</h4>';
          return;
        }
        if(item.type === 'paragraph') {
          closeList();
          notes += '<p>' + esc(item.text) + '</p>';
          return;
        }
        if(!listOpen) {
          notes += '<ul>';
          listOpen = true;
        }
        if(item.text !== undefined) {
          notes += '<li>' + esc(item.text) + '</li>';
          return;
        }
        const answerKey = 'q' + item.n;
        const before = esc(item.before || '');
        const after = esc(item.after || '');
        const wordLimit = q.instructions.some(text => /ONE WORD ONLY/i.test(text)) ? ' data-max-words="1"' : '';
        notes += '<li>' + before + (before ? ' ' : '') +
          '<span class="gap listening-note-gap"><span class="gap-n">' + item.n + '</span>' +
          '<input type="text" class="sc-input" data-q="' + answerKey + '"' + wordLimit + ' value="' + esc(savedAnswers[answerKey] || '') + '" autocomplete="off" spellcheck="false" aria-label="Answer for question ' + item.n + '">' +
          '</span><span class="sc-hint listening-word-hint" data-hint="' + answerKey + '"></span>' +
          (after && /^[A-Za-z(]/.test(after) ? ' ' : '') + after + '</li>';
      });
      closeList();
      return '<div class="listening-note-list">' + (q.title ? '<h3 class="qg-title">' + esc(q.title) + '</h3>' : '') +
        '<div class="listening-note-instructions">' + instructionLines + '</div>' +
        notes + '</div>';
    }
    if(q.type === 'table') {
      const renderCell = cell => {
        if(cell.text !== undefined) return esc(cell.text);
        const renderPart = part => {
          if(part.text !== undefined) return esc(part.text);
          const answerKey = 'q' + part.n;
          return '<span class="gap listening-table-gap"><span class="gap-n">' + part.n + '</span><input type="text" class="sc-input" data-q="' + answerKey + '" value="' + esc(savedAnswers[answerKey] || '') + '" autocomplete="off" spellcheck="false" aria-label="Answer for question ' + part.n + '">' + esc(part.after || '') + '</span>';
        };
        if(Array.isArray(cell.parts)) return cell.parts.map(renderPart).join(' ');
        return esc(cell.before || '') + '<span class="gap listening-table-gap"><span class="gap-n">' + cell.n + '</span><input type="text" class="sc-input" data-q="q' + cell.n + '" value="' + esc(savedAnswers['q' + cell.n] || '') + '" autocomplete="off" spellcheck="false" aria-label="Answer for question ' + cell.n + '">' + esc(cell.after || '') + '</span>';
      };
      return '<div class="listening-table-wrap"><h3 class="qg-title">' + esc(q.title) + '</h3><p class="qg-instr">' + esc(q.instructions) + '</p>' +
        '<table class="data-table listening-table"><thead><tr>' + q.columns.map(col => '<th scope="col">' + esc(col) + '</th>').join('') + '</tr></thead><tbody>' +
        q.rows.map(row => '<tr>' + row.cells.map(cell => '<td>' + renderCell(cell) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }
    if(q.type === 'note') {
      return '<div class="mcq-item" data-qn="' + q.n + '"><div class="mcq-stem"><span class="qn">' + q.n + '</span><span>' + esc(q.stem) + '</span></div>' +
        '<div class="qi"> <span class="qt">' + esc(q.prompt || '________') + '</span><input type="text" class="sc-input" data-q="' + qKey + '" value="' + esc(saved) + '" autocomplete="off" spellcheck="false" aria-label="Answer for question ' + q.n + '"></div>' +
        '</div>';
    }
    if(q.type === 'multi-select-pair') {
      const selected = Array.isArray(savedAnswers[q.answerKey]) ? savedAnswers[q.answerKey] : [];
      return '<section class="listening-multi-select-group" data-qn="' + Number(q.range.split('–')[0]) + '" data-max-select="2">' +
        '<div class="listening-matching-instructions"><p>' + esc(q.instructions) + '</p></div>' +
        '<div class="mcq-stem"><span class="qn listening-range">' + esc(q.range) + '</span><span>' + esc(q.stem) + '</span></div>' +
        '<div class="small listening-select-count" role="status" aria-live="polite">Select exactly 2 answers (' + selected.length + ' of 2 selected).</div>' +
        q.opts.map(([letter, text]) => {
          const checked = selected.includes(letter) ? ' checked' : '';
          return '<label class="opt' + (checked ? ' selected' : '') + '"><input type="checkbox" value="' + esc(letter) + '" data-q="' + esc(q.answerKey) + '"' + checked + '><span class="ok-key">' + esc(letter) + '</span><span>' + esc(text) + '</span></label>';
        }).join('') + '</section>';
    }
    if(q.type === 'multi-select') {
      const selected = Array.isArray(saved) ? saved : (typeof saved === 'string' ? saved.split(',') : []);
      return '<div class="mcq-item" data-qn="' + q.n + '" data-max-select="' + (q.maxSelect || 0) + '"><div class="mcq-stem"><span class="qn">' + q.n + '</span><span>' + esc(q.stem) + '</span></div>' +
        q.opts.map(o => {
          const optionCode = String(o).split('. ')[0].trim();
          const checked = selected.includes(optionCode) ? ' checked' : '';
          return '<label class="opt' + (checked ? ' selected' : '') + '"><input type="checkbox" value="' + esc(optionCode) + '" data-q="' + qKey + '"' + checked + '><span class="ok-key">' + esc(optionCode) + '</span><span>' + esc(o) + '</span></label>';
        }).join('') +
        '<div class="small" style="margin:6px 0 0 42px">Choose ' + (q.maxSelect || 2) + ' options.</div></div>';
    }
    if(q.type === 'matching') {
      const letters = q.letters || ['A','B','C'];
      const opts = q.opts || letters.map(l => l + '. Option ' + l);
      const selected = String(saved || '');
      return '<div class="qi" data-qn="' + q.n + '"><span class="qn">' + q.n + '</span><span class="qt">' + esc(q.stem) + '</span>' +
        '<select data-q="' + qKey + '" aria-label="Answer for question ' + q.n + '">' +
        '<option value="">–</option>' + letters.map(l => '<option value="' + l + '"' + (selected === l ? ' selected' : '') + '>' + l + '</option>').join('') +
        '</select>' +
        '<div class="small" style="margin-top:6px">Options: ' + opts.map(o => esc(String(o).split('. ')[0].trim()) + ' — ' + esc(String(o).split('. ').slice(1).join('. '))).join(' · ') + '</div>' +
        '</div>';
    }
    const items = Array.isArray(q.opts) ? q.opts : [];
    return '<div class="mcq-item" data-qn="' + q.n + '"><div class="mcq-stem"><span class="qn">' + q.n + '</span><span>' + esc(q.stem) + '</span></div>' + items.map(o => {
      const optionCode = Array.isArray(o) ? String(o[0]) : String(o).split('. ')[0].trim();
      const optionText = Array.isArray(o) ? o[1] : o;
      const checked = saved && String(saved) === optionCode ? ' checked' : '';
      return '<label class="opt' + (checked ? ' selected' : '') + '"><input type="radio" name="lq' + q.n + '" value="' + esc(optionCode) + '" data-q="' + qKey + '"' + checked + '><span class="ok-key">' + esc(optionCode) + '</span><span>' + esc(optionText) + '</span></label>';
    }).join('') + '</div>';
  };

  panel.innerHTML = '<div class="card">' +
    '<div class="run-top"><div><span class="sp-chip">Listening</span></div><div class="small">Section 1–4</div></div>' +
    sections.map(section => {
      const sectionQuestions = Array.isArray(section.questions) ? section.questions : [];
      return '<div class="cue" style="margin-bottom:16px"><div class="eyebrow">Audio cue</div><h3>' + esc(section.title || listening.title || 'Listening placeholder') + '</h3>' +
        '<audio controls preload="metadata" data-listening-audio aria-label="Audio for ' + esc(section.title || listening.title || 'Listening section') + '" src="' + esc(section.audio || listening.audio || './Audio/listening-placeholder.wav') + '" style="width:100%;margin:10px 0 6px"></audio>' +
        '<p class="listening-audio-error hidden" role="status" aria-live="polite"></p>' +
        '<p class="small">' + esc(section.instructions || 'Listen carefully and answer the questions below.') + '</p></div>' +
        '<div class="listening-questions">' + sectionQuestions.map(renderQuestion).join('') + '</div>';
    }).join('') +
    '<div class="btn-row"><button class="btn btn-primary" id="btn-finish-listening">Finish Listening →</button></div>' +
  '</div>';
  $$('#screen-run-listening .sc-input[data-max-words]').forEach(updateScHint);
  $$('#screen-run-listening audio[data-listening-audio]').forEach(audio => {
    const showAudioError = () => {
      const message = audio.error && (audio.error.code === 3 || audio.error.code === 4)
        ? 'This audio format is unsupported or the file is invalid. Replace it with a valid MP3 or WAV recording.'
        : 'This audio file could not be loaded. Check that the file exists at the listed path.';
      const status = audio.parentElement.querySelector('.listening-audio-error');
      status.textContent = message;
      status.classList.remove('hidden');
    };
    audio.addEventListener('error', showAudioError);
    if(audio.error) showAudioError();
  });
}

/* ================================================================================
   RENDER: READING
   ================================================================================ */
function optionList(letters, withWords){
  return '<option value="">–</option>' + letters.map(l => '<option value="' + l + '">' + l + '</option>').join('');
}
function renderReading(){
  const tabs = $('#reading-tabs'), panes = $('#reading-panes');
  tabs.innerHTML = ''; panes.innerHTML = '';
  CONTENT.reading.passages.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'tab'; b.type = 'button'; b.dataset.tab = p.id; b.setAttribute('role','tab');
    b.innerHTML = esc(p.tab) + '<small>' + esc(p.range) + '</small>';
    tabs.appendChild(b);

    const pane = document.createElement('div'); pane.className = 'pane'; pane.id = 'rpane-' + p.id;
    let passage = '<div class="passage-col"><div class="card"><div class="passage-title">' + esc(p.title) + '</div>';
    p.paras.forEach(pa => {
      const isGlossary = pa[0] === 'Glossary';
      passage += '<div class="para' + (isGlossary ? ' glossary' : '') + '"><span class="para-l">' + esc(pa[0]) + '</span><p>' + esc(pa[1]) + '</p></div>';
    });
    passage += '</div></div>';
    let qs = '<div class="q-col"><div class="card">';
    p.groups.forEach(g => { qs += renderGroup(g); });
    qs += '</div></div>';
    pane.innerHTML = '<div class="read-grid">' + passage + qs + '</div>';
    panes.appendChild(pane);
  });
  // palette
  const pn = $('#pal-nums'); pn.innerHTML = '';
  for(let n = 1; n <= 30; n++){
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pal-btn'; b.dataset.n = n; b.textContent = n;
    b.setAttribute('aria-label', 'Go to question ' + n);
    pn.appendChild(b);
    if(n === 13 || n === 26){ const s = document.createElement('span'); s.className = 'pal-sep'; pn.appendChild(s); }
  }
}
function renderGroup(g){
  let h = '<div class="qg"><h3 class="qg-title">' + g.title + '</h3>' +
    (g.noteTitle ? '<h4 class="note-title">' + esc(g.noteTitle) + '</h4>' : '') +
    '<div class="qg-instr">' + g.instr + '</div>';
  if(g.type === 'matching'){
    if(g.choiceTable){
      h += '<table class="data-table matching-key" aria-label="Matching answer options"><tbody>' +
        g.choiceTable.map(row => '<tr><th scope="row">' + esc(row[0]) + '</th><td>' + esc(row[1]) + '</td></tr>').join('') +
        '</tbody></table>';
    }
    g.items.forEach(it => {
      h += '<div class="qi" data-qn="' + it.n + '"><span class="qn">' + it.n + '</span><span class="qt">' + esc(it.text) + '</span>' +
           '<select data-q="q' + it.n + '" aria-label="Answer for question ' + it.n + '">' + optionList(g.letters) + '</select></div>';
    });
  } else if(g.type === 'tfng'){
    g.items.forEach(it => {
      h += '<div class="mcq-item" data-qn="' + it.n + '"><div class="mcq-stem"><span class="qn">' + it.n + '</span><span>' + esc(it.stem) + '</span></div>';
      g.opts.forEach(o => {
        h += '<label class="opt"><input type="radio" name="q' + it.n + '" data-q="q' + it.n + '" value="' + o[0] + '"><span class="ok-key">' + o[0] + '</span><span>' + esc(o[1]) + '</span></label>';
      });
      h += '</div>';
    });
  } else if(g.type === 'summary'){
    const text = esc(g.text).replace(/\{\{(\d+)\}\}/g, (m, n) =>
      '<span class="gap" data-qn="' + n + '"><span class="gap-n">' + n + '</span><input type="text" class="sc-input" data-max-words="1" data-q="q' + n + '" autocomplete="off" spellcheck="false" aria-label="Answer for question ' + n + '"></span>');
    h += '<p class="summary-text">' + text + '</p>';
  } else if(g.type === 'mcq'){
    g.items.forEach(it => {
      h += '<div class="mcq-item" data-qn="' + it.n + '"><div class="mcq-stem"><span class="qn">' + it.n + '</span><span>' + esc(it.stem) + '</span></div>';
      it.opts.forEach(o => {
        h += '<label class="opt"><input type="radio" name="q' + it.n + '" data-q="q' + it.n + '" value="' + o[0] + '"><span class="ok-key">' + o[0] + '</span><span>' + esc(o[1]) + '</span></label>';
      });
      h += '</div>';
    });
  } else if(g.type === 'mcq2'){
    h += '<div class="mcq-item" data-qn="18"><div class="mcq-stem"><span class="qn" style="width:auto;border-radius:15px;padding:0 9px">18–19</span><span>' + g.stem + '</span></div>';
    g.opts.forEach(o => {
      h += '<label class="opt"><input type="checkbox" data-q="q18_19" value="' + o[0] + '"><span class="ok-key">' + o[0] + '</span><span>' + esc(o[1]) + '</span></label>';
    });
    h += '<div class="small" style="margin:6px 0 0 42px">Choose exactly two answers. Click a chosen answer again to remove it.</div></div>';
  } else if(g.type === 'sentence'){
    g.items.forEach(it => {
      if(it.type === 'heading'){
        h += '<h4 class="qi-heading">' + esc(it.text) + '</h4>';
        return;
      }
      if(it.type === 'text'){
        h += '<div class="qi-static">' + esc(it.text) + '</div>';
        return;
      }
      h += '<div class="qi" data-qn="' + it.n + '"><span class="qn">' + it.n + '</span><div class="sc-line">' + esc(it.before) +
           ' <input type="text" class="sc-input" data-q="q' + it.n + '" autocomplete="off" spellcheck="false" aria-label="Answer for question ' + it.n + '"> ' + esc(it.after) +
           '<span class="sc-hint" data-hint="q' + it.n + '"></span></div></div>';
    });
  }
  return h + '</div>';
}
function applyReadingAnswers(){
  $$('#reading-panes [data-q]').forEach(el => {
    const q = el.dataset.q, v = S.r[q];
    if(el.type === 'radio'){ el.checked = (v === el.value); }
    else if(el.type === 'checkbox'){ el.checked = Array.isArray(v) && v.indexOf(el.value) >= 0; }
    else if(v !== undefined){ el.value = v; }
  });
  $$('#reading-panes .opt').forEach(l => l.classList.toggle('sel', l.querySelector('input').checked));
  $$('#reading-panes .sc-input').forEach(updateScHint);
  updatePalette();
}
function updateScHint(inp){
  const maxWords = Number(inp.dataset.maxWords) || 2;
  const n = wordCount(inp.value);
  const overLimit = n > maxWords;
  inp.classList.toggle('warn', overLimit);
  if(overLimit) inp.setAttribute('aria-invalid', 'true');
  else inp.removeAttribute('aria-invalid');
  const hintRoot = inp.closest('.qi') || inp.closest('li') || inp.parentElement;
  const hint = hintRoot && $('[data-hint="' + inp.dataset.q + '"]', hintRoot);
  if(hint) hint.textContent = overLimit ? 'Maximum ' + maxWords + (maxWords === 1 ? ' word.' : ' words.') : '';
}
function isAnswered(n){
  const v = S.r['q' + n]; return v !== undefined && String(v).trim() !== '';
}
function updatePalette(){
  let done = 0;
  $$('#pal-nums .pal-btn').forEach(b => {
    const a = isAnswered(Number(b.dataset.n)); b.classList.toggle('answered', a); if(a) done++;
  });
  $('#pal-count').textContent = 'Answered ' + done + ' / 30';
}
function unansweredCount(){ let c = 0; for(let n = 1; n <= 30; n++) if(!isAnswered(n)) c++; return c; }
function setReadingTab(id){
  S.tab.reading = id;
  $$('#reading-tabs .tab').forEach(t => { const on = t.dataset.tab === id; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $$('#reading-panes .pane').forEach(p => p.classList.toggle('active', p.id === 'rpane-' + id));
  save();
}
function goToQuestion(n){
  const pid = n <= 13 ? 'p1' : (n <= 26 ? 'p2' : 'p3'); setReadingTab(pid);
  const target = $('#reading-panes [data-qn="' + n + '"]');
  if(target){ target.scrollIntoView({behavior:'smooth', block:'center'}); const f = $('select,input', target); if(f && !isTestEnv()) setTimeout(() => f.focus({preventScroll:true}), 350); }
}
function onReadingInput(e){
  const t = e.target; if(!t.dataset || !t.dataset.q) return;
  const q = t.dataset.q;
  if(t.type === 'checkbox'){
    const boxes = $$('#reading-panes input[data-q="' + q + '"]');
    const sel = boxes.filter(b => b.checked).map(b => b.value);
    S.r[q] = sel.sort();
    boxes.forEach(b => b.closest('.opt').classList.toggle('sel', b.checked));
  } else if(t.type === 'radio'){
    if(t.checked){ S.r[q] = t.value; $$('#reading-panes input[name="' + t.name + '"]').forEach(r => r.closest('.opt').classList.toggle('sel', r.checked)); }
  } else {
    S.r[q] = t.value;
    if(t.classList.contains('sc-input')) updateScHint(t);
  }
  updatePalette(); save();
}

/* ================================================================================
   RENDER: WRITING
   ================================================================================ */
function renderWriting(){
  const W = CONTENT.writing, tabs = $('#writing-tabs'), panes = $('#writing-panes');
  tabs.innerHTML = ''; panes.innerHTML = '';
  [['t1','Task 1','about 20 min'],['t2','Task 2','about 40 min']].forEach(x => {
    const b = document.createElement('button'); b.className = 'tab'; b.type = 'button'; b.dataset.tab = x[0];
    b.innerHTML = x[1] + '<small>' + x[2] + '</small>'; tabs.appendChild(b);
  });
  const t1 = W.task1, t2 = W.task2;
  panes.innerHTML =
   '<div class="pane" id="wpane-t1"><div class="read-grid"><div class="passage-col"><div class="card">' +
     '<div class="task-head"><span class="task-label">Writing Task 1</span><span class="task-time">You should spend about ' + t1.minutes + ' minutes on this task.</span></div>' +
     '<p class="prompt">' + esc(t1.prompt) + '</p>' +
     '<div class="diagram-placeholder"><img src="' + esc(t1.image || './Diagrams/diagram1.png') + '" alt="' + esc(t1.caption || 'Writing Task 1 graph') + '"></div>' +
     '<p class="prompt strong">' + esc(t1.task) + '</p><p class="prompt">Write at least <b>' + t1.minWords + ' words</b>.</p></div></div>' +
     '<div><div class="card"><label class="fld" for="w-t1" style="margin-top:0">Your answer — Task 1</label><textarea class="write" id="w-t1" spellcheck="false" autocomplete="off" placeholder="Type your report here..."></textarea>' +
     '<div class="wc" id="wc-t1"><span>Words: <b id="wn-t1">0</b></span><span>Minimum ' + t1.minWords + '</span></div></div></div></div></div>' +
   '<div class="pane" id="wpane-t2"><div class="read-grid"><div class="passage-col"><div class="card">' +
     '<div class="task-head"><span class="task-label">Writing Task 2</span><span class="task-time">You should spend about ' + t2.minutes + ' minutes on this task.</span></div>' +
     '<p class="prompt">Write about the following topic:</p><p class="prompt strong">' + esc(t2.prompt) + '</p><p class="prompt strong">' + esc(t2.question) + '</p>' +
     '<p class="prompt">' + esc(t2.note) + '</p><p class="prompt">Write at least <b>' + t2.minWords + ' words</b>.</p></div></div>' +
     '<div><div class="card"><label class="fld" for="w-t2" style="margin-top:0">Your answer — Task 2</label><textarea class="write" id="w-t2" spellcheck="false" autocomplete="off" placeholder="Type your essay here..."></textarea>' +
     '<div class="wc" id="wc-t2"><span>Words: <b id="wn-t2">0</b></span><span>Minimum ' + t2.minWords + '</span></div></div></div></div></div>';
  ['t1','t2'].forEach(k => { $('#w-' + k).value = S.w[k] || ''; updateWC(k); });
}
function updateWC(k){
  const min = CONTENT.writing[k === 't1' ? 'task1' : 'task2'].minWords;
  const n = wordCount($('#w-' + k).value);
  $('#wn-' + k).textContent = n;
  const box = $('#wc-' + k); box.classList.toggle('ok', n >= min); box.classList.toggle('near', n < min && n >= Math.floor(min * 0.8));
}
function setWritingTab(id){
  S.tab.writing = id;
  $$('#writing-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  $$('#writing-panes .pane').forEach(p => p.classList.toggle('active', p.id === 'wpane-' + id));
  save();
}

/* ================================================================================
   SPEAKING FLOW
   ================================================================================ */
const Sp = {
  iv:null, deadline:0, t0:0, p3i:0, stage:'', onEnd:null, soft:false,
  log(ev){ S.sp.log.push({t: Math.round((Date.now() - this.t0) / 1000), ev: ev}); save(); },
  clear(){ if(this.iv){ clearInterval(this.iv); this.iv = null; } },
  beep(){
    try{
      const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return;
      const ctx = new AC(), o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.07; o.start();
      setTimeout(() => { try{ o.stop(); ctx.close(); }catch(e){} }, 220);
    }catch(e){}
  },
  startClock(seconds, label, onEnd, soft){
    this.clear(); this.deadline = Date.now() + seconds * 1000; this.onEnd = onEnd; this.soft = !!soft;
    $('#sp-clock-label').textContent = label; $('#sp-clockwrap').classList.remove('hidden');
    const upd = () => {
      const rem = Math.ceil((this.deadline - Date.now()) / 1000);
      const c = $('#sp-clock'); c.textContent = fmt(Math.max(0, rem));
      c.className = 'sp-clock' + (rem <= 10 ? ' red' : (rem <= 30 ? ' amber' : ''));
      if(rem <= 0){
        if(this.soft){ this.clear(); c.textContent = '00:00'; }
        else { this.clear(); const f = this.onEnd; this.onEnd = null; if(f) f(); }
      }
    };
    upd(); this.iv = setInterval(upd, 250);
  },
  controls(html){ $('#sp-controls').innerHTML = html; },
  panels(cue, clock, p3, end){
    $('#sp-cuewrap').classList.toggle('hidden', !cue); $('#sp-clockwrap').classList.toggle('hidden', !clock);
    $('#sp-p3wrap').classList.toggle('hidden', !p3); $('#sp-endwrap').classList.toggle('hidden', !end);
  },
  begin(){
    this.t0 = Date.now(); S.sp.log = []; save();
    const cue = CONTENT.speaking.cue;
    $('#sp-cue').innerHTML = '<div class="eyebrow">Part 2 · Topic card</div><h3>' + esc(cue.title) + '</h3><p>You should say:</p><ul>' + cue.bullets.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>';
    $('#sp-notes').value = S.sp.notes || '';
    const chip = $('#sp-mode-chip');
    if(S.sp.mode === 'record'){ chip.innerHTML = '<span class="rec-dot"></span>Recording'; chip.className = 'sp-chip'; }
    else { chip.textContent = 'Live with your teacher'; chip.className = 'sp-chip live'; }
    this.prep();
  },
  prep(){
    this.stage = 'prep'; this.log('part2_prep_start');
    $('#sp-step-label').textContent = 'Part 2 · Preparation';
    this.panels(true, true, false, false);
    this.controls('<button class="btn btn-primary" id="sp-btn-ready">I am ready — start speaking now</button>');
    this.startClock(CONTENT.speaking.prepSeconds, 'Preparation time', () => this.talk());
  },
  talk(){
    this.clear(); this.stage = 'talk'; this.beep(); this.log('part2_talk_start');
    $('#sp-step-label').textContent = 'Part 2 · Speaking';
    this.panels(true, true, false, false);
    this.controls('<button class="btn btn-ghost" id="sp-btn-done2">I have finished Part 2</button>');
    this.startClock(CONTENT.speaking.talkSeconds, 'Speak now — up to 2 minutes', () => this.part3(0));
  },
  part3(i){
    this.clear(); this.stage = 'p3'; this.p3i = i; this.log('part3_q' + (i + 1));
    const qs = CONTENT.speaking.part3;
    $('#sp-step-label').textContent = 'Part 3 · Question ' + (i + 1) + ' of ' + qs.length;
    $('#sp-p3-label').textContent = 'Part 3 · Question ' + (i + 1) + ' of ' + qs.length;
    $('#sp-p3-q').textContent = qs[i];
    this.panels(false, true, true, false);
    const last = i === qs.length - 1;
    this.controls('<button class="btn btn-primary" id="sp-btn-next">' + (last ? 'Finish Speaking ✓' : 'Next question →') + '</button>');
    this.startClock(CONTENT.speaking.part3GuideSeconds, 'Guide time (about 1 minute)', null, true);
  },
  next(){
    const qs = CONTENT.speaking.part3;
    if(this.p3i >= qs.length - 1) this.finish(); else this.part3(this.p3i + 1);
  },
  finish(){
    this.clear(); this.log('speaking_end');
    this.panels(false, false, false, true); this.controls('');
    finishModule('speaking', 'done');
  }
};

/* ================================================================================
   MODULE FLOW
   ================================================================================ */
function nextStepAfter(id){
  const nxt = CONFIG.modules[modIndex(id) + 1];
  return nxt ? 'intro:' + nxt.id : 'done';
}
async function startModule(id){
  if(id === 'listening'){
    S.li = S.li || { answers: {} };
    S.mod[id].start = Date.now(); S.mod[id].end = null;
    renderListening();
    show('run:' + id);
    return;
  }
  if(id === 'speaking'){
    // decide recording vs live, BEFORE the timer starts
    S.sp.mode = 'live';
    if(CONFIG.recordSpeaking){
      if(Rec.supported()){
        try{ await Rec.start(); S.sp.mode = 'record'; S.sp.mime = Rec.mime; }
        catch(err){
          const ok = window.confirm('The microphone could not be used (' + (err && err.name ? err.name : 'error') + ').\n\nPress OK to do Speaking LIVE with your teacher instead, or Cancel to try again.');
          if(!ok) return;
        }
      } else {
        const ok = window.confirm('This browser cannot record audio.\n\nPress OK to do Speaking LIVE with your teacher instead, or Cancel to stop.');
        if(!ok) return;
      }
    }
  }
  S.mod[id].start = Date.now(); S.mod[id].end = null;
  show('run:' + id);
  if(id === 'reading'){ setReadingTab(S.tab.reading || 'p1'); updatePalette(); }
  if(id === 'writing'){ setWritingTab(S.tab.writing || 't1'); }
  if(id === 'speaking'){ Sp.begin(); }
}
async function finishModule(id, reason){
  const ms = S.mod[id]; if(!ms || ms.end) return;
  ms.end = Date.now();
  if(id === 'listening'){ S.li = S.li || { answers: {} }; }
  if(id === 'speaking'){ Sp.clear(); await Rec.stop(); }
  if(reason === 'time') toast('Time is up for ' + modById(id).label + '.', 5000);
  const nxt = nextStepAfter(id);
  save();
  if(nxt === 'done') submitExam(); else show(nxt);
}
function confirmFinish(id){
  let msg = 'Finish ' + modById(id).label + '? You cannot come back to it.';
  if(id === 'reading'){ const u = unansweredCount(); if(u) msg = 'You have ' + u + ' unanswered question' + (u > 1 ? 's' : '') + '.\n\n' + msg; }
  if(id === 'writing'){
    const a = wordCount(S.w.t1), b = wordCount(S.w.t2);
    const m1 = CONTENT.writing.task1.minWords, m2 = CONTENT.writing.task2.minWords;
    if(a < m1 || b < m2) msg = 'Word counts — Task 1: ' + a + ' (min ' + m1 + '), Task 2: ' + b + ' (min ' + m2 + ').\n\n' + msg;
  }
  return window.confirm(msg);
}

/* ================================================================================
   REPORT, DOWNLOADS, PRINT
   ================================================================================ */
function safeName(){
  const n = (S.name || 'student').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return n || 'student';
}
function audioFileName(){ return 'Phase3_Speaking_' + safeName() + '.' + Rec.ext(); }
function used(id){ const m = S.mod[id]; return (m && m.start && m.end) ? Math.round((m.end - m.start) / 1000) : null; }
function listeningAnswerKeys(answers){
  return Object.keys(answers).sort((a, b) => {
    const aNumber = Number((a.match(/\d+/) || [0])[0]);
    const bNumber = Number((b.match(/\d+/) || [0])[0]);
    return aNumber - bNumber || a.localeCompare(b);
  });
}
function listeningAudioFiles(){
  const sections = CONTENT.listening && Array.isArray(CONTENT.listening.sections) ? CONTENT.listening.sections : [];
  return sections.map(section => section.audio).filter(Boolean);
}
function buildReport(){
  const audioFiles = listeningAudioFiles();
  return {
    exam: 'Phase 3 Capstone', version: 1,
    student: {name: S.name, date: S.date},
    submittedAt: S.submittedAt ? new Date(S.submittedAt).toISOString() : null,
    timed: CONFIG.timed,
    timeUsedSec: {reading: used('reading'), writing: used('writing'), listening: used('listening')},
    reading: {answers: S.r},
    writing: {task1: {text: S.w.t1, words: wordCount(S.w.t1)}, task2: {text: S.w.t2, words: wordCount(S.w.t2)}},
    listening: {
      answers: S.li && S.li.answers ? S.li.answers : {},
      audioFile: audioFiles[0] || (CONTENT.listening && CONTENT.listening.audio) || './Audio/listening-placeholder.wav',
      audioFiles: audioFiles,
      completed: !!(S.mod.listening && S.mod.listening.end)
    }
  };
}
function readingLines(rep){
  const a = rep.reading.answers, lines = [];
  for(let n = 1; n <= 30; n++){
    let v = a['q' + n]; v = (v === undefined || String(v).trim() === '') ? '(no answer)' : String(v);
    lines.push([String(n), v]);
  }
  return lines;
}
function mmss(s){ return s == null ? '—' : fmt(s); }
function buildText(rep){
  let t = '';
  t += 'PHASE 3 CAPSTONE — ANSWER SHEET\n';
  t += 'Name: ' + rep.student.name + '\nDate: ' + rep.student.date + '\nSubmitted: ' + (rep.submittedAt || '') + '\n';
  t += 'Time used — Listening ' + mmss(rep.timeUsedSec.listening) + ' | Reading ' + mmss(rep.timeUsedSec.reading) + ' | Writing ' + mmss(rep.timeUsedSec.writing) + (rep.timed ? '' : '  (untimed mode)') + '\n\n';
  t += '=== LISTENING ===\n';
  const listeningAnswers = rep.listening && rep.listening.answers ? rep.listening.answers : {};
  listeningAnswerKeys(listeningAnswers).forEach(k => { t += k + ': ' + listeningAnswers[k] + '\n'; });
  if(!Object.keys(listeningAnswers).length) t += '(no answers)\n';
  t += '=== READING ===\n';
  readingLines(rep).forEach(l => { t += 'Q' + l[0] + ': ' + l[1] + '\n'; });
  t += '\n=== WRITING TASK 1 (' + rep.writing.task1.words + ' words) ===\n' + (rep.writing.task1.text || '(no answer)') + '\n';
  t += '\n=== WRITING TASK 2 (' + rep.writing.task2.words + ' words) ===\n' + (rep.writing.task2.text || '(no answer)') + '\n';
  t += '\n=== MACHINE-READABLE BLOCK (for the teacher\'s marking tool — please do not edit) ===\n' + JSON.stringify(rep) + '\n=== END MACHINE-READABLE BLOCK ===\n';
  return t;
}
function buildPrintHTML(rep){
  const lines = readingLines(rep);
  const cols = lines.map(l => '<div><b>' + esc(l[0]) + '</b>&nbsp; ' + esc(l[1]) + '</div>').join('');
  const listeningAnswers = rep.listening && rep.listening.answers ? rep.listening.answers : {};
  const listeningText = Object.keys(listeningAnswers).length ? listeningAnswerKeys(listeningAnswers).map(k => '<div><b>' + esc(k) + '</b> ' + esc(listeningAnswers[k]) + '</div>').join('') : '<p>(no answers)</p>';
  return '<h1>Phase 3 Capstone — Answer Sheet</h1>' +
    '<table><tr><td><b>Name</b></td><td>' + esc(rep.student.name) + '</td><td><b>Date</b></td><td>' + esc(rep.student.date) + '</td></tr>' +
    '<tr><td><b>Time used</b></td><td colspan="3">Listening ' + mmss(rep.timeUsedSec.listening) + ' · Reading ' + mmss(rep.timeUsedSec.reading) + ' · Writing ' + mmss(rep.timeUsedSec.writing) + '</td></tr></table>' +
    '<h2>Listening</h2><div class="cols">' + listeningText + '</div>' +
    '<h2>Reading</h2><div class="cols">' + cols + '</div>' +
    '<h2>Writing Task 1 (' + rep.writing.task1.words + ' words)</h2><pre>' + esc(rep.writing.task1.text || '(no answer)') + '</pre>' +
    '<h2>Writing Task 2 (' + rep.writing.task2.words + ' words)</h2><pre>' + esc(rep.writing.task2.text || '(no answer)') + '</pre>';
}
function download(filename, blob){
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function submitExam(){
  if(!S.submitted){ S.submitted = true; S.submittedAt = Date.now(); }
  save(); show('done'); renderDone();
}
function renderDone(){
  const rep = buildReport(), root = $('#done-root');
  root.innerHTML =
    '<div class="card"><div class="eyebrow">Exam submitted</div><h1>Well done, ' + esc(S.name) + '.</h1>' +
    '<p class="lead">All three sections are finished. <b>Do these steps now, before you close this page:</b></p>' +
    '<div class="dl-grid">' +
      '<div class="dl"><div><b>1. Answer sheet (.txt)</b><span class="small">Contains all your answers. Upload this file to Google Classroom.</span></div><button class="btn btn-primary" id="btn-dl-txt">⬇ Download answer sheet</button></div>' +
      '<div class="dl"><div><b>2. Printed copy (optional PDF)</b><span class="small">Choose “Save as PDF” in the print window if you want a readable copy.</span></div><button class="btn btn-ghost" id="btn-print">🖨 Print / Save as PDF</button></div>' +
      '<div class="dl"><div><b>3. Listening answers</b><span class="small">This page stores your listening selections in the answer sheet for your teacher.</span></div></div>' +
    '</div>' +
    '<table class="sum"><tr><th>Section</th><th>Time used</th><th>Words</th></tr>' +
    '<tr><td>Listening</td><td>' + mmss(rep.timeUsedSec.listening) + '</td><td>—</td></tr>' +
    '<tr><td>Reading</td><td>' + mmss(rep.timeUsedSec.reading) + '</td><td>—</td></tr>' +
    '<tr><td>Writing Task 1</td><td rowspan="2">' + mmss(rep.timeUsedSec.writing) + '</td><td>' + rep.writing.task1.words + '</td></tr>' +
    '<tr><td>Writing Task 2</td><td>' + rep.writing.task2.words + '</td></tr></table>' +
    '<div class="note">Your results will be shared after your teacher has marked your work. This checkpoint helps choose what to practise in Phase 4 — thank you for your effort.</div>' +
    '<div class="btn-row"><button class="btn btn-ghost" id="btn-new">Start a new attempt on this device</button></div></div>';
  $('#print-sheet').innerHTML = buildPrintHTML(rep);
}

/* ================================================================================
   INTEGRITY: copy protection + paste blocking + leave warning
   ================================================================================ */
const NOTICE = '[EXAM CONTENT PROTECTED — This text belongs to a closed-book assessment. Copying it, or using it to request AI assistance, breaks the integrity statement you agreed to.] ';
document.addEventListener('copy', e => {
  const sel = window.getSelection ? window.getSelection().toString() : '';
  if(!sel) return;
  const a = document.activeElement;
  if(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;   // copying your own typing is fine
  e.preventDefault();
  const enc = Array.from(sel).map(c => c.codePointAt(0).toString(16)).join(' ');
  if(e.clipboardData) e.clipboardData.setData('text/plain', NOTICE + enc);
  toast('Copying exam content is disabled.');
});
document.addEventListener('paste', e => {
  if(!CONFIG.blockPaste) return;
  const t = e.target;
  if(t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text')) && t.id !== 'inp-name'){
    e.preventDefault(); toast('Pasting is disabled during the exam.');
  }
});
window.addEventListener('beforeunload', e => {
  const inRun = /^run:/.test(S.step);
  const unsavedAudio = Rec.ready && !Rec.downloaded;
  if(inRun || unsavedAudio){ e.preventDefault(); e.returnValue = ''; return ''; }
});

/* ================================================================================
   EVENTS
   ================================================================================ */
function bindEvents(){
  // cover
  const validate = () => {
    $('#btn-begin').disabled = !($('#inp-name').value.trim().length >= 2 && $('#chk-integrity').checked);
  };
  $('#inp-name').addEventListener('input', validate);
  $('#chk-integrity').addEventListener('change', validate);
  $('#btn-begin').addEventListener('click', () => {
    S = freshState();
    S.name = $('#inp-name').value.trim(); S.date = $('#inp-date').value || new Date().toISOString().slice(0,10);
    if(!CONFIG.modules.length) return;
    show('intro:' + CONFIG.modules[0].id);
  });
  $('#btn-resume').addEventListener('click', () => resumeAttempt());
  $('#btn-discard').addEventListener('click', () => {
    if(window.confirm('Erase the saved attempt and start again?')){ clearSaved(); S = freshState(); location.reload(); }
  });

  // intro start buttons (delegated)
  $('#main-content').addEventListener('click', e => {
    const b = e.target.closest('[data-start]'); if(!b) return;
    b.disabled = true; startModule(b.dataset.start).finally(() => { b.disabled = false; });
  });

  // reading
  $('#reading-tabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if(t) setReadingTab(t.dataset.tab); });
  $('#reading-panes').addEventListener('input', onReadingInput);
  $('#reading-panes').addEventListener('change', onReadingInput);
  $('#pal-nums').addEventListener('click', e => { const b = e.target.closest('.pal-btn'); if(b) goToQuestion(Number(b.dataset.n)); });
  $('#btn-finish-reading').addEventListener('click', () => { if(confirmFinish('reading')) finishModule('reading', 'button'); });

  // writing
  $('#writing-tabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if(t) setWritingTab(t.dataset.tab); });
  $('#writing-panes').addEventListener('input', e => {
    const t = e.target; if(t.id === 'w-t1' || t.id === 'w-t2'){ const k = t.id.slice(2); S.w[k] = t.value; updateWC(k); save(); }
  });
  $('#btn-finish-writing').addEventListener('click', () => { if(confirmFinish('writing')) finishModule('writing', 'button'); });

  // listening
  $('#screen-run-listening').addEventListener('input', e => {
    const t = e.target; if(!t || !t.dataset || !t.dataset.q) return;
    if(t.type === 'checkbox') return;
    S.li = S.li || { answers: {} };
    S.li.answers[t.dataset.q] = t.value;
    if(t.dataset.maxWords) updateScHint(t);
    save();
  });
  $('#screen-run-listening').addEventListener('change', e => {
    const t = e.target; if(!t || !t.dataset || !t.dataset.q) return;
    if(t.type === 'radio' || t.tagName === 'SELECT') {
      S.li = S.li || { answers: {} };
      S.li.answers[t.dataset.q] = t.value;
      save();
    }
    if(t.type === 'radio') {
      const question = t.closest('.mcq-item');
      if(question) question.querySelectorAll('.opt').forEach(label => {
        label.classList.toggle('selected', label.querySelector('input').checked);
      });
    }
  });
  $('#screen-run-listening').addEventListener('click', e => {
    const check = e.target.closest('input[type="checkbox"][data-q]');
    if(check){
      S.li = S.li || { answers: {} };
      const qKey = check.dataset.q;
      const container = check.closest('.listening-multi-select-group, .mcq-item');
      const group = container ? container.querySelectorAll('input[type="checkbox"][data-q="' + qKey + '"]') : [];
      const maxSelect = container ? Number(container.dataset.maxSelect || 0) : 0;
      if(check.checked && maxSelect && Array.from(group).filter(input => input.checked).length > maxSelect) {
        check.checked = false;
        toast('Choose no more than ' + maxSelect + ' answers for this question.');
      }
      const values = Array.from(group).filter(x => x.checked).map(x => x.value);
      S.li.answers[qKey] = values;
      save();
      group.forEach(input => input.closest('.opt').classList.toggle('selected', input.checked));
      const count = container && container.querySelector('.listening-select-count');
      if(count) count.textContent = 'Select exactly ' + maxSelect + ' answers (' + values.length + ' of ' + maxSelect + ' selected).';
      return;
    }
    const b = e.target.closest('#btn-finish-listening'); if(!b) return;
    if(confirmFinish('listening')) finishModule('listening', 'button');
  });

  // done
  $('#done-root').addEventListener('click', e => {
    const b = e.target.closest('button'); if(!b) return;
    if(b.id === 'btn-dl-txt'){ const rep = buildReport(); download('Phase3_Capstone_' + safeName() + '.txt', new Blob([buildText(rep)], {type:'text/plain;charset=utf-8'})); }
    else if(b.id === 'btn-print'){ $('#print-sheet').innerHTML = buildPrintHTML(buildReport()); window.print(); }
    else if(b.id === 'btn-dl-audio'){ download(audioFileName(), Rec.blob); Rec.downloaded = true; }
    else if(b.id === 'btn-new'){
      if(window.confirm('This erases the saved answers on this device. Make sure you have downloaded your files first. Continue?')){ clearSaved(); Rec.downloaded = true; Rec.ready = false; S = freshState(); location.reload(); }
    }
  });
}

/* ================================================================================
   RESUME + INIT
   ================================================================================ */
function resumeAttempt(){
  // called from cover when a saved, unfinished attempt exists
  const m = /^(intro|run):(\w+)$/.exec(S.step);
  if(S.step === 'done' || S.submitted){ show('done'); renderDone(); return; }
  if(!m){ return; }
  const id = m[2];
  if(m[1] === 'run'){
    if(id === 'speaking'){
      // a recording cannot survive a reload: restart Speaking from its intro screen
      S.sp.interrupted = true; S.mod.speaking.start = null; S.sp.mode = null; show('intro:speaking'); return;
    }
    const mod = modById(id);
    if(CONFIG.timed && S.mod[id].start && (Date.now() - S.mod[id].start) / 1000 >= mod.minutes * 60){ finishModule(id, 'time'); return; }
    show('run:' + id);
    if(id === 'reading') setReadingTab(S.tab.reading || 'p1');
    if(id === 'writing') setWritingTab(S.tab.writing || 't1');
    if(id === 'listening') renderListening();
    return;
  }
  show('intro:' + id);
}
function init(){
  try{ localStorage.setItem('__t','1'); localStorage.removeItem('__t'); }catch(e){ storageOK = false; }
  if(!storageOK){ const w = $('#storage-warn'); w.style.display = 'block'; w.textContent = 'Warning: this browser is not allowing saved progress (private mode?). Do not refresh or close the page during the exam.'; }

  renderCover(); renderIntros(); renderReading(); renderWriting(); renderListening();
  bindEvents(); applyReadingAnswers();
  if(S.sp.notes) $('#sp-notes').value = S.sp.notes;

  const hasSaved = S.name && S.step !== 'cover';
  if(hasSaved){
    const done = S.submitted || S.step === 'done';
    $('#cover-resume').classList.remove('hidden');
    $('#cover-resume-text').textContent = done
      ? 'An attempt by ' + S.name + ' was already submitted on this device.'
      : 'An unfinished attempt by ' + S.name + ' was found (' + S.step.replace(':', ' → ') + ').';
    $('#btn-resume').textContent = done ? 'Show my submission page' : 'Resume where I stopped';
    $('#cover-form').classList.add('hidden');
  }
  S.step = hasSaved ? S.step : 'cover';
  // do not call show() for resumed state here: the learner must press Resume (shows cover first)
  $$('.screen').forEach(s => s.classList.remove('active')); $('#screen-cover').classList.add('active');
  renderRail(); tick();
  if(isTestEnv()) window.__p3 = {S: () => S, CONFIG, CONTENT, Rec, Sp, buildReport, buildText, startModule, finishModule, show, setReadingTab, goToQuestion, submitExam, resumeAttempt, isAnswered, unansweredCount, renderDone};
}
init();

})();
