import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONTACT_KEYS, resolveBook, syncContactFields } from '@/lib/book/migrate';
import { emptyHistory, type History as UndoHistory } from '@/lib/book/ops';
import type { Book } from '@/lib/book/model';
import type { SaveState } from '@/components/book-editor/book-editor';
// Editor code is loaded only when the Book editor tab opens; the public site never loads it.
const BookEditor=lazy(()=>import('@/components/book-editor/book-editor').then(m=>({default:m.BookEditor})));
import { ArrowLeft, Eye, FileText, BookOpen, Layers, Settings, History, Save, Plus, Trash2, Download, Upload, LogOut, Menu, X, Globe, ShieldOff, ArrowUp, ArrowDown, Copy, RotateCcw, Image as ImageIcon, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/portfolio';
import { usePortfolio, moveItem, type PortfolioContent, type SiteText } from '@/lib/portfolio-content';
import { describeChanges, type Change } from '@/lib/content-diff';
import builtInCoverAsset from '@/assets/tome-cover.jpg.asset.json';
const builtInCover = builtInCoverAsset.url;
import { resolveImage } from '@/lib/book/image-store';
import { ACCEPT_ATTR, MAX_UPLOAD_BYTES, isAcceptedMime, mediaUsage, mergeUsage } from '@/lib/media';
import { LIMITS, MAX_CONTENT_BYTES, parseContent, type Issue } from '@/lib/content-schema';
import { OUTCOME_LABEL, VISIT_TTL_DAYS, type VisitRow } from '@/lib/visit-info';
import { ApiError, conflictFrom, describeStorageFallback, describeUploadError, issuesFrom, studioApi, type AdminContent, type MediaList, type Revision } from '@/lib/studio-client';

const tabs=[{label:'Story & identity',icon:FileText},{label:'Book editor',icon:BookOpen},{label:'Selected projects',icon:Layers},{label:'Contact & links',icon:Settings},{label:'Site text & SEO',icon:Globe},{label:'Media',icon:ImageIcon},{label:'Version history',icon:History},{label:'Visitors',icon:Users}];
const DRAFT_KEY='studio-draft';
/** Characters used / allowed; turns noticeable when 90% of the limit is reached. */
const Count=({n,max}:{n:number;max:number})=><em className={n>=max*0.9?'char-count near':'char-count'}>{n}/{max}</em>;
const summarise=(changes:Change[],limit=6)=>changes.length===0?'':changes.slice(0,limit).map(c=>c.summary).join('; ')+(changes.length>limit?` (+${changes.length-limit} more)`:'');
type Notice={kind:'ok'|'warn'|'error';text:string;issues?:Issue[]}|null;

function restoreDraft(base:AdminContent):PortfolioContent|null{
  try{const raw=sessionStorage.getItem(DRAFT_KEY);if(!raw)return null;const saved=JSON.parse(raw) as {baseVersion?:unknown;draft?:unknown};if(saved.baseVersion!==base.version)return null;return parseContent(saved.draft).content;}catch{return null;}
}
const formatSize=(bytes:number)=>bytes>=1_000_000?`${(bytes/1_000_000).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1000))} KB`;
const when=(iso:string)=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleString();};
/** One visit in the visitor log. Everything shown here came from the visitor's browser, so it is only ever rendered as text. */
function VisitCard({v}:{v:VisitRow}){
  const device=v.model||v.modelGuess||'Model not shared by this browser';
  const specs=[v.gpu||'GPU unknown',v.memory?`${v.memory} GB RAM`:'RAM unknown',v.cores?`${v.cores} cores`:null,v.screen?`${v.screen} @${v.dpr}x`:null,v.net||null,v.lang||null].filter(Boolean).join(' · ');
  return <article className={`visit-row outcome-${v.outcome}`}>
    <div className="visit-top"><b>{when(v.time)}</b><span className="visit-ip">{v.ip}{v.country?` · ${v.country}`:''}</span></div>
    <div className="visit-device">{device}<i> · {v.os} · {v.browser}</i></div>
    <div className="visit-result"><span className="tier-badge">{v.tier?v.tier.toUpperCase():'—'}</span>{OUTCOME_LABEL[v.outcome]}{v.bootMs!==undefined?` · built in ${(v.bootMs/1000).toFixed(1)} s`:''}{v.reason?` · ${v.reason}`:''}</div>
    <div className="visit-specs">{specs}</div>
  </article>;
}

export function Studio({initial,initialRevisions,onLogout,onExpired}:{initial:AdminContent;initialRevisions:Revision[];onLogout:()=>void;onExpired:()=>void}){
  const router=useRouter();const navigate=useNavigate();const {update,reset}=usePortfolio();
  const [base,setBase]=useState(initial);
  const [draft,setDraft]=useState<PortfolioContent>(()=>restoreDraft(initial)??initial.content);
  const [tab,setTab]=useState(0),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<Notice>(null);const [conflict,setConflict]=useState<AdminContent|null>(null);
  const [revisions,setRevisions]=useState(initialRevisions);
  const fileInput=useRef<HTMLInputElement>(null);
  const dirty=useMemo(()=>JSON.stringify(draft)!==JSON.stringify(base.content),[draft,base]);
  // Debounced draft autosave (session storage, keyed to the published base version for conflict detection).
  const [saveState,setSaveState]=useState<SaveState>('idle');
  const [epoch,setEpoch]=useState(0);
  // Undo history lives here so it survives switching tabs (the Book editor unmounts); it is cleared whenever the whole book is replaced.
  const [history,setHistory]=useState<UndoHistory>(emptyHistory);
  const replaced=useCallback(()=>{setEpoch(e=>e+1);setHistory(emptyHistory());},[]);
  const [note,setNote]=useState('');
  const changes=useMemo(()=>describeChanges(base.content,draft),[base,draft]);
  const revisionDiffs=useMemo(()=>tab===6?revisions.map(r=>describeChanges(r.content,draft)):[],[tab,revisions,draft]);
  useEffect(()=>{setSaveState(s=>dirty?'saving':s);const t=window.setTimeout(()=>{try{if(dirty)sessionStorage.setItem(DRAFT_KEY,JSON.stringify({baseVersion:base.version,draft}));else sessionStorage.removeItem(DRAFT_KEY);setSaveState(dirty?'saved':'idle');}catch{setSaveState('error');}},500);return()=>window.clearTimeout(t);},[dirty,draft,base.version]);
  const book=useMemo(()=>resolveBook(draft),[draft]);
  const setBook=useCallback((next:Book)=>{setDraft(d=>({...d,book:next}));setNotice(null);},[]);
  useEffect(()=>{if(!dirty)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty]);
  // Once a book is stored it is its own source of truth, so the fields that also appear on it are pushed into it here
  // (contact heading/intro/email/links by element role, and the book title); before that it is derived from them live.
  function change<K extends keyof PortfolioContent>(key:K,value:PortfolioContent[K]){
    setDraft(d=>{
      const next={...d,[key]:value} as PortfolioContent;
      if(!d.book)return next;
      if((CONTACT_KEYS as readonly string[]).includes(key as string))return {...next,book:syncContactFields(d.book,next)};
      if(key==='bookTitle')return {...next,book:{...d.book,title:String(value)}};
      return next;
    });
    setNotice(null);
  }
  function setSite(patch:Partial<SiteText>){setDraft(d=>({...d,site:{...d.site,...patch}}));setNotice(null);}
  function siteField(key:'contactCta'|'viewProject'|'seoTitle'|'seoDescription'|'ogImage',label:string,max:number,multiline=false){const value=draft.site[key];return <label className="editor-field" key={key}><span>{label}<Count n={value.length} max={max}/></span>{multiline?<textarea rows={3} value={value} maxLength={max} onChange={e=>setSite({[key]:e.target.value})}/>:<input value={value} maxLength={max} type="text" onChange={e=>setSite({[key]:e.target.value})}/>}</label>;}
  function field(key:keyof PortfolioContent,label:string,multiline=false){const value=draft[key];if(typeof value!=='string')return null;return <label className="editor-field" key={key}><span>{label}<Count n={value.length} max={multiline?1000:300}/></span>{multiline?<textarea rows={3} value={value} maxLength={1000} onChange={e=>change(key,e.target.value)}/>:<input value={value} maxLength={300} onChange={e=>change(key,e.target.value)}/>}</label>;}
  async function publish(version=base.version){
    const check=parseContent(draft);
    if(check.issues.length){setNotice({kind:'error',text:'Fix these before publishing:',issues:check.issues});return;}
    setBusy(true);setNotice(null);setConflict(null);
    try{
      const saved=await studioApi.save(version,draft,note);
      setBase(saved);setDraft(saved.content);setNote('');
      await router.invalidate();
      setNotice({kind:'ok',text:`Published as version ${saved.version}. Your live site now shows these changes.`});
      studioApi.revisions().then(r=>setRevisions(r.revisions)).catch(()=>{});
    }catch(e){
      if(e instanceof ApiError){
        if(e.status===401){onExpired();return;}
        if(e.status===409){const current=conflictFrom(e);if(current){setConflict(current);return;}}
        if(e.status===422){setNotice({kind:'error',text:'The server rejected some fields:',issues:issuesFrom(e)});return;}
      }
      setNotice({kind:'error',text:'Could not publish. Check your connection and try again.'});
    }finally{setBusy(false);}
  }
  // ---- images: the book cover, the share preview, and the library of everything uploaded ----
  const imageInput=useRef<HTMLInputElement>(null);
  const uploadTarget=useRef<'coverImage'|'ogImage'|'library'>('library');
  const expiredRef=useRef(onExpired);expiredRef.current=onExpired;
  const [uploading,setUploading]=useState(false);
  const [media,setMedia]=useState<MediaList|null>(null);
  const [moving,setMoving]=useState(false);
  const [mediaError,setMediaError]=useState<string|null>(null);
  const usage=useMemo(()=>mergeUsage(mediaUsage(draft),mediaUsage(base.content)),[draft,base]);
  const loadMedia=useCallback(async()=>{
    try{setMedia(await studioApi.listMedia());setMediaError(null);}
    catch(e){
      if(e instanceof ApiError&&e.status===401){expiredRef.current();return;}
      setMediaError(e instanceof ApiError&&e.body['error']==='media_not_configured'?describeUploadError(e):'Could not load your images. Check your connection and try again.');
    }
  },[]);
  useEffect(()=>{if(tab===5)void loadMedia();},[tab,loadMedia]);
  const [visits,setVisits]=useState<VisitRow[]>([]);
  const [visitCursor,setVisitCursor]=useState<string|null>(null);
  const [visitsState,setVisitsState]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const [visitsNote,setVisitsNote]=useState<string|null>(null);
  const visitCursorRef=useRef<string|null>(null);
  const loadVisits=useCallback(async(more=false)=>{
    setVisitsState('loading');
    try{
      const page=await studioApi.visits(more?visitCursorRef.current:null);
      visitCursorRef.current=page.nextCursor;setVisitCursor(page.nextCursor);
      setVisits(prev=>more?[...prev,...page.items]:page.items);
      setVisitsNote(page.supported?null:'This storage cannot list entries, so the visitor log is unavailable.');
      setVisitsState('ready');
    }catch(e){
      if(e instanceof ApiError&&e.status===401){expiredRef.current();return;}
      setVisitsNote('Could not load the visitor log. Check your connection and try again.');setVisitsState('error');
    }
  },[]);
  useEffect(()=>{if(tab===7)void loadVisits();},[tab,loadVisits]);
  const clearVisitLog=useCallback(async()=>{
    if(!window.confirm('Delete the whole visitor log? This cannot be undone.'))return;
    setVisitsState('loading');
    try{
      for(let i=0;i<60;i++){if((await studioApi.clearVisits()).done)break;}
      setVisits([]);visitCursorRef.current=null;setVisitCursor(null);
      setVisitsNote('Log cleared. Deletions can take up to a minute to show everywhere.');setVisitsState('ready');
    }catch(e){
      if(e instanceof ApiError&&e.status===401){expiredRef.current();return;}
      setVisitsNote('Could not clear the log.');setVisitsState('error');
    }
  },[]);
  const visitSummary=useMemo(()=>{
    const tiers:Record<string,number>={};let noResult=0,gaveUp=0;
    for(const v of visits){tiers[v.tier||'?']=(tiers[v.tier||'?']??0)+1;if(v.outcome==='started')noResult++;if(v.outcome==='gave_up')gaveUp++;}
    return {tiers,noResult,gaveUp};
  },[visits]);
  function pickImage(target:'coverImage'|'ogImage'|'library'){uploadTarget.current=target;imageInput.current?.click();}
  async function handleImage(file:File){
    const target=uploadTarget.current;
    if(!isAcceptedMime(file.type)){setNotice({kind:'error',text:'Please choose a JPEG, PNG, WebP or GIF image.'});return;}
    if(file.size>MAX_UPLOAD_BYTES){setNotice({kind:'error',text:`That image is larger than ${MAX_UPLOAD_BYTES/1_000_000} MB.`});return;}
    setUploading(true);
    try{
      const uploaded=await studioApi.upload(file);
      if(target!=='library')setSite({[target]:uploaded.key});
      const fallback=describeStorageFallback(uploaded,target==='coverImage'?'the cover':target==='ogImage'?'the share preview':null);
      if(fallback)setNotice({kind:'warn',text:fallback});
      else setNotice({kind:'ok',text:uploaded.existing?'That image was already uploaded, so it is reused.':target==='library'?'Image uploaded.':'Image uploaded. Publish to make it live.'});
      if(tab===5)void loadMedia();
    }catch(e){
      if(e instanceof ApiError&&e.status===401){expiredRef.current();return;}
      setNotice({kind:'error',text:describeUploadError(e)});
    }finally{setUploading(false);}
  }
  async function moveToR2(){
    setMoving(true);
    let moved=0,failed=0;
    try{
      // A few images per request (a Worker may only make so many storage calls at once); stop if a round moves nothing.
      for(let round=0;round<200;round++){
        const r=await studioApi.migrateMedia();
        moved+=r.moved;failed+=r.failed;
        if(r.remaining===0||r.moved===0)break;
      }
      setNotice(failed>0?{kind:'warn',text:`Moved ${moved} image${moved===1?'':'s'} to R2. ${failed} could not be moved and stay in the backup storage; they still work.`}:{kind:'ok',text:`Moved ${moved} image${moved===1?'':'s'} to Cloudflare R2.`});
    }catch(e){
      if(e instanceof ApiError&&e.status===401){expiredRef.current();return;}
      setNotice({kind:'error',text:e instanceof ApiError&&e.body['error']==='r2_not_connected'?'Cloudflare R2 is not connected, so nothing can be moved yet. See DEPLOY.md, “Image uploads (R2)”.':'Could not move the images. Try again.'});
    }finally{setMoving(false);void loadMedia();}
  }
  async function deleteImage(name:string){
    if(!window.confirm('Delete this image from storage? This cannot be undone.'))return;
    try{
      await studioApi.deleteMedia(name);
      setMedia(m=>m?{...m,items:m.items.filter(i=>i.name!==name)}:m);
      setNotice({kind:'ok',text:'Image deleted.'});
    }catch(e){
      if(e instanceof ApiError&&e.status===401){expiredRef.current();return;}
      if(e instanceof ApiError&&e.body['error']==='in_use'){setNotice({kind:'error',text:'The published site still uses that image. Publish a version without it first.'});void loadMedia();return;}
      setNotice({kind:'error',text:'Could not delete the image. Try again.'});
    }
  }
  const coverPreview=resolveImage({key:draft.site.coverImage})||builtInCover;
  const ogKey=draft.site.ogImage;
  const ogPreview=ogKey?resolveImage({key:ogKey.startsWith('media:')?ogKey:`url:${ogKey}`}):'';

  function discard(){
    if(!window.confirm('Discard all unpublished changes and go back to the published version?'))return;
    setDraft(base.content);replaced();setNote('');
    setNotice({kind:'ok',text:'Changes discarded. Your draft matches the published version again.'});
  }
  // Ctrl/Cmd+S publishes, but only after a confirmation: publishing is public, and the shortcut is muscle memory.
  const publishShortcut=useRef<()=>void>(()=>{});
  publishShortcut.current=()=>{
    if(!dirty||busy)return;
    const n=changes.length;
    if(!window.confirm(`Publish ${n>0?`${n} change${n===1?'':'s'}`:'your changes'} now? This goes live for everyone.`))return;
    void publish();
  };
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='s'){e.preventDefault();publishShortcut.current();}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[]);
  function previewDraft(){update(draft);navigate({to:'/'});}
  function exportContent(){const blob=new Blob([JSON.stringify(draft,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${draft.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'portfolio'}.json`;a.click();URL.revokeObjectURL(url);}
  async function importFile(file:File){
    // Same limit the server enforces, so a file the Studio exported can always be imported again.
    if(file.size>MAX_CONTENT_BYTES){setNotice({kind:'error',text:`That file is ${(file.size/1_000_000).toFixed(1)} MB; the most the server accepts is ${(MAX_CONTENT_BYTES/1_000_000).toFixed(0)} MB.`});return;}
    try{
      const result=parseContent(JSON.parse(await file.text()));
      setDraft(result.content);replaced();
      setNotice({kind:'ok',text:result.issues.length?`Imported with ${result.issues.length} adjustment${result.issues.length===1?'':'s'}. Review the draft, then publish.`:'Imported. Review the draft, then publish.'});
    }catch{setNotice({kind:'error',text:'That file is not valid portfolio JSON.'});}
  }
  function loadRevision(rev:Revision){setDraft(rev.content);replaced();setTab(0);setNotice({kind:'ok',text:`Loaded version ${rev.version} into your draft. Press Publish to make it live.`});}
  async function logout(){
    if(dirty&&!window.confirm('You have unpublished changes. Sign out and discard them?'))return;
    try{await studioApi.logout();}catch{/* The cookie expires on its own. */}
    try{sessionStorage.removeItem(DRAFT_KEY);}catch{/* ignore */}
    reset();onLogout();
  }
  async function logoutEverywhere(){
    if(!window.confirm(`Sign out of every device? Anyone signed in elsewhere, including you on other browsers, will have to sign in again.${dirty?' Your unpublished changes here will also be discarded.':''}`))return;
    try{await studioApi.logoutAll();}
    catch(e){if(e instanceof ApiError&&e.status===401){onExpired();return;}setNotice({kind:'error',text:'Could not sign out of all devices. Check your connection and try again.'});return;}
    try{sessionStorage.removeItem(DRAFT_KEY);}catch{/* ignore */}
    reset();onLogout();
  }
  return <div className="studio"><aside className={open?'studio-sidebar expanded':'studio-sidebar'}><Link to="/"><Brand/></Link><div className="studio-sidebar-label">CONTENT STUDIO</div><nav>{tabs.map((item,i)=><Button key={item.label} variant="ghost" className={tab===i?'selected':''} onClick={()=>{setTab(i);setOpen(false);}}><item.icon/><span>{item.label}</span></Button>)}</nav><Link className="return-link" to="/"><ArrowLeft size={16}/>Return to portfolio</Link></aside><div className="studio-main"><header className="studio-header"><Button variant="ghost" size="icon" className="studio-menu" aria-label="Toggle studio navigation" onClick={()=>setOpen(!open)}>{open?<X/>:<Menu/>}</Button><span>{draft.name.toUpperCase()} <i>/</i> CONTENT STUDIO{dirty&&<b className="studio-dirty"> · UNPUBLISHED CHANGES</b>}</span><div><span className="studio-tools"><Button variant="ghost" size="icon" title="Import content" aria-label="Import content" onClick={()=>fileInput.current?.click()}><Upload/></Button><Button variant="ghost" size="icon" title="Export content" aria-label="Export content" onClick={exportContent}><Download/></Button><Button variant="ghost" size="icon" title="Sign out" aria-label="Sign out" onClick={logout}><LogOut/></Button><Button variant="ghost" size="icon" title="Sign out of all devices" aria-label="Sign out of all devices" onClick={()=>void logoutEverywhere()}><ShieldOff/></Button></span><Button variant="outline" onClick={previewDraft}><Eye/>Preview</Button><Button onClick={()=>publish()} disabled={busy||!dirty}><Save/>{busy?'Publishing…':'Publish'}</Button></div><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void importFile(file);}}/></header><div className={tab===1?"studio-content wide":"studio-content"}><div className="editor-heading"><span className="eyebrow">YOUR WORLD, YOUR WORDS</span><h1>{tabs[tab]?.label}</h1><p>Edits stay in your draft until you press Publish. Live version: {base.version===0?'built-in defaults':`v${base.version}${base.updatedAt?` · ${when(base.updatedAt)}`:''}${base.note?` · “${base.note}”`:''}`}.{dirty?' You have unpublished changes.':''}</p></div>
    {dirty&&<section className="changes-panel" aria-label="Changes since the published version"><div className="changes-head"><span>{changes.length||'SOME'} CHANGE{changes.length===1?'':'S'} SINCE {base.version===0?'THE DEFAULTS':`V${base.version}`}</span><Button variant="ghost" size="sm" onClick={discard}><RotateCcw/>Discard changes</Button></div><ul>{changes.length===0&&<li>Small edits that are not itemised.</li>}{changes.slice(0,12).map((c,i)=><li key={`${i}-${c.summary}`}><b>{c.area}</b>{c.summary}</li>)}{changes.length>12&&<li>+{changes.length-12} more</li>}</ul><label className="editor-field"><span>Note for this version (optional)<Count n={note.length} max={LIMITS.note}/></span><input value={note} maxLength={LIMITS.note} placeholder="e.g. Added my new project" onChange={e=>setNote(e.target.value)}/></label></section>}
    {tab===0&&<div className="editor-grid"><div>{field('name','Full name')}{field('wordmark','Sanctuary wordmark')}{field('headline','Opening headline',true)}{field('introduction','Opening introduction',true)}</div><div>{field('aboutTitle','Origin headline',true)}{field('about','Your story',true)}{field('projectsTitle','Artifacts headline')}{field('bookTitle','Grimoire headline')}{field('bookDescription','Grimoire introduction',true)}</div></div>}
    {tab===1&&<Suspense fallback={<p className="studio-empty">Opening the book…</p>}><BookEditor key={epoch} book={book} onChange={setBook} saveState={saveState} onPreview={previewDraft} history={history} onHistory={setHistory} onNotify={setNotice}/></Suspense>}
    {tab===2&&<div><div className="editor-section-title"><span>SELECTED WORK · {draft.projects.length}/{LIMITS.projects}</span><Button variant="outline" disabled={draft.projects.length>=LIMITS.projects} title={draft.projects.length>=LIMITS.projects?`At most ${LIMITS.projects} projects`:undefined} onClick={()=>change('projects',[...draft.projects,{title:'Untitled project',category:'NEW PROJECT',description:'',url:''}])}><Plus/>Add project</Button></div>{draft.projects.map((item,i)=><div className="achievement-editor" key={i}><div className="achievement-editor-header"><span>PROJECT {String(i+1).padStart(2,'0')}</span><span className="studio-tools"><Button variant="ghost" size="icon" title="Move up" aria-label={`Move project ${i+1} up`} disabled={i===0} onClick={()=>change('projects',moveItem(draft.projects,i,i-1))}><ArrowUp/></Button><Button variant="ghost" size="icon" title="Move down" aria-label={`Move project ${i+1} down`} disabled={i===draft.projects.length-1} onClick={()=>change('projects',moveItem(draft.projects,i,i+1))}><ArrowDown/></Button><Button variant="ghost" size="icon" title={draft.projects.length>=LIMITS.projects?`At most ${LIMITS.projects} projects`:'Duplicate'} aria-label={`Duplicate project ${i+1}`} disabled={draft.projects.length>=LIMITS.projects} onClick={()=>change('projects',[...draft.projects.slice(0,i+1),{...item,title:`${item.title.slice(0,LIMITS.project-7)} (copy)`},...draft.projects.slice(i+1)])}><Copy/></Button></span><Button variant="ghost" size="icon" aria-label={`Delete project ${i+1}`} onClick={()=>change('projects',draft.projects.filter((_,j)=>j!==i))}><Trash2/></Button></div><div className="achievement-fields">{(['title','category','description','url'] as const).map(key=><label className="editor-field" key={key}><span>{key==='url'?'Project link':key}<Count n={item[key].length} max={LIMITS.project}/></span>{key==='description'?<textarea rows={4} value={item[key]} maxLength={500} onChange={e=>change('projects',draft.projects.map((a,j)=>j===i?{...a,[key]:e.target.value}:a))}/>:<input value={item[key]} maxLength={500} type={key==='url'?'url':'text'} onChange={e=>change('projects',draft.projects.map((a,j)=>j===i?{...a,[key]:e.target.value}:a))}/>}</label>)}</div></div>)}</div>}
    {tab===3&&<div><p className="editor-hint">These also update the contact page of your book: its heading, intro, email and the link targets. A link on that page whose label you renamed keeps its label; one you deleted is left alone.</p><div className="editor-grid"><div>{field('contactTitle','Closing headline',true)}{field('contactText','Closing introduction',true)}{field('email','Email address')}</div><div>{field('github','GitHub URL')}{field('linkedin','LinkedIn URL')}{field('facebook','Facebook URL')}</div></div></div>}
    {tab===4&&<div><p className="editor-hint">Wording that used to be fixed in the site. Section names appear in the menu, the side dock and the small headings. Search & sharing text appears in the browser tab, search results and link previews.</p><div className="editor-grid"><div><div className="editor-section-title"><span>SECTION NAMES</span></div>{draft.site.chapters.map((name,i)=><label className="editor-field" key={i}><span>{['Opening','Story','Projects','Book','Contact'][i]} section<Count n={name.length} max={LIMITS.chapter}/></span><input value={name} maxLength={LIMITS.chapter} onChange={e=>setSite({chapters:draft.site.chapters.map((c,j)=>j===i?e.target.value:c)})}/></label>)}<div className="editor-section-title"><span>BUTTONS</span></div>{siteField('contactCta','Contact button',LIMITS.label)}{siteField('viewProject','Project link button',LIMITS.label)}<div className="editor-section-title"><span>BOOK COVER</span></div><div className="media-field"><img src={coverPreview} alt="Current book cover"/><div><Button variant="outline" size="sm" disabled={uploading} onClick={()=>pickImage('coverImage')}><Upload/>{draft.site.coverImage?'Replace cover':'Upload cover'}</Button>{draft.site.coverImage&&<Button variant="ghost" size="sm" onClick={()=>setSite({coverImage:''})}>Use built-in cover</Button>}</div></div><p className="editor-hint">The cover of the 3D book. Portrait works best: about 1400×1900 px (3:4); other shapes are stretched to fit. JPEG, PNG, WebP or GIF up to 8 MB.</p></div><div><div className="editor-section-title"><span>SEARCH & SHARING</span></div>{siteField('seoTitle','Page title',LIMITS.seoTitle)}{siteField('seoDescription','Page description',LIMITS.seoDescription,true)}<div className="editor-section-title"><span>SHARE PREVIEW IMAGE</span></div>{siteField('ogImage','Image link, or upload one (optional)',LIMITS.single)}<div className="media-field">{ogPreview&&<img src={ogPreview} alt="Share preview"/>}<div><Button variant="outline" size="sm" disabled={uploading} onClick={()=>pickImage('ogImage')}><Upload/>Upload image</Button>{draft.site.ogImage&&<Button variant="ghost" size="sm" onClick={()=>setSite({ogImage:''})}>Use built-in image</Button>}</div></div><p className="editor-hint">Shown when your link is shared. Leave empty to use the site's built-in image. About 1200×630 works best. An uploaded image needs the site's public address to be set (see DEPLOY.md).</p><div className="editor-section-title"><span>STORY TAGS · {draft.site.tech.length}/{LIMITS.tech}</span><Button variant="outline" disabled={draft.site.tech.length>=LIMITS.tech} onClick={()=>setSite({tech:[...draft.site.tech,'New tag']})}><Plus/>Add tag</Button></div>{draft.site.tech.map((tag,i)=><label className="editor-field" key={i}><span>Tag {i+1}<Count n={tag.length} max={LIMITS.techItem}/></span><div className="tag-row"><input value={tag} maxLength={LIMITS.techItem} onChange={e=>setSite({tech:draft.site.tech.map((t,j)=>j===i?e.target.value:t)})}/><Button variant="ghost" size="icon" type="button" title="Move up" aria-label={`Move tag ${i+1} up`} disabled={i===0} onClick={()=>setSite({tech:moveItem(draft.site.tech,i,i-1)})}><ArrowUp/></Button><Button variant="ghost" size="icon" type="button" title="Move down" aria-label={`Move tag ${i+1} down`} disabled={i===draft.site.tech.length-1} onClick={()=>setSite({tech:moveItem(draft.site.tech,i,i+1)})}><ArrowDown/></Button><Button variant="ghost" size="icon" type="button" aria-label={`Delete tag ${i+1}`} onClick={()=>setSite({tech:draft.site.tech.filter((_,j)=>j!==i)})}><Trash2/></Button></div></label>)}</div></div></div>}
    <input ref={imageInput} type="file" accept={ACCEPT_ATTR} hidden onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void handleImage(f);}}/>
    {tab===5&&<div><p className="editor-hint">Every image you have uploaded, shared by the book, the cover and the share preview. An image the published site uses cannot be deleted: publish a version without it first.</p><div className="editor-section-title"><span>UPLOADED IMAGES{media?` · ${media.items.length}`:''}</span><Button variant="outline" disabled={uploading} onClick={()=>pickImage('library')}><Upload/>{uploading?'Uploading…':'Upload image'}</Button></div>{mediaError&&<p className="editor-hint" role="alert">{mediaError}</p>}{media&&!media.r2Connected&&<p className="editor-hint" role="status">Cloudflare R2 is not connected, so new uploads are kept in the site's own backup storage (KV) instead. They work normally. See DEPLOY.md, “Image uploads (R2)”.</p>}{media&&media.items.some(i=>i.storage==='kv')&&<div className="save-notice warn" role="status">{media.items.filter(i=>i.storage==='kv').length} image{media.items.filter(i=>i.storage==='kv').length===1?'':'s'} not saved in Cloudflare R2 (kept in backup storage; still working).<div className="notice-actions">{media.r2Connected?<Button variant="outline" size="sm" disabled={moving} onClick={()=>void moveToR2()}>{moving?'Moving…':'Move to R2'}</Button>:<span>Connect R2 to move them.</span>}</div></div>}{!mediaError&&!media&&<p className="studio-empty">Loading…</p>}{media&&media.items.length===0&&<p className="studio-empty">No images yet.</p>}{media&&media.items.length>0&&<div className="media-grid">{media.items.map(item=>{const uses=usage.get(item.name);const inUse=!!uses&&uses.size>0;return <figure className="media-item" key={item.name}><img src={`/media/${item.name}`} alt="" loading="lazy"/><figcaption><span>{item.size>0?`${formatSize(item.size)} · `:''}{item.uploaded?when(item.uploaded):''}{item.storage==='kv'?' · backup storage, not R2':''}</span><span>{inUse?`In use: ${[...uses!].join(', ')}`:'Not used'}</span></figcaption><Button variant="ghost" size="sm" disabled={inUse} title={inUse?'In use: cannot delete':'Delete this image'} onClick={()=>void deleteImage(item.name)}><Trash2/>Delete</Button></figure>;})}</div>}{media?.truncated&&<p className="editor-hint">Only the newest images are shown.</p>}</div>}
    {tab===6&&<div><div className="editor-section-title"><span>LAST {revisions.length} REPLACED VERSION{revisions.length===1?'':'S'}</span></div>{revisions.length===0&&<p className="studio-empty">No earlier versions yet. Each publish keeps the version it replaces.</p>}{revisions.map((rev,i)=><div className="achievement-editor" key={rev.version}><div className="achievement-editor-header"><span>VERSION {rev.version}{rev.updatedAt?` · ${when(rev.updatedAt)}`:''}</span><Button variant="outline" onClick={()=>loadRevision(rev)}>Load into draft</Button></div>{rev.note&&<p className="revision-note">“{rev.note}”</p>}<p className="revision-diff">{revisionDiffs[i]?.length?`Your draft differs from this version in: ${summarise(revisionDiffs[i] as Change[])}.`:'Identical to your current draft.'}</p></div>)}</div>}
    {tab===7&&<div><div className="editor-section-title"><span>VISITORS · {visits.length}{visitCursor?'+':''}</span><div className="visit-tools"><Button variant="outline" disabled={visitsState==='loading'} onClick={()=>void loadVisits()}>Refresh</Button><Button variant="outline" disabled={visitsState==='loading'||visits.length===0} onClick={()=>void clearVisitLog()}><Trash2/>Clear log</Button></div></div>
      <p className="editor-hint">Every visit to the public page, newest first: time, IP address, device and specs. Each entry deletes itself after {VISIT_TTL_DAYS} days. Visitors whose browser sends Do Not Track or Global Privacy Control are not recorded. The exact device model is shared only by Chrome on Android; iPhones can only be narrowed to a family. A visit marked "No result" never reported back: the visitor left early or the tab crashed.</p>
      {visitsNote&&<p className="studio-empty" role="status">{visitsNote}</p>}
      <div className="visit-summary">{['high','mid','low','lite'].map(k=><span key={k}>{k.toUpperCase()}<b>{visitSummary.tiers[k]??0}</b></span>)}<span>NO RESULT<b>{visitSummary.noResult}</b></span><span>GAVE UP<b>{visitSummary.gaveUp}</b></span></div>
      {visitsState==='ready'&&visits.length===0&&!visitsNote&&<p className="studio-empty">No visits recorded yet.</p>}
      <div className="visit-list">{visits.map(v=><VisitCard key={v.key} v={v}/>)}</div>
      {visitCursor&&<Button variant="outline" disabled={visitsState==='loading'} onClick={()=>void loadVisits(true)}>Load more</Button>}</div>}
    {notice&&<div className={notice.kind==='ok'?'save-notice':`save-notice ${notice.kind}`} role={notice.kind==='error'?'alert':'status'}>{notice.text}{notice.issues&&notice.issues.length>0&&<ul>{notice.issues.slice(0,8).map(i=><li key={`${i.path}:${i.message}`}>{i.path||'content'}: {i.message}</li>)}</ul>}</div>}
    {conflict&&<div className="save-notice error" role="alert">A newer version (v{conflict.version}) was published from another session, so nothing was overwritten.<div className="notice-actions"><Button variant="outline" onClick={()=>{setBase(conflict);setDraft(conflict.content);replaced();setConflict(null);}}>Load latest into draft</Button><Button variant="outline" onClick={()=>void publish(conflict.version)}>Overwrite with my draft</Button></div></div>}
    </div><footer className="studio-footer"><span>THE PORTFOLIO OF {draft.name.toUpperCase()}</span><span>CONTENT STUDIO / {new Date().getFullYear()}</span></footer></div></div>;
}
